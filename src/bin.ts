#!/usr/bin/env node
import { log } from './util/log.js';

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === 'auth') {
    const { runAuthCli } = await import('./cli/auth.js');
    process.exitCode = await runAuthCli(rest);
  } else if (command === undefined) {
    const { runServer } = await import('./server.js');
    await runServer();
  } else {
    log(`Unknown command "${command}". Use "yt-core-mcp auth --help" or run without arguments to start the MCP server.`);
    process.exitCode = 1;
  }
} catch (err) {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
