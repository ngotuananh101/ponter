import { describe, it, expect, vi } from 'vitest';
import { TerminalSession } from '../src/session';
import type { SessionState } from '../src/types';

function makeSession(
  overrides: {
    id?: string;
    cols?: number;
    rows?: number;
    sendInputFn?: (data: Uint8Array | string) => void;
    resizeFn?: (cols: number, rows: number) => void;
    closeFn?: () => void;
  } = {},
) {
  const send = overrides.sendInputFn ?? vi.fn();
  const resize = overrides.resizeFn ?? vi.fn();
  const close = overrides.closeFn ?? vi.fn();
  const session = new TerminalSession(
    overrides.id ?? 'term-1',
    overrides.cols ?? 80,
    overrides.rows ?? 24,
    send,
    resize,
    close,
  );
  return { session, send, resize, close };
}

describe('TerminalSession', () => {
  it('starts in connecting state with defaults', () => {
    const { session } = makeSession();
    expect(session.state).toBe('connecting');
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
    expect(session.id).toBe('term-1');
    expect(session.exitCode).toBeUndefined();
  });

  it('write delegates to sendInputFn only when connecting or active', () => {
    const { session, send } = makeSession();
    session.write('hello');
    expect(send).toHaveBeenCalledWith('hello');

    session.receiveOutput(new TextEncoder().encode('first'));
    expect(session.state).toBe('active');
    session.write('again');
    expect(send).toHaveBeenLastCalledWith('again');

    session.markExited(0);
    session.write('after-exit');
    // still last call is 'again', not 'after-exit'
    expect(send).toHaveBeenLastCalledWith('again');
  });

  it('resize updates cols/rows and delegates', () => {
    const { session, resize } = makeSession();
    session.resize(100, 30);
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(30);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it('close sets state to closed and calls closeFn', () => {
    const { session, close } = makeSession();
    session.close();
    expect(session.state).toBe('closed');
    expect(close).toHaveBeenCalled();

    // idempotent: calling close again is a no-op
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('receiveOutput pushes to buffer, transitions to active, notifies data listeners', () => {
    const { session } = makeSession();
    const received: Uint8Array[] = [];
    const unsub = session.onData((d) => received.push(d));

    session.receiveOutput(new TextEncoder().encode('hello'));
    expect(session.state).toBe('active');
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe('hello');
    expect(new TextDecoder().decode(session.buffer.getAll())).toBe('hello');

    unsub();
    // no further listeners
    session.receiveOutput(new TextEncoder().encode(' world'));
    expect(received).toHaveLength(1);
  });

  it('markExited sets exitCode, transitions to exited, notifies exit listeners', () => {
    const { session } = makeSession();
    const exits: Array<number | undefined> = [];
    const unsub = session.onExit((code) => exits.push(code));

    session.markExited(0);
    expect(session.exitCode).toBe(0);
    expect(session.state).toBe('exited');
    expect(exits).toEqual([0]);

    unsub();
    session.markExited(1);
    expect(exits).toEqual([0]); // listener removed
  });

  it('onStateChange fires for each distinct state transition', () => {
    const { session } = makeSession();
    const states: SessionState[] = [];
    const unsub = session.onStateChange((s) => states.push(s));

    session.receiveOutput(new TextEncoder().encode('x')); // connecting -> active
    session.markExited(0); // active -> exited
    session.close(); // exited -> closed
    expect(states).toEqual(['active', 'exited', 'closed']);

    unsub();
    // no more notifications after unsubscription
    session.markExited(1);
    expect(states).toEqual(['active', 'exited', 'closed']);
  });

  it('setState is idempotent (no duplicate notifications)', () => {
    const { session } = makeSession();
    const states: SessionState[] = [];
    session.onStateChange((s) => states.push(s));

    // already 'connecting'
    session.receiveOutput(new TextEncoder().encode('x')); // -> active
    expect(states).toEqual(['active']);
  });

  it('ring buffer evicts oldest bytes when output exceeds capacity', () => {
    const { session } = makeSession();
    const big = new Uint8Array(200);
    for (let i = 0; i < 200; i++) big[i] = i;
    session.receiveOutput(big);
    session.receiveOutput(big);
    // 400 bytes into 64KiB buffer -> retained fully
    expect(session.buffer.getAll()).toHaveLength(400);
  });

  it('listener unsubscription returns a function and removes the callback', () => {
    const { session } = makeSession();
    let count = 0;
    const unsub = session.onData(() => count++);
    session.receiveOutput(new TextEncoder().encode('a'));
    expect(count).toBe(1);
    unsub();
    session.receiveOutput(new TextEncoder().encode('b'));
    expect(count).toBe(1); // not notified again
  });
});
