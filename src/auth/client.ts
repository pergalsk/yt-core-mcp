import { OAuth2Client } from 'google-auth-library';
import { loadClientConfig } from './client-config.js';
import { grantedGroups, type ScopeGroup } from './scopes.js';
import { TokenStore } from './token-store.js';

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Returns an OAuth client authorized for the given scope group.
 * Access tokens are refreshed in memory by google-auth-library; if Google
 * rotates the refresh token, the new one is written back to the vault.
 */
export function getAuthorizedClient(group: ScopeGroup, store = new TokenStore()): OAuth2Client {
  const stored = store.load();
  if (!stored) {
    throw new AuthRequiredError('Not logged in. Run `yt-core-mcp auth` in a terminal.');
  }
  if (!grantedGroups(stored.scopes).includes(group)) {
    throw new AuthRequiredError(`Permission "${group}" not granted. Run \`yt-core-mcp auth --add ${group}\` in a terminal.`);
  }

  const { clientId, clientSecret } = loadClientConfig();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: stored.refreshToken });
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
      store.save({ refreshToken: tokens.refresh_token, scopes: stored.scopes });
    }
  });
  return client;
}

/**
 * Tries to get an access token with the stored refresh token.
 * Returns null if it works, otherwise the error message (e.g. `invalid_grant` for an expired or revoked token).
 */
export async function checkRefreshToken(refreshToken: string): Promise<string | null> {
  try {
    const { clientId, clientSecret } = loadClientConfig();
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    await client.getAccessToken();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
}
