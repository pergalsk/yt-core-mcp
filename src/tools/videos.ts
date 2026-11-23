import type { youtube_v3 } from '@googleapis/youtube';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openGuardedFile } from '../files/file-guard.js';
import { runTool, untrustedResult } from './result.js';
import type { YouTubeFactory } from './youtube.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// Overwrites existing data on YouTube; repeating the same call gives the same result.
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const videoId = z.string().regex(/^[\w-]{11}$/).describe('YouTube video id (11 characters).');
const maxResults = z.number().int().min(1).max(50).default(10).describe('Results per page (1-50).');
const pageToken = z.string().max(200).optional().describe('nextPageToken from a previous call.');

/** Uploads a JPEG/PNG (≤2 MB, read via the file guard) as the video's custom thumbnail. */
export async function setThumbnail(
  api: youtube_v3.Youtube,
  id: string,
  path: string,
): Promise<youtube_v3.Schema$ThumbnailSetResponse> {
  const file = await openGuardedFile(path, 'thumbnail');
  try {
    const res = await api.thumbnails.set({
      videoId: id,
      media: { mimeType: file.mimeType, body: file.handle.createReadStream({ start: 0, autoClose: false }) },
    });
    return res.data;
  } finally {
    await file.handle.close();
  }
}

/** Drops undefined values (needed for exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export interface VideoPatch {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  categoryId?: string | undefined;
  privacyStatus?: 'public' | 'unlisted' | 'private' | undefined;
}

/**
 * Safe partial update. videos.update resets every omitted field of a sent part,
 * so we fetch the current video, merge the patch into its writable fields and
 * send only the parts that changed.
 */
export async function updateVideo(
  api: youtube_v3.Youtube,
  id: string,
  patch: VideoPatch,
): Promise<youtube_v3.Schema$Video> {
  const { privacyStatus, ...snippetPatch } = patch;
  const snippetChanged = Object.values(snippetPatch).some((v) => v !== undefined);
  if (!snippetChanged && privacyStatus === undefined) throw new Error('Nothing to update.');

  const current = (await api.videos.list({ part: ['snippet', 'status'], id: [id] })).data.items?.[0];
  if (!current?.snippet || !current.status) throw new Error(`Video ${id} not found or not owned by you.`);

  const body: youtube_v3.Schema$Video = { id };
  const part: string[] = [];
  if (snippetChanged) {
    const s = current.snippet;
    body.snippet = defined({
      title: snippetPatch.title ?? s.title,
      description: snippetPatch.description ?? s.description,
      tags: snippetPatch.tags ?? s.tags,
      categoryId: snippetPatch.categoryId ?? s.categoryId,
      defaultLanguage: s.defaultLanguage,
      defaultAudioLanguage: s.defaultAudioLanguage,
    });
    part.push('snippet');
  }
  if (privacyStatus !== undefined) {
    const s = current.status;
    body.status = defined({
      privacyStatus,
      // A scheduled publish time is only allowed on private videos.
      publishAt: privacyStatus === 'private' ? s.publishAt : null,
      embeddable: s.embeddable,
      license: s.license,
      publicStatsViewable: s.publicStatsViewable,
      selfDeclaredMadeForKids: s.selfDeclaredMadeForKids,
      containsSyntheticMedia: s.containsSyntheticMedia,
    });
    part.push('status');
  }

  return (await api.videos.update({ part, requestBody: body })).data;
}

export function registerVideoTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'video_set_thumbnail',
    {
      title: 'Set video thumbnail',
      description:
        'Replaces the custom thumbnail of your video (YouTube Data API thumbnails.set). ' +
        'The file must be JPEG or PNG, max 2 MB, inside the media folder (YT_CORE_MCP_MEDIA_ROOT). Costs 50 quota units.',
      inputSchema: {
        videoId,
        path: z.string().min(1).max(1000).describe('Image path, absolute or relative to the media folder.'),
      },
      annotations: OVERWRITE,
    },
    (args) =>
      runTool(async () => {
        const data = await setThumbnail(yt('core'), args.videoId, args.path);
        return { content: [{ type: 'text', text: JSON.stringify({ videoId: args.videoId, thumbnails: data.items }, null, 2) }] };
      }),
  );

  server.registerTool(
    'video_update',
    {
      title: 'Update video',
      description:
        'Changes title, description, tags, category or privacy of your video. Only the given fields change; ' +
        'the rest is kept (fetch → merge → videos.update). Costs ~51 quota units.',
      inputSchema: {
        videoId,
        title: z.string().min(1).max(100).optional(),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string().min(1).max(500)).max(500).optional().describe('Replaces all tags.'),
        categoryId: z.string().regex(/^\d+$/).optional().describe('Numeric category id (see categories_list).'),
        privacyStatus: z.enum(['public', 'unlisted', 'private']).optional(),
      },
      annotations: OVERWRITE,
    },
    ({ videoId: id, ...patch }) =>
      runTool(async () => {
        const v = await updateVideo(yt('core'), id, patch);
        return untrustedResult({ id: v.id, snippet: v.snippet, status: v.status });
      }),
  );

  server.registerTool(
    'video_get',
    {
      title: 'Get videos',
      description: 'Gets details and statistics of up to 50 videos by id (YouTube Data API videos.list). Costs 1 quota unit.',
      inputSchema: { ids: z.array(videoId).min(1).max(50) },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').videos.list({
          part: ['snippet', 'status', 'statistics', 'contentDetails'],
          id: args.ids,
        });
        return untrustedResult(
          (res.data.items ?? []).map((v) => ({
            id: v.id,
            title: v.snippet?.title,
            description: v.snippet?.description,
            tags: v.snippet?.tags,
            categoryId: v.snippet?.categoryId,
            channelId: v.snippet?.channelId,
            channelTitle: v.snippet?.channelTitle,
            publishedAt: v.snippet?.publishedAt,
            privacyStatus: v.status?.privacyStatus,
            publishAt: v.status?.publishAt,
            duration: v.contentDetails?.duration,
            viewCount: v.statistics?.viewCount,
            likeCount: v.statistics?.likeCount,
            commentCount: v.statistics?.commentCount,
          })),
        );
      }),
  );

  server.registerTool(
    'video_list',
    {
      title: 'List my videos',
      description:
        'Lists videos uploaded to your channel, newest first, including private ones (uploads playlist). Costs 2 quota units.',
      inputSchema: { maxResults, pageToken },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const channel = (await api.channels.list({ part: ['contentDetails'], mine: true })).data.items?.[0];
        const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) throw new Error('No YouTube channel found for this account.');
        const res = await api.playlistItems.list({
          part: ['snippet', 'status'],
          playlistId: uploads,
          maxResults: args.maxResults,
          ...(args.pageToken ? { pageToken: args.pageToken } : {}),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((i) => ({
            id: i.snippet?.resourceId?.videoId,
            title: i.snippet?.title,
            publishedAt: i.snippet?.publishedAt,
            privacyStatus: i.status?.privacyStatus,
          })),
        });
      }),
  );

  server.registerTool(
    'channel_get',
    {
      title: 'Get channel',
      description: 'Gets details and statistics of your channel, or of a channel by id (channels.list). Costs 1 quota unit.',
      inputSchema: {
        channelId: z.string().regex(/^UC[\w-]{22}$/).optional().describe('Channel id; omit for your own channel.'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').channels.list({
          part: ['snippet', 'statistics', 'contentDetails'],
          ...(args.channelId ? { id: [args.channelId] } : { mine: true }),
        });
        const c = res.data.items?.[0];
        if (!c) throw new Error('Channel not found.');
        return untrustedResult({
          id: c.id,
          title: c.snippet?.title,
          description: c.snippet?.description,
          customUrl: c.snippet?.customUrl,
          country: c.snippet?.country,
          publishedAt: c.snippet?.publishedAt,
          subscriberCount: c.statistics?.subscriberCount,
          videoCount: c.statistics?.videoCount,
          viewCount: c.statistics?.viewCount,
          uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads,
        });
      }),
  );

  server.registerTool(
    'categories_list',
    {
      title: 'List video categories',
      description: 'Lists video categories for a region (videoCategories.list). Costs 1 quota unit.',
      inputSchema: {
        regionCode: z.string().regex(/^[A-Za-z]{2}$/).default('SK').describe('ISO 3166-1 alpha-2 country code.'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').videoCategories.list({ part: ['snippet'], regionCode: args.regionCode });
        return untrustedResult(
          (res.data.items ?? []).map((c) => ({ id: c.id, title: c.snippet?.title, assignable: c.snippet?.assignable })),
        );
      }),
  );
}
