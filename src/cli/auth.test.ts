import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredCredential } from '../auth/token-store.js';
import { SCOPE_GROUPS } from '../auth/scopes.js';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  log: vi.fn(),
  stored: { value: null as StoredCredential | null },
}));
vi.mock('../auth/login.js', () => ({ login: mocks.login, logout: mocks.logout }));
vi.mock('../util/log.js', () => ({ log: mocks.log }));
vi.mock('../auth/token-store.js', () => ({
  TokenStore: class {
    load() {
      return mocks.stored.value;
    }
  },
}));

import { runAuthCli } from './auth.js';

const logged = () => mocks.log.mock.calls.map((c) => String(c[0])).join('\n');

afterEach(() => {
  vi.clearAllMocks();
  mocks.stored.value = null;
});

describe('runAuthCli', () => {
  it('--help prints usage', async () => {
    expect(await runAuthCli(['--help'])).toBe(0);
    expect(logged()).toMatch(/Usage:/);
  });

  it('--status when not logged in', async () => {
    expect(await runAuthCli(['--status'])).toBe(0);
    expect(logged()).toMatch(/Client file: /);
    expect(logged()).toMatch(/Not logged in\./);
  });

  it('--status lists granted groups', async () => {
    mocks.stored.value = { refreshToken: 'r', scopes: [...SCOPE_GROUPS.core, ...SCOPE_GROUPS.analytics] };
    expect(await runAuthCli(['--status'])).toBe(0);
    expect(logged()).toMatch(/Granted groups: core, analytics/);
  });

  it.each([
    [null, 0, /No stored token/],
    [{ revoked: true, removed: true }, 0, /Token revoked at Google\.\nToken removed locally\./],
    [{ revoked: false, removed: true }, 1, /Failed to revoke the token at Google\.\nToken removed locally\./],
    [{ revoked: true, removed: false }, 1, /Failed to remove the local token/],
  ])('--logout (%o)', async (result, code, message) => {
    mocks.logout.mockResolvedValue(result);
    expect(await runAuthCli(['--logout'])).toBe(code);
    expect(logged()).toMatch(message);
  });

  it('logs in with core by default', async () => {
    mocks.login.mockResolvedValue({ groups: ['core'], missing: [] });
    expect(await runAuthCli([])).toBe(0);
    expect(mocks.login).toHaveBeenCalledWith(['core']);
    expect(logged()).toMatch(/Logged in\. Granted groups: core/);
  });

  it('--add requests extra groups and fails when one was not granted', async () => {
    mocks.login.mockResolvedValue({ groups: ['core'], missing: ['analytics'] });
    expect(await runAuthCli(['--add', 'analytics'])).toBe(1);
    expect(mocks.login).toHaveBeenCalledWith(['core', 'analytics']);
    expect(logged()).toMatch(/Not granted .*: analytics/);
  });

  it('--help explains that captions and comments share one scope', async () => {
    await runAuthCli(['--help']);
    expect(logged()).toMatch(/captions and comments groups share one OAuth scope/);
  });

  it.each([
    ['captions', 'comments'],
    ['comments', 'captions'],
  ])('--add %s says that %s is granted too', async (group, other) => {
    mocks.login.mockResolvedValue({ groups: ['core', 'captions', 'comments'], missing: [] });
    expect(await runAuthCli(['--add', group])).toBe(0);
    expect(mocks.login).toHaveBeenCalledWith(['core', group]);
    expect(logged()).toMatch(new RegExp(`"${group}" shares its OAuth scope with ${other}, so ${other} will be granted too`));
    expect(logged()).toMatch(/Granted groups: core, captions, comments/);
  });

  it('--add analytics prints no shared-scope note', async () => {
    mocks.login.mockResolvedValue({ groups: ['core', 'analytics'], missing: [] });
    await runAuthCli(['--add', 'analytics']);
    expect(logged()).not.toMatch(/shares its OAuth scope/);
  });

  it('rejects an unknown group without logging in', async () => {
    expect(await runAuthCli(['--add', 'nope'])).toBe(1);
    expect(mocks.login).not.toHaveBeenCalled();
    expect(logged()).toMatch(/Unknown group "nope"/);
  });

  it('throws on unknown options', async () => {
    await expect(runAuthCli(['--bogus'])).rejects.toThrow();
  });
});
