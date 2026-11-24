import { OAuth2Client } from 'google-auth-library';
import { loadClientConfig } from './client-config.js';
import { grantedGroups, type ScopeGroup } from './scopes.js';
import { TokenStore, type StoredCredential } from './token-store.js';
import { log } from '../util/log.js';

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** One client per process, so the in-memory access token is reused between tool calls. */
let cached: { key: string; client: OAuth2Client } | null = null;

/** Identifies a stored credential; a new login, `auth --add` or a rotated token changes it. */
function credentialKey(stored: StoredCredential): string {
  return JSON.stringify([stored.refreshToken, stored.scopes]);
}

/** Drops the cached client, so the next call builds a new one. */
export function resetAuthorizedClient(): void {
  cached = null;
}

/**
 * Returns an OAuth client authorized for the given scope group.
 * The client is reused while the stored credential stays the same.
 * Access tokens are refreshed in memory by google-auth-library; if Google
 * rotates the refresh token, the new one is written back to the vault.
 */
export function getAuthorizedClient(group: ScopeGroup, store = new TokenStore()): OAuth2Client {
  const stored = store.load();
  if (!stored) {
    cached = null;
    throw new AuthRequiredError('Not logged in. Run `yt-core-mcp auth` in a terminal.');
  }
  if (!grantedGroups(stored.scopes).includes(group)) {
    throw new AuthRequiredError(`Permission "${group}" not granted. Run \`yt-core-mcp auth --add ${group}\` in a terminal.`);
  }

  const key = credentialKey(stored);
  if (cached?.key === key) return cached.client;

  const { clientId, clientSecret } = loadClientConfig();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: stored.refreshToken });
  let current = stored.refreshToken;
  client.on('tokens', (tokens) => {
    if (!tokens.refresh_token || tokens.refresh_token === current) return;
    // Runs inside an event emitter: a throw here could crash the server, so log and go on.
    try {
      const latest = store.load();
      // Logged out or logged in again meanwhile: keep what is in the vault.
      if (!latest || latest.refreshToken !== current) return;
      const rotated = { ...latest, refreshToken: tokens.refresh_token };
      store.save(rotated);
      current = rotated.refreshToken;
      // Same client, new token: keep it cached instead of rebuilding on the next call.
      if (cached?.client === client && cached.key === credentialKey(latest)) {
        cached = { key: credentialKey(rotated), client };
      }
    } catch (err) {
      log(`Could not save the rotated refresh token: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  cached = { key, client };
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
