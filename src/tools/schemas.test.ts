import { describe, expect, it } from 'vitest';
import { description, languageCode, maxResults, pageToken, resourceId, tags, title, videoId } from './schemas.js';

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

describe('shared text schemas', () => {
  it('title allows 1-100 characters without < or >', () => {
    expect(title.safeParse('Živé vysielanie').success).toBe(true);
    expect(title.safeParse('').success).toBe(false);
    expect(title.safeParse('a'.repeat(101)).success).toBe(false);
    expect(title.safeParse('a <b>').success).toBe(false);
    expect(title.safeParse('a > b').success).toBe(false);
  });

  it('description counts UTF-8 bytes (Slovak letters take 2 bytes)', () => {
    expect(description.safeParse('a'.repeat(5000)).success).toBe(true);
    expect(description.safeParse('a'.repeat(5001)).success).toBe(false);
    expect(description.safeParse('ľščťžýáíé'.repeat(277) + 'a'.repeat(14)).success).toBe(true); // 4986 + 14 bytes
    expect(description.safeParse('ž'.repeat(2500)).success).toBe(true); // 5000 bytes
    expect(description.safeParse('ž'.repeat(2500) + 'a').success).toBe(false); // 5001 bytes, only 2501 chars
    expect(description.safeParse('1 < 2').success).toBe(false);
  });

  it('tags allow 500 characters in total, incl. commas and quotes', () => {
    expect(tags.safeParse(['a'.repeat(499)]).success).toBe(true);
    expect(tags.safeParse(['a'.repeat(500)]).success).toBe(true);
    expect(tags.safeParse(['a'.repeat(501)]).success).toBe(false);
    expect(tags.safeParse(['a'.repeat(249), 'b'.repeat(250)]).success).toBe(true); // 249 + 1 comma + 250
    expect(tags.safeParse(['a'.repeat(250), 'b'.repeat(250)]).success).toBe(false); // 501
    expect(tags.safeParse(['a b'.repeat(166)]).success).toBe(true); // 498 + 2 quotes
    expect(tags.safeParse(['a b'.repeat(166) + 'c']).success).toBe(false); // 499 + 2 quotes
    expect(tags.safeParse(Array.from({ length: 501 }, () => 'a')).success).toBe(false);
    expect(tags.safeParse(['']).success).toBe(false);
  });

  it('languageCode accepts BCP-47 codes', () => {
    expect(languageCode.safeParse('sk').success).toBe(true);
    expect(languageCode.safeParse('en-US').success).toBe(true);
    expect(languageCode.safeParse('zh-Hant').success).toBe(true);
    expect(languageCode.safeParse('e').success).toBe(false);
    expect(languageCode.safeParse('en-U').success).toBe(false);
    expect(languageCode.safeParse('en_US').success).toBe(false);
  });
});
