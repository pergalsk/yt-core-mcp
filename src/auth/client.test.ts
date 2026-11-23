import { describe, expect, it, vi } from 'vitest';
import { SCOPE_GROUPS } from './scopes.js';
import { TokenStore, type StoredCredential } from './token-store.js';

vi.mock('./client-config.js', () => ({ loadClientConfig: () => ({ clientId: 'id', clientSecret: 'secret' }) }));

const { AuthRequiredError, getAuthorizedClient } = await import('./client.js');

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
  it('requires login when nothing is stored', () => {
    const { store } = memoryStore(null);
    expect(() => getAuthorizedClient('core', store)).toThrow(AuthRequiredError);
    expect(() => getAuthorizedClient('core', store)).toThrow(/Not logged in/);
  });

  it('requires the scope group to be granted', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    expect(() => getAuthorizedClient('analytics', store)).toThrow(/auth --add analytics/);
  });

  it('returns a client with the stored refresh token', () => {
    const { store } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    const client = getAuthorizedClient('core', store);
    expect(client.credentials.refresh_token).toBe('r1');
  });

  it('saves a rotated refresh token and keeps the scopes', () => {
    const { store, saved } = memoryStore({ refreshToken: 'r1', scopes: coreScopes });
    const client = getAuthorizedClient('core', store);
    client.emit('tokens', { access_token: 'a' });
    client.emit('tokens', { refresh_token: 'r1' });
    expect(saved()?.refreshToken).toBe('r1');
    client.emit('tokens', { refresh_token: 'r2' });
    expect(saved()).toEqual({ refreshToken: 'r2', scopes: coreScopes });
  });
});
