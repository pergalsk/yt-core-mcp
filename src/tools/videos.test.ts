import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { youtube_v3 } from '@googleapis/youtube';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REGION_ENV } from '../config.js';
import { TokenStore } from '../auth/token-store.js';
import { MEDIA_ROOT_ENV } from '../files/file-guard.js';
import { createServer } from '../server.js';
import { UNTRUSTED_NOTICE } from './result.js';
import type { YouTubeFactory } from './youtube.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });
const VID = 'abcdefghijk';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const current: youtube_v3.Schema$Video = {
  id: VID,
  snippet: {
    title: 'Old',
    description: 'Keep me',
    tags: ['a'],
    categoryId: '22',
    defaultLanguage: 'sk',
    channelId: 'c1',
    publishedAt: '2026-01-01T00:00:00Z',
  },
  status: { privacyStatus: 'private', publishAt: '2026-12-01T10:00:00Z', embeddable: true, license: 'youtube', uploadStatus: 'processed' },
  statistics: { viewCount: '5' },
};

function fakeYouTube() {
  const api = {
    videos: {
      list: vi.fn().mockResolvedValue({ data: { items: [current] } }),
      update: vi.fn((p: { requestBody: unknown }) => Promise.resolve({ data: p.requestBody })),
    },
    thumbnails: {
      set: vi.fn(async (p: { media: { body: Readable } }) => {
        const chunks: Buffer[] = [];
        for await (const c of p.media.body) chunks.push(c as Buffer);
        return { data: { items: [{ default: { url: 'u', size: Buffer.concat(chunks).length } }] } };
      }),
    },
    channels: {
      list: vi.fn().mockResolvedValue({
        data: {
          items: [
            {
              id: 'UC1',
              snippet: { title: 'My channel', description: 'd', customUrl: '@me', country: 'SK', publishedAt: 'p' },
              statistics: { subscriberCount: '10', videoCount: '2', viewCount: '99' },
              contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
            },
          ],
        },
      }),
    },
    playlistItems: {
      list: vi.fn().mockResolvedValue({
        data: {
          nextPageToken: 'N',
          items: [{ snippet: { title: 'T', publishedAt: 'p', resourceId: { videoId: VID } }, status: { privacyStatus: 'unlisted' } }],
        },
      }),
    },
    videoCategories: {
      list: vi.fn().mockResolvedValue({ data: { items: [{ id: '22', snippet: { title: 'People & Blogs', assignable: true } }] } }),
    },
  };
  const factory = vi.fn<YouTubeFactory>(() => api as unknown as youtube_v3.Youtube);
  return { factory, api };
}

async function connect(yt: YouTubeFactory) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(emptyStore, yt).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function parseText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '');
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'yt-videos-'));
  await writeFile(join(root, 'cover.png'), PNG);
  await writeFile(join(root, 'fake.png'), 'not an image');
  vi.stubEnv(MEDIA_ROOT_ENV, root);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('video tools', () => {
  it('have correct annotations', async () => {
    const { tools } = await (await connect(fakeYouTube().factory)).listTools();
    const ann = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const name of ['video_get', 'video_list', 'channel_get', 'categories_list']) {
      expect(ann(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    for (const name of ['video_set_thumbnail', 'video_update']) {
      expect(ann(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    }
  });

  it('video_update merges the patch into current snippet and keeps other fields', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({ name: 'video_update', arguments: { videoId: VID, title: 'New' } });

    expect(result.isError).toBeFalsy();
    expect(yt.factory).toHaveBeenCalledWith('core');
    expect(yt.api.videos.list).toHaveBeenCalledWith({ part: ['snippet', 'status'], id: [VID] });
    expect(yt.api.videos.update).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: {
        id: VID,
        snippet: { title: 'New', description: 'Keep me', tags: ['a'], categoryId: '22', defaultLanguage: 'sk' },
      },
    });
  });

  it('video_update keeps status fields and drops publishAt when made public', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    await client.callTool({ name: 'video_update', arguments: { videoId: VID, privacyStatus: 'public' } });

    expect(yt.api.videos.update).toHaveBeenCalledWith({
      part: ['status'],
      requestBody: {
        id: VID,
        status: {
          privacyStatus: 'public',
          publishAt: null,
          embeddable: true,
          license: 'youtube',
        },
      },
    });
  });

  it('video_update refuses empty patch and unknown video', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const empty = await client.callTool({ name: 'video_update', arguments: { videoId: VID } });
    expect(empty.isError).toBe(true);

    yt.api.videos.list.mockResolvedValue({ data: { items: [] } });
    const missing = await client.callTool({ name: 'video_update', arguments: { videoId: VID, title: 'x' } });
    expect(missing.isError).toBe(true);
    expect(yt.api.videos.update).not.toHaveBeenCalled();
  });

  it('video_set_thumbnail uploads the guarded file', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({ name: 'video_set_thumbnail', arguments: { videoId: VID, path: 'cover.png' } });

    expect(result.isError).toBeFalsy();
    const call = yt.api.thumbnails.set.mock.calls[0]?.[0] as unknown as { videoId: string; media: { mimeType: string } };
    expect(call.videoId).toBe(VID);
    expect(call.media.mimeType).toBe('image/png');
    expect(parseText(result)).toEqual({ videoId: VID, thumbnails: [{ default: { url: 'u', size: PNG.length } }] });
  });

  it('video_set_thumbnail refuses files rejected by the file guard', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    for (const path of ['fake.png', '../outside.png']) {
      const result = await client.callTool({ name: 'video_set_thumbnail', arguments: { videoId: VID, path } });
      expect(result.isError).toBe(true);
    }
    expect(yt.api.thumbnails.set).not.toHaveBeenCalled();
  });

  it('video_get returns untrusted video details', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'video_get', arguments: { ids: [VID] } });
    expect(yt.api.videos.list).toHaveBeenCalledWith({ part: ['snippet', 'status', 'statistics', 'contentDetails'], id: [VID] });
    expect(parseText(result)).toMatchObject({
      notice: UNTRUSTED_NOTICE,
      untrustedData: [{ id: VID, title: 'Old', privacyStatus: 'private', viewCount: '5' }],
    });
  });

  it('video_list reads the uploads playlist of my channel', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'video_list', arguments: { maxResults: 5 } });
    expect(yt.api.channels.list).toHaveBeenCalledWith({ part: ['contentDetails'], mine: true });
    expect(yt.api.playlistItems.list).toHaveBeenCalledWith({ part: ['snippet', 'status'], playlistId: 'UU1', maxResults: 5 });
    expect(parseText(result)).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: { nextPageToken: 'N', items: [{ id: VID, title: 'T', publishedAt: 'p', privacyStatus: 'unlisted' }] },
    });
  });

  it('channel_get uses mine=true by default and id when given', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({ name: 'channel_get', arguments: {} });
    expect(yt.api.channels.list).toHaveBeenLastCalledWith({ part: ['snippet', 'statistics', 'contentDetails'], mine: true });
    expect(parseText(result)).toMatchObject({ untrustedData: { id: 'UC1', subscriberCount: '10', uploadsPlaylistId: 'UU1' } });

    const channelId = 'UC' + 'x'.repeat(22);
    await client.callTool({ name: 'channel_get', arguments: { channelId } });
    expect(yt.api.channels.list).toHaveBeenLastCalledWith({ part: ['snippet', 'statistics', 'contentDetails'], id: [channelId] });
  });

  it('categories_list defaults to regionCode SK', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'categories_list', arguments: {} });
    expect(yt.api.videoCategories.list).toHaveBeenCalledWith({ part: ['snippet'], regionCode: 'SK' });
    expect(parseText(result)).toMatchObject({ untrustedData: [{ id: '22', title: 'People & Blogs', assignable: true }] });
  });

  it('categories_list uses the region from YT_CORE_MCP_REGION by default', async () => {
    vi.stubEnv(REGION_ENV, 'US');
    const yt = fakeYouTube();
    await (await connect(yt.factory)).callTool({ name: 'categories_list', arguments: {} });
    expect(yt.api.videoCategories.list).toHaveBeenCalledWith({ part: ['snippet'], regionCode: 'US' });
    vi.stubEnv(REGION_ENV, undefined);
  });
});
