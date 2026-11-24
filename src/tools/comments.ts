import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confirmAction } from './confirm.js';
import { READ_ONLY, WRITE } from './annotations.js';
import { jsonResult, runTool, untrustedResult } from './result.js';
import { pageToken, videoId } from './schemas.js';
import type { YouTubeFactory } from './youtube.js';

export function registerCommentTools(server: McpServer, yt: YouTubeFactory): void {
  server.registerTool(
    'comment_list',
    {
      title: 'List comments',
      description:
        'Lists top-level comment threads of a video (YouTube Data API commentThreads.list). Costs 1 quota unit. ' +
        'Needs the `engagement` permission group. ' +
        'Use topLevelCommentId as parentId for comment_reply.',
      inputSchema: {
        videoId,
        order: z.enum(['time', 'relevance']).default('time'),
        maxResults: z.number().int().min(1).max(100).default(20).describe('Results per page (1-100).'),
        pageToken,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(async () => {
        const res = await yt('engagement').commentThreads.list({
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
        'Needs the `engagement` permission group. ' +
        'The user must confirm the reply in the client; refused if the client cannot ask for confirmation.',
      inputSchema: {
        parentId: z.string().min(1).max(200).describe('Id of the top-level comment to reply to (topLevelCommentId).'),
        text: z.string().min(1).max(10000).describe('Reply text.'),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(async () => {
        await confirmAction(server, `Post this public reply to comment ${args.parentId}?\n\n${args.text}`);
        const res = await yt('engagement').comments.insert({
          part: ['snippet'],
          requestBody: { snippet: { parentId: args.parentId, textOriginal: args.text } },
        });
        return jsonResult({ id: res.data.id, parentId: args.parentId });
      }),
  );
}
