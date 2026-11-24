import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Asks the user to confirm an action via MCP elicitation. Throws (so `runTool` returns a tool error)
 * if the client does not support elicitation or the user does not confirm.
 */
export async function confirmAction(server: McpServer, message: string): Promise<void> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new Error('This action needs user confirmation, but the MCP client does not support elicitation. Refused.');
  }
  const res = await server.server.elicitInput({
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Confirm', description: 'Check to confirm this action.' } },
      required: ['confirm'],
    },
  });
  if (res.action !== 'accept' || res.content?.['confirm'] !== true) {
    throw new Error('Action was not confirmed by the user. Nothing was done.');
  }
}

/**
 * Asks the user to confirm when `next` privacy is public or unlisted and differs from `current`
 * (undefined for new items). Going private or keeping the same value needs no confirmation.
 */
export async function confirmPrivacy(
  server: McpServer,
  what: string,
  next: string | null | undefined,
  current?: string | null,
): Promise<void> {
  if ((next !== 'public' && next !== 'unlisted') || next === current) return;
  await confirmAction(
    server,
    `Make ${what} ${next}? ${next === 'public' ? 'Anyone can find it' : 'Anyone with the link can see it'}.`,
  );
}
