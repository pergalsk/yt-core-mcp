import { spawn } from 'node:child_process';

/**
 * Open a URL in the default browser without going through a shell
 * (no string interpolation into a command line → no injection).
 * Only https URLs are allowed.
 */
export function openBrowser(url: string): void {
  if (!url.startsWith('https://')) throw new Error('Refusing to open a non-https URL.');
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => {
    /* user can still open the printed URL manually */
  });
  child.unref();
}
