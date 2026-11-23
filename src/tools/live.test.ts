import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { youtube_v3 } from '@googleapis/youtube';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../auth/token-store.js';
import { MEDIA_ROOT_ENV } from '../files/file-guard.js';
import { createServer } from '../server.js';
import { toUtcIso } from './live.js';
import { UNTRUSTED_NOTICE } from './result.js';
import type { YouTubeFactory } from './youtube.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });
const BID = 'abcdefghijk';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const broadcast: youtube_v3.Schema$LiveBroadcast = {
  id: BID,
  snippet: { title: 'Old', description: 'Keep me', scheduledStartTime: '2026-12-01T18:00:00Z' },
  status: { privacyStatus: 'private', lifeCycleStatus: 'ready', selfDeclaredMadeForKids: false },
  contentDetails: {
    boundStreamId: 's1',
    enableDvr: true,
    enableEmbed: true,
    enableAutoStart: false,
    enableAutoStop: true,
    latencyPreference: 'normal',
    monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0, embedHtml: '<iframe>' },
  },
};

function fakeYouTube() {
  const api = {
    liveBroadcasts: {
      insert: vi.fn((p: { requestBody: youtube_v3.Schema$LiveBroadcast }) =>
        Promise.resolve({ data: { ...p.requestBody, id: BID } }),
      ),
      bind: vi.fn().mockResolvedValue({ data: {} }),
      list: vi.fn().mockResolvedValue({ data: { nextPageToken: 'N', items: [broadcast] } }),
      update: vi.fn((p: { requestBody: unknown }) => Promise.resolve({ data: p.requestBody })),
    },
    liveStreams: {
      list: vi.fn().mockResolvedValue({
        data: {
          items: [
            {
              id: 's1',
              snippet: { title: 'OBS' },
              contentDetails: { isReusable: true },
              status: { streamStatus: 'ready', healthStatus: { status: 'noData' } },
              cdn: {
                ingestionType: 'rtmp',
                resolution: 'variable',
                frameRate: 'variable',
                ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'abcd-efgh-ijkl-mnop' },
              },
            },
          ],
        },
      }),
    },
    videos: {
      list: vi.fn().mockResolvedValue({ data: { items: [{ id: BID, snippet: { title: 'Old', categoryId: '22' }, status: {} }] } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
    thumbnails: { set: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    playlistItems: { insert: vi.fn().mockResolvedValue({ data: { id: 'pi1' } }) },
  };
  const factory = vi.fn<YouTubeFactory>(() => api as unknown as youtube_v3.Youtube);
  return { factory, api };
}

async function connect(yt: YouTubeFactory, elicit?: () => ElicitResult) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(emptyStore, yt).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  await client.connect(clientTransport);
  return client;
}

function parseData(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  const parsed = JSON.parse(content[0]?.text ?? '') as { notice: string; untrustedData: Record<string, unknown> };
  expect(parsed.notice).toBe(UNTRUSTED_NOTICE);
  return parsed.untrustedData;
}

function errorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { text: string }[])[0]?.text ?? '';
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'yt-live-'));
  await writeFile(join(root, 'cover.png'), PNG);
  vi.stubEnv(MEDIA_ROOT_ENV, root);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('toUtcIso', () => {
  it('uses the time zone for local times, incl. summer/winter time', () => {
    expect(toUtcIso('2026-12-01T19:00', 'Europe/Bratislava')).toBe('2026-12-01T18:00:00.000Z');
    expect(toUtcIso('2026-07-01T19:00:30', 'Europe/Bratislava')).toBe('2026-07-01T17:00:30.000Z');
    expect(toUtcIso('2026-12-01T19:00', 'UTC')).toBe('2026-12-01T19:00:00.000Z');
  });

  it('keeps an explicit offset', () => {
    expect(toUtcIso('2026-12-01T19:00+02:00', 'Europe/Bratislava')).toBe('2026-12-01T17:00:00.000Z');
    expect(toUtcIso('2026-12-01T19:00Z', 'Europe/Bratislava')).toBe('2026-12-01T19:00:00.000Z');
  });
});

describe('live tools', () => {
  it('have correct annotations and never expose transition', async () => {
    const { tools } = await (await connect(fakeYouTube().factory)).listTools();
    const ann = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const name of ['live_list_broadcasts', 'live_get_broadcast', 'live_list_streams']) {
      expect(ann(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    expect(ann('live_schedule_broadcast')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    for (const name of ['live_update_broadcast', 'live_publish_broadcast']) {
      expect(ann(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    }
    expect(tools.filter((t) => t.name.startsWith('live_')).map((t) => t.name)).toHaveLength(6);
  });

  it('live_schedule_broadcast runs the full flow with private default', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({
      name: 'live_schedule_broadcast',
      arguments: {
        title: 'Live',
        description: 'Desc',
        startTime: '2026-12-01T19:00',
        streamId: 's1',
        thumbnailPath: 'cover.png',
        categoryId: '10',
        tags: ['a'],
        defaultLanguage: 'sk',
        playlistId: 'PL1',
        enableDvr: false,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(yt.factory).toHaveBeenCalledWith('core');
    expect(yt.api.liveBroadcasts.insert).toHaveBeenCalledWith({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: { title: 'Live', description: 'Desc', scheduledStartTime: '2026-12-01T18:00:00.000Z' },
        status: { privacyStatus: 'private' },
        contentDetails: { enableDvr: false },
      },
    });
    expect(yt.api.liveBroadcasts.bind).toHaveBeenCalledWith({ id: BID, part: ['id'], streamId: 's1' });
    expect(yt.api.thumbnails.set.mock.calls[0]?.[0]).toMatchObject({ videoId: BID, media: { mimeType: 'image/png' } });
    expect(yt.api.videos.update).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: { id: BID, snippet: { title: 'Old', tags: ['a'], categoryId: '10', defaultLanguage: 'sk' } },
    });
    expect(yt.api.playlistItems.insert).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: { snippet: { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: BID } } },
    });
    expect(parseData(result)).toMatchObject({
      broadcastId: BID,
      privacyStatus: 'private',
      steps: { insert: 'ok', bind: 'ok', thumbnail: 'ok', videoDetails: 'ok', playlist: 'ok' },
      failedSteps: [],
    });
  });

  it('live_schedule_broadcast sends only given options and skips missing steps', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'live_schedule_broadcast',
      arguments: { title: 'Live', startTime: '2026-12-01T19:00Z' },
    });
    expect(yt.api.liveBroadcasts.insert).toHaveBeenCalledWith({
      part: ['snippet', 'status'],
      requestBody: { snippet: { title: 'Live', scheduledStartTime: '2026-12-01T19:00:00.000Z' }, status: { privacyStatus: 'private' } },
    });
    expect(parseData(result)).toMatchObject({
      steps: { insert: 'ok', bind: 'skipped', thumbnail: 'skipped', videoDetails: 'skipped', playlist: 'skipped' },
    });
  });

  it('live_schedule_broadcast reports a failed step and keeps the broadcast', async () => {
    const yt = fakeYouTube();
    yt.api.liveBroadcasts.bind.mockRejectedValue(new Error('Stream not found'));
    const result = await (await connect(yt.factory)).callTool({
      name: 'live_schedule_broadcast',
      arguments: { title: 'Live', startTime: '2026-12-01T19:00', streamId: 'bad', playlistId: 'PL1' },
    });
    expect(result.isError).toBeFalsy();
    const data = parseData(result);
    expect(data).toMatchObject({
      broadcastId: BID,
      steps: { bind: { error: 'Stream not found' }, playlist: 'ok' },
      failedSteps: ['bind'],
    });
    expect(data['note']).toMatch(/NOT deleted/);
  });

  it('live_schedule_broadcast checks the thumbnail before creating anything', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'live_schedule_broadcast',
      arguments: { title: 'Live', startTime: '2026-12-01T19:00', thumbnailPath: '../outside.png' },
    });
    expect(result.isError).toBe(true);
    expect(yt.api.liveBroadcasts.insert).not.toHaveBeenCalled();
  });

  it('live_update_broadcast merges into current broadcast', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'live_update_broadcast',
      arguments: { broadcastId: BID, startTime: '2026-12-02T20:00', latencyPreference: 'low' },
    });
    expect(result.isError).toBeFalsy();
    expect(yt.api.liveBroadcasts.update).toHaveBeenCalledWith({
      part: ['snippet', 'contentDetails'],
      requestBody: {
        id: BID,
        snippet: { title: 'Old', description: 'Keep me', scheduledStartTime: '2026-12-02T19:00:00.000Z' },
        contentDetails: {
          enableDvr: true,
          enableEmbed: true,
          latencyPreference: 'low',
          enableAutoStart: false,
          enableAutoStop: true,
          monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0 },
        },
      },
    });
    expect(yt.api.videos.update).not.toHaveBeenCalled();
    expect(parseData(result)).toMatchObject({ steps: { broadcast: 'ok' }, failedSteps: [] });
  });

  it('live_update_broadcast refuses an empty patch', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'live_update_broadcast', arguments: { broadcastId: BID } });
    expect(result.isError).toBe(true);
    expect(yt.api.liveBroadcasts.update).not.toHaveBeenCalled();
  });

  it('live_publish_broadcast changes privacy after confirmation', async () => {
    const yt = fakeYouTube();
    const elicit = vi.fn((): ElicitResult => ({ action: 'accept', content: { confirm: true } }));
    const result = await (await connect(yt.factory, elicit)).callTool({
      name: 'live_publish_broadcast',
      arguments: { broadcastId: BID, privacyStatus: 'public' },
    });
    expect(result.isError).toBeFalsy();
    expect(elicit).toHaveBeenCalledOnce();
    expect(yt.api.liveBroadcasts.update).toHaveBeenCalledWith({
      part: ['status'],
      requestBody: { id: BID, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } },
    });
  });

  it('live_publish_broadcast does nothing without confirmation', async () => {
    const yt = fakeYouTube();
    const declined = await (await connect(yt.factory, () => ({ action: 'decline' }))).callTool({
      name: 'live_publish_broadcast',
      arguments: { broadcastId: BID, privacyStatus: 'public' },
    });
    expect(declined.isError).toBe(true);
    const unsupported = await (await connect(yt.factory)).callTool({
      name: 'live_publish_broadcast',
      arguments: { broadcastId: BID, privacyStatus: 'unlisted' },
    });
    expect(unsupported.isError).toBe(true);
    expect(yt.api.liveBroadcasts.update).not.toHaveBeenCalled();
  });

  it('live_publish_broadcast explains an API refusal with a YouTube Studio hint', async () => {
    const yt = fakeYouTube();
    yt.api.liveBroadcasts.update.mockRejectedValue(new Error('Forbidden'));
    const result = await (await connect(yt.factory, () => ({ action: 'accept', content: { confirm: true } }))).callTool({
      name: 'live_publish_broadcast',
      arguments: { broadcastId: BID, privacyStatus: 'public' },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/Forbidden[\s\S]*YouTube Studio: https:\/\/studio\.youtube\.com\/video\/abcdefghijk/);
  });

  it('live_list_broadcasts filters by status', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'live_list_broadcasts', arguments: {} });
    expect(yt.api.liveBroadcasts.list).toHaveBeenCalledWith({
      part: ['snippet', 'status', 'contentDetails'],
      broadcastStatus: 'upcoming',
      maxResults: 10,
    });
    expect(parseData(result)).toEqual({
      nextPageToken: 'N',
      items: [
        {
          id: BID,
          title: 'Old',
          scheduledStartTime: '2026-12-01T18:00:00Z',
          privacyStatus: 'private',
          lifeCycleStatus: 'ready',
          boundStreamId: 's1',
        },
      ],
    });
  });

  it('live_get_broadcast returns details and settings', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'live_get_broadcast', arguments: { broadcastId: BID } });
    expect(yt.api.liveBroadcasts.list).toHaveBeenCalledWith({ part: ['snippet', 'status', 'contentDetails'], id: [BID] });
    expect(parseData(result)).toMatchObject({ id: BID, description: 'Keep me', enableDvr: true, latencyPreference: 'normal' });

    yt.api.liveBroadcasts.list.mockResolvedValue({ data: { items: [] } });
    const missing = await (await connect(yt.factory)).callTool({ name: 'live_get_broadcast', arguments: { broadcastId: BID } });
    expect(missing.isError).toBe(true);
  });

  it('live_list_streams masks the stream key', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'live_list_streams', arguments: {} });
    expect(yt.api.liveStreams.list).toHaveBeenCalledWith({
      part: ['snippet', 'cdn', 'status', 'contentDetails'],
      mine: true,
      maxResults: 10,
    });
    const text = JSON.stringify(result.content);
    expect(text).not.toContain('abcd-efgh');
    expect(parseData(result)).toMatchObject({ items: [{ id: 's1', isReusable: true, streamKey: '****mnop' }] });
  });
});
