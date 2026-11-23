import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { SCOPE_GROUPS } from './auth/scopes.js';
import { TokenStore, type SecretBackend } from './auth/token-store.js';
import { createServer } from './server.js';
import type { YouTubeFactory } from './tools/youtube.js';

async function connect(get: SecretBackend['get']) {
  const store = new TokenStore({ get, set: () => undefined, delete: () => false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(store, vi.fn<YouTubeFactory>()).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function authStatus(get: SecretBackend['get']): Promise<unknown> {
  const result = await (await connect(get)).callTool({ name: 'auth_status', arguments: {} });
  const content = result.content as { text: string }[];
  return JSON.parse(content[0]?.text ?? '');
}

describe('createServer', () => {
  it('registers all tools', async () => {
    const { tools } = await (await connect(() => null)).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'analytics_daily',
      'analytics_demographics',
      'analytics_geography',
      'analytics_overview',
      'analytics_retention',
      'analytics_top_videos',
      'analytics_traffic_sources',
      'analytics_video',
      'auth_status',
      'caption_list',
      'caption_upload',
      'categories_list',
      'channel_get',
      'comment_list',
      'comment_reply',
      'live_delete_broadcast',
      'live_get_broadcast',
      'live_list_broadcasts',
      'live_list_streams',
      'live_publish_broadcast',
      'live_schedule_broadcast',
      'live_update_broadcast',
      'playlist_add_item',
      'playlist_create',
      'playlist_list',
      'playlist_remove_item',
      'search_public',
      'video_delete',
      'video_get',
      'video_list',
      'video_set_thumbnail',
      'video_update',
      'video_upload',
      'videos_trending',
    ]);
  });

  it('auth_status when not logged in', async () => {
    expect(await authStatus(() => null)).toEqual({
      loggedIn: false,
      grantedGroups: [],
      notGranted: ['core', 'captions', 'comments', 'analytics'],
    });
  });

  it('auth_status lists granted and missing groups', async () => {
    const stored = JSON.stringify({ refreshToken: 'r', scopes: [...SCOPE_GROUPS.core, ...SCOPE_GROUPS.captions] });
    expect(await authStatus(() => stored)).toEqual({
      loggedIn: true,
      grantedGroups: ['core', 'captions', 'comments'],
      notGranted: ['analytics'],
    });
  });

  it('auth_status reports a broken stored credential', async () => {
    expect(await authStatus(() => 'not json')).toEqual({ loggedIn: false, error: expect.stringMatching(/corrupted/) as unknown });
  });
});
