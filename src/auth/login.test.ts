import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCOPE_GROUPS } from './scopes.js';
import { TokenStore, type StoredCredential } from './token-store.js';

const { receiver, openBrowser, log } = vi.hoisted(() => ({
  receiver: { redirectUri: 'http://127.0.0.1:5555/callback', code: Promise.resolve('the-code'), close: vi.fn() },
  openBrowser: vi.fn(),
  log: vi.fn(),
}));
vi.mock('./client-config.js', () => ({ loadClientConfig: () => ({ clientId: 'id', clientSecret: 'secret' }) }));
vi.mock('./loopback.js', () => ({ startLoopbackReceiver: vi.fn(() => Promise.resolve(receiver)) }));
vi.mock('../util/open-browser.js', () => ({ openBrowser }));
vi.mock('../util/log.js', () => ({ log }));

import { login, logout } from './login.js';

const CORE = SCOPE_GROUPS.core[0];
const ANALYTICS = SCOPE_GROUPS.analytics[0];

function memoryStore(initial: StoredCredential | null) {
  let value = initial === null ? null : JSON.stringify(initial);
  const store = new TokenStore({
    get: () => value,
    set: (v) => {
      value = v;
    },
    delete: () => {
      const had = value !== null;
      value = null;
      return had;
    },
  });
  return { store, saved: () => (value === null ? null : (JSON.parse(value) as StoredCredential)) };
}

function mockGetToken(tokens: { refresh_token?: string; scope?: string }) {
  return vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens, res: null } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('login', () => {
  it('opens Google consent with PKCE + state and stores the granted scopes', async () => {
    const getToken = mockGetToken({ refresh_token: 'r1', scope: CORE });
    const { store, saved } = memoryStore(null);

    expect(await login(['core'], store)).toEqual({ groups: ['core'], missing: [] });

    const authUrl = new URL(String(openBrowser.mock.calls[0]?.[0]));
    expect(authUrl.searchParams.get('scope')).toBe(CORE);
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ code: 'the-code', redirect_uri: receiver.redirectUri }));
    expect(saved()).toEqual({ refreshToken: 'r1', scopes: [CORE] });
    expect(receiver.close).toHaveBeenCalledOnce();
  });

  it('keeps already granted groups and records only scopes the user ticked', async () => {
    mockGetToken({ scope: CORE });
    const { store, saved } = memoryStore({ refreshToken: 'old', scopes: [CORE] });

    expect(await login(['analytics'], store)).toEqual({ groups: ['core'], missing: ['analytics'] });

    const authUrl = new URL(String(openBrowser.mock.calls[0]?.[0]));
    expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual([CORE, ANALYTICS]);
    expect(saved()).toEqual({ refreshToken: 'old', scopes: [CORE] });
  });

  it('fails without a refresh token and still closes the receiver', async () => {
    mockGetToken({ scope: CORE });
    const { store, saved } = memoryStore(null);
    await expect(login(['core'], store)).rejects.toThrow(/did not return a refresh token/);
    expect(saved()).toBeNull();
    expect(receiver.close).toHaveBeenCalledOnce();
  });
});

describe('logout', () => {
  it('returns false when nothing is stored', async () => {
    const revoke = vi.spyOn(OAuth2Client.prototype, 'revokeToken');
    expect(await logout(memoryStore(null).store)).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes the token at Google and removes it locally', async () => {
    const revoke = vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockResolvedValue({} as never);
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: [CORE] });
    expect(await logout(store)).toBe(true);
    expect(revoke).toHaveBeenCalledWith('r1');
    expect(saved()).toBeNull();
  });

  it('removes the token locally even when revoking fails', async () => {
    vi.spyOn(OAuth2Client.prototype, 'revokeToken').mockRejectedValue(new Error('offline'));
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: [CORE] });
    expect(await logout(store)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not revoke/));
    expect(saved()).toBeNull();
  });
});
