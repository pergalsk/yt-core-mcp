import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { loadClientConfig } from './client-config.js';
import { startLoopbackReceiver } from './loopback.js';
import { grantedGroups, scopesFor, type ScopeGroup } from './scopes.js';
import { TokenStore } from './token-store.js';
import { openBrowser } from '../util/open-browser.js';
import { log } from '../util/log.js';

export interface LoginResult {
  groups: ScopeGroup[];
  missing: ScopeGroup[];
}

/**
 * Interactive OAuth 2.0 login for installed apps (Google "loopback IP" flow):
 * authorization code + PKCE (S256) + random state, incremental authorization.
 * Only runs from the CLI — never exposed as an MCP tool.
 */
export async function login(requested: ScopeGroup[], store = new TokenStore()): Promise<LoginResult> {
  const existing = store.load();
  const wanted = [...new Set<ScopeGroup>([...(existing ? grantedGroups(existing.scopes) : []), ...requested])];
  const scopes = scopesFor(wanted);

  const { clientId, clientSecret } = loadClientConfig();
  const state = randomBytes(32).toString('base64url');
  const receiver = await startLoopbackReceiver(state);
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri: receiver.redirectUri });

  try {
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeChallenge) throw new Error('Failed to generate PKCE challenge.');
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    log(`Opening browser for Google login. If it does not open, visit:\n${authUrl}\n`);
    openBrowser(authUrl);

    const code = await receiver.code;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: receiver.redirectUri });

    const refreshToken = tokens.refresh_token ?? existing?.refreshToken;
    if (!refreshToken) throw new Error('Google did not return a refresh token.');

    // With granular consent the user may untick some scopes — record only what was granted.
    const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
    store.save({ refreshToken, scopes: granted });

    const groups = grantedGroups(granted);
    return { groups, missing: wanted.filter((g) => !groups.includes(g)) };
  } finally {
    receiver.close();
  }
}

/** Revoke the refresh token at Google (official recommendation) and remove it locally. */
export async function logout(store = new TokenStore()): Promise<boolean> {
  const existing = store.load();
  if (!existing) return false;
  try {
    const { clientId, clientSecret } = loadClientConfig();
    await new OAuth2Client({ clientId, clientSecret }).revokeToken(existing.refreshToken);
  } catch {
    log('Warning: could not revoke the token at Google; removing it locally anyway.');
  }
  return store.clear();
}
