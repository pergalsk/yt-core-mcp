import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { grantedGroups, ALL_GROUPS } from './auth/scopes.js';
import { TokenStore } from './auth/token-store.js';
import { registerCaptionTools } from './tools/captions.js';
import { registerCommentTools } from './tools/comments.js';
import { registerSearchTools } from './tools/search.js';
import { registerVideoTools } from './tools/videos.js';
import { youtubeFactory, type YouTubeFactory } from './tools/youtube.js';

export function createServer(store = new TokenStore(), yt: YouTubeFactory = youtubeFactory(store)): McpServer {
  const server = new McpServer({ name: 'yt-core-mcp', version: '0.1.0' });

  server.registerTool(
    'auth_status',
    {
      title: 'Auth status',
      description:
        'Shows whether yt-core-mcp is logged in to YouTube and which permission groups are granted. ' +
        'Login itself can only be done by the user in a terminal (`yt-core-mcp auth`).',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => {
      let result: Record<string, unknown>;
      try {
        const stored = store.load();
        const granted = stored ? grantedGroups(stored.scopes) : [];
        result = {
          loggedIn: stored !== null,
          grantedGroups: granted,
          notGranted: ALL_GROUPS.filter((g) => !granted.includes(g)),
        };
      } catch (err) {
        result = { loggedIn: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerSearchTools(server, yt);
  registerCaptionTools(server, yt);
  registerVideoTools(server, yt);
  registerCommentTools(server, yt);

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
