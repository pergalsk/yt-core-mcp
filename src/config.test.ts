import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, SERVER_VERSION } from './config.js';

describe('loadConfig', () => {
  it('keeps the current defaults when nothing is set', () => {
    const config = loadConfig({ APPDATA: 'C:\\AppData' });
    expect(config).toEqual({
      timezone: 'Europe/Bratislava',
      region: 'SK',
      mediaRoot: undefined,
      clientFile: join('C:\\AppData', 'yt-core-mcp', 'client_secret.json'),
    });
  });

  it('reads overrides from env', () => {
    expect(
      loadConfig({
        YT_CORE_MCP_TIMEZONE: 'America/New_York',
        YT_CORE_MCP_REGION: 'US',
        YT_CORE_MCP_MEDIA_ROOT: 'D:\\media',
        YT_CORE_MCP_CLIENT_FILE: 'D:\\client.json',
      }),
    ).toEqual({ timezone: 'America/New_York', region: 'US', mediaRoot: 'D:\\media', clientFile: 'D:\\client.json' });
  });

  it('rejects an invalid time zone or region', () => {
    expect(() => loadConfig({ YT_CORE_MCP_TIMEZONE: 'Mars/Base' })).toThrow(/YT_CORE_MCP_TIMEZONE/);
    expect(() => loadConfig({ YT_CORE_MCP_REGION: 'USA' })).toThrow(/YT_CORE_MCP_REGION/);
  });
});

describe('SERVER_VERSION', () => {
  it('comes from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
