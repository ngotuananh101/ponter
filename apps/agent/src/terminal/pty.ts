// apps/agent/src/terminal/pty.ts
import type { ShellPolicy } from './shell-policy.js';

export const MAX_PTY_CHUNK = 16 * 1024;
export const MAX_SESSIONS = 10;
/**
 * Exported with no caller: the frame-size cap belongs to the data-channel
 * router (Task 18), which is the only layer that sees a whole frame. Carried
 * obligation, not an unused constant.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

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
  /** Resolved through `ShellPolicy` before it reaches here. */
  policy?: ShellPolicy;
}

export class PtyError extends Error {
  constructor(
    readonly code: 'pty-spawn-failed' | 'session-limit-reached',
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

  async create(options: PtyCreateOptions): Promise<void> {
    if (this.sessions.has(options.terminalId)) return;
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new PtyError(
        'session-limit-reached',
        'the agent already has 10 terminal sessions',
      );
    }
    let process_: PtyProcess;
    try {
      process_ = this.host.spawn(options.shell, [], {
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
    this.sessions.set(options.terminalId, { process: process_ });
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
    process_.onData((chunk: string | Buffer) => {
      this.emitChunks(
        options.terminalId,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    process_.onExit((event: { exitCode?: number }) => {
      this.sessions.delete(options.terminalId);
      this.exitHandler?.({
        terminalId: options.terminalId,
        exitCode: typeof event?.exitCode === 'number' ? event.exitCode : null,
      });
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

  async close(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    session.process.kill();
  }

  private emitChunks(terminalId: string, buffer: Buffer): void {
    for (let offset = 0; offset < buffer.length; offset += MAX_PTY_CHUNK) {
      const slice = buffer.subarray(offset, offset + MAX_PTY_CHUNK);
      this.dataHandler?.({ terminalId, data: slice.toString('base64') });
    }
  }
}
