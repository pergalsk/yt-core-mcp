import { z } from 'zod';

/** Zod fields shared by several tools. */

export const videoId = z.string().regex(/^[\w-]{11}$/).describe('YouTube video id (11 characters).');
/** Generic YouTube resource id (playlist, playlist item, stream, ...). */
export const resourceId = z.string().regex(/^[\w-]{1,64}$/);
export const maxResults = z.number().int().min(1).max(50).default(10).describe('Results per page (1-50).');
export const pageToken = z.string().max(200).optional().describe('nextPageToken from a previous call.');
