import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * One-shot loopback receiver for the OAuth redirect (RFC 8252 / Google "loopback IP address" flow).
 * - binds to 127.0.0.1 only (never all interfaces), on a random free port
 * - accepts a single GET carrying either `code`+`state` or `error`
 * - verifies `state` in constant time (CSRF protection)
 * - never reflects request data into the HTML response
 */
export interface LoopbackReceiver {
  redirectUri: string;
  /** Resolves with the authorization code; rejects on error, state mismatch or timeout. */
  code: Promise<string>;
  close(): void;
}

const PAGE_OK = '<!doctype html><meta charset="utf-8"><title>yt-core-mcp</title><p>Login successful. You can close this tab.</p>';
const PAGE_FAIL = '<!doctype html><meta charset="utf-8"><title>yt-core-mcp</title><p>Login failed. Check the terminal.</p>';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startLoopbackReceiver(expectedState: string, timeoutMs = 120_000): Promise<LoopbackReceiver> {
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Mark as handled: the caller may await `code` later (or never, e.g. after close()).
  code.catch(() => undefined);

  let done = false;
  const finish = (err: Error | null, value?: string): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    if (err) settle?.reject(err);
    else if (value !== undefined) settle?.resolve(value);
  };

  const server: Server = createServer((req, res) => {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" };
    if (req.method !== 'GET' || done) {
      res.writeHead(405, headers).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const params = url.searchParams;
    if (!params.has('code') && !params.has('error')) {
      // e.g. /favicon.ico — ignore without consuming the one-shot receiver
      res.writeHead(404, headers).end();
      return;
    }
    const state = params.get('state') ?? '';
    if (!safeEqual(state, expectedState)) {
      res.writeHead(400, headers).end(PAGE_FAIL);
      finish(new Error('OAuth state mismatch — possible CSRF, login aborted.'));
      return;
    }
    const error = params.get('error');
    const authCode = params.get('code');
    if (error !== null || authCode === null || authCode === '') {
      res.writeHead(400, headers).end(PAGE_FAIL);
      // OAuth error codes are [a-z_]; strip anything else before it reaches the terminal.
      const reason = (error ?? 'missing_code').replace(/[^a-z_]/gi, '').slice(0, 64);
      finish(new Error(`Google returned an OAuth error: ${reason}`));
      return;
    }
    res.writeHead(200, headers).end(PAGE_OK);
    finish(null, authCode);
  });

  const timer = setTimeout(() => {
    finish(new Error('Login timed out — no response from the browser.'));
  }, timeoutMs);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    redirectUri: `http://127.0.0.1:${String(port)}`,
    code,
    close: () => {
      finish(new Error('Login cancelled.'));
    },
  };
}
