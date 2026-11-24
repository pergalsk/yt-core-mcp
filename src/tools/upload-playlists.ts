import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { youtube_v3 } from '@googleapis/youtube';
import { z } from 'zod';
import { openGuardedFile } from '../files/file-guard.js';
import { READ_ONLY, WRITE } from './annotations.js';
import { confirmPrivacy } from './confirm.js';
import { resumableUpload, type AuthFactory } from './resumable-upload.js';
import { runTool, untrustedResult } from './result.js';
import { description, pageToken, resourceId, tags, title, videoId } from './schemas.js';
import type { YouTubeFactory } from './youtube.js';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

const privacyStatus = z.enum(['private', 'unlisted', 'public']);

/** Adds a video to a playlist (playlistItems.insert). Exported for reuse by other tools. */
export async function addPlaylistItem(
  client: youtube_v3.Youtube,
  playlistId: string,
  videoId: string,
  position?: number,
): Promise<youtube_v3.Schema$PlaylistItem> {
  const res = await client.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId }, ...(position !== undefined && { position }) },
    },
  });
  return res.data;
}

export function registerUploadAndPlaylistTools(server: McpServer, yt: YouTubeFactory, auth: AuthFactory): void {
  server.registerTool(
    'video_upload',
    {
      title: 'Upload video',
      description:
        'Uploads a local video file to your channel (resumable upload, videos.insert). The file must be inside the ' +
        'media folder (YT_CORE_MCP_MEDIA_ROOT). Default privacy is private. Note: uploads from unverified API ' +
        'projects are locked to private until the project passes a YouTube audit. Costs about 100 quota units. ' +
        'Needs the `core` permission group.',
      inputSchema: {
        file: z.string().min(1).max(1000).describe('Path to the video, absolute or relative to the media folder.'),
        title,
        description: description.optional(),
        tags: tags.optional().describe('Max 500 characters in total.'),
        categoryId: z.string().regex(/^\d+$/).optional().describe('Numeric video category id.'),
        privacyStatus: privacyStatus.default('private'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const file = await openGuardedFile(args.file, 'video');
        try {
          await confirmPrivacy(server, `new video "${args.title}"`, args.privacyStatus);
          const video: youtube_v3.Schema$Video = {
            snippet: {
              title: args.title,
              ...(args.description !== undefined && { description: args.description }),
              ...(args.tags !== undefined && { tags: args.tags }),
              ...(args.categoryId !== undefined && { categoryId: args.categoryId }),
            },
            status: { privacyStatus: args.privacyStatus },
          };
          // The googleapis client only does multipart uploads, so the resumable protocol
          // is done with the OAuth client directly.
          const data = await resumableUpload<youtube_v3.Schema$Video>(auth('core'), {
            url: UPLOAD_URL,
            params: { uploadType: 'resumable', part: 'snippet,status' },
            metadata: video,
            file,
          });
          return untrustedResult({
            id: data.id,
            title: data.snippet?.title,
            uploadStatus: data.status?.uploadStatus,
            privacyStatus: data.status?.privacyStatus,
          });
        } finally {
          await file.handle.close();
        }
      }),
  );

  server.registerTool(
    'playlist_list',
    {
      title: 'List my playlists',
      description:
        'Lists playlists of your channel (playlists.list mine=true). Costs 1 quota unit. ' +
        'Needs the `core` permission group.',
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).default(25).describe('Results per page (1-50).'),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').playlists.list({
          part: ['snippet', 'status', 'contentDetails'],
          mine: true,
          maxResults: args.maxResults,
          ...(args.pageToken !== undefined && { pageToken: args.pageToken }),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((p) => ({
            id: p.id,
            title: p.snippet?.title,
            description: p.snippet?.description,
            privacyStatus: p.status?.privacyStatus,
            itemCount: p.contentDetails?.itemCount,
            publishedAt: p.snippet?.publishedAt,
          })),
        });
      }),
  );

  server.registerTool(
    'playlist_create',
    {
      title: 'Create playlist',
      description:
        'Creates a playlist on your channel (playlists.insert). Default privacy is private. Costs 50 quota units. ' +
        'Needs the `core` permission group.',
      inputSchema: {
        title: z.string().min(1).max(150),
        description: z.string().max(5000).optional(),
        privacyStatus: privacyStatus.default('private'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        await confirmPrivacy(server, `new playlist "${args.title}"`, args.privacyStatus);
        const res = await yt('core').playlists.insert({
          part: ['snippet', 'status'],
          requestBody: {
            snippet: { title: args.title, ...(args.description !== undefined && { description: args.description }) },
            status: { privacyStatus: args.privacyStatus },
          },
        });
        return untrustedResult({
          id: res.data.id,
          title: res.data.snippet?.title,
          privacyStatus: res.data.status?.privacyStatus,
        });
      }),
  );

  server.registerTool(
    'playlist_add_item',
    {
      title: 'Add video to playlist',
      description:
        'Adds a video to one of your playlists (playlistItems.insert). Adding the same video twice creates a duplicate. ' +
        'Costs 50 quota units. ' +
        'Needs the `core` permission group.',
      inputSchema: {
        playlistId: resourceId,
        videoId,
        position: z.number().int().min(0).optional().describe('Zero-based position; default is the end.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const item = await addPlaylistItem(yt('core'), args.playlistId, args.videoId, args.position);
        return untrustedResult({
          id: item.id,
          playlistId: item.snippet?.playlistId,
          videoId: item.snippet?.resourceId?.videoId,
          position: item.snippet?.position,
        });
      }),
  );
}
