import { describe, expect, it } from 'vitest';
import { grantedGroups, isScopeGroup, scopesFor } from './scopes.js';

describe('scopes', () => {
  it('core requests only the youtube scope', () => {
    expect(scopesFor(['core'])).toEqual(['https://www.googleapis.com/auth/youtube']);
  });

  it('deduplicates shared scopes', () => {
    expect(scopesFor(['captions', 'comments'])).toHaveLength(1);
  });

  it('derives granted groups from scopes', () => {
    expect(grantedGroups(['https://www.googleapis.com/auth/youtube'])).toEqual(['core']);
    expect(grantedGroups([])).toEqual([]);
  });

  it('validates group names', () => {
    expect(isScopeGroup('analytics')).toBe(true);
    expect(isScopeGroup('toString')).toBe(false);
  });
});
