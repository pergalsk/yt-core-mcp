import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confirmAction } from './confirm.js';
import { runTool, untrustedResult } from './result.js';
import type { YouTubeFactory } from './youtube.js';

export function registerCommentTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'comment_list',
    {
      title: 'List comments',
      description:
        'Lists top-level comment threads of a video (YouTube Data API commentThreads.list). Costs 1 quota unit. ' +
        'Use topLevelCommentId as parentId for comment_reply.',
      inputSchema: {
        videoId: z.string().regex(/^[\w-]{11}$/).describe('YouTube video id.'),
        order: z.enum(['time', 'relevance']).default('time'),
        maxResults: z.number().int().min(1).max(100).default(20).describe('Results per page (1-100).'),
        pageToken: z.string().max(200).optional().describe('nextPageToken from a previous call.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(async () => {
        const res = await yt('comments').commentThreads.list({
          part: ['snippet'],
          videoId: args.videoId,
          order: args.order,
          maxResults: args.maxResults,
          textFormat: 'plainText',
          ...(args.pageToken !== undefined && { pageToken: args.pageToken }),
        });
        return untrustedResult({
          nextPageToken: res.data.nextPageToken ?? null,
          items: (res.data.items ?? []).map((t) => {
            const c = t.snippet?.topLevelComment;
            return {
              threadId: t.id,
              topLevelCommentId: c?.id,
              author: c?.snippet?.authorDisplayName,
              text: c?.snippet?.textDisplay,
              likeCount: c?.snippet?.likeCount,
              publishedAt: c?.snippet?.publishedAt,
              totalReplyCount: t.snippet?.totalReplyCount,
              canReply: t.snippet?.canReply,
            };
          }),
        });
      }),
  );

  server.registerTool(
    'comment_reply',
    {
      title: 'Reply to comment',
      description:
        'Posts a public reply to a comment (YouTube Data API comments.insert). Costs 50 quota units. ' +
        'The user must confirm the reply in the client; refused if the client cannot ask for confirmation.',
      inputSchema: {
        parentId: z.string().min(1).max(200).describe('Id of the top-level comment to reply to (topLevelCommentId).'),
        text: z.string().min(1).max(10000).describe('Reply text.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      runTool(async () => {
        await confirmAction(server, `Post this public reply to comment ${args.parentId}?\n\n${args.text}`);
        const res = await yt('comments').comments.insert({
          part: ['snippet'],
          requestBody: { snippet: { parentId: args.parentId, textOriginal: args.text } },
        });
        const result = { id: res.data.id, parentId: args.parentId };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }),
  );
}
