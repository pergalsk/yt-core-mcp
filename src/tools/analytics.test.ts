import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { youtubeAnalytics_v2 } from '@googleapis/youtubeanalytics';
import { describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../auth/token-store.js';
import { createServer } from '../server.js';
import { analyticsFactory, registerAnalyticsTools, type AnalyticsFactory } from './analytics.js';

const emptyStore = new TokenStore({ get: () => null, set: () => undefined, delete: () => false });
const range = { startDate: '2026-01-01', endDate: '2026-01-31' };
const TOOLS = [
  'analytics_overview',
  'analytics_top_videos',
  'analytics_video',
  'analytics_traffic_sources',
  'analytics_demographics',
  'analytics_geography',
  'analytics_daily',
  'analytics_retention',
];

function fakeAnalytics() {
  const query = vi.fn<(params: youtubeAnalytics_v2.Params$Resource$Reports$Query) => Promise<unknown>>().mockResolvedValue({
    data: {
      columnHeaders: [{ name: 'video' }, { name: 'views' }],
      rows: [
        ['v1', 10],
        ['v2', 5],
      ],
    },
  });
  const client = { reports: { query } } as unknown as youtubeAnalytics_v2.Youtubeanalytics;
  const factory = vi.fn<AnalyticsFactory>(() => client);
  return { factory, query };
}

async function connect(analytics: AnalyticsFactory) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerAnalyticsTools(server, analytics);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

function parseText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? '');
}

describe('analytics tools', () => {
  it('are registered in createServer as read-only tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(emptyStore).connect(serverTransport);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    }
  });

  it('analytics_top_videos queries channel==MINE and maps rows to objects', async () => {
    const ya = fakeAnalytics();
    const client = await connect(ya.factory);
    const result = await client.callTool({ name: 'analytics_top_videos', arguments: { ...range, maxResults: 2 } });

    expect(ya.query).toHaveBeenCalledWith({
      ids: 'channel==MINE',
      ...range,
      dimensions: 'video',
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained',
      sort: '-views',
      maxResults: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({
      rows: [
        { video: 'v1', views: 10 },
        { video: 'v2', views: 5 },
      ],
    });
  });

  it('analytics_retention filters by video', async () => {
    const ya = fakeAnalytics();
    const client = await connect(ya.factory);
    await client.callTool({ name: 'analytics_retention', arguments: { ...range, videoId: 'dQw4w9WgXcQ' } });
    expect(ya.query).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 'elapsedVideoTimeRatio', filters: 'video==dQw4w9WgXcQ' }),
    );
  });

  it('never requests revenue metrics', async () => {
    const ya = fakeAnalytics();
    const client = await connect(ya.factory);
    for (const name of TOOLS) {
      await client.callTool({ name, arguments: { ...range, videoId: 'dQw4w9WgXcQ' } });
    }
    expect(ya.query).toHaveBeenCalledTimes(TOOLS.length);
    for (const [params] of ya.query.mock.calls) {
      expect(params.ids).toBe('channel==MINE');
      expect(params.metrics).not.toMatch(/revenue|cpm|adImpressions/i);
    }
  });

  it('rejects invalid input without calling the API', async () => {
    const ya = fakeAnalytics();
    const client = await connect(ya.factory);
    const result = await client.callTool({
      name: 'analytics_video',
      arguments: { startDate: '2026/01/01', endDate: '2026-01-31', videoId: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(ya.query).not.toHaveBeenCalled();
  });

  it('rejects impossible dates and a reversed range without calling the API', async () => {
    const ya = fakeAnalytics();
    const client = await connect(ya.factory);
    const feb30 = await client.callTool({ name: 'analytics_overview', arguments: { startDate: '2026-02-30', endDate: '2026-03-31' } });
    expect(feb30.isError).toBe(true);
    const reversed = await client.callTool({ name: 'analytics_overview', arguments: { startDate: '2026-02-01', endDate: '2026-01-31' } });
    expect(reversed.content).toEqual([{ type: 'text', text: 'startDate (2026-02-01) must not be after endDate (2026-01-31).' }]);
    expect(ya.query).not.toHaveBeenCalled();

    const sameDay = await client.callTool({ name: 'analytics_overview', arguments: { startDate: '2024-02-29', endDate: '2024-02-29' } });
    expect(sameDay.isError).toBeFalsy();
  });

  it('returns a clear error when not logged in', async () => {
    const client = await connect(analyticsFactory(emptyStore));
    const result = await client.callTool({ name: 'analytics_overview', arguments: range });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Not logged in. Run `yt-core-mcp auth` in a terminal.' }]);
  });
});
