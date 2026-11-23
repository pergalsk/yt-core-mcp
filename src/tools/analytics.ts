import { youtubeAnalytics, type youtubeAnalytics_v2 } from '@googleapis/youtubeanalytics';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getAuthorizedClient } from '../auth/client.js';
import { TokenStore } from '../auth/token-store.js';
import { READ_ONLY } from './annotations.js';
import { runTool } from './result.js';
import { videoId } from './schemas.js';

/** Returns a YouTube Analytics API client authorized for the `analytics` scope group. Injected, so tests can pass a fake. */
export type AnalyticsFactory = () => youtubeAnalytics_v2.Youtubeanalytics;

export function analyticsFactory(store = new TokenStore()): AnalyticsFactory {
  return () => youtubeAnalytics({ version: 'v2', auth: getAuthorizedClient('analytics', store) });
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // Rejects impossible dates like 2026-02-30 (a plain regex lets them through).
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'must be a real date');
const dateRange = {
  startDate: date.describe('Start date, YYYY-MM-DD.'),
  endDate: date.describe('End date, YYYY-MM-DD (inclusive).'),
};

const SUMMARY_METRICS =
  'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';

type Query = Omit<youtubeAnalytics_v2.Params$Resource$Reports$Query, 'ids' | 'startDate' | 'endDate'>;

/** Turns the column/row report into a list of objects keyed by column name. */
function toRows(data: youtubeAnalytics_v2.Schema$QueryResponse): Record<string, unknown>[] {
  const names = (data.columnHeaders ?? []).map((h) => h.name ?? '');
  return (data.rows ?? []).map((row: unknown[]) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

export function registerAnalyticsTools(server: McpServer, analytics: AnalyticsFactory): void {
  async function report(args: { startDate: string; endDate: string }, query: Query): Promise<CallToolResult> {
    if (args.startDate > args.endDate) throw new Error(`startDate (${args.startDate}) must not be after endDate (${args.endDate}).`);
    const res = await analytics().reports.query({
      ids: 'channel==MINE',
      startDate: args.startDate,
      endDate: args.endDate,
      ...query,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ rows: toRows(res.data) }, null, 2) }] };
  }

  server.registerTool(
    'analytics_overview',
    {
      title: 'Channel analytics overview',
      description: 'Totals for your channel in a date range: views, watch time, subscribers, likes, comments, shares.',
      inputSchema: dateRange,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => report(args, { metrics: SUMMARY_METRICS })),
  );

  server.registerTool(
    'analytics_top_videos',
    {
      title: 'Top videos',
      description: 'Your most viewed videos in a date range, with watch time, likes and subscribers gained.',
      inputSchema: {
        ...dateRange,
        maxResults: z.number().int().min(1).max(200).default(10).describe('Number of videos (1-200).'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(() =>
        report(args, {
          dimensions: 'video',
          metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained',
          sort: '-views',
          maxResults: args.maxResults,
        }),
      ),
  );

  server.registerTool(
    'analytics_video',
    {
      title: 'Video analytics',
      description: 'Totals for one of your videos in a date range: views, watch time, subscribers, likes, comments, shares.',
      inputSchema: { ...dateRange, videoId },
      annotations: READ_ONLY,
    },
    (args) => runTool(() => report(args, { metrics: SUMMARY_METRICS, filters: `video==${args.videoId}` })),
  );

  server.registerTool(
    'analytics_traffic_sources',
    {
      title: 'Traffic sources',
      description: 'Where your channel views came from (search, suggested, external, ...) in a date range.',
      inputSchema: dateRange,
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(() =>
        report(args, { dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched', sort: '-views' }),
      ),
  );

  server.registerTool(
    'analytics_demographics',
    {
      title: 'Viewer demographics',
      description: 'Share of your channel viewers by age group and gender in a date range (viewerPercentage).',
      inputSchema: dateRange,
      annotations: READ_ONLY,
    },
    (args) => runTool(() => report(args, { dimensions: 'ageGroup,gender', metrics: 'viewerPercentage' })),
  );

  server.registerTool(
    'analytics_geography',
    {
      title: 'Viewer geography',
      description: 'Your channel views and watch time by country in a date range.',
      inputSchema: dateRange,
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(() =>
        report(args, {
          dimensions: 'country',
          metrics: 'views,estimatedMinutesWatched,averageViewDuration',
          sort: '-views',
        }),
      ),
  );

  server.registerTool(
    'analytics_daily',
    {
      title: 'Daily analytics',
      description: 'Your channel views, watch time and subscriber changes per day in a date range.',
      inputSchema: dateRange,
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(() =>
        report(args, {
          dimensions: 'day',
          metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
          sort: 'day',
        }),
      ),
  );

  server.registerTool(
    'analytics_retention',
    {
      title: 'Audience retention',
      description:
        'Audience retention curve for one of your videos: share of viewers still watching at each point (0-1) of the video.',
      inputSchema: { ...dateRange, videoId },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(() =>
        report(args, {
          dimensions: 'elapsedVideoTimeRatio',
          metrics: 'audienceWatchRatio,relativeRetentionPerformance',
          filters: `video==${args.videoId}`,
          sort: 'elapsedVideoTimeRatio',
        }),
      ),
  );
}
