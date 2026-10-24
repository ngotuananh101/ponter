// apps/agent/test/runtime.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  FilesTicker,
  IDLE_TICK_MS,
  resolveDefaultSource,
} from '../src/runtime.js';
import { FILES_IDLE_TIMEOUT_MS } from '../src/files/protocol.js';
import type { AgentConfig } from '../src/config.js';

const sources = {
  monitors: [
    { id: '1', primary: false },
    { id: '2', primary: true },
  ],
};

describe('resolveDefaultSource', () => {
  it('prefers the primary monitor by default', () => {
    expect(resolveDefaultSource('primary', sources)).toEqual({
      kind: 'monitor',
      id: '2',
    });
  });

  it('honours an explicit monitor id', () => {
    expect(resolveDefaultSource('monitor:1', sources)).toEqual({
      kind: 'monitor',
      id: '1',
    });
  });

  it('falls back to the first monitor when none is flagged primary', () => {
    const flat = { monitors: [{ id: '7', primary: false }] };
    expect(resolveDefaultSource('primary', flat)).toEqual({
      kind: 'monitor',
      id: '7',
    });
  });

  it('resolves the test source', () => {
    expect(resolveDefaultSource('test', sources)).toEqual({ kind: 'test' });
  });

  it('throws a named error when there are no sources at all', () => {
    expect(() => resolveDefaultSource('primary', { monitors: [] })).toThrow(
      /no monitors/,
    );
  });

  it('throws for an unknown selector rather than silently picking one', () => {
    // A typo in AGENT_DESKTOP_DEFAULT_SOURCE must fail at startup. Defaulting
    // would stream the wrong monitor and look like a capture bug.
    expect(() => resolveDefaultSource('moniter:1', sources)).toThrow(
      /unknown desktop source/,
    );
  });
});

describe('FilesTicker', () => {
  /**
   * **R3: the production tick owner.** `checkIdle()` and `flushAcks()` were
   * defined and never called outside the fences — measured at B-12g's commit:
   * `setInterval` appeared **0** times in the whole document, and `checkIdle`'s
   * only callers were two assertions inside Task 11's session fence. A state
   * machine with an idle deadline and a 20 ms ack flush, driven by nobody,
   * never fires either one: a stalled transfer is never reaped and a low-rate
   * upload never acknowledges. This follow-up wires the driver (MAJOR-1) — the
   * `AgentRuntime` wiring tests at the end of this file own the intervals; the
   * class here keeps the injected clock so no test sleeps.
   *
   * The Rust drove both from `lib.rs:1852-1858`, ticked at `:1890` and
   * `:1898-1899` — 1 s for idle, 20 ms for acks. The port keeps the injected
   * clock: `now` is a parameter here exactly as it is in `FilesSession`, so
   * the tick is testable by advancing a number rather than by sleeping.
   */
  function ticker() {
    const calls: string[] = [];
    const session = {
      // `(): unknown[] => …`, not a bare `() => []`: the bare arrow infers
      // `never[]`, so `mockReturnValue([idleFrame])` in the emit test is
      // unassignable and the mock can only ever return `[]` — a type-level
      // vacuity (MAJOR-6 item 3: the annotation is the fix; the type was
      // hiding it).
      checkIdle: vi.fn((): unknown[] => {
        calls.push('idle');
        return [];
      }),
      flushAcks: vi.fn((): unknown[] => {
        calls.push('acks');
        return [];
      }),
    };
    const emit = vi.fn();
    let now = 0;
    const t = new FilesTicker(session, {
      now: () => now,
      emit,
    });
    return {
      session,
      emit,
      calls,
      t,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('calls checkIdle once per 1000 ms of elapsed time', () => {
    const { t, session, advance } = ticker();
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled(); // no time has passed
    advance(999);
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled();
    advance(1);
    t.tick();
    expect(session.checkIdle).toHaveBeenCalledTimes(1);
  });

  it('calls flushAcks once per 20 ms of elapsed time', () => {
    const { t, session, advance } = ticker();
    advance(19);
    t.tick();
    expect(session.flushAcks).not.toHaveBeenCalled();
    advance(1);
    t.tick();
    expect(session.flushAcks).toHaveBeenCalledTimes(1);
  });

  it('catches up on idle ticks it slept through, rather than dropping them', () => {
    // A tick interval that overshoots must not lose a reap: the idle deadline
    // is wall-clock, so skipping a `checkIdle` because the timer was 3 s late
    // leaves a timed-out transfer alive for another full period.
    const { t, session, advance } = ticker();
    advance(3_500);
    t.tick();
    expect(session.checkIdle).toHaveBeenCalledTimes(3);
  });

  it('emits whatever either tick returns', () => {
    const { t, session, emit, advance } = ticker();
    const idleFrame = { type: 'files-error', code: 'TRANSFER_TIMEOUT' };
    const ackFrame = { type: 'files-upload-ack', nextChunkIndex: 16 };
    session.checkIdle.mockReturnValue([idleFrame]);
    session.flushAcks.mockReturnValue([ackFrame]);
    advance(1_000);
    t.tick();
    expect(emit).toHaveBeenCalledWith(idleFrame);
    expect(emit).toHaveBeenCalledWith(ackFrame);
  });

  it('stops ticking after stop()', () => {
    const { t, session, advance } = ticker();
    t.stop();
    advance(5_000);
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled();
    expect(session.flushAcks).not.toHaveBeenCalled();
  });
});

describe('AgentRuntime — the production tick wiring (MAJOR-1)', () => {
  /**
   * **MAJOR-1: the driver must be wired, not merely defined.** The ticker tests
   * above prove the state machine; these prove the runtime actually constructs
   * it and clears its intervals on `stop()`. They use the real
   * `setInterval`/`clearInterval` under `vi.useFakeTimers()`, so the handles
   * are the production ones — a wiring test that mocked the timer would prove
   * nothing about `setInterval` ownership. The session is injected through the
   * `filesSession` seam so the emitted frame is observable without a real
   * `FilesSession` root; the production values of that seam are themselves
   * covered by Task 11's `FilesSession` fence.
   */
  function wiring(overrides: Partial<AgentConfig> = {}) {
    const config = {
      filesRoot: '/data',
      desktopProfile: { id: '720p30' },
      ...overrides,
    } as unknown as AgentConfig;
    const sent: { label: string; frame: unknown }[] = [];
    const session = {
      // One frame, not an empty list: test 3 asserts the guard by absence, and
      // a session whose `checkIdle` never emits makes the empty-array assertion
      // pass even with the guard deleted (the fixture-vacuity class). The
      // shape is test 1's frame so the assertion has a real violation to
      // forbid.
      checkIdle: vi.fn(
        () => [{ type: 'files-error', code: 'TRANSFER_TIMEOUT' }] as unknown[],
      ),
      flushAcks: vi.fn(() => [] as unknown[]),
    };
    const deps = {
      send: (label: string, frame: unknown) => sent.push({ label, frame }),
      // Real clock, not a constant: `FilesTicker.tick()` computes
      // `now - lastIdleAt`, so a constant closure freezes that at 0 forever
      // and no tick ever runs (the frozen-clock defect this fence shipped
      // with). `vi.useFakeTimers()` mocks `Date.now`, so the closure must
      // actually call it for `advanceTimersByTimeAsync` to move it.
      now: () => Date.now(),
      filesSession: () => session,
    };
    return { config, deps, sent, session };
  }

  it('drives the files session from real intervals and emits idle frames through send', async () => {
    vi.useFakeTimers();
    try {
      const { config, deps, sent, session } = wiring();
      session.checkIdle = vi.fn(() => [
        { type: 'files-error', code: 'TRANSFER_TIMEOUT' },
      ]);
      const runtime = await AgentRuntime.start(config, deps);
      expect(sent).toEqual([]);
      // One idle period: `checkIdle` runs once and its frame goes out on the
      // `files` channel — the label Task 18's router serves.
      await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
      expect(session.checkIdle).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([
        {
          label: 'files',
          frame: { type: 'files-error', code: 'TRANSFER_TIMEOUT' },
        },
      ]);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears the tick intervals so no late tick fires', async () => {
    vi.useFakeTimers();
    try {
      const { config, deps, sent, session } = wiring();
      session.checkIdle = vi.fn(() => [
        { type: 'files-error', code: 'TRANSFER_TIMEOUT' },
      ]);
      const runtime = await AgentRuntime.start(config, deps);
      await runtime.stop();
      // Well past several idle periods: nothing fires, because the handles are
      // cleared. Without the clearing this emits one frame per elapsed period.
      await vi.advanceTimersByTimeAsync(FILES_IDLE_TIMEOUT_MS * 3);
      expect(session.checkIdle).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the ticker entirely when the config has no files root', async () => {
    // The Rust's files manager is `Option<FilesManager>`; a config without a
    // root must not open one, and must not tick a session that does not exist.
    // The fixture emits (checkIdle returns a frame, exactly like test 1's) so
    // the `[]` assertion has something to be violated by: a session whose
    // checkIdle never emits would pass with the guard deleted, the same
    // vacuous-fixture class as the detach case (PM probe forkE — 59 leaked
    // frames when the guard is gone). `Date.now()` in `wiring()` is
    // load-bearing too: a constant closure (`now: () => 1_000_000`) freezes
    // the ticker's catch-up arithmetic at `now - lastIdleAt = 0` forever —
    // fake timers mock `Date.now` and cannot move a closure that never calls
    // it.
    vi.useFakeTimers();
    try {
      const { config, deps, sent } = wiring({ filesRoot: null });
      const runtime = await AgentRuntime.start(config, deps);
      await vi.advanceTimersByTimeAsync(FILES_IDLE_TIMEOUT_MS * 2);
      expect(sent).toEqual([]);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('status() reports the config it was started with', async () => {
    // MAJOR-6 item 4: `status()` is the only runtime member with no caller
    // anywhere in the fence — its five config fields are exactly what the
    // constructor wiring exists to produce, and the landed class (no
    // constructor) could not have compiled this call. `start` with no
    // `filesSession` and no `filesRoot` keeps the interval wiring out of the
    // assertion; the assertion reads what the wiring produced, not the
    // process.
    const config = {
      agentId: 'agent-1',
      server: 'wss://host/x',
      filesRoot: null,
      allowInput: true,
      desktopProfile: { id: '720p30' },
    } as unknown as AgentConfig;
    const runtime = await AgentRuntime.start(config);
    try {
      expect(runtime.status()).toEqual({
        agentId: 'agent-1',
        connected: false,
        server: 'wss://host/x',
        filesRoot: null,
        allowInput: true,
        desktopProfile: '720p30',
      });
    } finally {
      await runtime.stop();
    }
  });
});
