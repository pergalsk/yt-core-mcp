import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectMimeType, FileGuardError, openGuardedFile, type FileKind } from './file-guard.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

let base: string;
let root: string;
let outside: string;

async function expectRefused(input: string, kind: FileKind = 'thumbnail') {
  await expect(openGuardedFile(input, kind, root)).rejects.toThrow(FileGuardError);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'yt-guard-'));
  root = join(base, 'media');
  outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'cover.png'), PNG);
  await writeFile(join(root, 'sub', 'cover.jpg'), JPEG);
  await writeFile(join(root, 'fake.png'), 'not an image');
  await writeFile(join(root, 'empty.png'), '');
  await writeFile(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
  await writeFile(join(outside, 'secret.png'), PNG);
  await symlink(outside, join(root, 'junction'), 'junction');
  await link(join(outside, 'secret.png'), join(root, 'hardlink.png'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('openGuardedFile', () => {
  it('opens an allowed file (absolute and relative path)', async () => {
    for (const input of [join(root, 'cover.png'), 'sub/cover.jpg']) {
      const f = await openGuardedFile(input, 'thumbnail', root);
      expect(f.mimeType).toMatch(/^image\//);
      expect(f.size).toBeGreaterThan(0);
      await f.handle.close();
    }
  });

  it('opens a file when the root is given via a junction alias', async () => {
    const alias = join(base, 'media-alias');
    await symlink(root, alias, 'junction');
    const f = await openGuardedFile(join(alias, 'cover.png'), 'thumbnail', alias);
    expect(f.mimeType).toBe('image/png');
    await f.handle.close();
    await expect(openGuardedFile(join(alias, 'junction', 'secret.png'), 'thumbnail', alias)).rejects.toThrow(
      FileGuardError,
    );
  });

  it('refuses when the root is not configured or missing', async () => {
    for (const r of ['', join(base, 'nope')]) {
      await expect(openGuardedFile('cover.png', 'thumbnail', r)).rejects.toThrow(FileGuardError);
    }
    delete process.env.YT_CORE_MCP_MEDIA_ROOT;
    await expect(openGuardedFile('cover.png', 'thumbnail')).rejects.toThrow(/disabled/);
  });

  it('refuses traversal and paths outside the root', async () => {
    await expectRefused('../outside/secret.png');
    await expectRefused(join(outside, 'secret.png'));
    await expectRefused('\\\\127.0.0.1\\c$\\secret.png');
    await expectRefused('.');
  });

  it('refuses symlink/junction escape and hard links', async () => {
    await expectRefused('junction/secret.png');
    await expectRefused('hardlink.png');
  });

  it('refuses directories, missing, empty, wrong type and too large files', async () => {
    await expectRefused('sub');
    await expectRefused('missing.png');
    await expectRefused('empty.png');
    await expectRefused('fake.png');
    await expectRefused('cover.png', 'video');
    await expectRefused('big.png');
  });

  it('uses one message for every path refusal (no oracle)', async () => {
    const messages = await Promise.all(
      ['missing.png', '../outside/secret.png', 'fake.png', 'junction/secret.png'].map((p) =>
        openGuardedFile(p, 'thumbnail', root).catch((e: unknown) => (e as Error).message),
      ),
    );
    expect(new Set(messages).size).toBe(1);
  });
});

describe('detectMimeType', () => {
  const ascii = (s: string) => Buffer.from(s, 'latin1');

  it('detects images', () => {
    expect(detectMimeType('thumbnail', PNG)).toBe('image/png');
    expect(detectMimeType('thumbnail', JPEG)).toBe('image/jpeg');
  });

  it('detects videos', () => {
    expect(detectMimeType('video', ascii('\0\0\0\x18ftypisom'))).toBe('video/mp4');
    expect(detectMimeType('video', ascii('\0\0\0\x14ftypqt  '))).toBe('video/quicktime');
    expect(detectMimeType('video', ascii('\x1a\x45\xdf\xa3\x9f\x42\x82\x84webm'))).toBe('video/webm');
    expect(detectMimeType('video', ascii('\x1a\x45\xdf\xa3\xa3\x42\x82\x88matroska'))).toBe('video/x-matroska');
    expect(detectMimeType('video', PNG)).toBeNull();
  });

  it('detects captions', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const vtt = Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000');
    expect(detectMimeType('caption', Buffer.concat([bom, vtt]))).toBe('text/vtt');
    expect(detectMimeType('caption', Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nAhoj'))).toBe(
      'application/x-subrip',
    );
    expect(detectMimeType('caption', Buffer.from('WEBVTTX'))).toBeNull();
    expect(detectMimeType('caption', Buffer.from('hello'))).toBeNull();
  });
});
