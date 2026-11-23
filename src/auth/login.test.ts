import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login, logout } from './login.js';
import { SCOPE_GROUPS } from './scopes.js';
import { TokenStore, type StoredCredential } from './token-store.js';

const { revokeToken, getToken, generateAuthUrl, receiver, openBrowser } = vi.hoisted(() => ({
  revokeToken: vi.fn(),
  getToken: vi.fn(),
  generateAuthUrl: vi.fn(() => 'https://accounts.google.com/auth'),
  receiver: { redirectUri: 'http://127.0.0.1:5555/callback', code: Promise.resolve('the-code'), close: vi.fn() },
  openBrowser: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    revokeToken = revokeToken;
    getToken = getToken;
    generateAuthUrl = generateAuthUrl;
    generateCodeVerifierAsync = () => Promise.resolve({ codeVerifier: 'verifier', codeChallenge: 'challenge' });
  },
  CodeChallengeMethod: { S256: 'S256' },
}));
vi.mock('./client-config.js', () => ({ loadClientConfig: () => ({ clientId: 'id', clientSecret: 'sec' }) }));
vi.mock('./loopback.js', () => ({ startLoopbackReceiver: () => Promise.resolve(receiver) }));
vi.mock('../util/open-browser.js', () => ({ openBrowser }));
vi.mock('../util/log.js', () => ({ log: vi.fn() }));

function store(value: string | null, deleted = true) {
  return new TokenStore({ get: () => value, set: () => undefined, delete: () => deleted });
}

const stored = JSON.stringify({ refreshToken: 'rt', scopes: [] });

describe('logout', () => {
  beforeEach(() => {
    revokeToken.mockReset();
  });

  it('returns null when no token is stored', async () => {
    await expect(logout(store(null))).resolves.toBeNull();
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('revokes and removes the token', async () => {
    revokeToken.mockResolvedValue({});
    await expect(logout(store(stored))).resolves.toEqual({ revoked: true, removed: true });
    expect(revokeToken).toHaveBeenCalledWith('rt');
  });

  it('reports a failed revoke but still removes the token locally', async () => {
    revokeToken.mockRejectedValue(new Error('network down'));
    await expect(logout(store(stored))).resolves.toEqual({ revoked: false, removed: true });
  });

  it('reports a failed local removal', async () => {
    revokeToken.mockResolvedValue({});
    await expect(logout(store(stored, false))).resolves.toEqual({ revoked: true, removed: false });
  });
});

const CORE = SCOPE_GROUPS.core[0];
const ANALYTICS = SCOPE_GROUPS.analytics[0];

function memoryStore(initial: StoredCredential | null) {
  let value = initial === null ? null : JSON.stringify(initial);
  const s = new TokenStore({
    get: () => value,
    set: (v) => {
      value = v;
    },
    delete: () => false,
  });
  return { store: s, saved: () => (value === null ? null : (JSON.parse(value) as StoredCredential)) };
}

describe('login', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens Google consent with PKCE + state and stores the granted scopes', async () => {
    getToken.mockResolvedValue({ tokens: { refresh_token: 'r1', scope: CORE } });
    const { store: s, saved } = memoryStore(null);

    expect(await login(['core'], s)).toEqual({ groups: ['core'], missing: [] });

    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: 'offline',
        scope: [CORE],
        state: expect.any(String) as unknown,
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
      }),
    );
    expect(openBrowser).toHaveBeenCalledWith('https://accounts.google.com/auth');
    expect(getToken).toHaveBeenCalledWith({ code: 'the-code', codeVerifier: 'verifier', redirect_uri: receiver.redirectUri });
    expect(saved()).toEqual({ refreshToken: 'r1', scopes: [CORE] });
    expect(receiver.close).toHaveBeenCalledOnce();
  });

  it('keeps already granted groups and records only scopes the user ticked', async () => {
    getToken.mockResolvedValue({ tokens: { scope: CORE } });
    const { store: s, saved } = memoryStore({ refreshToken: 'old', scopes: [CORE] });

    expect(await login(['analytics'], s)).toEqual({ groups: ['core'], missing: ['analytics'] });

    expect(generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ scope: [CORE, ANALYTICS] }));
    expect(saved()).toEqual({ refreshToken: 'old', scopes: [CORE] });
  });

  it('fails without a refresh token and still closes the receiver', async () => {
    getToken.mockResolvedValue({ tokens: { scope: CORE } });
    const { store: s, saved } = memoryStore(null);
    await expect(login(['core'], s)).rejects.toThrow(/did not return a refresh token/);
    expect(saved()).toBeNull();
    expect(receiver.close).toHaveBeenCalledOnce();
  });
});
