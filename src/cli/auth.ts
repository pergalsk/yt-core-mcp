import { parseArgs } from 'node:util';
import { login, logout } from '../auth/login.js';
import { ALL_GROUPS, grantedGroups, isScopeGroup, type ScopeGroup } from '../auth/scopes.js';
import { TokenStore } from '../auth/token-store.js';
import { clientFilePath } from '../auth/client-config.js';
import { log } from '../util/log.js';

const USAGE = `Usage:
  yt-core-mcp auth                 Log in (core YouTube permission)
  yt-core-mcp auth --add <group>   Add a permission group (${ALL_GROUPS.join(', ')})
  yt-core-mcp auth --status        Show login status
  yt-core-mcp auth --logout        Revoke and remove the stored token`;

export async function runAuthCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      add: { type: 'string', multiple: true },
      status: { type: 'boolean' },
      logout: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    log(USAGE);
    return 0;
  }

  if (values.status) {
    const stored = new TokenStore().load();
    log(`Client file: ${clientFilePath()}`);
    log(stored ? `Logged in. Granted groups: ${grantedGroups(stored.scopes).join(', ') || '(none)'}` : 'Not logged in.');
    return 0;
  }

  if (values.logout) {
    log((await logout()) ? 'Logged out (token revoked and removed).' : 'No stored token.');
    return 0;
  }

  const requested: ScopeGroup[] = ['core'];
  for (const g of values.add ?? []) {
    if (!isScopeGroup(g)) {
      log(`Unknown group "${g}".\n${USAGE}`);
      return 1;
    }
    requested.push(g);
  }

  const { groups, missing } = await login(requested);
  log(`Logged in. Granted groups: ${groups.join(', ') || '(none)'}`);
  if (missing.length > 0) {
    log(`Not granted (unticked on the consent screen): ${missing.join(', ')}`);
    return 1;
  }
  return 0;
}
