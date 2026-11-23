import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runAuthCli: vi.fn(), runServer: vi.fn(), log: vi.fn() }));
vi.mock('./cli/auth.js', () => ({ runAuthCli: mocks.runAuthCli }));
vi.mock('./server.js', () => ({ runServer: mocks.runServer }));
vi.mock('./util/log.js', () => ({ log: mocks.log }));

const realArgv = process.argv;

/** Runs bin.ts as if started with the given CLI arguments. */
async function run(...args: string[]) {
  process.argv = ['node', 'bin.js', ...args];
  vi.resetModules();
  await import('./bin.js');
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = realArgv;
  process.exitCode = undefined;
  vi.clearAllMocks();
});

describe('bin', () => {
  it('starts the MCP server without arguments', async () => {
    await run();
    expect(mocks.runServer).toHaveBeenCalledOnce();
    expect(mocks.runAuthCli).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('passes the rest of the arguments to the auth CLI and uses its exit code', async () => {
    mocks.runAuthCli.mockResolvedValue(1);
    await run('auth', '--add', 'analytics');
    expect(mocks.runAuthCli).toHaveBeenCalledWith(['--add', 'analytics']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown command', async () => {
    await run('bogus');
    expect(mocks.log).toHaveBeenCalledWith(expect.stringMatching(/Unknown command "bogus"/));
    expect(process.exitCode).toBe(1);
  });

  it('prints errors and sets exit code 1', async () => {
    mocks.runServer.mockRejectedValue(new Error('boom'));
    await run();
    expect(mocks.log).toHaveBeenCalledWith('boom');
    expect(process.exitCode).toBe(1);
  });
});
