// apps/agent/src/terminal/pty.ts
import type { ShellPolicy } from './shell-policy.js';

export const MAX_PTY_CHUNK = 16 * 1024;
export const MAX_SESSIONS = 10;

/**
 * The `node-pty` seam, written against the surface `IPty` actually declares
 * (`typings/node-pty.d.ts:117-190`): `onData` / `onExit`, not EventEmitter's
 * `on`. `IPty extends Terminal`, whose `on` delegates to a private `_socket`
 * and is absent from the declared type, so a seam built on `on` cannot be
 * satisfied by the real host at all — it needs a cast to typecheck, and that
 * cast is what hides a runtime defect (see the `onExit` note in `create`).
 */
export interface PtyProcess {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: string | Buffer) => void): void;
  onExit(cb: (event: { exitCode?: number }) => void): void;
}

/** The `node-pty` seam. Tests supply a fake so no shell is ever spawned. */
export interface PtyHost {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      /**
       * **Must be `null`.** `node-pty`'s default is `'utf8'`, which puts the
       * master fd into text mode (`_socket.setEncoding(encoding)`): a byte
       * that is not valid UTF-8 arrives at `onData` already replaced by
       * U+FFFD, and the original byte is unrecoverable. ADR-10 makes the
       * terminal payload bytes, not text, and B40 ports it — so the host
       * adapter that supplies the real `node-pty` must pass `encoding: null`
       * and the manager must never convert before base64.
       */
      encoding: null;
    },
  ): PtyProcess;
}

export interface PtyCreateOptions {
  terminalId: string;
  shell: string;
  cols: number;
  rows: number;
  /**
   * Which of the Rust's two arms this spawn is on (`lib.rs:1379-1405`).
   *
   * - `'peer'` — `create.shell` came off the wire and is **untrusted input**: it
   *   is resolved through `policy` before any process exists.
   * - `'operator'` — the peer asked for no shell, so this is
   *   `shell_for_dispatch.clone()`, the operator's own `AGENT_SHELL`. The Rust
   *   deliberately does **not** re-check it (`lib.rs:1405`): a deployment whose
   *   shell sits outside its own allowlist still gets its own terminal.
   *
   * Required, and required *separately* from `policy`, because the two arms must
   * not be distinguishable by whether a policy happens to be present — that
   * coupling is what made a missing policy mean "spawn unchecked".
   */
  shellSource: 'peer' | 'operator';
  /**
   * The allowlist. **Required**: there is now no object shape in which a
   * peer-supplied shell reaches `spawn`. The Rust cannot express one either —
   * `SessionConfig.shell_policy` is built non-optionally from config
   * (`lib.rs:714`) and read as a plain field at the dispatch site
   * (`lib.rs:567`).
   */
  policy: ShellPolicy;
}

/**
 * The two wire spellings a terminal failure can carry (B41).
 *
 * Named rather than inlined because two modules now need it: `PtyError` below
 * narrows `code` to it, and `frames.buildTerminalErrorFrame` types the frame's
 * `payload.code` with it. The Rust pins the same pair in
 * `every_pty_error_code_has_the_kebab_case_wire_spelling` (`pty.rs:642`) — the
 * browser switches on these strings, so a rename is a breaking change.
 */
export type PtyErrorCode = 'pty-spawn-failed' | 'session-limit-reached';

export class PtyError extends Error {
  constructor(
    readonly code: PtyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PtyError';
  }
}

interface Session {
  process: PtyProcess;
}

/**
 * PTY sessions (B39–B41).
 *
 * Four details that are not obvious:
 *
 * - **Output is base64 of raw bytes, never a UTF-8 decode.** A chunk boundary can
 *   land mid-codepoint; decoding to a string and re-encoding would corrupt it,
 *   and a terminal sending `0xff` would throw outright. The browser's `atob`
 *   handles it because the split happens at base64 length, not code unit.
 * - **The bytes are only raw if the host says so.** `node-pty` defaults to
 *   `encoding: 'utf8'`, which decodes the master fd to a string *before* this
 *   class ever sees it — the corruption then happened upstream and base64
 *   cannot recover it. That is why `PtyHost.spawn` takes `encoding: null`.
 * - **Chunking is 16 KiB of raw bytes per frame.** Above that, `writeSync`-style
 *   framing exceeds the SCTP message size the browser accepts.
 * - **The exit code is reaped from the process's own `exit` event, not inferred
 *   from a zero-length read.** `node-pty` gives us the event, so the Rust's
 *   slave-end dance (drop it so `read()` returns `Ok(0)`) has no analogue here —
 *   there is no slave handle to hold. That whole class of bug does not port.
 *
 * The 10-session cap is agent-side and load-bearing: each session is a process
 * with a pty; a peer that opens sessions in a loop would exhaust the host.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private dataHandler:
    ((frame: { terminalId: string; data: string }) => void) | null = null;
  private exitHandler:
    ((frame: { terminalId: string; exitCode: number | null }) => void) | null =
    null;

  constructor(private readonly host: PtyHost) {}

  onData(cb: (frame: { terminalId: string; data: string }) => void): void {
    this.dataHandler = cb;
  }

  onExit(
    cb: (frame: { terminalId: string; exitCode: number | null }) => void,
  ): void {
    this.exitHandler = cb;
  }

  /**
   * The promise is part of the contract, so a failure must arrive as a
   * **rejection**, never as a synchronous throw: every caller in the tree
   * treats this as a promise (`data-channels.ts:568` wraps it in
   * `Promise.resolve(...).catch(...)` to answer with a `terminal-error` frame,
   * and four tests assert `expect(manager.create(...)).rejects`). A bare
   * `throw` from a non-`async` function escapes *before* the promise exists:
   * measured, that turns those four cells red, and in production it skips the
   * `.catch` so the browser gets no error frame and the throw continues into
   * werift's `async datachannelReceive` as an `unhandledRejection` (the Task 31
   * F-6 path to `process.exit(1)`).
   *
   * The body runs **synchronously**, exactly as an `async` body without an
   * `await` does — `openSession` is called inline, not deferred to a microtask,
   * so nothing that observed the old ordering sees a change.
   */
  create(options: PtyCreateOptions): Promise<void> {
    try {
      this.openSession(options);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private openSession(options: PtyCreateOptions): void {
    if (this.sessions.has(options.terminalId)) return;
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new PtyError(
        'session-limit-reached',
        'the agent already has 10 terminal sessions',
      );
    }
    // **The allowlist is consulted before a process exists**, as the Rust does
    // (`lib.rs:1372-1400`): a peer-supplied shell is untrusted input, and
    // checking it after `spawn` would already have executed it. The policy
    // throws `ShellRefusedError` with the Rust's own wording; it is re-thrown
    // as `pty-spawn-failed`, which is the frame the Rust sends for a refused
    // shell too ("reuse the pinned spawn-failure frame … a third wire code
    // would change a contract for no reader's benefit").
    //
    // **The operator's shell is exempt, and the split is the Rust's own**: it
    // resolves `Some(requested)` through the policy and passes
    // `None => shell_for_dispatch.clone()` straight through (`lib.rs:1379-1405`).
    // Re-checking the operator's shell would make a deployment whose
    // `AGENT_SHELL` is outside its own `/etc/shells` refuse its own terminal.
    const shell =
      options.shellSource === 'peer'
        ? this.resolveShell(options.policy, options.shell)
        : options.shell;
    let process_: PtyProcess;
    try {
      process_ = this.host.spawn(shell, [], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8',
        } as Record<string, string>,
        // Bytes, not text. See the `encoding` note on `PtyHost.spawn`.
        encoding: null,
      });
    } catch (error) {
      throw new PtyError('pty-spawn-failed', (error as Error).message);
    }
    // With `encoding: null` a real `node-pty` emits Buffers. The `string` half
    // is tolerated only so a fake host cannot smuggle in a lossy decode
    // silently: `Buffer.from(string)` is the utf8 round trip this code exists
    // to avoid, so the string branch is a bug in the host adapter, not a
    // supported input — which is why the real host must pass `encoding: null`.
    //
    // `onData`/`onExit`, not `on`: that is `IPty`'s declared surface, and it is
    // also the only one that delivers the exit code. `Terminal.prototype.emit`
    // passes it as **positional argument 0** (`lib/terminal.js:90-93`), so an
    // EventEmitter-shaped handler reading `event?.exitCode` gets `undefined`
    // on every real exit and reports `null` — a defect the plan's own fence
    // observed as `[-1]` and its `as never` cast hid from `tsc`.
    //
    // **Subscribe before registering the slot.** Registering first leaks a slot
    // forever if a subscription throws: the map keeps an entry nothing will
    // ever delete, so the agent silently offers 9 sessions instead of 10 for
    // the rest of its life. On a throw, kill the spawned process and report
    // the same `pty-spawn-failed` an unwireable spawn reports.
    try {
      process_.onData((chunk: string | Buffer) => {
        this.emitChunks(
          options.terminalId,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      });
      process_.onExit((event: { exitCode?: number }) => {
        this.emitExit(options.terminalId, process_, event);
      });
    } catch (error) {
      try {
        process_.kill();
      } catch {
        // The process is already unusable; a failing kill changes nothing.
      }
      throw new PtyError('pty-spawn-failed', (error as Error).message);
    }
    this.sessions.set(options.terminalId, { process: process_ });
  }

  private resolveShell(policy: ShellPolicy, requested: string): string {
    try {
      return policy.resolveClientShell(requested);
    } catch (error) {
      throw new PtyError(
        'pty-spawn-failed',
        `shell refused: ${(error as Error).message}`,
      );
    }
  }

  private emitExit(
    terminalId: string,
    process_: PtyProcess,
    event: { exitCode?: number },
  ): void {
    // **Only this process may free the slot.** `close()` drops the map entry
    // but cannot unsubscribe, so an old process's exit handler outlives it; a
    // reused id would then be deleted by a stranger's death, silencing a live
    // terminal the browser still shows and emitting an exit nobody asked for.
    // The exit is still reported either way — Rust reports the exit and only
    // guards the eviction.
    if (this.sessions.get(terminalId)?.process === process_)
      this.sessions.delete(terminalId);
    this.exitHandler?.({
      terminalId,
      exitCode: typeof event?.exitCode === 'number' ? event.exitCode : null,
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.process.resize(cols, rows);
  }

  write(terminalId: string, bytes: Uint8Array): void {
    // Pass the Buffer through. `Buffer.from(bytes).toString('utf8')` — the
    // obvious spelling — is a lossy round trip for any byte input that is not
    // valid UTF-8, and it is the *inbound* half of the same defect as the
    // `encoding` note on `PtyHost.spawn`. Measured: writing `41 ff fe 42` that
    // way reaches the child as `41 ef bf bd ef bf bd 42`.
    this.sessions.get(terminalId)?.process.write(Buffer.from(bytes));
  }

  /**
   * Same contract as `create`: failures are rejections, not synchronous throws.
   * `kill()` is the reachable one — `closeAll` wraps it in `try/catch` twice in
   * this file precisely because a process that is already gone can throw — and
   * `data-channels.ts:536` calls this through `Promise.resolve(...).catch(...)`
   * to log a failed close. A bare throw would skip that `.catch`.
   */
  close(terminalId: string): Promise<void> {
    try {
      this.closeSession(terminalId);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private closeSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    session.process.kill();
  }

  /**
   * Kill every live session (B41's lifecycle half).
   *
   * `AgentRuntime.stop()` promises the pty sessions are torn down before the
   * socket — a pty that outlives the socket leaves an orphan shell on the host
   * — and it cannot enumerate the ids itself: they come from the peer. Clearing
   * the map **before** killing matters for the same reason `emitExit` guards on
   * process identity (`:204-221`): a `kill()` that synchronously delivered an
   * exit event would otherwise re-enter `emitExit` and delete whatever a
   * concurrent `create` had just registered under a reused id.
   *
   * Deliberately **not** `Promise.all(ids.map(close))`: `close()` runs its body
   * synchronously (only its failure arm is deferred, as a rejection), and an
   * `await` here would make the teardown order in `stop()` depend on a
   * microtask the caller cannot see.
   */
  closeAll(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      try {
        session.process.kill();
      } catch {
        // A process that is already gone is exactly what this method wants.
      }
    }
  }

  private emitChunks(terminalId: string, buffer: Buffer): void {
    for (let offset = 0; offset < buffer.length; offset += MAX_PTY_CHUNK) {
      const slice = buffer.subarray(offset, offset + MAX_PTY_CHUNK);
      this.dataHandler?.({ terminalId, data: slice.toString('base64') });
    }
  }
}
