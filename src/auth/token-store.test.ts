import { describe, expect, it } from 'vitest';
import { TokenStore, type SecretBackend } from './token-store.js';

function memoryBackend(initial: string | null = null): SecretBackend & { value: string | null } {
  const b = {
    value: initial,
    get: () => b.value,
    set: (v: string) => {
      b.value = v;
    },
    delete: () => {
      const had = b.value !== null;
      b.value = null;
      return had;
    },
  };
  return b;
}

describe('TokenStore', () => {
  it('round-trips a credential', () => {
    const store = new TokenStore(memoryBackend());
    store.save({ refreshToken: 'r', scopes: ['a'] });
    expect(store.load()).toEqual({ refreshToken: 'r', scopes: ['a'] });
  });

  it('returns null when empty', () => {
    expect(new TokenStore(memoryBackend()).load()).toBeNull();
  });

  it('rejects corrupted data without leaking it', () => {
    expect(() => new TokenStore(memoryBackend('secret-garbage')).load()).toThrow(/corrupted/);
    expect(() => new TokenStore(memoryBackend('{"x":1}')).load()).toThrow(/invalid format/);
  });

  it('refuses to save an empty refresh token', () => {
    expect(() => {
      new TokenStore(memoryBackend()).save({ refreshToken: '', scopes: [] });
    }).toThrow();
  });

  it('clears', () => {
    const b = memoryBackend('{"refreshToken":"r","scopes":[]}');
    expect(new TokenStore(b).clear()).toBe(true);
    expect(b.value).toBeNull();
  });
});
