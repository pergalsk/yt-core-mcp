import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openGuardedFile } from '../files/file-guard.js';
import { READ_ONLY, WRITE } from './annotations.js';
import { runTool, untrustedResult } from './result.js';
import { languageCode, videoId } from './schemas.js';
import type { YouTubeFactory } from './youtube.js';

export function registerCaptionTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'caption_list',
    {
      title: 'List captions',
      description:
        'Lists caption tracks of one of your videos (YouTube Data API captions.list). Costs 50 quota units. ' +
        'Needs the `captions` permission group (shares its OAuth scope with `comments`).',
      inputSchema: { videoId },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('captions').captions.list({ part: ['snippet'], videoId: args.videoId });
        return untrustedResult({
          items: (res.data.items ?? []).map((c) => ({
            id: c.id,
            language: c.snippet?.language,
            name: c.snippet?.name,
            trackKind: c.snippet?.trackKind,
            isDraft: c.snippet?.isDraft,
            status: c.snippet?.status,
            lastUpdated: c.snippet?.lastUpdated,
          })),
        });
      }),
  );

  server.registerTool(
    'caption_upload',
    {
      title: 'Upload caption',
      description:
        'Uploads a new SRT or VTT caption track to one of your videos (YouTube Data API captions.insert). ' +
        'Costs 400 quota units. The file must be inside the media folder (YT_CORE_MCP_MEDIA_ROOT). ' +
        'Needs the `captions` permission group (shares its OAuth scope with `comments`).',
      inputSchema: {
        videoId,
        file: z.string().min(1).max(1000).describe('Path to the .srt/.vtt file, absolute or relative to the media folder.'),
        language: languageCode.describe('BCP-47 language code, e.g. "en" or "sk".'),
        name: z.string().max(150).default('').describe('Track name shown to viewers (max 150 characters).'),
        isDraft: z.boolean().default(false).describe('Upload as draft (not visible to viewers).'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        const file = await openGuardedFile(args.file, 'caption');
        try {
          const res = await yt('captions').captions.insert({
            part: ['snippet'],
            requestBody: {
              snippet: { videoId: args.videoId, language: args.language, name: args.name, isDraft: args.isDraft },
            },
            media: { mimeType: file.mimeType, body: file.handle.createReadStream({ start: 0, autoClose: false }) },
          });
          return untrustedResult({
            id: res.data.id,
            language: res.data.snippet?.language,
            name: res.data.snippet?.name,
            isDraft: res.data.snippet?.isDraft,
            status: res.data.snippet?.status,
          });
        } finally {
          await file.handle.close();
        }
      }),
  );
}
