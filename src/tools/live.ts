import type { youtube_v3 } from '@googleapis/youtube';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { openGuardedFile } from '../files/file-guard.js';
import { confirmAction } from './confirm.js';
import { runTool, untrustedResult } from './result.js';
import { addPlaylistItem } from './upload-playlists.js';
import { setThumbnail, updateVideo, type VideoPatch } from './videos.js';
import type { YouTubeFactory } from './youtube.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// Overwrites existing data on YouTube; repeating the same call gives the same result.
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const START_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

const broadcastId = z.string().regex(/^[\w-]{11}$/).describe('Broadcast id (same as its video id, 11 characters).');
const maxResults = z.number().int().min(1).max(50).default(10).describe('Results per page (1-50).');
const pageToken = z.string().max(200).optional().describe('nextPageToken from a previous call.');

const startTime = z
  .string()
  .regex(START_RE)
  .describe('Start, ISO 8601 (e.g. 2026-12-01T19:00). Without Z/offset it is local time in `timezone`.');

// Optional fields: only sent when given, otherwise YouTube's own defaults / current values apply.
const details = {
  description: z.string().max(5000).optional(),
  thumbnailPath: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('Cover image (JPEG/PNG ≤2 MB) inside the media folder (YT_CORE_MCP_MEDIA_ROOT).'),
  categoryId: z.string().regex(/^\d+$/).optional().describe('Numeric category id (see categories_list).'),
  tags: z.array(z.string().min(1).max(500)).max(500).optional().describe('Replaces all tags.'),
  defaultLanguage: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional().describe('Language, e.g. "sk".'),
  madeForKids: z.boolean().optional().describe('Self-declared made for kids.'),
  enableDvr: z.boolean().optional().describe('Viewers can rewind (YouTube default: true).'),
  enableEmbed: z.boolean().optional().describe('Can be embedded on other sites (YouTube default: true).'),
  latencyPreference: z.enum(['normal', 'low', 'ultraLow']).optional().describe('YouTube default: normal.'),
  enableAutoStart: z
    .boolean()
    .optional()
    .describe('YouTube goes live by itself when the stream data arrives (YouTube default: false).'),
  enableAutoStop: z
    .boolean()
    .optional()
    .describe('YouTube ends the broadcast by itself when the stream data stops (YouTube default: true).'),
};

/** Offset of `timeZone` from UTC (ms) at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** Converts an ISO 8601 start (with or without offset) to a UTC ISO string. */
export function toUtcIso(start: string, timeZone: string): string {
  const m = START_RE.exec(start);
  if (!m) throw new Error(`Invalid start time: ${start}`);
  if (m[7]) return new Date(start).toISOString();
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  // Second pass handles a DST change between the wall time and the first guess.
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone)).toISOString();
}

function maskKey(key: string | null | undefined): string | undefined {
  return key ? `****${key.slice(-4)}` : undefined;
}

function studioUrl(id: string): string {
  return `https://studio.youtube.com/video/${id}/livestreaming`;
}

/** Drops undefined values (needed for exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

type Step = 'ok' | 'skipped' | { error: string };

/** Runs one step of a multi-step flow; a failure is recorded instead of thrown. */
async function step(fn: (() => Promise<unknown>) | undefined): Promise<Step> {
  if (!fn) return 'skipped';
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

function stepsResult(id: string, steps: Record<string, Step>, extra: Record<string, unknown> = {}) {
  const failedSteps = Object.keys(steps).filter((k) => typeof steps[k] === 'object');
  return untrustedResult({
    broadcastId: id,
    studioUrl: studioUrl(id),
    ...extra,
    steps,
    failedSteps,
    ...(failedSteps.length > 0 && {
      note: 'Some steps failed (see steps). The broadcast was NOT deleted. Fix it with live_update_broadcast or in YouTube Studio.',
    }),
  });
}

async function getBroadcast(api: youtube_v3.Youtube, id: string): Promise<youtube_v3.Schema$LiveBroadcast> {
  const res = await api.liveBroadcasts.list({ part: ['snippet', 'status', 'contentDetails'], id: [id] });
  const b = res.data.items?.[0];
  if (!b?.snippet || !b.status || !b.contentDetails) throw new Error(`Broadcast ${id} not found or not owned by you.`);
  return b;
}

interface BroadcastPatch {
  title?: string | undefined;
  description?: string | undefined;
  scheduledStartTime?: string | undefined;
  privacyStatus?: 'public' | 'unlisted' | 'private' | undefined;
  madeForKids?: boolean | undefined;
  enableDvr?: boolean | undefined;
  enableEmbed?: boolean | undefined;
  latencyPreference?: 'normal' | 'low' | 'ultraLow' | undefined;
  enableAutoStart?: boolean | undefined;
  enableAutoStop?: boolean | undefined;
}

/**
 * Safe partial update. liveBroadcasts.update resets every omitted field of a sent part,
 * so the patch is merged into the current broadcast and only changed parts are sent.
 */
async function updateBroadcast(
  api: youtube_v3.Youtube,
  current: youtube_v3.Schema$LiveBroadcast,
  patch: BroadcastPatch,
): Promise<youtube_v3.Schema$LiveBroadcast> {
  const s = current.snippet ?? {};
  const st = current.status ?? {};
  const c = current.contentDetails ?? {};
  const body: youtube_v3.Schema$LiveBroadcast = { id: current.id ?? null };
  const part: string[] = [];
  if (patch.title !== undefined || patch.description !== undefined || patch.scheduledStartTime !== undefined) {
    body.snippet = defined({
      title: patch.title ?? s.title,
      description: patch.description ?? s.description,
      scheduledStartTime: patch.scheduledStartTime ?? s.scheduledStartTime,
      scheduledEndTime: s.scheduledEndTime,
    });
    part.push('snippet');
  }
  if (patch.privacyStatus !== undefined || patch.madeForKids !== undefined) {
    body.status = defined({
      privacyStatus: patch.privacyStatus ?? st.privacyStatus,
      selfDeclaredMadeForKids: patch.madeForKids ?? st.selfDeclaredMadeForKids,
    });
    part.push('status');
  }
  const { enableDvr, enableEmbed, latencyPreference, enableAutoStart, enableAutoStop } = patch;
  if ([enableDvr, enableEmbed, latencyPreference, enableAutoStart, enableAutoStop].some((v) => v !== undefined)) {
    // monitorStream is required when contentDetails is sent.
    body.contentDetails = defined({
      enableDvr: enableDvr ?? c.enableDvr,
      enableEmbed: enableEmbed ?? c.enableEmbed,
      latencyPreference: latencyPreference ?? c.latencyPreference,
      enableAutoStart: enableAutoStart ?? c.enableAutoStart,
      enableAutoStop: enableAutoStop ?? c.enableAutoStop,
      closedCaptionsType: c.closedCaptionsType,
      recordFromStart: c.recordFromStart,
      projection: c.projection,
      monitorStream: c.monitorStream
        ? defined({
            enableMonitorStream: c.monitorStream.enableMonitorStream,
            broadcastStreamDelayMs: c.monitorStream.broadcastStreamDelayMs,
          })
        : undefined,
    });
    part.push('contentDetails');
  }
  if (part.length === 0) throw new Error('Nothing to update.');
  return (await api.liveBroadcasts.update({ part, requestBody: body })).data;
}

/** Video-level fields of a broadcast (set via videos.update), or undefined if none given. */
function videoPatch(args: Pick<VideoPatch, 'categoryId' | 'tags' | 'defaultLanguage'>): VideoPatch | undefined {
  const { categoryId, tags, defaultLanguage } = args;
  return [categoryId, tags, defaultLanguage].some((v) => v !== undefined) ? { categoryId, tags, defaultLanguage } : undefined;
}

function summary(b: youtube_v3.Schema$LiveBroadcast) {
  return {
    id: b.id,
    title: b.snippet?.title,
    scheduledStartTime: b.snippet?.scheduledStartTime,
    actualStartTime: b.snippet?.actualStartTime,
    actualEndTime: b.snippet?.actualEndTime,
    privacyStatus: b.status?.privacyStatus,
    lifeCycleStatus: b.status?.lifeCycleStatus,
    boundStreamId: b.contentDetails?.boundStreamId,
  };
}

export function registerLiveTools(server: McpServer, yt: YouTubeFactory): void {
  const timezone = z
    .string()
    .min(1)
    .max(64)
    .default(loadConfig().timezone)
    .describe('IANA time zone for `startTime`.');

  server.registerTool(
    'live_schedule_broadcast',
    {
      title: 'Schedule live broadcast',
      description:
        'Plans (never starts) a live broadcast: liveBroadcasts.insert → bind to an existing stream → thumbnail → ' +
        'category/tags/language (videos.update) → add to playlist. Default privacy is private. Options not given are ' +
        'not sent, so YouTube defaults apply. If a later step fails, the broadcast is kept and the result lists ' +
        'what failed. Costs ~50 quota units plus ~50 per optional step.',
      inputSchema: {
        title: z.string().min(1).max(100),
        startTime,
        timezone,
        privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
        streamId: z
          .string()
          .regex(/^[\w-]{1,64}$/)
          .optional()
          .describe('Existing reusable stream to bind (see live_list_streams). Omit to bind later.'),
        playlistId: z.string().regex(/^[\w-]{1,64}$/).optional().describe('Playlist to add the broadcast to.'),
        ...details,
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const scheduledStartTime = toUtcIso(args.startTime, args.timezone);
        // Check the cover image before creating anything.
        if (args.thumbnailPath) await (await openGuardedFile(args.thumbnailPath, 'thumbnail')).handle.close();

        const contentDetails = defined({
          enableDvr: args.enableDvr,
          enableEmbed: args.enableEmbed,
          latencyPreference: args.latencyPreference,
          enableAutoStart: args.enableAutoStart,
          enableAutoStop: args.enableAutoStop,
        });
        const hasContentDetails = Object.keys(contentDetails).length > 0;
        const created = await api.liveBroadcasts.insert({
          part: ['snippet', 'status', ...(hasContentDetails ? ['contentDetails'] : [])],
          requestBody: {
            snippet: defined({ title: args.title, description: args.description, scheduledStartTime }),
            status: defined({ privacyStatus: args.privacyStatus, selfDeclaredMadeForKids: args.madeForKids }),
            ...(hasContentDetails && { contentDetails }),
          },
        });
        const id = created.data.id;
        if (!id) throw new Error('YouTube did not return a broadcast id.');

        const { streamId, thumbnailPath, playlistId } = args;
        const patch = videoPatch(args);
        const steps: Record<string, Step> = {
          insert: 'ok',
          bind: await step(streamId ? () => api.liveBroadcasts.bind({ id, part: ['id'], streamId }) : undefined),
          thumbnail: await step(thumbnailPath ? () => setThumbnail(api, id, thumbnailPath) : undefined),
          videoDetails: await step(patch ? () => updateVideo(api, id, patch) : undefined),
          playlist: await step(playlistId ? () => addPlaylistItem(api, playlistId, id) : undefined),
        };
        return stepsResult(id, steps, { scheduledStartTime, privacyStatus: created.data.status?.privacyStatus });
      }),
  );

  server.registerTool(
    'live_update_broadcast',
    {
      title: 'Update live broadcast',
      description:
        'Changes a planned broadcast. Only the given fields change; the rest is kept (fetch → merge → update). ' +
        'Privacy is changed with live_publish_broadcast. Costs ~51 quota units plus ~50 per extra step.',
      inputSchema: {
        broadcastId,
        title: z.string().min(1).max(100).optional(),
        startTime: startTime.optional(),
        timezone,
        ...details,
      },
      annotations: OVERWRITE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const id = args.broadcastId;
        const bPatch: BroadcastPatch = {
          title: args.title,
          description: args.description,
          scheduledStartTime: args.startTime ? toUtcIso(args.startTime, args.timezone) : undefined,
          madeForKids: args.madeForKids,
          enableDvr: args.enableDvr,
          enableEmbed: args.enableEmbed,
          latencyPreference: args.latencyPreference,
          enableAutoStart: args.enableAutoStart,
          enableAutoStop: args.enableAutoStop,
        };
        const hasBroadcastPatch = Object.values(bPatch).some((v) => v !== undefined);
        const vPatch = videoPatch(args);
        const { thumbnailPath } = args;
        if (!hasBroadcastPatch && !vPatch && !thumbnailPath) throw new Error('Nothing to update.');

        const steps: Record<string, Step> = {};
        if (hasBroadcastPatch) steps['broadcast'] = await step(async () => updateBroadcast(api, await getBroadcast(api, id), bPatch));
        if (thumbnailPath) steps['thumbnail'] = await step(() => setThumbnail(api, id, thumbnailPath));
        if (vPatch) steps['videoDetails'] = await step(() => updateVideo(api, id, vPatch));
        return stepsResult(id, steps);
      }),
  );

  server.registerTool(
    'live_publish_broadcast',
    {
      title: 'Publish live broadcast',
      description:
        'Changes the privacy of a planned broadcast to public or unlisted (does not start it). Asks the user to ' +
        'confirm first. Unverified API projects may be refused by YouTube; then publish in YouTube Studio. ' +
        'Costs ~51 quota units.',
      inputSchema: { broadcastId, privacyStatus: z.enum(['public', 'unlisted']) },
      annotations: OVERWRITE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const id = args.broadcastId;
        const current = await getBroadcast(api, id);
        await confirmAction(
          server,
          `Make live broadcast "${current.snippet?.title ?? id}" (${id}, start ${current.snippet?.scheduledStartTime ?? '?'}) ` +
            `${args.privacyStatus}? ${args.privacyStatus === 'public' ? 'Anyone can find it' : 'Anyone with the link can see it'}.`,
        );
        let updated: youtube_v3.Schema$LiveBroadcast;
        try {
          updated = await updateBroadcast(api, current, { privacyStatus: args.privacyStatus });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          throw new Error(
            `YouTube refused to change the privacy: ${msg}\nHint: API projects that are not verified by YouTube ` +
              `may not be allowed to make broadcasts public. Publish it in YouTube Studio: ${studioUrl(id)}`,
            { cause: err },
          );
        }
        return untrustedResult(summary(updated));
      }),
  );

  server.registerTool(
    'live_list_broadcasts',
    {
      title: 'List live broadcasts',
      description: 'Lists your live broadcasts by status (liveBroadcasts.list). Costs 1 quota unit.',
      inputSchema: {
        status: z.enum(['upcoming', 'active', 'completed', 'all']).default('upcoming'),
        maxResults,
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').liveBroadcasts.list({
          part: ['snippet', 'status', 'contentDetails'],
          broadcastStatus: args.status,
          maxResults: args.maxResults,
          ...(args.pageToken !== undefined && { pageToken: args.pageToken }),
        });
        return untrustedResult({ nextPageToken: res.data.nextPageToken ?? null, items: (res.data.items ?? []).map(summary) });
      }),
  );

  server.registerTool(
    'live_get_broadcast',
    {
      title: 'Get live broadcast',
      description: 'Gets details and settings of one of your live broadcasts (liveBroadcasts.list). Costs 1 quota unit.',
      inputSchema: { broadcastId },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const b = await getBroadcast(yt('core'), args.broadcastId);
        const c = b.contentDetails;
        return untrustedResult({
          ...summary(b),
          description: b.snippet?.description,
          scheduledEndTime: b.snippet?.scheduledEndTime,
          thumbnailUrl: b.snippet?.thumbnails?.high?.url ?? b.snippet?.thumbnails?.default?.url,
          madeForKids: b.status?.selfDeclaredMadeForKids,
          enableDvr: c?.enableDvr,
          enableEmbed: c?.enableEmbed,
          latencyPreference: c?.latencyPreference,
          enableAutoStart: c?.enableAutoStart,
          enableAutoStop: c?.enableAutoStop,
          studioUrl: studioUrl(args.broadcastId),
        });
      }),
  );

  server.registerTool(
    'live_list_streams',
    {
      title: 'List live streams',
      description:
        'Lists your reusable live streams (ingest settings) to bind to a broadcast (liveStreams.list). ' +
        'Stream keys are masked. Costs 1 quota unit.',
      inputSchema: { maxResults, pageToken },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').liveStreams.list({
          part: ['snippet', 'cdn', 'status', 'contentDetails'],
          mine: true,
          maxResults: args.maxResults,
          ...(args.pageToken !== undefined && { pageToken: args.pageToken }),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((s) => ({
            id: s.id,
            title: s.snippet?.title,
            isReusable: s.contentDetails?.isReusable,
            streamStatus: s.status?.streamStatus,
            healthStatus: s.status?.healthStatus?.status,
            ingestionType: s.cdn?.ingestionType,
            resolution: s.cdn?.resolution,
            frameRate: s.cdn?.frameRate,
            ingestionAddress: s.cdn?.ingestionInfo?.ingestionAddress,
            streamKey: maskKey(s.cdn?.ingestionInfo?.streamName),
          })),
        });
      }),
  );
}
