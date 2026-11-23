import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStore } from './auth/token-store.js';
import { MEDIA_ROOT_ENV, REGION_ENV, SERVER_VERSION, TIMEZONE_ENV } from './config.js';
import { createServer } from './server.js';
import type { YouTubeFactory } from './tools/youtube.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(emptyStore, vi.fn<YouTubeFactory>()).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server', () => {
  it('reports the version from package.json', async () => {
    expect((await connect()).getServerVersion()?.version).toBe(SERVER_VERSION);
  });

  it('auth_status shows the resolved config', async () => {
    vi.stubEnv(TIMEZONE_ENV, 'UTC');
    vi.stubEnv(REGION_ENV, 'CZ');
    vi.stubEnv(MEDIA_ROOT_ENV, 'D:\\media');
    const result = await (await connect()).callTool({ name: 'auth_status', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? '')).toMatchObject({
      loggedIn: false,
      config: { timezone: 'UTC', region: 'CZ', mediaRootSet: true },
    });
  });

  it('auth_status reports a missing media folder', async () => {
    vi.stubEnv(MEDIA_ROOT_ENV, '');
    const result = await (await connect()).callTool({ name: 'auth_status', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? '')).toMatchObject({ config: { mediaRootSet: false } });
  });
});
