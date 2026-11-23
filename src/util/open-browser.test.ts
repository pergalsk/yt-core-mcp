import { afterEach, describe, expect, it, vi } from 'vitest';

const { child, spawn } = vi.hoisted(() => {
  const child = { on: vi.fn(), unref: vi.fn() };
  return { child, spawn: vi.fn(() => child) };
});
vi.mock('node:child_process', () => ({ spawn }));

import { openBrowser } from './open-browser.js';

const URL = 'https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2';
const realPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.clearAllMocks();
});

describe('openBrowser', () => {
  it('refuses non-https URLs', () => {
    expect(() => {
      openBrowser('http://example.com');
    }).toThrow(/non-https/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', URL]],
    ['darwin', 'open', [URL]],
    ['linux', 'xdg-open', [URL]],
  ])('on %s runs %s without a shell', (platform, cmd, args) => {
    setPlatform(platform);
    openBrowser(URL);
    expect(spawn).toHaveBeenCalledWith(cmd, args, { stdio: 'ignore', detached: true, shell: false });
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
  });
});
