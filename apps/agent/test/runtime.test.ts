// apps/agent/test/runtime.test.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  FilesTicker,
  IDLE_TICK_MS,
  resolveDefaultSource,
} from '../src/runtime.js';
import { DataChannelRouter } from '../src/session/data-channels.js';
import { ShellPolicy } from '../src/terminal/shell-policy.js';
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

describe('AgentRuntime — the terminal path (B41)', () => {
  /**
   * **The defect this closes is a composition one.** `PtyManager` had no
   * production constructor and `DataChannelRouter` had none either (measured:
   * `new PtyManager` 0 and `new DataChannelRouter` 0 in `src/`), so `AgentRuntime`'s
   * own docblock promised a pty teardown that did not exist and no `terminal-*`
   * frame was ever produced. These cells drive the **real** `PtyManager` through
   * the **real** router and read what comes out of the runtime's send seam —
   * the seam a transport binds. A fake host supplies the processes, so no shell
   * is ever spawned.
   */
  function fakePtyHost() {
    const spawned: { file: string; opts: Record<string, unknown> }[] = [];
    const procs: (EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
      onData: (cb: (chunk: string | Buffer) => void) => void;
      onExit: (cb: (event: { exitCode?: number }) => void) => void;
    })[] = [];
    const host = {
      spawn: (file: string, _args: string[], opts: Record<string, unknown>) => {
        spawned.push({ file, opts });
        const emitter = new EventEmitter();
        const p = Object.assign(emitter, {
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: (cb: (chunk: string | Buffer) => void) => {
            emitter.on('data', cb);
          },
          onExit: (cb: (event: { exitCode?: number }) => void) => {
            emitter.on('exit', cb);
          },
        });
        procs.push(p);
        return p;
      },
    };
    return { host, spawned, procs };
  }

  function terminalWiring(
    overrides: Partial<AgentConfig> = {},
    depOverrides: Record<string, unknown> = {},
  ) {
    const config = {
      filesRoot: null,
      shell: '/bin/sh',
      cols: 80,
      rows: 24,
      ...overrides,
    } as unknown as AgentConfig;
    const sent: { label: string; frame: unknown }[] = [];
    const { host, spawned, procs } = fakePtyHost();
    const deps = {
      send: (label: string, frame: unknown) => sent.push({ label, frame }),
      now: () => 1_700_000_000_000,
      pty: host,
      ...depOverrides,
    };
    return { config, deps, sent, spawned, procs };
  }

  it('emits pty output as a terminal-data frame on the terminal channel', async () => {
    const { config, deps, sent, procs } = terminalWiring();
    const runtime = await AgentRuntime.start(config, deps);
    try {
      await runtime.terminal.create({
        terminalId: 't1',
        cols: 80,
        rows: 24,
        shell: undefined,
      });
      procs[0]!.emit('data', Buffer.from('hi'));

      expect(sent).toEqual([
        {
          label: 'terminal',
          // The full envelope, asserted through the reader's operation: the
          // browser keys on `type`, drops anything whose `channel` is not
          // `terminal`, and base64-decodes `payload.data`.
          frame: {
            type: 'terminal-data',
            channel: 'terminal',
            payload: {
              terminalId: 't1',
              data: Buffer.from('hi').toString('base64'),
            },
            timestamp: 1_700_000_000_000,
          },
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it('emits the exit as a terminal-exit frame, both polarities of the code', async () => {
    const { config, deps, sent, procs } = terminalWiring();
    const runtime = await AgentRuntime.start(config, deps);
    try {
      for (const id of ['t1', 't2']) {
        await runtime.terminal.create({
          terminalId: id,
          cols: 80,
          rows: 24,
          shell: undefined,
        });
      }
      procs[0]!.emit('exit', { exitCode: 7 });
      procs[1]!.emit('exit', {});

      const frames = sent.map((s) => s.frame as Record<string, unknown>);
      expect(frames[0]).toMatchObject({
        type: 'terminal-exit',
        channel: 'terminal',
        payload: { terminalId: 't1', exitCode: 7 },
      });
      // `null`, not an absent key: Rust's `Option<u32>` has no
      // `skip_serializing_if`, so the key is always on the wire.
      expect(frames[1]).toMatchObject({
        type: 'terminal-exit',
        channel: 'terminal',
        payload: { terminalId: 't2', exitCode: null },
      });
      expect('exitCode' in (frames[1]!.payload as object)).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('stop() closes every live pty before it returns', async () => {
    // The docblock's teardown order, made observable. A pty that outlives the
    // socket is an orphan shell on the host, and the runtime is the only object
    // that knows a pty exists at all.
    const { config, deps, procs } = terminalWiring();
    const runtime = await AgentRuntime.start(config, deps);
    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      await runtime.terminal.create({
        terminalId: id,
        cols: 80,
        rows: 24,
        shell: undefined,
      });
    }
    expect(procs.every((p) => p.kill.mock.calls.length === 0)).toBe(true);

    await runtime.stop();

    expect(procs.map((p) => p.kill.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('joins the router to the manager: a terminal-create frame spawns, a resize forwards', async () => {
    // The composition seam — the axis this whole defect hid on. A
    // `DataChannelRouter` built over `runtime.terminal` (the shape `RouterDeps`
    // asks for) must reach the same `PtyManager` the runtime tears down.
    const { config, deps, spawned, procs, sent } = terminalWiring();
    const runtime = await AgentRuntime.start(config, deps);
    try {
      const router = new DataChannelRouter({
        terminal: runtime.terminal,
        files: { handle: () => [], acceptBinaryChunk: () => [] },
        desktop: { onControl: () => {}, onSelect: () => {} },
        input: { admit: () => false, decode: () => null, apply: () => null },
        send: () => {},
        logger: { warn: () => {} },
        now: () => 1_700_000_000_000,
      });
      const channel = {
        label: 'terminal',
        on: (_event: 'message', cb: (data: Uint8Array) => void) => {
          emit = (data: Uint8Array) => cb(data);
          return () => {};
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      let emit: (data: Uint8Array) => void = () => {};
      router.attach(channel);

      const envelope = (type: string, payload: Record<string, unknown>) =>
        new TextEncoder().encode(
          JSON.stringify({ type, channel: 'terminal', payload, timestamp: 0 }),
        );

      emit(
        envelope('terminal-create', { terminalId: 't1', cols: 100, rows: 30 }),
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.file).toBe('/bin/sh');
      expect(spawned[0]!.opts).toMatchObject({ cols: 100, rows: 30 });

      emit(
        envelope('terminal-resize', { terminalId: 't1', cols: 120, rows: 40 }),
      );
      expect(procs[0]!.resize).toHaveBeenCalledWith(120, 40);

      emit(envelope('terminal-data', { terminalId: 't1', data: 'bHM=' }));
      expect(procs[0]!.write).toHaveBeenCalledWith(Buffer.from([0x6c, 0x73]));

      procs[0]!.emit('data', Buffer.from('out'));
      expect(sent.at(-1)?.label).toBe('terminal');

      emit(envelope('terminal-close', { terminalId: 't1' }));
      await new Promise((r) => setTimeout(r, 0));
      expect(procs[0]!.kill).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  it('spawns the operator shell without consulting the allowlist when the peer asked for none', async () => {
    // Rust's arm is `None => shell_for_dispatch.clone()` (`lib.rs:1403`) — the
    // configured shell is **operator policy and is never re-checked**, so a
    // deployment whose `AGENT_SHELL` sits outside its own `/etc/shells` still
    // gets its own terminal. The peer's `Some(requested)` arm is the one that
    // goes through `resolve_client_shell`. This cell is the discriminating
    // polarity: the policy below does not allow `/opt/operator/shell`, and the
    // spawn must happen anyway.
    const { config, deps, spawned } = terminalWiring(
      { shell: '/opt/operator/shell' },
      { shellPolicy: new ShellPolicy({ configured: '/bin/sh' }) },
    );
    const runtime = await AgentRuntime.start(config, deps);
    try {
      await runtime.terminal.create({
        terminalId: 't1',
        cols: 80,
        rows: 24,
        shell: undefined,
      });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.file).toBe('/opt/operator/shell');
    } finally {
      await runtime.stop();
    }
  });

  it('reports a refused shell to the browser on the terminal channel', async () => {
    // Through the real policy: the peer asks for a shell outside the
    // allowlist, `PtyManager.create` refuses before spawning, and the router
    // turns the rejection into the frame the browser shows. Under BASE the
    // throw escaped into the channel callback and nothing was sent.
    const { config, deps, sent } = terminalWiring(
      {},
      {
        // Operator policy, resolved once at start — the Rust's
        // `shell_policy_for_dispatch`. Injected so the cell needles a shell the
        // host would otherwise accept.
        shellPolicy: new ShellPolicy({ configured: '/bin/sh' }),
      },
    );
    const runtime = await AgentRuntime.start(config, deps);
    try {
      const router = new DataChannelRouter({
        terminal: runtime.terminal,
        files: { handle: () => [], acceptBinaryChunk: () => [] },
        desktop: { onControl: () => {}, onSelect: () => {} },
        input: { admit: () => false, decode: () => null, apply: () => null },
        send: () => {},
        logger: { warn: () => {} },
        now: () => 1_700_000_000_000,
      });
      let emit: (data: Uint8Array) => void = () => {};
      const channel = {
        label: 'terminal',
        on: (_event: 'message', cb: (data: Uint8Array) => void) => {
          emit = (data: Uint8Array) => cb(data);
          return () => {};
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      router.attach(channel);
      emit(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'terminal-create',
            channel: 'terminal',
            payload: {
              terminalId: 't1',
              cols: 80,
              rows: 24,
              shell: '/tmp/evil.sh',
            },
            timestamp: 0,
          }),
        ),
      );
      await new Promise((r) => setTimeout(r, 0));

      // The refusal is framed at the router's boundary, so it leaves through
      // the attached channel — the same wire the browser reads.
      const wire = channel.send.mock.calls.at(-1)?.[0] as string;
      expect(typeof wire).toBe('string');
      expect(JSON.parse(wire)).toEqual({
        type: 'terminal-error',
        channel: 'terminal',
        payload: {
          terminalId: 't1',
          code: 'pty-spawn-failed',
          message: expect.stringContaining('shell refused'),
        },
        timestamp: 1_700_000_000_000,
      });
      // And nothing was spawned.
      expect(sent).toEqual([]);
      // **Exactly one frame.** `at(-1)` alone cannot see a second frame, and
      // the router is the single error-frame owner (the Rust frames at the
      // dispatch site, `lib.rs:1390-1401`, never inside `pty.rs`); a runtime
      // that also framed would send the browser the message twice.
      expect(channel.send).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });
});
