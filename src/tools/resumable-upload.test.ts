import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { OAuth2Client } from 'google-auth-library';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHUNK_UNIT, resumableUpload, type ResumableUploadOptions } from './resumable-upload.js';

const SIZE = CHUNK_UNIT * 2 + 1000;
const BYTES = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

interface RequestOpts {
  method: string;
  headers: Record<string, string>;
  data?: unknown;
}

const network = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${String(status)}`), { response: { status } });

/** Fake YouTube upload endpoint. `plan[n]` makes the n-th data PUT store `keep` bytes and then fail. */
function fakeServer(plan: ({ keep?: number; error: Error } | undefined)[] = []) {
  let stored = Buffer.alloc(0);
  let puts = 0;
  const reply = (total: number) =>
    stored.length === total
      ? { status: 200, headers: new Headers(), data: { id: 'v1', size: stored.length } }
      : { status: 308, headers: new Headers(stored.length ? { range: `bytes=0-${String(stored.length - 1)}` } : {}), data: '' };
  const request = vi.fn(async (o: RequestOpts) => {
    if (o.method === 'POST') return { status: 200, headers: new Headers({ location: 'https://upload.example/s1' }), data: '' };
    const range = o.headers['Content-Range'] ?? '';
    const query = /^bytes \*\/(\d+)$/.exec(range);
    if (query) return reply(Number(query[1]));
    const [, start, , total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range) ?? [];
    expect(Number(start)).toBe(stored.length);
    const chunks: Buffer[] = [];
    for await (const c of o.data as Readable) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(Number(o.headers['Content-Length']));
    const fail = plan[puts++];
    stored = Buffer.concat([stored, fail ? body.subarray(0, fail.keep ?? 0) : body]);
    if (fail) throw fail.error;
    return reply(Number(total));
  });
  return { auth: { request } as unknown as OAuth2Client, request, stored: () => stored };
}

let dir: string;
let handle: FileHandle;
const sleep = vi.fn(() => Promise.resolve());

function opts(extra: Partial<ResumableUploadOptions> = {}): ResumableUploadOptions {
  return {
    url: 'https://upload.example/start',
    params: { uploadType: 'resumable' },
    metadata: { snippet: { title: 'T' } },
    file: { handle, size: SIZE, mimeType: 'video/mp4' },
    sleep,
    ...extra,
  };
}

const ranges = (request: ReturnType<typeof fakeServer>['request']) =>
  request.mock.calls.slice(1).map(([o]) => o.headers['Content-Range']);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yt-resumable-'));
  await writeFile(join(dir, 'v.mp4'), BYTES);
  handle = await open(join(dir, 'v.mp4'), 'r');
});

afterAll(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

describe('resumableUpload', () => {
  it('starts a session and sends the whole file in one PUT by default', async () => {
    const s = fakeServer();
    await expect(resumableUpload(s.auth, opts())).resolves.toEqual({ id: 'v1', size: SIZE });
    expect(s.request).toHaveBeenNthCalledWith(1, {
      url: 'https://upload.example/start',
      method: 'POST',
      params: { uploadType: 'resumable' },
      headers: { 'X-Upload-Content-Length': String(SIZE), 'X-Upload-Content-Type': 'video/mp4' },
      data: { snippet: { title: 'T' } },
    });
    expect(ranges(s.request)).toEqual([`bytes 0-${String(SIZE - 1)}/${String(SIZE)}`]);
    expect(s.stored().equals(BYTES)).toBe(true);
  });

  it('sends chunks of the given size', async () => {
    const s = fakeServer();
    await resumableUpload(s.auth, opts({ chunkSize: CHUNK_UNIT }));
    expect(ranges(s.request)).toEqual([
      `bytes 0-${String(CHUNK_UNIT - 1)}/${String(SIZE)}`,
      `bytes ${String(CHUNK_UNIT)}-${String(2 * CHUNK_UNIT - 1)}/${String(SIZE)}`,
      `bytes ${String(2 * CHUNK_UNIT)}-${String(SIZE - 1)}/${String(SIZE)}`,
    ]);
    expect(s.stored().equals(BYTES)).toBe(true);
  });

  it('resumes from the server-confirmed offset after a network error', async () => {
    const s = fakeServer([{ keep: 1234, error: network() }]);
    sleep.mockClear();
    await expect(resumableUpload(s.auth, opts())).resolves.toEqual({ id: 'v1', size: SIZE });
    expect(ranges(s.request)).toEqual([`bytes 0-${String(SIZE - 1)}/${String(SIZE)}`, `bytes */${String(SIZE)}`, `bytes 1234-${String(SIZE - 1)}/${String(SIZE)}`]);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(s.stored().equals(BYTES)).toBe(true);
  });

  it('retries 5xx errors with growing backoff', async () => {
    const s = fakeServer([{ error: httpError(503) }, { keep: 10, error: httpError(500) }]);
    sleep.mockClear();
    await resumableUpload(s.auth, opts());
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(ranges(s.request).at(-1)).toBe(`bytes 10-${String(SIZE - 1)}/${String(SIZE)}`);
    expect(s.stored().equals(BYTES)).toBe(true);
  });

  it('gives up with a clear error after N retries', async () => {
    const s = fakeServer(Array.from({ length: 10 }, () => ({ keep: 100, error: network() })));
    sleep.mockClear();
    await expect(resumableUpload(s.auth, opts({ maxRetries: 2 }))).rejects.toThrow(
      /^Upload failed after 2 retries \(200 of \d+ bytes confirmed\): socket hang up$/,
    );
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const s = fakeServer([{ error: httpError(403) }]);
    await expect(resumableUpload(s.auth, opts())).rejects.toThrow('HTTP 403');
    expect(s.request).toHaveBeenCalledTimes(2);
  });

  it('returns the video when the status query shows the upload is complete', async () => {
    const s = fakeServer([{ keep: SIZE, error: network() }]);
    await expect(resumableUpload(s.auth, opts())).resolves.toEqual({ id: 'v1', size: SIZE });
    expect(ranges(s.request)).toEqual([`bytes 0-${String(SIZE - 1)}/${String(SIZE)}`, `bytes */${String(SIZE)}`]);
  });

  it('refuses a chunk size that is not a multiple of 256 KiB', async () => {
    const s = fakeServer();
    await expect(resumableUpload(s.auth, opts({ chunkSize: 1000 }))).rejects.toThrow(/multiple of 262144/);
    expect(s.request).not.toHaveBeenCalled();
  });

  it('fails when no upload URL is returned', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: new Headers(), data: '' });
    await expect(resumableUpload({ request }, opts())).rejects.toThrow(/did not return an upload URL/);
  });
});
