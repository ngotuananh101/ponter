// apps/agent/src/runtime.ts
import { createRequire } from 'node:module';
import type { ProfileId } from '@ponter/shared';
import type { AgentConfig } from './config.js';
import { FilesRoot } from './files/sandbox.js';
import { FilesSession } from './files/session.js';
import type { DesktopSource } from './desktop/control.js';
import { PtyManager, type PtyHost } from './terminal/pty.js';
import {
  buildTerminalDataFrame,
  buildTerminalExitFrame,
} from './terminal/frames.js';
import type { ShellPolicy } from './terminal/shell-policy.js';
import type { RouterDeps } from './session/data-channels.js';

export interface DesktopSourceList {
  monitors: { id: string; primary: boolean }[];
}

/**
 * The two Rust tick periods (`lib.rs:1852-1858`). Named rather than inlined so
 * the intervals are greppable from the tests that assert them — the Rust's
 * were magic numbers at the call sites, which is part of why the port lost them.
 */
export const IDLE_TICK_MS = 1_000;
export const ACK_TICK_MS = 20;

/**
 * Resolves `AGENT_DESKTOP_DEFAULT_SOURCE` (B59).
 *
 * `primary` means "the monitor flagged primary, else the first one" — a headless
 * or virtual host commonly reports no primary at all, and failing there would
 * make the zero-click onboarding path dead on exactly the machines that need it.
 *
 * An unrecognised selector **throws**. Silently falling back to `primary` would
 * turn a typo in the operator's env into a stream of the wrong monitor, which
 * reads as a capture bug and is diagnosed hours later.
 */
export function resolveDefaultSource(
  selector: string,
  sources: DesktopSourceList,
): DesktopSource {
  if (selector === 'test') return { kind: 'test' };
  if (selector === 'primary') {
    const first = sources.monitors[0];
    if (!first) throw new Error('no monitors are available to capture');
    const primary = sources.monitors.find((m) => m.primary) ?? first;
    return { kind: 'monitor', id: primary.id };
  }
  const monitor = /^monitor:(.+)$/.exec(selector);
  const monitorId = monitor?.[1];
  if (monitorId) {
    if (!sources.monitors.some((m) => m.id === monitorId)) {
      throw new Error(`unknown desktop source ${selector}`);
    }
    // Present in `sources` but possibly captured by another process; the capture
    // layer reports that, not this resolver.
    return { kind: 'monitor', id: monitorId };
  }
  throw new Error(`unknown desktop source ${selector}`);
}

/**
 * The tick owner (R3) — the production caller `checkIdle()` and `flushAcks()`
 * did not have.
 *
 * The Rust drove two ticks: `idle_tick` at 1 s and `ack_tick` at 20 ms
 * (`apps/agent/src/lib.rs:1852-1858`, driven at `:1890` and `:1898-1899`). In
 * this plan the two functions existed and were called **only from test
 * assertions** — so a stalled transfer was never reaped and a slow upload was
 * never acknowledged, with no error anywhere.
 *
 * **Two intervals, one entry point, and the driver outside.** `tick()` is
 * called from a `setInterval` the runtime owns (not from here), which keeps
 * this class free of a real timer and therefore testable by advancing a number.
 * The clock is injected for the same reason `FilesSession`'s is: the deadline
 * arithmetic is what the tests need to control.
 *
 * **Catch up, do not drop.** If the timer fires late — a busy event loop, a GC
 * pause, a suspended laptop — the elapsed time may span several idle periods.
 * Calling `checkIdle()` once for 3.5 s of elapsed time leaves a timed-out
 * transfer alive for another full period; the idle deadline is wall-clock, so
 * the reap owed is proportional to the time that passed. Measured as a
 * count, not a boolean.
 *
 * **`flushAcks()` is called once per tick, not once per 20 ms elapsed.** Its
 * contract (§R7) is "take whatever is pending, with no gate" — calling it more
 * than once within a period cannot produce a second ack because `pendingAck`
 * is cleared on the first, so a catch-up loop there would be dead code that
 * reads as work.
 */
export class FilesTicker {
  private readonly now: () => number;
  private readonly emit: (frame: unknown) => void;
  private lastIdleAt: number;
  private lastAckAt: number;
  private stopped = false;

  constructor(
    private readonly session: {
      checkIdle(): unknown[];
      flushAcks(): unknown[];
    },
    deps: { now: () => number; emit: (frame: unknown) => void },
  ) {
    this.now = deps.now;
    this.emit = deps.emit;
    this.lastIdleAt = deps.now();
    this.lastAckAt = deps.now();
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();

    // Catch up: one `checkIdle()` per whole idle period that has elapsed.
    while (now - this.lastIdleAt >= IDLE_TICK_MS) {
      this.lastIdleAt += IDLE_TICK_MS;
      for (const frame of this.session.checkIdle()) this.emit(frame);
    }

    // One flush per tick. `flushAcks()` clears `pendingAck`, so a second call
    // in the same period is a no-op — see the class note.
    if (now - this.lastAckAt >= ACK_TICK_MS) {
      this.lastAckAt = now;
      for (const frame of this.session.flushAcks()) this.emit(frame);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

export interface RuntimeStatus {
  agentId: string;
  connected: boolean;
  server: string;
  filesRoot: string | null;
  allowInput: boolean;
  /** The profile **id** the config resolved to, not the whole record. */
  desktopProfile: ProfileId;
}

/**
 * The lifecycle owner (B14/B53).
 *
 * It exists as a class rather than a bag of closures for one reason: `stop()`
 * must be idempotent and must tear down in a fixed order — desktop session,
 * files session, pty sessions, then the socket — because a pty that outlives the
 * socket leaves an orphan shell on the host. The order is `stop()`'s
 * implementation, not a caller's responsibility.
 *
 * `createAgentRuntime` is the only public entry point; `AgentRuntime.start` is
 * exported for tests that want a handle without the process-level wiring.
 *
 * **MAJOR-1: the tick driver lives here.** `FilesSession` carries the idle
 * deadline and the 20 ms ack flush, but it is a state machine — something must
 * call `checkIdle()`/`flushAcks()` or neither ever fires. The Rust drove both
 * from one `tokio::select!` loop (`lib.rs:1845-1910`: `idle_tick` at 1 s,
 * `ack_tick` at 20 ms). The port's equivalent is two `setInterval` handles the
 * runtime owns: `IDLE_TICK_MS` and `ACK_TICK_MS`, both firing `ticker.tick()`,
 * whose catch-up arithmetic turns elapsed wall time into the right number of
 * calls. A config with no `filesRoot` has no `FilesSession` and no ticker,
 * matching the Rust's `Option<FilesManager>` handling, and `stop()` clears both
 * handles before anything else so a late tick cannot fire against a torn-down
 * session.
 */
export interface RuntimeDeps {
  send: (label: string, frame: unknown) => void;
  now?: () => number;
  filesSession?: (
    root: string,
    now: () => number,
  ) => { checkIdle(): unknown[]; flushAcks(): unknown[] };
  /**
   * The `node-pty` seam (B41). **Injected for the same reason `filesSession`
   * is**: `PtyManager` takes a `PtyHost` (`pty.ts:29-51`) and the runtime is
   * the only object that can give it the real one, so the fence can drive the
   * whole terminal path — spawn, output, exit, teardown — without ever spawning
   * a shell. Production omits it and gets the lazy real adapter below.
   */
  pty?: PtyHost;
  /**
   * The operator's shell policy (B36/B37), resolved once at start the way the
   * Rust resolves `shell_policy_for_dispatch`. Peer-requested shells are
   * resolved against this **before any process exists**; an absent policy keeps
   * the operator's configured shell for every session.
   */
  shellPolicy?: ShellPolicy;
}

/**
 * The real `node-pty` host, loaded on first spawn.
 *
 * `node-pty` is a native addon: importing it at module load would make every
 * import of `runtime.js` pay for a prebuild that a test (or an agent with no
 * terminal feature in use) may never need, and would make a missing prebuild a
 * crash on startup rather than on the first terminal. The seam is `PtyHost`
 * (`pty.ts:29-51`) and `node-pty`'s own `spawn` is already that shape — it
 * takes `encoding`, which is the one option this port depends on.
 *
 * The `require` is deliberate: `apps/agent` is `"type": "module"`, and
 * `node-pty` is CommonJS with a native binding. A static ESM import of it works
 * under Node today but not under every bundler the agent may be packaged with,
 * and the addon is exactly the case `createRequire` exists for.
 */
function lazyNodePtyHost(): PtyHost {
  let real: PtyHost | null = null;
  return {
    spawn(file, args, options) {
      if (real === null) {
        const require = createRequire(import.meta.url);
        real = require('node-pty') as PtyHost;
      }
      return real.spawn(file, args, options);
    },
  };
}

export class AgentRuntime {
  private stopped = false;
  private readonly tickers: NodeJS.Timeout[] = [];
  /**
   * B41: the pty owner. `public` because the router's `deps.terminal` **is**
   * this object (`RouterDeps.terminal`, `data-channels.ts:93-120`) — the
   * production binding is `terminal: runtime.terminal`, and a transport that
   * builds the router needs to reach it. Its four methods are the whole
   * surface the router uses.
   */
  readonly terminal: RouterDeps['terminal'];
  private readonly pty: PtyManager;

  /**
   * MAJOR-6: the class declared **no constructor** while `static start` called
   * `new AgentRuntime(deps)` and `status()` read five `this.config.*` fields —
   * so the class could not implement its own `RuntimeStatus` interface and the
   * fence did not typecheck (8 errors, 6 of them here). `config` and `deps` are
   * parameter properties: the class holds exactly what `status()` and `stop()`
   * read, and `RuntimeDeps` is the **one** declaration both this constructor
   * and `static start` use, so the two cannot drift.
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly deps: RuntimeDeps,
  ) {
    this.pty = new PtyManager(deps.pty ?? lazyNodePtyHost());
    // **The subscription is the whole wiring.** `PtyManager` reports
    // `{terminalId, data}` and `{terminalId, exitCode}` through callbacks and
    // never serialises (`pty.ts`, and Task 27's §2.3 keeps it that way); the
    // frames are built here, where the channel that carries them is known.
    // The clock is injected so the envelopes are pinnable.
    this.pty.onData((frame) =>
      this.deps.send(
        'terminal',
        buildTerminalDataFrame(
          frame.terminalId,
          frame.data,
          (this.deps.now ?? Date.now)(),
        ),
      ),
    );
    this.pty.onExit((frame) =>
      this.deps.send(
        'terminal',
        buildTerminalExitFrame(
          frame.terminalId,
          frame.exitCode,
          (this.deps.now ?? Date.now)(),
        ),
      ),
    );
    // A refused *create* is **not** framed here. The Rust frames it at the
    // dispatch site (`spawn_failure_frame`, `lib.rs:1390-1401` and `:2833-2849`),
    // not inside `pty.rs`, and `DataChannelRouter.createTerminal` is this port's
    // dispatch site. Framing here too would send two `terminal-error` frames for
    // one refusal — the browser shows the message twice and the second arrives
    // after the router's, so a reader that reacts to the first sees a duplicate.
    // So `create` propagates the rejection and the router turns it into the one
    // frame. `pty.ts`'s own fences (defects 5 and 7) pin `rejects.toMatchObject`,
    // which is the contract this keeps.
    this.terminal = {
      write: (terminalId, bytes) => this.pty.write(terminalId, bytes),
      resize: (terminalId, cols, rows) =>
        this.pty.resize(terminalId, cols, rows),
      create: (options) =>
        this.pty.create({
          terminalId: options.terminalId,
          cols: options.cols,
          rows: options.rows,
          // **The operator's shell is policy-exempt; a peer's is not.** Rust
          // splits exactly this way (`lib.rs:1372-1403`): `Some(requested) =>
          // shell_policy.resolve_client_shell(&requested)` and `None =>
          // shell_for_dispatch.clone()` — the configured shell is never
          // re-checked, because it is operator policy, not peer input. Passing
          // the policy for a `None` request would make a deployment whose
          // `AGENT_SHELL` is outside its own allowlist refuse its own terminal.
          ...(options.shell === undefined
            ? { shell: this.config.shell }
            : {
                shell: options.shell,
                ...(this.deps.shellPolicy
                  ? { policy: this.deps.shellPolicy }
                  : {}),
              }),
        }),
      close: (terminalId) => this.pty.close(terminalId),
    };
  }

  /**
   * **MAJOR-1's test seam, and the honest shape of Plan 2's wiring.** The
   * production values construct the real session (`FilesRoot.open` +
   * `FilesSession`) and emit through `send`; a test overrides `filesSession`
   * with a fake state machine and observes the tick through its emit. The
   * `send` seam is the one Task 18's router exposes (`router.send`), so the
   * runtime→router binding is `send: router.send` once Task 18 lands in the
   * same binary.
   */
  static async start(
    config: AgentConfig,
    deps: RuntimeDeps = {
      send: () => {
        throw new Error('no transport is wired yet');
      },
    },
  ): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(config, deps);
    if (config.filesRoot) {
      const now = deps.now ?? Date.now;
      const session = deps.filesSession
        ? deps.filesSession(config.filesRoot, now)
        : new FilesSession(FilesRoot.open(config.filesRoot), now);
      const ticker = new FilesTicker(session, {
        now,
        emit: (frame) => deps.send('files', frame),
      });
      runtime.tickers.push(
        setInterval(() => ticker.tick(), IDLE_TICK_MS),
        setInterval(() => ticker.tick(), ACK_TICK_MS),
      );
    }
    return runtime;
  }

  status(): RuntimeStatus {
    return {
      agentId: this.config.agentId,
      connected: false,
      server: this.config.server,
      filesRoot: this.config.filesRoot,
      allowInput: this.config.allowInput,
      desktopProfile: this.config.desktopProfile.id,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // **The docblock's order, now real: pty sessions before the socket.** A
    // pty that outlives the socket leaves an orphan shell on the host. The
    // intervals go first so a late tick cannot emit against a torn-down
    // session; `closeAll` then kills every live shell, including the ones no
    // caller remembers — the ids came from the peer.
    for (const handle of this.tickers.splice(0)) clearInterval(handle);
    this.pty.closeAll();
  }
}

export async function createAgentRuntime(
  config: AgentConfig,
): Promise<AgentRuntime> {
  return AgentRuntime.start(config);
}
