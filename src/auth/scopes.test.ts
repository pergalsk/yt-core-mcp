import { describe, expect, it } from 'vitest';
import { grantedGroups, resolveGroup, scopesFor } from './scopes.js';

describe('scopes', () => {
  it('core requests only the youtube scope', () => {
    expect(scopesFor(['core'])).toEqual(['https://www.googleapis.com/auth/youtube']);
  });

  it('derives granted groups from scopes', () => {
    expect(grantedGroups(['https://www.googleapis.com/auth/youtube'])).toEqual(['core']);
    expect(grantedGroups([])).toEqual([]);
  });

  it('engagement uses the force-ssl scope, so existing credentials keep working', () => {
    expect(scopesFor(['engagement'])).toEqual(['https://www.googleapis.com/auth/youtube.force-ssl']);
    expect(grantedGroups(['https://www.googleapis.com/auth/youtube.force-ssl'])).toEqual(['engagement']);
  });

  it('resolves group names and the captions/comments aliases', () => {
    expect(resolveGroup('analytics')).toBe('analytics');
    expect(resolveGroup('engagement')).toBe('engagement');
    expect(resolveGroup('captions')).toBe('engagement');
    expect(resolveGroup('comments')).toBe('engagement');
    expect(resolveGroup('toString')).toBeNull();
    expect(resolveGroup('nope')).toBeNull();
  });
});
