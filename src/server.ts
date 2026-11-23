import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { checkRefreshToken } from './auth/client.js';
import { loadConfig, SERVER_VERSION } from './config.js';
import { grantedGroups, ALL_GROUPS, SHARED_SCOPE_NOTE } from './auth/scopes.js';
import { TokenStore } from './auth/token-store.js';
import { analyticsFactory, registerAnalyticsTools } from './tools/analytics.js';
import { registerCaptionTools } from './tools/captions.js';
import { registerCommentTools } from './tools/comments.js';
import { registerDeleteTools } from './tools/delete.js';
import { registerLiveTools } from './tools/live.js';
import { jsonResult, runTool } from './tools/result.js';
import { registerSearchTools } from './tools/search.js';
import { registerUploadAndPlaylistTools } from './tools/upload-playlists.js';
import { registerVideoTools } from './tools/videos.js';
import { youtubeFactory, type YouTubeFactory } from './tools/youtube.js';

export function createServer(store = new TokenStore(), yt: YouTubeFactory = youtubeFactory(store)): McpServer {
  const server = new McpServer({ name: 'yt-core-mcp', version: SERVER_VERSION });

  server.registerTool(
    'auth_status',
    {
      title: 'Auth status',
      description:
        'Shows whether yt-core-mcp is logged in to YouTube, whether the stored token still works, ' +
        'which permission groups are granted and the resolved config (default timezone and region, ' +
        'whether the media folder is set). ' +
        'Login itself can only be done by the user in a terminal (`yt-core-mcp auth`).',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      runTool(async () => {
        let result: Record<string, unknown>;
        try {
          const stored = store.load();
          const granted = stored ? grantedGroups(stored.scopes) : [];
          result = {
            loggedIn: stored !== null,
            grantedGroups: granted,
            notGranted: ALL_GROUPS.filter((g) => !granted.includes(g)),
            sharedScopes: SHARED_SCOPE_NOTE,
          };
          if (stored) {
            const tokenError = await checkRefreshToken(stored.refreshToken);
            result.tokenValid = tokenError === null;
            if (tokenError !== null) {
              result.tokenError = `${tokenError} — run \`yt-core-mcp auth\` in a terminal to log in again.`;
            }
          }
        } catch (err) {
          result = { loggedIn: false, error: err instanceof Error ? err.message : 'Unknown error' };
        }
        const config = loadConfig();
        result.config = { timezone: config.timezone, region: config.region, mediaRootSet: Boolean(config.mediaRoot) };
        return jsonResult(result);
      }),
  );

  registerSearchTools(server, yt);
  registerUploadAndPlaylistTools(server, yt);
  registerCaptionTools(server, yt);
  registerVideoTools(server, yt);
  registerCommentTools(server, yt);
  registerAnalyticsTools(server, analyticsFactory(store));
  registerDeleteTools(server, yt);
  registerLiveTools(server, yt);

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
