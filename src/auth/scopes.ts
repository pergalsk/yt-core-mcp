/**
 * OAuth scopes grouped by feature. Only `core` is requested by default;
 * other groups are added later with incremental authorization
 * (`yt-core-mcp auth --add <group>`), following Google's least-privilege guidance.
 */
export const SCOPE_GROUPS = {
  // Live broadcasts, streams, thumbnails, video metadata, playlists, uploads.
  core: ['https://www.googleapis.com/auth/youtube'],
  // Captions and comments both require the force-ssl scope.
  engagement: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  analytics: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
} as const satisfies Record<string, readonly string[]>;

export type ScopeGroup = keyof typeof SCOPE_GROUPS;

export const ALL_GROUPS = Object.keys(SCOPE_GROUPS) as ScopeGroup[];

/** Older group names still accepted by `auth --add`. */
const GROUP_ALIASES: Record<string, ScopeGroup> = { captions: 'engagement', comments: 'engagement' };

/** Resolves a group name or alias to a scope group, or null if unknown. */
export function resolveGroup(name: string): ScopeGroup | null {
  if (Object.hasOwn(SCOPE_GROUPS, name)) return name as ScopeGroup;
  return Object.hasOwn(GROUP_ALIASES, name) ? (GROUP_ALIASES[name] ?? null) : null;
}

export function scopesFor(groups: readonly ScopeGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => SCOPE_GROUPS[g]))];
}

export function grantedGroups(grantedScopes: readonly string[]): ScopeGroup[] {
  const granted = new Set(grantedScopes);
  return ALL_GROUPS.filter((g) => SCOPE_GROUPS[g].every((s) => granted.has(s)));
}
