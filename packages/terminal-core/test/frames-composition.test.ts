// packages/terminal-core/test/frames-composition.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { DataChannelMessage } from '@ponter/shared';
import type { RTCDataChannelLike } from '@ponter/webrtc-core';
import { DataChannelManager } from '@ponter/webrtc-core';
import { TerminalClient } from '../src/client';
import {
  buildTerminalDataFrame,
  buildTerminalErrorFrame,
  buildTerminalExitFrame,
} from '../../../apps/agent/src/terminal/frames';

/**
 * **The composition axis.** Task 27's defect hid here: `pty.test.ts` asserts
 * `PtyManager`'s callbacks, the router fence asserts the arms it has, and the
 * browser — the only reader of the wire — is the observer of neither. So these
 * cells drive the agent's **real builders** into the browser's **real client**
 * through `webrtc-core`'s **real** data-channel manager, and assert what a user
 * of the terminal sees: decoded bytes, an exited session, an error message.
 *
 * No `as never` and no hand-built envelopes: if a builder's field is renamed or
 * its `channel` changes, this file fails to compile or the frame is dropped
 * before it reaches a session — which is exactly what happens in production.
 */

function fakeBrowserChannel(label: string) {
  const handlers: ((data: string | ArrayBuffer) => void)[] = [];
  const channel: RTCDataChannelLike = {
    label,
    readyState: 'open',
    send: vi.fn(),
    close: vi.fn(),
    onMessage: (handler) => {
      handlers.push(handler);
    },
    onStateChange: () => {},
  };
  return {
    channel,
    /**
     * Deliver a wire frame the way a real channel delivers it: **a string**.
     * `webrtc-core`'s typed listener only dispatches when `typeof data ===
     * 'string'` (`data-channel.ts:32`), which is why the builders return
     * objects and the transport serialises them — asserted here rather than
     * assumed, because an object delivered directly would be a silent drop.
     */
    deliver: (frame: unknown) => {
      const text = JSON.stringify(frame);
      for (const handler of handlers) handler(text);
    },
  };
}

function connected() {
  const manager = new DataChannelManager();
  const { channel, deliver } = fakeBrowserChannel('terminal');
  manager.registerChannel(channel);
  const client = new TerminalClient('agent-1', manager);
  return { client, manager, deliver };
}

describe('TerminalClient reading frames the agent builds', () => {
  it('renders the bytes a terminal-data frame carries', () => {
    // The reader's operation, end to end: base64 in `payload.data` →
    // `atob`/`Buffer.from` → `session.receiveOutput`. Raw bytes, including a
    // truncated UTF-8 sequence, because ADR-10's payload is bytes.
    const { client, deliver } = connected();
    const session = client.createSession();
    const received: number[] = [];
    session.onData((chunk) => received.push(...chunk));

    const raw = Buffer.from([0x68, 0x69, 0x00, 0xff]);
    // Inject the clock so the frame is pinnable — the builder never reads it.
    deliver(buildTerminalDataFrame(session.id, raw.toString('base64'), 1_000));

    expect(received).toEqual([...raw]);
  });

  it('marks the session exited with the code a terminal-exit frame carries', () => {
    const { client, deliver } = connected();
    const session = client.createSession();
    const exitCodes: (number | undefined)[] = [];
    session.onExit((code) => exitCodes.push(code));

    deliver(buildTerminalExitFrame(session.id, 42, 1_000));

    expect(session.state).toBe('exited');
    expect(session.exitCode).toBe(42);
    expect(exitCodes).toEqual([42]);
  });

  it('marks the session exited with no code when the frame carries null', () => {
    // The `null` polarity of §2.2. The browser's `markExited(exitCode?: number)`
    // treats `null` the same as `undefined`, so the wire keeps the key (the
    // Rust's `Option<u32>` without `skip_serializing_if`) and the reader is
    // unaffected.
    const { client, deliver } = connected();
    const session = client.createSession();
    const exitCodes: (number | undefined)[] = [];
    session.onExit((code) => exitCodes.push(code));

    deliver(buildTerminalExitFrame(session.id, null, 1_000));

    expect(session.state).toBe('exited');
    expect(session.exitCode).toBeNull();
    expect(exitCodes).toEqual([null]);
  });

  it('surfaces the message a terminal-error frame carries', () => {
    // Without this the agent's refusal to spawn was invisible: the terminal
    // opened and stayed blank with no way to tell a missing shell from a slow
    // one (`terminal-core/src/client.ts:321-327` says so).
    const { client, deliver } = connected();
    const session = client.createSession();
    const errors: string[] = [];
    client.onError((message) => errors.push(message));

    deliver(
      buildTerminalErrorFrame(
        session.id,
        'pty-spawn-failed',
        'shell refused: /tmp/evil.sh is not in the shell allowlist',
        1_000,
      ),
    );

    expect(errors).toEqual([
      'shell refused: /tmp/evil.sh is not in the shell allowlist',
    ]);
  });

  it('ignores a frame addressed to a terminal this client does not have', () => {
    // The positive control for the four cells above: every one of them asserts
    // that a delivered frame reached a **specific** session, so a client that
    // routed every frame to every session would pass them. Here the id matches
    // nothing, and nothing may be delivered.
    const { client, deliver } = connected();
    const session = client.createSession();
    const received: number[] = [];
    session.onData((chunk) => received.push(...chunk));
    const errors: string[] = [];
    client.onError((message) => errors.push(message));

    deliver(
      buildTerminalDataFrame(
        'someone-else',
        Buffer.from('x').toString('base64'),
        1,
      ),
    );
    deliver(buildTerminalExitFrame('someone-else', 1, 1));
    deliver(
      buildTerminalErrorFrame('someone-else', 'pty-spawn-failed', 'nope', 1),
    );

    expect(received).toEqual([]);
    expect(session.state).not.toBe('exited');
    expect(errors).toEqual([]);
  });
});

/**
 * `DataChannelMessage` is the type the browser's typed listener hands its
 * subscribers (`webrtc-core/src/data-channel.ts:31-41`). Asserting the builders
 * are assignable to it here — in the **consumer's** package, against the
 * **consumer's** imported type — is the seam type gate: a `channel` typo or a
 * payload field rename is a `tsc` error in this file, not a silent drop at
 * runtime, and no cast is involved.
 */
describe('the builders satisfy the browser envelope type', () => {
  it('types each builder value as a DataChannelMessage', () => {
    const data: DataChannelMessage = buildTerminalDataFrame('t1', 'aGk=', 1);
    const exit: DataChannelMessage = buildTerminalExitFrame('t1', null, 1);
    const error: DataChannelMessage = buildTerminalErrorFrame(
      't1',
      'session-limit-reached',
      'too many',
      1,
    );
    expect([data.channel, exit.channel, error.channel]).toEqual([
      'terminal',
      'terminal',
      'terminal',
    ]);
  });
});
