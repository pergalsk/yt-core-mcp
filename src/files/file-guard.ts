import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Single entry point for reading local files (thumbnails, videos, captions).
 *
 * Threat model: the AI client chooses the path. It must not be able to read
 * anything outside the folder the user allowed, nor make us touch remote
 * paths (UNC → NTLM leak). Checks:
 * - lexical containment first (no filesystem call for paths outside root)
 * - realpath containment (symlinks / junctions resolved)
 * - regular file, single hard link, size limit, magic bytes
 * - identity check lstat(path) vs fstat(handle), because Windows has no
 *   O_NOFOLLOW; the caller then reads only from the returned handle.
 * Every refusal for a given kind has the same message (no path oracle).
 */

export const MEDIA_ROOT_ENV = 'YT_CORE_MCP_MEDIA_ROOT';

export type FileKind = 'thumbnail' | 'video' | 'caption';

export interface GuardedFile {
  /** Open read-only handle. The caller must close it. */
  handle: FileHandle;
  size: number;
  mimeType: string;
}

// Limits from the official API docs (thumbnails.set, videos.insert, captions.insert).
const MB = 1024 * 1024;
const RULES: Record<FileKind, { maxBytes: number; label: string }> = {
  thumbnail: { maxBytes: 2 * MB, label: 'JPEG/PNG, max 2 MB' },
  video: { maxBytes: 256 * 1024 * MB, label: 'MP4/MOV/MKV/WebM, max 256 GB' },
  caption: { maxBytes: 100 * MB, label: 'SRT/VTT, max 100 MB' },
};

const HEADER_BYTES = 64;

export class FileGuardError extends Error {
  override name = 'FileGuardError';
}

function refusal(kind: FileKind): FileGuardError {
  return new FileGuardError(
    `File refused: it must be a regular file inside the media folder (${RULES[kind].label}).`,
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Returns the MIME type if the header matches the kind, otherwise null. */
export function detectMimeType(kind: FileKind, header: Buffer): string | null {
  const ascii = header.toString('latin1');
  switch (kind) {
    case 'thumbnail':
      if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
      if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
      }
      return null;
    case 'video':
      // ISO base media file (MP4 / QuickTime): box type "ftyp" at offset 4, brand at 8.
      if (ascii.slice(4, 8) === 'ftyp') return ascii.slice(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
      // EBML header (Matroska / WebM); DocType appears in the first bytes.
      if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
        return ascii.includes('webm') ? 'video/webm' : 'video/x-matroska';
      }
      return null;
    case 'caption': {
      const raw = header.toString('utf8');
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip UTF-8 BOM
      if (/^WEBVTT(?:[ \t\r\n]|$)/.test(text)) return 'text/vtt';
      if (/^\s*\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(text)) {
        return 'application/x-subrip';
      }
      return null;
    }
  }
}

/**
 * Opens `input` (absolute, or relative to the media root) after all checks.
 * `root` defaults to the YT_CORE_MCP_MEDIA_ROOT env variable; unset ⇒ refused.
 */
export async function openGuardedFile(
  input: string,
  kind: FileKind,
  root: string | undefined = process.env[MEDIA_ROOT_ENV],
): Promise<GuardedFile> {
  if (!root) {
    throw new FileGuardError(`Local file access is disabled. Set ${MEDIA_ROOT_ENV} to an allowed folder.`);
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FileGuardError(`Media folder from ${MEDIA_ROOT_ENV} does not exist.`);
  }

  // Lexical check before any filesystem access to the user-supplied path.
  const candidate = resolve(realRoot, input);
  if (!isInside(realRoot, candidate)) throw refusal(kind);

  let handle: FileHandle | undefined;
  try {
    const realFile = await realpath(candidate);
    if (!isInside(realRoot, realFile)) throw refusal(kind);

    const linkStat = await lstat(realFile, { bigint: true });
    if (!linkStat.isFile()) throw refusal(kind);

    handle = await open(realFile, 'r');
    const fileStat = await handle.stat({ bigint: true });
    if (
      !fileStat.isFile() ||
      fileStat.dev !== linkStat.dev ||
      fileStat.ino !== linkStat.ino ||
      fileStat.nlink !== 1n ||
      fileStat.size > BigInt(RULES[kind].maxBytes)
    ) {
      throw refusal(kind);
    }

    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
    const mimeType = detectMimeType(kind, header.subarray(0, bytesRead));
    if (!mimeType) throw refusal(kind);

    return { handle, size: Number(fileStat.size), mimeType };
  } catch (err) {
    await handle?.close();
    if (err instanceof FileGuardError) throw err;
    throw refusal(kind);
  }
}
