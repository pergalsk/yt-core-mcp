import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';

describe('defined', () => {
  it('drops undefined values and keeps the rest', () => {
    expect(defined({ a: 1, b: undefined, c: null, d: '', e: false })).toEqual({ a: 1, c: null, d: '', e: false });
  });

  it('returns an empty object when all values are undefined', () => {
    expect(defined({ a: undefined })).toEqual({});
  });
});
