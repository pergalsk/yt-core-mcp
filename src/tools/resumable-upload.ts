import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { OAuth2Client } from 'google-auth-library';
import type { ScopeGroup } from '../auth/scopes.js';
import { log } from '../util/log.js';

/** Returns the OAuth client for a scope group. Injected into tools, so tests can pass a fake. */
export type AuthFactory = (group: ScopeGroup) => OAuth2Client;

/** Upload chunks must be a multiple of this size (YouTube resumable protocol). */
export const CHUNK_UNIT = 256 * 1024;

const READ_BYTES = 1024 * 1024;

export interface UploadFile {
  handle: FileHandle;
  size: number;
  mimeType: string;
}

export interface ResumableUploadOptions {
  /** Session start URL; `params` are sent as the query string. */
  url: string;
  params: Record<string, string>;
  /** JSON metadata sent when the session starts. */
  metadata: object;
  file: UploadFile;
  /** Bytes per PUT, a multiple of 256 KiB. Default: the rest of the file in one PUT. */
  chunkSize?: number;
  /** Failed attempts in a row before giving up. Default: 5. */
  maxRetries?: number;
  /** First backoff delay in ms, doubled after each failure. Default: 1000. */
  backoffMs?: number;
  /** Replaceable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Requester = Pick<OAuth2Client, 'request'>;

const okOrIncomplete = (status: number) => (status >= 200 && status < 300) || status === 308;

/** True for 5xx and for network errors (no HTTP response). */
function isRetryable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } }).response?.status;
  return status === undefined || status >= 500;
}

/**
 * Reads bytes [start, end) from the handle. Used instead of handle.createReadStream, which adds a
 * listener to the handle per stream (and closes the handle when destroyed).
 */
async function* readRange(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
  for (let pos = start; pos < end; ) {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(Math.min(READ_BYTES, end - pos)), 0, undefined, pos);
    if (bytesRead === 0) throw new Error('The file got shorter during the upload.');
    yield buffer.subarray(0, bytesRead);
    pos += bytesRead;
  }
}

/** Next byte to send, from a 308 `Range: bytes=0-<last>` header (no header = nothing stored yet). */
function nextOffset(range: string | null): number {
  const m = range ? /^bytes=0-(\d+)$/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

// Uploads a file with the resumable protocol. On a 5xx or network error it asks the server how many
// bytes it has (empty PUT with `Content-Range: bytes */<size>`) and continues from there, with backoff.
export async function resumableUpload<T>(auth: Requester, opts: ResumableUploadOptions): Promise<T> {
  const { file, maxRetries = 5, backoffMs = 1000 } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chunkSize = opts.chunkSize ?? file.size;
  if (opts.chunkSize !== undefined && (chunkSize <= 0 || chunkSize % CHUNK_UNIT !== 0)) {
    throw new Error(`Chunk size must be a positive multiple of ${String(CHUNK_UNIT)} bytes.`);
  }

  // Step 1: start a session; the upload URL comes back in the Location header.
  const session = await auth.request({
    url: opts.url,
    method: 'POST',
    params: opts.params,
    headers: { 'X-Upload-Content-Length': String(file.size), 'X-Upload-Content-Type': file.mimeType },
    data: opts.metadata,
  });
  const location = session.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload URL.');

  // Step 2: send bytes (read only from the guarded handle) until the server returns the created resource.
  let offset = 0;
  let failures = 0;
  let mustQuery = false;
  for (;;) {
    try {
      let res;
      if (mustQuery) {
        res = await auth.request<T>({
          url: location,
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${String(file.size)}` },
          validateStatus: okOrIncomplete,
        });
      } else {
        const end = Math.min(offset + chunkSize, file.size);
        res = await auth.request<T>({
          url: location,
          method: 'PUT',
          headers: {
            'Content-Length': String(end - offset),
            'Content-Type': file.mimeType,
            'Content-Range': `bytes ${String(offset)}-${String(end - 1)}/${String(file.size)}`,
          },
          data: Readable.from(readRange(file.handle, offset, end)),
          validateStatus: okOrIncomplete,
        });
      }
      if (res.status !== 308) return res.data;
      const next = nextOffset(res.headers.get('range'));
      if (!mustQuery && next > offset) failures = 0;
      offset = next;
      mustQuery = false;
    } catch (err) {
      if (!isRetryable(err)) throw err;
      failures++;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (failures > maxRetries) {
        throw new Error(
          `Upload failed after ${String(maxRetries)} retries (${String(offset)} of ${String(file.size)} bytes confirmed): ${msg}`,
          { cause: err },
        );
      }
      const delay = backoffMs * 2 ** (failures - 1);
      log(`yt-core-mcp: upload error (${msg}), retry ${String(failures)}/${String(maxRetries)} in ${String(delay)} ms`);
      await sleep(delay);
      mustQuery = true;
    }
  }
}
