import { describe, expect, it } from 'vitest';
import { AuthRequiredError } from '../auth/client.js';
import { errorResult, runTool, untrustedResult, UNTRUSTED_NOTICE } from './result.js';

describe('tool results', () => {
  it('wraps data with an untrusted-content notice', () => {
    const result = untrustedResult({ title: 'x' });
    const content = result.content[0];
    expect(content?.type).toBe('text');
    expect(JSON.parse(content?.type === 'text' ? content.text : '')).toEqual({
      notice: UNTRUSTED_NOTICE,
      untrustedData: { title: 'x' },
    });
  });

  it('passes auth errors through unchanged', () => {
    const result = errorResult(new AuthRequiredError('Not logged in. Run `yt-core-mcp auth` in a terminal.'));
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Not logged in. Run `yt-core-mcp auth` in a terminal.' }],
    });
  });

  it('turns a revoked refresh token into a re-login hint', () => {
    expect(errorResult(new Error('invalid_grant')).content).toEqual([
      { type: 'text', text: 'Login expired or was revoked. Run `yt-core-mcp auth` in a terminal.' },
    ]);
  });

  it('runTool catches thrown errors', async () => {
    const result = await runTool(() => Promise.reject(new Error('boom')));
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  });
});
