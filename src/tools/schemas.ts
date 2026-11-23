import { z } from 'zod';

/** Zod fields shared by several tools. */

export const videoId = z.string().regex(/^[\w-]{11}$/).describe('YouTube video id (11 characters).');
/** Generic YouTube resource id (playlist, playlist item, stream, ...). */
export const resourceId = z.string().regex(/^[\w-]{1,64}$/);
export const maxResults = z.number().int().min(1).max(50).default(10).describe('Results per page (1-50).');
export const pageToken = z.string().max(200).optional().describe('nextPageToken from a previous call.');

const noAngleBrackets = (s: string) => !/[<>]/.test(s);
const ANGLE_MSG = 'must not contain < or >';

/** Video / broadcast title (YouTube: max 100 characters, no < or >). */
export const title = z.string().min(1).max(100).refine(noAngleBrackets, ANGLE_MSG);

/** Video / broadcast description (YouTube: max 5000 UTF-8 bytes, no < or >). */
export const description = z
  .string()
  .refine((s) => Buffer.byteLength(s, 'utf8') <= 5000, 'must be at most 5000 bytes (UTF-8; letters with diacritics take 2 bytes)')
  .refine(noAngleBrackets, ANGLE_MSG);

/** Length YouTube counts for tags: commas between tags, quotes around tags with a space. */
function tagsLength(tags: string[]): number {
  return tags.reduce((sum, t, i) => sum + t.length + (t.includes(' ') ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

/** Video tags (YouTube: max 500 characters in total). */
export const tags = z
  .array(z.string().min(1))
  .refine((t) => tagsLength(t) <= 500, 'tags must be at most 500 characters in total (incl. commas and quotes)');

/** BCP-47 language code, e.g. "sk" or "en-US". */
export const languageCode = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
