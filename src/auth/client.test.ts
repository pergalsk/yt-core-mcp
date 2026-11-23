import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, checkRefreshToken, getAuthorizedClient } from './client.js';
import { SCOPE_GROUPS } from './scopes.js';
import { TokenStore, type StoredCredential } from './token-store.js';

const getAccessToken = vi.fn();
const setCredentials = vi.fn();
const on = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    getAccessToken = getAccessToken;
    setCredentials = setCredentials;
    on = on;
  },
}));
vi.mock('./client-config.js', () => ({ loadClientConfig: () => ({ clientId: 'id', clientSecret: 'sec' }) }));

describe('checkRefreshToken', () => {
  beforeEach(() => {
    getAccessToken.mockReset();
    setCredentials.mockReset();
  });

  it('returns null when a refresh works', async () => {
    getAccessToken.mockResolvedValue({ token: 'at' });
    await expect(checkRefreshToken('rt')).resolves.toBeNull();
    expect(setCredentials).toHaveBeenCalledWith({ refresh_token: 'rt' });
  });

  it('returns the error message when the refresh fails', async () => {
    getAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(checkRefreshToken('rt')).resolves.toBe('invalid_grant');
  });
});

function memoryStore(initial: StoredCredential | null) {
  let value = initial === null ? null : JSON.stringify(initial);
  const store = new TokenStore({
    get: () => value,
    set: (v) => {
      value = v;
    },
    delete: () => false,
  });
  return { store, saved: () => (value === null ? null : (JSON.parse(value) as StoredCredential)) };
}

const coreScopes = [...SCOPE_GROUPS.core];

describe('getAuthorizedClient', () => {
  beforeEach(() => {
    setCredentials.mockReset();
    on.mockReset();
  });

  it('requires login when nothing is stored', () => {
    const { store } = memoryStore(null);
    expect(() => getAuthorizedClient('core', store)).toThrow(AuthRequiredError);
    expect(() => getAuthorizedClient('core', store)).toThrow(/Not logged in/);
  });

  it('requires the scope group to be granted', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    expect(() => getAuthorizedClient('analytics', store)).toThrow(/auth --add analytics/);
  });

  it('uses the stored refresh token', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    getAuthorizedClient('core', store);
    expect(setCredentials).toHaveBeenCalledWith({ refresh_token: 'r1' });
  });

  it('saves a rotated refresh token and keeps the scopes', () => {
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    getAuthorizedClient('core', store);
    const [event, onTokens] = on.mock.calls[0] as [string, (tokens: { refresh_token?: string }) => void];
    expect(event).toBe('tokens');
    onTokens({});
    onTokens({ refresh_token: 'r1' });
    expect(saved()?.refreshToken).toBe('r1');
    onTokens({ refresh_token: 'r2' });
    expect(saved()).toEqual({ refreshToken: 'r2', scopes: coreScopes });
  });
});
