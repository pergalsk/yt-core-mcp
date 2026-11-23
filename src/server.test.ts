import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRefreshToken } from './auth/client.js';
import { TokenStore } from './auth/token-store.js';
import { createServer } from './server.js';
import type { YouTubeFactory } from './tools/youtube.js';

vi.mock('./auth/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth/client.js')>()),
  checkRefreshToken: vi.fn(),
}));

function store(value: string | null) {
  return new TokenStore({ get: () => value, set: () => undefined, delete: () => false });
}

async function authStatus(value: string | null): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(store(value), vi.fn<YouTubeFactory>()).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const res = await client.callTool({ name: 'auth_status', arguments: {} });
  const [content] = res.content as [{ text: string }];
  return JSON.parse(content.text) as Record<string, unknown>;
}

const stored = JSON.stringify({ refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/youtube'] });

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
});
