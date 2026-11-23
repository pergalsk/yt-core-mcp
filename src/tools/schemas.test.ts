import { describe, expect, it } from 'vitest';
import { maxResults, pageToken, resourceId, videoId } from './schemas.js';

describe('shared schemas', () => {
  it('videoId accepts only 11-character ids', () => {
    expect(videoId.safeParse('dQw4w9WgXcQ').success).toBe(true);
    expect(videoId.safeParse('abc123').success).toBe(false);
    expect(videoId.safeParse('dQw4w9WgXcQx').success).toBe(false);
    expect(videoId.safeParse('../w9WgXcQx').success).toBe(false);
  });

  it('resourceId accepts 1-64 id characters', () => {
    expect(resourceId.safeParse('PL1_a-b').success).toBe(true);
    expect(resourceId.safeParse('').success).toBe(false);
    expect(resourceId.safeParse('../x').success).toBe(false);
    expect(resourceId.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('maxResults defaults to 10 and allows 1-50', () => {
    expect(maxResults.parse(undefined)).toBe(10);
    expect(maxResults.safeParse(50).success).toBe(true);
    expect(maxResults.safeParse(51).success).toBe(false);
  });

  it('pageToken is optional', () => {
    expect(pageToken.parse(undefined)).toBeUndefined();
    expect(pageToken.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
