import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRefreshToken } from './client.js';

const getAccessToken = vi.fn();
const setCredentials = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    getAccessToken = getAccessToken;
    setCredentials = setCredentials;
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
