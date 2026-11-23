import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { youtube_v3 } from '@googleapis/youtube';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../auth/token-store.js';
import { MEDIA_ROOT_ENV } from '../files/file-guard.js';
import { createServer } from '../server.js';
import { UNTRUSTED_NOTICE } from './result.js';
import { addPlaylistItem } from './upload-playlists.js';
import type { YouTubeFactory } from './youtube.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });

// Minimal MP4 header: box size + "ftyp" + brand.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(52)]);

function fakeYouTube() {
  const authRequest = vi.fn(async (opts: { method: string; data: unknown }) => {
    if (opts.method === 'POST') return { headers: new Headers({ location: 'https://upload.example/session1' }), data: '' };
    const chunks: Buffer[] = [];
    if (!(opts.data instanceof Readable)) throw new Error('expected a stream');
    for await (const chunk of opts.data) chunks.push(chunk as Buffer);
    return {
      data: {
        id: 'v1',
        snippet: { title: 'My video', bytes: Buffer.concat(chunks).length },
        status: { uploadStatus: 'uploaded', privacyStatus: 'private' },
      },
    };
  });
  const playlistsList = vi.fn().mockResolvedValue({
    data: {
      nextPageToken: 'NEXT',
      items: [
        {
          id: 'PL1',
          snippet: { title: 'Mix', description: 'd', publishedAt: '2026-01-01T00:00:00Z' },
          status: { privacyStatus: 'public' },
          contentDetails: { itemCount: 3 },
        },
      ],
    },
  });
  const playlistsInsert = vi.fn().mockResolvedValue({
    data: { id: 'PL2', snippet: { title: 'New' }, status: { privacyStatus: 'private' } },
  });
  const playlistItemsInsert = vi.fn().mockResolvedValue({
    data: { id: 'PLI1', snippet: { playlistId: 'PL1', resourceId: { videoId: 'v1' }, position: 0 } },
  });
  const client = {
    context: { _options: { auth: { request: authRequest } } },
    playlists: { list: playlistsList, insert: playlistsInsert },
    playlistItems: { insert: playlistItemsInsert },
  } as unknown as youtube_v3.Youtube;
  const factory = vi.fn<YouTubeFactory>(() => client);
  return { client, factory, authRequest, playlistsList, playlistsInsert, playlistItemsInsert };
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

describe('upload and playlist tools', () => {
  let media: string;

  beforeEach(async () => {
    media = await mkdtemp(join(tmpdir(), 'yt-upload-'));
    process.env[MEDIA_ROOT_ENV] = media;
  });

  afterEach(async () => {
    delete process.env.YT_CORE_MCP_MEDIA_ROOT;
    await rm(media, { recursive: true, force: true });
  });

  it('have correct annotations', async () => {
    const { tools } = await (await connect(fakeYouTube().factory)).listTools();
    const byName = (n: string) => tools.find((t) => t.name === n);
    expect(byName('playlist_list')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ['video_upload', 'playlist_create', 'playlist_add_item']) {
      expect(byName(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
    expect(byName('video_upload')?.description).toMatch(/unverified API projects are locked to private/);
  });

  it('video_upload starts a resumable session and streams the guarded file', async () => {
    await writeFile(join(media, 'clip.mp4'), MP4);
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({ name: 'video_upload', arguments: { file: 'clip.mp4', title: 'My video' } });

    expect(result.isError).toBeFalsy();
    expect(yt.factory).toHaveBeenCalledWith('core');
    expect(yt.authRequest).toHaveBeenNthCalledWith(1, {
      url: 'https://www.googleapis.com/upload/youtube/v3/videos',
      method: 'POST',
      params: { uploadType: 'resumable', part: 'snippet,status' },
      headers: { 'X-Upload-Content-Length': String(MP4.length), 'X-Upload-Content-Type': 'video/mp4' },
      data: { snippet: { title: 'My video' }, status: { privacyStatus: 'private' } },
    });
    expect(yt.authRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://upload.example/session1',
        method: 'PUT',
        headers: { 'Content-Length': String(MP4.length), 'Content-Type': 'video/mp4' },
      }),
    );
    expect(parseText(result)).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: { id: 'v1', title: 'My video', uploadStatus: 'uploaded', privacyStatus: 'private' },
    });
    const uploaded = (await yt.authRequest.mock.results[1]?.value) as { data: { snippet: { bytes: number } } };
    expect(uploaded.data.snippet.bytes).toBe(MP4.length);
  });

  it('video_upload refuses files outside the media folder without calling the API', async () => {
    const yt = fakeYouTube();
    const client = await connect(yt.factory);
    const result = await client.callTool({ name: 'video_upload', arguments: { file: '../secret.mp4', title: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringMatching(/^File refused/) as unknown }]);
    expect(yt.authRequest).not.toHaveBeenCalled();
  });

  it('video_upload refuses non-video files', async () => {
    await writeFile(join(media, 'fake.mp4'), 'not a video');
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'video_upload',
      arguments: { file: 'fake.mp4', title: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(yt.authRequest).not.toHaveBeenCalled();
  });

  it('playlist_list lists my playlists as untrusted data', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'playlist_list', arguments: {} });
    expect(yt.playlistsList).toHaveBeenCalledWith({
      part: ['snippet', 'status', 'contentDetails'],
      mine: true,
      maxResults: 25,
    });
    expect(parseText(result)).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: {
        nextPageToken: 'NEXT',
        items: [
          { id: 'PL1', title: 'Mix', description: 'd', privacyStatus: 'public', itemCount: 3, publishedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    });
  });

  it('playlist_create defaults to private', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({ name: 'playlist_create', arguments: { title: 'New' } });
    expect(yt.playlistsInsert).toHaveBeenCalledWith({
      part: ['snippet', 'status'],
      requestBody: { snippet: { title: 'New' }, status: { privacyStatus: 'private' } },
    });
    expect(parseText(result)).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: { id: 'PL2', title: 'New', privacyStatus: 'private' },
    });
  });

  it('playlist_add_item inserts a playlist item', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'playlist_add_item',
      arguments: { playlistId: 'PL1', videoId: 'v1', position: 0 },
    });
    expect(yt.playlistItemsInsert).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: { snippet: { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: 'v1' }, position: 0 } },
    });
    expect(parseText(result)).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: { id: 'PLI1', playlistId: 'PL1', videoId: 'v1', position: 0 },
    });
  });

  it('addPlaylistItem omits position when not given', async () => {
    const yt = fakeYouTube();
    await addPlaylistItem(yt.client, 'PL1', 'v1');
    expect(yt.playlistItemsInsert).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: { snippet: { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: 'v1' } } },
    });
  });

  it('playlist_add_item rejects invalid ids without calling the API', async () => {
    const yt = fakeYouTube();
    const result = await (await connect(yt.factory)).callTool({
      name: 'playlist_add_item',
      arguments: { playlistId: '../x', videoId: 'v1' },
    });
    expect(result.isError).toBe(true);
    expect(yt.playlistItemsInsert).not.toHaveBeenCalled();
  });
});
