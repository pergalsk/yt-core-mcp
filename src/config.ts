import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Single place where environment variables are read. */

export const CLIENT_FILE_ENV = 'YT_CORE_MCP_CLIENT_FILE';
export const MEDIA_ROOT_ENV = 'YT_CORE_MCP_MEDIA_ROOT';
export const TIMEZONE_ENV = 'YT_CORE_MCP_TIMEZONE';
export const REGION_ENV = 'YT_CORE_MCP_REGION';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  APPDATA: z.string().optional(),
  [CLIENT_FILE_ENV]: z.string().optional(),
  [MEDIA_ROOT_ENV]: z.string().optional(),
  [TIMEZONE_ENV]: z.string().max(64).refine(isTimeZone, 'must be an IANA time zone').default('Europe/Bratislava'),
  [REGION_ENV]: z.string().regex(/^[A-Za-z]{2}$/, 'must be a 2-letter country code').default('SK'),
});

export interface Config {
  /** Default IANA time zone for live broadcast start times. */
  timezone: string;
  /** Default ISO 3166-1 alpha-2 region for region-based lists. */
  region: string;
  /** Folder allowed for local file access; unset or empty ⇒ disabled. */
  mediaRoot: string | undefined;
  /** Path of the Google OAuth client JSON. */
  clientFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = result.data;
  const base = e.APPDATA ?? join(homedir(), '.config');
  return {
    timezone: e[TIMEZONE_ENV],
    region: e[REGION_ENV],
    mediaRoot: e[MEDIA_ROOT_ENV],
    clientFile: e[CLIENT_FILE_ENV] ?? join(base, 'yt-core-mcp', 'client_secret.json'),
  };
}

/** Version from package.json (one level above both src/ and dist/). */
export const SERVER_VERSION = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))).version;
