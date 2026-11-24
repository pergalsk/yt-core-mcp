import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { confirmAction, confirmPrivacy } from './confirm.js';

function fakeServer(elicitation: boolean, answer: ElicitResult = { action: 'accept', content: { confirm: true } }) {
  const elicitInput = vi.fn().mockResolvedValue(answer);
  const server = {
    server: { getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}), elicitInput },
  } as unknown as McpServer;
  return { server, elicitInput };
}

describe('confirmAction', () => {
  it('resolves when the user checks confirm', async () => {
    const { server, elicitInput } = fakeServer(true);
    await expect(confirmAction(server, 'Delete it?')).resolves.toBeUndefined();
    expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({ mode: 'form', message: 'Delete it?' }));
  });

  it('refuses without asking when the client does not support elicitation', async () => {
    const { server, elicitInput } = fakeServer(false);
    await expect(confirmAction(server, 'Delete it?')).rejects.toThrow(/does not support elicitation/);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it.each<ElicitResult>([
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { confirm: false } },
    { action: 'accept' },
  ])('throws when not confirmed (%o)', async (answer) => {
    const { server } = fakeServer(true, answer);
    await expect(confirmAction(server, 'Delete it?')).rejects.toThrow(/not confirmed/);
  });
});

describe('confirmPrivacy', () => {
  it.each([
    ['public', undefined],
    ['unlisted', undefined],
    ['public', 'private'],
    ['unlisted', 'public'],
  ])('asks when going %s from %s', async (next, current) => {
    const { server, elicitInput } = fakeServer(true);
    await confirmPrivacy(server, 'video "X"', next, current);
    expect(elicitInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(`Make video "X" ${next}?`) as unknown }),
    );
  });

  it.each([
    ['private', 'public'],
    ['public', 'public'],
    ['unlisted', 'unlisted'],
    [undefined, 'private'],
  ])('does not ask when going %s from %s', async (next, current) => {
    const { server, elicitInput } = fakeServer(false);
    await expect(confirmPrivacy(server, 'x', next, current)).resolves.toBeUndefined();
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it('throws when declined', async () => {
    const { server } = fakeServer(true, { action: 'decline' });
    await expect(confirmPrivacy(server, 'x', 'public')).rejects.toThrow(/not confirmed/);
  });
});
