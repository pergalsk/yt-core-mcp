import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DELETE } from './annotations.js';
import { confirmAction } from './confirm.js';
import { runTool } from './result.js';
import { resourceId, videoId } from './schemas.js';
import type { YouTubeFactory } from './youtube.js';

/** Asks the user to confirm deleting `what` (refuses if not found or not confirmed), then runs `del`. */
async function confirmAndDelete(
  server: McpServer,
  what: string,
  title: string | null | undefined,
  del: () => Promise<unknown>,
): Promise<CallToolResult> {
  if (title === undefined) throw new Error(`${what} not found (or not yours). Nothing was deleted.`);
  await confirmAction(server, `Permanently delete ${what}: "${title ?? '(no title)'}"? This cannot be undone.`);
  await del();
  return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, what }, null, 2) }] };
}

export function registerDeleteTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'video_delete',
    {
      title: 'Delete video',
      description:
        'Permanently deletes one of your videos (videos.delete). Costs 51 quota units. ' +
        'The user must confirm in the client; refused if the client cannot ask for confirmation.',
      inputSchema: { videoId },
      annotations: DELETE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const res = await api.videos.list({ part: ['snippet'], id: [args.videoId] });
        const item = res.data.items?.[0];
        return confirmAndDelete(server, `video ${args.videoId}`, item && item.snippet?.title, () =>
          api.videos.delete({ id: args.videoId }),
        );
      }),
  );

  server.registerTool(
    'live_delete_broadcast',
    {
      title: 'Delete live broadcast',
      description:
        'Permanently deletes one of your live broadcasts (liveBroadcasts.delete). Costs 51 quota units. ' +
        'The user must confirm in the client; refused if the client cannot ask for confirmation.',
      inputSchema: { broadcastId: resourceId },
      annotations: DELETE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const res = await api.liveBroadcasts.list({ part: ['snippet'], id: [args.broadcastId] });
        const item = res.data.items?.[0];
        return confirmAndDelete(server, `live broadcast ${args.broadcastId}`, item && item.snippet?.title, () =>
          api.liveBroadcasts.delete({ id: args.broadcastId }),
        );
      }),
  );

  server.registerTool(
    'playlist_remove_item',
    {
      title: 'Remove video from playlist',
      description:
        'Removes an item from one of your playlists (playlistItems.delete). Costs 51 quota units. ' +
        'Takes the playlist item id (e.g. from playlist_add_item), not the video id. ' +
        'The user must confirm in the client; refused if the client cannot ask for confirmation.',
      inputSchema: { playlistItemId: resourceId },
      annotations: DELETE,
    },
    (args) =>
      runTool(async () => {
        const api = yt('core');
        const res = await api.playlistItems.list({ part: ['snippet'], id: [args.playlistItemId] });
        const item = res.data.items?.[0];
        return confirmAndDelete(server, `playlist item ${args.playlistItemId}`, item && item.snippet?.title, () =>
          api.playlistItems.delete({ id: args.playlistItemId }),
        );
      }),
  );
}
