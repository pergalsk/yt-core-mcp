import { describe, expect, it } from 'vitest';
import { parseClientConfig } from './client-config.js';

describe('parseClientConfig', () => {
  it('accepts a Desktop app client', () => {
    expect(parseClientConfig('{"installed":{"client_id":"id","client_secret":"sec"}}')).toEqual({
      clientId: 'id',
      clientSecret: 'sec',
    });
  });

  it('rejects a Web client', () => {
    expect(() => parseClientConfig('{"web":{"client_id":"id","client_secret":"sec"}}')).toThrow(/Desktop app/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseClientConfig('nope')).toThrow(/not valid JSON/);
  });
});
