/**
 * OAuth scopes grouped by feature. Only `core` is requested by default;
 * other groups are added later with incremental authorization
 * (`yt-core-mcp auth --add <group>`), following Google's least-privilege guidance.
 */
export const SCOPE_GROUPS = {
  // Live broadcasts, streams, thumbnails, video metadata, playlists, uploads.
  core: ['https://www.googleapis.com/auth/youtube'],
  // Captions and comments require the force-ssl scope.
  captions: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  comments: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  analytics: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
} as const satisfies Record<string, readonly string[]>;

export type ScopeGroup = keyof typeof SCOPE_GROUPS;

export const ALL_GROUPS = Object.keys(SCOPE_GROUPS) as ScopeGroup[];

export function isScopeGroup(value: string): value is ScopeGroup {
  return Object.hasOwn(SCOPE_GROUPS, value);
}

export function scopesFor(groups: readonly ScopeGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => SCOPE_GROUPS[g]))];
}

export function grantedGroups(grantedScopes: readonly string[]): ScopeGroup[] {
  const granted = new Set(grantedScopes);
  return ALL_GROUPS.filter((g) => SCOPE_GROUPS[g].every((s) => granted.has(s)));
}
