import { describe, expect, it } from 'vitest';
import { startLoopbackReceiver } from './loopback.js';

async function hit(base: string, query: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/?${query}`);
  return { status: res.status, body: await res.text() };
}

describe('startLoopbackReceiver', () => {
  it('binds to 127.0.0.1 on a random port', async () => {
    const r = await startLoopbackReceiver('s');
    expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    r.close();
    await expect(r.code).rejects.toThrow('cancelled');
  });

  it('resolves the code when state matches', async () => {
    const r = await startLoopbackReceiver('good-state');
    const res = await hit(r.redirectUri, 'code=abc&state=good-state');
    expect(res.status).toBe(200);
    await expect(r.code).resolves.toBe('abc');
  });

  it('rejects on state mismatch (CSRF)', async () => {
    const r = await startLoopbackReceiver('good-state');
    const res = await hit(r.redirectUri, 'code=abc&state=evil');
    expect(res.status).toBe(400);
    await expect(r.code).rejects.toThrow('state mismatch');
  });

  it('does not reflect error text into HTML and sanitizes it for the terminal', async () => {
    const r = await startLoopbackReceiver('st');
    const res = await hit(r.redirectUri, `error=${encodeURIComponent('<script>x</script>')}&state=st`);
    expect(res.body).not.toContain('<script>');
    await expect(r.code).rejects.toThrow('OAuth error: scriptxscript');
  });

  it('ignores unrelated requests without consuming the receiver', async () => {
    const r = await startLoopbackReceiver('st');
    const fav = await fetch(`${r.redirectUri}/favicon.ico`);
    expect(fav.status).toBe(404);
    await hit(r.redirectUri, 'code=ok&state=st');
    await expect(r.code).resolves.toBe('ok');
  });

  it('times out', async () => {
    const r = await startLoopbackReceiver('st', 50);
    await expect(r.code).rejects.toThrow('timed out');
  });
});
