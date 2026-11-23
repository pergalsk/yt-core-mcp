import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from './open-browser.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.mocked(spawn).mockClear();
});

describe('openBrowser', () => {
  const url = 'https://example.com/?a=1&b=2';

  it.each([
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
  ] as const)('on %s runs %s without a shell', (platform, cmd, args) => {
    setPlatform(platform);
    openBrowser(url);
    expect(spawn).toHaveBeenCalledWith(cmd, args, { stdio: 'ignore', detached: true, shell: false });
  });

  it('refuses non-https URLs', () => {
    expect(() => {
      openBrowser('http://example.com');
    }).toThrow(/non-https/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
