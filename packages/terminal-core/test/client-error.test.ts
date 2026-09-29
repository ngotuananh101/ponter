import { describe, it, expect, vi } from 'vitest';
import { TerminalClient } from '../src/client';
import type { DataChannelManager } from '@ponter/webrtc-core';
import type { DataChannelMessage } from '@ponter/shared';

// The agent could not previously tell the browser that a terminal failed: a
// refused PTY spawn was a `tracing::warn!` on the agent and nothing at all in
// the browser, which showed a terminal that opened and stayed blank forever.
describe('TerminalClient terminal-error', () => {
  function setup(): {
    client: TerminalClient;
    deliver: (msg: DataChannelMessage) => void;
  } {
    let handler: ((msg: DataChannelMessage) => void) | undefined;
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn(
        (_channel: string, cb: (m: DataChannelMessage) => void) => {
          handler = cb;
          return () => {};
        },
      ),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    return { client, deliver: (m) => handler?.(m) };
  }

  it('reports a failed spawn to the subscriber', () => {
    const { client, deliver } = setup();
    const onError = vi.fn();
    client.onError(onError);

    const session = client.createSession({ cols: 80, rows: 24 });

    deliver({
      type: 'terminal-error',
      channel: 'terminal',
      payload: {
        terminalId: session.id,
        code: 'pty-spawn-failed',
        message: 'no such shell: /nope',
      },
      timestamp: 1,
    } as unknown as DataChannelMessage);

    expect(onError).toHaveBeenCalledTimes(1);
    const [message] = onError.mock.calls[0]!;
    expect(message).toContain('no such shell');
  });

  it('ignores an error aimed at a terminal this client does not own', () => {
    // Otherwise a stray or replayed frame would blank an unrelated tab.
    const { client, deliver } = setup();
    const onError = vi.fn();
    client.onError(onError);
    client.createSession({ cols: 80, rows: 24 });

    deliver({
      type: 'terminal-error',
      channel: 'terminal',
      payload: {
        terminalId: 'someone-elses-terminal',
        code: 'pty-spawn-failed',
        message: 'nope',
      },
      timestamp: 1,
    } as unknown as DataChannelMessage);

    expect(onError).not.toHaveBeenCalled();
  });

  it('does not treat a terminal-error as terminal-data', () => {
    const { client, deliver } = setup();
    const session = client.createSession({ cols: 80, rows: 24 });
    client.onError(vi.fn());

    deliver({
      type: 'terminal-error',
      channel: 'terminal',
      payload: {
        terminalId: session.id,
        code: 'pty-spawn-failed',
        message: 'nope',
      },
      timestamp: 1,
    } as unknown as DataChannelMessage);

    // A failed spawn leaves the session `connecting`, not `active` and not
    // `exited` — the tab shows the error until the user retries.
    expect(session.state).toBe('connecting');
  });
});
