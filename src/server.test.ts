import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRefreshToken } from './auth/client.js';
import { SCOPE_GROUPS } from './auth/scopes.js';
import { TokenStore } from './auth/token-store.js';
import { MEDIA_ROOT_ENV, REGION_ENV, SERVER_VERSION, TIMEZONE_ENV } from './config.js';
import { createServer } from './server.js';
import type { YouTubeFactory } from './tools/youtube.js';

vi.mock('./auth/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth/client.js')>()),
  checkRefreshToken: vi.fn(),
}));

function store(value: string | null) {
  return new TokenStore({ get: () => value, set: () => undefined, delete: () => false });
}

async function connect(value: string | null = null) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(store(value), vi.fn<YouTubeFactory>()).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function authStatus(value: string | null): Promise<Record<string, unknown>> {
  const res = await (await connect(value)).callTool({ name: 'auth_status', arguments: {} });
  const [content] = res.content as [{ text: string }];
  return JSON.parse(content.text) as Record<string, unknown>;
}

const stored = JSON.stringify({ refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/youtube'] });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server', () => {
  it('reports the version from package.json', async () => {
    expect((await connect()).getServerVersion()?.version).toBe(SERVER_VERSION);
  });

  it('registers all tools', async () => {
    const { tools } = await (await connect()).listTools();
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
});

describe('tool descriptions', () => {
  async function descriptions(): Promise<Map<string, string>> {
    const { tools } = await (await connect()).listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? '']));
  }

  it('name the permission group and quota cost of every tool', async () => {
    for (const [name, text] of await descriptions()) {
      if (name === 'auth_status') continue;
      expect(text, name).toMatch(/Needs the `(core|captions|comments|analytics)` permission group/);
      expect(text, name).toMatch(/quota/i);
    }
  });

  it('say that captions and comments share one OAuth scope', async () => {
    const d = await descriptions();
    for (const name of ['comment_list', 'comment_reply']) {
      expect(d.get(name)).toContain('Needs the `comments` permission group (shares its OAuth scope with `captions`)');
    }
    for (const name of ['caption_list', 'caption_upload']) {
      expect(d.get(name)).toContain('Needs the `captions` permission group (shares its OAuth scope with `comments`)');
    }
  });

  it('explain analytics dates, time zone and data lag', async () => {
    for (const [name, text] of await descriptions()) {
      if (!name.startsWith('analytics_')) continue;
      expect(text, name).toMatch(/YYYY-MM-DD/);
      expect(text, name).toMatch(/US Pacific time/);
      expect(text, name).toMatch(/lags 2-3 days/);
    }
    expect((await descriptions()).get('analytics_top_videos')).toMatch(/video ids only.*video_get/);
  });

  it('warn about public videos, paged broadcasts and exact live quota', async () => {
    const d = await descriptions();
    expect(d.get('video_update')).toMatch(/privacyStatus public makes the video visible to everyone/);
    expect(d.get('live_list_broadcasts')).toMatch(/paged.*does not guarantee their order/);
    expect(d.get('live_schedule_broadcast')).toMatch(/51 for category\/tags\/language/);
    expect(d.get('live_update_broadcast')).toMatch(/51 for category\/tags\/language/);
    expect([...d.values()].join(' ')).not.toMatch(/~50 per/);
  });

  it('warn that ultraLow latency may be refused with DVR or captions', async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ['live_schedule_broadcast', 'live_update_broadcast']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema.properties?.latencyPreference as { description?: string };
      expect(schema.description, name).toMatch(/refuse ultraLow together with DVR or captions/);
    }
  });
});

describe('auth_status', () => {
  beforeEach(() => {
    vi.mocked(checkRefreshToken).mockReset();
  });

  it('does not check a token when not logged in', async () => {
    const status = await authStatus(null);
    expect(status.loggedIn).toBe(false);
    expect(status).not.toHaveProperty('tokenValid');
    expect(checkRefreshToken).not.toHaveBeenCalled();
  });

  it('lists granted and missing groups', async () => {
    vi.mocked(checkRefreshToken).mockResolvedValue(null);
    const value = JSON.stringify({ refreshToken: 'rt', scopes: [...SCOPE_GROUPS.core, ...SCOPE_GROUPS.captions] });
    expect(await authStatus(value)).toMatchObject({
      grantedGroups: ['core', 'captions', 'comments'],
      notGranted: ['analytics'],
    });
  });

  it('reports a broken stored credential', async () => {
    expect(await authStatus('not json')).toMatchObject({ loggedIn: false, error: expect.stringMatching(/corrupted/) as unknown });
    expect(checkRefreshToken).not.toHaveBeenCalled();
  });

  it('reports a working token', async () => {
    vi.mocked(checkRefreshToken).mockResolvedValue(null);
    const status = await authStatus(stored);
    expect(status).toMatchObject({ loggedIn: true, tokenValid: true });
    expect(status).not.toHaveProperty('tokenError');
    expect(checkRefreshToken).toHaveBeenCalledWith('rt');
  });

  it('reports a token that no longer works', async () => {
    vi.mocked(checkRefreshToken).mockResolvedValue('invalid_grant');
    const status = await authStatus(stored);
    expect(status).toMatchObject({ loggedIn: true, tokenValid: false });
    expect(status.tokenError).toContain('invalid_grant');
  });

  it('shows the resolved config', async () => {
    vi.stubEnv(TIMEZONE_ENV, 'UTC');
    vi.stubEnv(REGION_ENV, 'CZ');
    vi.stubEnv(MEDIA_ROOT_ENV, 'D:\\media');
    expect(await authStatus(null)).toMatchObject({
      loggedIn: false,
      config: { timezone: 'UTC', region: 'CZ', mediaRootSet: true },
    });
  });

  it('reports a missing media folder', async () => {
    vi.stubEnv(MEDIA_ROOT_ENV, '');
    expect(await authStatus(null)).toMatchObject({ config: { mediaRootSet: false } });
  });

  it('returns a tool error for an invalid config', async () => {
    const client = await connect();
    vi.stubEnv(REGION_ENV, 'nope');
    const res = await client.callTool({ name: 'auth_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: expect.stringMatching(/Invalid environment/) as unknown }]);
  });
});
