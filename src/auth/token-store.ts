import { Entry } from '@napi-rs/keyring';
import { z } from 'zod';

/**
 * Refresh token + granted scopes, stored in the OS credential vault
 * (Windows Credential Manager / macOS Keychain / Secret Service).
 * Access tokens are never persisted; they live only in memory.
 */
const StoredCredentialSchema = z.object({
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
});

export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

/** Minimal secret backend, injectable for tests. */
export interface SecretBackend {
  get(): string | null;
  set(value: string): void;
  delete(): boolean;
}

const SERVICE = 'yt-core-mcp';
const ACCOUNT = 'google-oauth';

export function keyringBackend(): SecretBackend {
  const entry = new Entry(SERVICE, ACCOUNT);
  return {
    get: () => entry.getPassword(),
    set: (value) => {
      entry.setPassword(value);
    },
    delete: () => entry.deletePassword(),
  };
}

export class TokenStore {
  constructor(private readonly backend: SecretBackend = keyringBackend()) {}

  load(): StoredCredential | null {
    const raw = this.backend.get();
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Stored credential is corrupted. Run `yt-core-mcp auth --logout` and log in again.');
    }
    const result = StoredCredentialSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('Stored credential has an invalid format. Run `yt-core-mcp auth --logout` and log in again.');
    }
    return result.data;
  }

  save(credential: StoredCredential): void {
    this.backend.set(JSON.stringify(StoredCredentialSchema.parse(credential)));
  }

  clear(): boolean {
    return this.backend.delete();
  }
}
