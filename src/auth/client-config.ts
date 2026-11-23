import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CLIENT_FILE_ENV, loadConfig } from '../config.js';

export { CLIENT_FILE_ENV };

/**
 * Google OAuth client of type "Desktop app" (JSON downloaded from Google Cloud Console).
 * For installed apps Google treats the client secret as non-confidential;
 * security comes from PKCE + state + loopback redirect, not from the secret.
 */
const InstalledClientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
});

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

export function clientFilePath(): string {
  return loadConfig().clientFile;
}

export function parseClientConfig(json: string): ClientConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('OAuth client file is not valid JSON.');
  }
  const result = InstalledClientSchema.safeParse(data);
  if (!result.success) {
    throw new Error('OAuth client file must be a "Desktop app" client (top-level "installed" key).');
  }
  return { clientId: result.data.installed.client_id, clientSecret: result.data.installed.client_secret };
}

export function loadClientConfig(path = clientFilePath()): ClientConfig {
  let json: string;
  try {
    json = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`OAuth client file not found: ${path} (set ${CLIENT_FILE_ENV} to override).`);
  }
  return parseClientConfig(json);
}
