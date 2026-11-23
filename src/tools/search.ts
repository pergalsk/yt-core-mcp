import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defined } from '../util/defined.js';
import { READ_ONLY } from './annotations.js';
import { runTool, untrustedResult } from './result.js';
import { maxResults, pageToken } from './schemas.js';
import type { YouTubeFactory } from './youtube.js';

const regionCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .optional()
  .describe('ISO 3166-1 alpha-2 country code, e.g. "US" or "SK".');

export function registerSearchTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'search_public',
    {
      title: 'Search YouTube',
      description:
        'Searches public YouTube videos, channels or playlists (YouTube Data API search.list). ' +
        'WARNING: every call costs 100 quota units (default daily quota is 10,000), so search only when needed.',
      inputSchema: {
        q: z.string().min(1).max(500).describe('Search query.'),
        type: z.enum(['video', 'channel', 'playlist']).default('video'),
        order: z.enum(['relevance', 'date', 'viewCount', 'rating', 'title']).default('relevance'),
        maxResults,
        regionCode,
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').search.list({
          part: ['snippet'],
          q: args.q,
          type: [args.type],
          order: args.order,
          maxResults: args.maxResults,
          ...defined({ regionCode: args.regionCode, pageToken: args.pageToken }),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((item) => ({
            kind: item.id?.kind?.replace('youtube#', ''),
            id: item.id?.videoId ?? item.id?.channelId ?? item.id?.playlistId,
            title: item.snippet?.title,
            description: item.snippet?.description,
            channelId: item.snippet?.channelId,
            channelTitle: item.snippet?.channelTitle,
            publishedAt: item.snippet?.publishedAt,
          })),
        });
      }),
  );

  server.registerTool(
    'videos_trending',
    {
      title: 'Trending videos',
      description:
        'Lists the most popular videos in a region (YouTube Data API videos.list chart=mostPopular). Costs 1 quota unit.',
      inputSchema: {
        regionCode,
        videoCategoryId: z.string().regex(/^\d+$/).optional().describe('Numeric video category id.'),
        maxResults,
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('core').videos.list({
          part: ['snippet', 'statistics', 'contentDetails'],
          chart: 'mostPopular',
          maxResults: args.maxResults,
          ...defined({ regionCode: args.regionCode, videoCategoryId: args.videoCategoryId, pageToken: args.pageToken }),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((v) => ({
            id: v.id,
            title: v.snippet?.title,
            channelId: v.snippet?.channelId,
            channelTitle: v.snippet?.channelTitle,
            publishedAt: v.snippet?.publishedAt,
            duration: v.contentDetails?.duration,
            viewCount: v.statistics?.viewCount,
            likeCount: v.statistics?.likeCount,
            commentCount: v.statistics?.commentCount,
          })),
        });
      }),
  );
}
