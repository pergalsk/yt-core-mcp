import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, checkRefreshToken, getAuthorizedClient, resetAuthorizedClient } from './client.js';
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
    delete: () => {
      value = null;
      return true;
    },
  });
  return { store, saved: () => (value === null ? null : (JSON.parse(value) as StoredCredential)) };
}

const coreScopes = [...SCOPE_GROUPS.core];

describe('getAuthorizedClient', () => {
  beforeEach(() => {
    resetAuthorizedClient();
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

  it('merges a rotated refresh token into the latest stored credential', () => {
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    getAuthorizedClient('core', store);
    const [, onTokens] = on.mock.calls[0] as [string, (tokens: { refresh_token?: string }) => void];
    const allScopes = [...coreScopes, ...SCOPE_GROUPS.analytics];
    store.save({ refreshToken: 'r1', scopes: allScopes });
    onTokens({ refresh_token: 'r2' });
    expect(saved()).toEqual({ refreshToken: 'r2', scopes: allScopes });
  });

  it('does not bring back a credential after logout', () => {
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    getAuthorizedClient('core', store);
    const [, onTokens] = on.mock.calls[0] as [string, (tokens: { refresh_token?: string }) => void];
    store.clear();
    onTokens({ refresh_token: 'r2' });
    expect(saved()).toBeNull();
  });

  it('logs to stderr and does not throw when saving the rotated token fails', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    getAuthorizedClient('core', store);
    const [, onTokens] = on.mock.calls[0] as [string, (tokens: { refresh_token?: string }) => void];
    vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('keyring locked');
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(console, 'log');
    expect(() => {
      onTokens({ refresh_token: 'r2' });
    }).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('keyring locked'));
    expect(stdout).not.toHaveBeenCalled();
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('reuses one client while the stored credential stays the same', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: [...coreScopes, ...SCOPE_GROUPS.analytics] });
    const first = getAuthorizedClient('core', store);
    expect(getAuthorizedClient('core', store)).toBe(first);
    expect(getAuthorizedClient('analytics', store)).toBe(first);
    expect(setCredentials).toHaveBeenCalledTimes(1);
  });

  it('keeps the client after it saved a rotated refresh token', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    const first = getAuthorizedClient('core', store);
    const [, onTokens] = on.mock.calls[0] as [string, (tokens: { refresh_token?: string }) => void];
    onTokens({ refresh_token: 'r2' });
    expect(getAuthorizedClient('core', store)).toBe(first);
  });

  it('builds a new client after `auth --add` changes the scopes', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    const first = getAuthorizedClient('core', store);
    expect(() => getAuthorizedClient('analytics', store)).toThrow(/auth --add analytics/);
    store.save({ refreshToken: 'r1', scopes: [...coreScopes, ...SCOPE_GROUPS.analytics] });
    const second = getAuthorizedClient('analytics', store);
    expect(second).not.toBe(first);
    expect(getAuthorizedClient('core', store)).toBe(second);
  });

  it('builds a new client after logout and a new login', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    const first = getAuthorizedClient('core', store);
    store.clear();
    expect(() => getAuthorizedClient('core', store)).toThrow(/Not logged in/);
    store.save({ refreshToken: 'r9', scopes: coreScopes });
    expect(getAuthorizedClient('core', store)).not.toBe(first);
    expect(setCredentials).toHaveBeenLastCalledWith({ refresh_token: 'r9' });
  });
});
