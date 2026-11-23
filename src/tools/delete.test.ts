import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { youtube_v3 } from '@googleapis/youtube';
import { describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../auth/token-store.js';
import { createServer } from '../server.js';
import type { YouTubeFactory } from './youtube.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });

function api(title?: string) {
  return {
    list: vi.fn().mockResolvedValue({
      data: { items: title === undefined ? [] : [{ snippet: { title, channelId: 'UCmine' } }] },
    }),
    delete: vi.fn().mockResolvedValue({ data: '' }),
  };
}

function fakeYouTube(title?: string) {
  const videos = api(title);
  const liveBroadcasts = api(title);
  const playlistItems = api(title);
  const channels = { list: vi.fn().mockResolvedValue({ data: { items: [{ id: 'UCmine' }] } }) };
  const client = { videos, liveBroadcasts, playlistItems, channels } as unknown as youtube_v3.Youtube;
  const factory = vi.fn<YouTubeFactory>(() => client);
  return { factory, videos, liveBroadcasts, playlistItems, channels };
}

/** Connects a test client; pass `elicit` to make the client support elicitation. */
async function connect(yt: YouTubeFactory, elicit?: (message: string) => ElicitResult) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(emptyStore, yt).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, (req) => elicit(req.params.message));
  await client.connect(clientTransport);
  return client;
}

const cases = [
  { tool: 'video_delete', arg: 'videoId', api: 'videos' },
  { tool: 'live_delete_broadcast', arg: 'broadcastId', api: 'liveBroadcasts' },
  { tool: 'playlist_remove_item', arg: 'playlistItemId', api: 'playlistItems' },
] as const;

const accept = (): ElicitResult => ({ action: 'accept', content: { confirm: true } });

describe.each(cases)('$tool', ({ tool, arg, api: apiName }) => {
  const call = { name: tool, arguments: { [arg]: 'abc123' } };

  it('has destructive annotations', async () => {
    const client = await connect(fakeYouTube().factory);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === tool)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('shows the title and deletes after the user confirms', async () => {
    const yt = fakeYouTube('My title');
    const elicit = vi.fn<(message: string) => ElicitResult>(accept);
    const client = await connect(yt.factory, elicit);
    const result = await client.callTool(call);

    expect(yt.factory).toHaveBeenCalledWith('core');
    expect(yt[apiName].list).toHaveBeenCalledWith({ part: ['snippet'], id: ['abc123'] });
    expect(elicit.mock.calls[0]?.[0]).toContain('"My title"');
    expect(yt[apiName].delete).toHaveBeenCalledWith({ id: 'abc123' });
    expect(result.isError).toBeFalsy();
  });

  it.each<ElicitResult>([
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { confirm: false } },
  ])('does nothing when not confirmed (%o)', async (answer) => {
    const yt = fakeYouTube('My title');
    const client = await connect(yt.factory, () => answer);
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    expect(yt[apiName].delete).not.toHaveBeenCalled();
  });

  it('is refused when the client does not support elicitation', async () => {
    const yt = fakeYouTube('My title');
    const client = await connect(yt.factory);
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    const content = result.content as { text: string }[];
    expect(content[0]?.text).toMatch(/does not support elicitation/);
    expect(yt[apiName].delete).not.toHaveBeenCalled();
  });

  it('fails without asking when the item is not found', async () => {
    const yt = fakeYouTube();
    const elicit = vi.fn(accept);
    const client = await connect(yt.factory, elicit);
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    expect(elicit).not.toHaveBeenCalled();
    expect(yt[apiName].delete).not.toHaveBeenCalled();
  });
});

describe('video_delete ownership', () => {
  const call = { name: 'video_delete', arguments: { videoId: 'abc123' } };

  it('checks the video belongs to my channel', async () => {
    const yt = fakeYouTube('My title');
    const client = await connect(yt.factory, accept);
    await client.callTool(call);
    expect(yt.channels.list).toHaveBeenCalledWith({ part: ['id'], mine: true });
  });

  it('refuses a foreign video without asking', async () => {
    const yt = fakeYouTube('Not mine');
    yt.channels.list.mockResolvedValue({ data: { items: [{ id: 'UCother' }] } });
    const elicit = vi.fn(accept);
    const client = await connect(yt.factory, elicit);
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toMatch(/not your video/);
    expect(elicit).not.toHaveBeenCalled();
    expect(yt.videos.delete).not.toHaveBeenCalled();
  });
});
