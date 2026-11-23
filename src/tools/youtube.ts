import { youtube, type youtube_v3 } from '@googleapis/youtube';
import { getAuthorizedClient } from '../auth/client.js';
import type { ScopeGroup } from '../auth/scopes.js';
import { TokenStore } from '../auth/token-store.js';

/** Returns a YouTube Data API client authorized for a scope group. Injected into tools, so tests can pass a fake. */
export type YouTubeFactory = (group: ScopeGroup) => youtube_v3.Youtube;

export function youtubeFactory(store = new TokenStore()): YouTubeFactory {
  return (group) => youtube({ version: 'v3', auth: getAuthorizedClient(group, store) });
}
