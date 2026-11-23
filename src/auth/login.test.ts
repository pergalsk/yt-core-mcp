import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logout } from './login.js';
import { TokenStore } from './token-store.js';

const revokeToken = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    revokeToken = revokeToken;
  },
  CodeChallengeMethod: { S256: 'S256' },
}));
vi.mock('./client-config.js', () => ({ loadClientConfig: () => ({ clientId: 'id', clientSecret: 'sec' }) }));

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
