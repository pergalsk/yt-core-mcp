import { describe, expect, it } from 'vitest';
import { grantedGroups, isScopeGroup, scopesFor, sharedWith } from './scopes.js';

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

  it('treats captions and comments as aliases of one scope', () => {
    expect(sharedWith('captions')).toEqual(['comments']);
    expect(sharedWith('comments')).toEqual(['captions']);
    expect(sharedWith('core')).toEqual([]);
    expect(sharedWith('analytics')).toEqual([]);
    expect(grantedGroups(scopesFor(['captions']))).toEqual(['captions', 'comments']);
    expect(grantedGroups(scopesFor(['comments']))).toEqual(['captions', 'comments']);
  });

  it('validates group names', () => {
    expect(isScopeGroup('analytics')).toBe(true);
    expect(isScopeGroup('toString')).toBe(false);
  });
});
