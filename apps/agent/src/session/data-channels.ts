// apps/agent/src/session/data-channels.ts
import { decodeBase64Strict } from '../base64.js';
import { MAX_DATA_CHANNEL_FRAME_BYTES } from '../signalling/constants.js';
import { frameFiles } from '../files/protocol.js';
import type { FilesFrame } from '../files/session.js';
import { decodeStreamControl } from '../desktop/control.js';
import { buildTerminalErrorFrame } from '../terminal/frames.js';
// Task 15's wire union. The import is **load-bearing, not cosmetic**: without
// it, `InputEvent` below resolves to the DOM global of the same name (`lib`
// includes `DOM`), and `RouterDeps.input` silently declares the browser's
// event type instead of the agent's. The typecheck caught this only because
// the test fence imported the real one and the two disagreed.
import type { InputEvent } from '../input/decode.js';

/**
 * The three labels this port serves, named after the wire (`WebRTCChannelType`
 * is `terminal | desktop | files | control`, `packages/shared/src/types/
 * webrtc.ts:7`).
 *
 * **Which channel carries what**, measured from the browser's own openers —
 * `apps/web/src/stores/terminal.ts` opens exactly `['terminal']` (`:544`),
 * `['control']` (`:937`) and `['files']` (`:1128`), and `connection.ts:160-165`
 * creates one data channel per requested label:
 *
 * - **`terminal`** — pty create/data/resize/close inbound; `terminal-data` and
 *   `terminal-exit` outbound (both base64-carried `terminalId`-routed frames).
 * - **`files`** — the files JSON vocabulary inbound and outbound, plus the
 *   binary upload-chunk frames (`bytes[0] === 0x02`).
 * - **`control`** — the desktop session's **only** data channel (the Rust says
 *   so verbatim at `lib.rs:2511`): `desktop-select`, `desktop-bitrate` and
 *   `desktop-input` inbound; `desktop-sources`, `desktop-stats`,
 *   `desktop-cursor` and `desktop-e2ee-ack` outbound.
 *
 * `'desktop'` is **not** served and **not** in this map on purpose: on the wire
 * it is the capability string and the RTP media label (`DESKTOP_LABEL` in the
 * offer's capabilities, the m-line for the video track) — a name, not a data
 * channel. No peer opens a `'desktop'` data channel; the Rust registers only
 * `terminal`, `control`, `desktop`, `files` as label constants and selects
 * `CONTROL_LABEL` for `SessionMode::Desktop` (`rtc.rs:73`, `lib.rs:1122-1126`).
 *
 * `input` and `cursor` **do not exist** on the wire: `grep` for
 * `createDataChannel('input')` and `createDataChannel('cursor')` returns zero
 * across the repo, and the Rust registers neither. Input rides `control` as
 * `desktop-input` (`desktop-core/src/client.ts:452,467`; `input.rs:189` gates
 * on `channel == "control"` **and** `type == "desktop-input"`). Cursor updates
 * ride `control` as outbound `desktop-cursor` frames. This map therefore needs
 * no internal discriminant wider than the wire labels — the wire type is
 * already the dispatch key.
 */
export const CHANNEL_LABELS = {
  terminal: 'terminal',
  files: 'files',
  control: 'control',
} as const;

export type ChannelLabel = (typeof CHANNEL_LABELS)[keyof typeof CHANNEL_LABELS];

const KNOWN = new Set<string>(Object.values(CHANNEL_LABELS));

/**
 * The slice of a werift data channel this module needs.
 *
 * werift's real channel has two message surfaces — the `onMessage` **Event**
 * (`channel.onMessage.subscribe(fn)` → `{ unSubscribe }`,
 * `werift/lib/common/src/event.d.ts:14-17`) and the `onmessage` **property**
 * (`channel.onmessage = fn`, werift's own EventTarget emulation) — and only
 * the Event's `subscribe` returns an unsubscribe. The adapter (Plan 1,
 * `packages/webrtc-core/src/adapters/werift.ts:56-66`) wraps `onMessage`
 * behind `onMessage(handler)` and keeps the handler in a closure, so it cannot
 * unsubscribe either. `RouterChannel` therefore asks for the unsubscribe
 * **directly**: the Plan-3 adapter work is expected to expose
 * `on('message', cb) → () => void` by returning the werift `unSubscribe`
 * handle (or removing the handler from its own list, exactly as the fake
 * below does). `detach` is only as real as that return value.
 */
export interface RouterChannel {
  readonly label: string;
  on(
    event: 'message',
    cb: (data: ArrayBuffer | Uint8Array | string) => void,
  ): () => void;
  close(): void;
  /**
   * The outbound half of the same channel. The real adapters already declare
   * exactly this signature — `packages/webrtc-core/src/adapters/werift.ts:42`
   * and `browser.ts:21` both have `send(data: string | ArrayBuffer |
   * Uint8Array): void` — so declaring it here is stating the contract the
   * transport already satisfies, not inventing a shape. It was missing from
   * this interface, which is why the fence did not compile: `send()` called
   * `channel.send(...)` on a type that had no such member.
   */
  send(data: string | ArrayBuffer | Uint8Array): void;
}

export interface RouterDeps {
  /**
   * The pty seam, shaped as `PtyManager` really is (Task 12): `write` takes
   * the **terminal id and bytes**, not a bare string — a terminal channel
   * carries several sessions, and `terminal-data`'s payload routes them.
   *
   * **B41 (Task 27) widened this to the other three wire types.** The browser
   * sends `terminal-create`, `terminal-resize` and `terminal-close` on the same
   * channel (`terminal-core/src/client.ts:106`, `:220`, `:248`) and the Rust
   * has an arm for each (`lib.rs:1366`, `:1436`, `:1452`). Only `write` and
   * `resize` existed here and `resize` had **no caller** — a peer that resized
   * or closed a terminal was ignored, and a shell that could not be spawned
   * left the browser staring at a blank terminal with no message.
   *
   * `create` is typed `Promise<void>` because `PtyManager.create` is async and
   * **rejects** on a refusal (`pty.ts:119-191`); the router is what turns that
   * rejection into the `terminal-error` frame, exactly as the Rust's dispatcher
   * does and `PtyManager` does not (`lib.rs:1390-1401`, `spawn_failure_frame`
   * at `:2833-2849`).
   */
  terminal: {
    write(terminalId: string, bytes: Uint8Array): void;
    resize(terminalId: string, cols: number, rows: number): void;
    create(options: {
      terminalId: string;
      cols: number;
      rows: number;
      shell: string | undefined;
    }): Promise<void>;
    close(terminalId: string): Promise<void> | void;
  };
  files: {
    handle(message: { type: string; [key: string]: unknown }): unknown[];
    acceptBinaryChunk(frame: Uint8Array): unknown[];
  };
  desktop: {
    onControl(control: unknown): void;
    onSelect(source: unknown): void;
  };
  /**
   * The input seam, in the order the Rust runs it: **admit → decode → apply**
   * (`lib.rs:2427-2469`).
   *
   * - `admit(now)` is the port of `InputRateLimiter::allow` (`input.rs:141`),
   *   with the operator gate folded in the way `apply_if_allowed`'s first
   *   parameter is. It takes a **timestamp**, not an event — it must run
   *   before decode, so it cannot depend on a decoded event. A closed gate is
   *   a refusal with **no rate accounting** (MAJOR-5 item 5b: the Rust never
   *   reaches the limiter when `allow_input` is false, `lib.rs:2430`), and the
   *   window is the Rust's `floor(now / 1000)` wall-clock index, not elapsed
   *   time since the first call (item 5a).
   * - `decode(bytes)` is Task 15's `decodeInput`; it returns a normalized
   *   `InputEvent` or `null`.
   * - `apply(event, now)` is the bound `applyInput` (`bindInputApply`): it
   *   closes over the live source rect and injector, maps normalized →
   *   absolute, injects, and returns the applied event's `seq ?? null`.
   *
   * The router holds **no geometry**: the rect is the one `desktop-sources`
   * publishes (`DesktopSourceInfo.x/y/width/height`, `desktop.ts:11-27`) and
   * it belongs to the desktop session, not to a wire dispatcher.
   */
  input: {
    admit(now: number): boolean;
    decode(bytes: Uint8Array): InputEvent | null;
    apply(event: InputEvent, now: number): number | null;
  };
  send(label: ChannelLabel, frame: unknown): void;
  logger: { warn(message: string): void };
  /** Injected so the envelope's `timestamp` is pinnable. Defaults to `Date.now`. */
  now?: () => number;
}

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * A pty dimension as the Rust's `u16` accepts it.
 *
 * `u16` is a **positive integer** — `serde` rejects a negative, a float, a
 * string and a non-finite value, and the Rust dispatch site logs and drops
 * rather than clamping (`lib.rs:1439-1445`). A zero is rejected for the same
 * reason the browser's own `debouncedResize` rejects it
 * (`terminal-core/src/client.ts:205`): a 0-column pty is not a terminal any
 * reader can use.
 *
 * Both the create and resize arms share this, so the two cannot drift on what
 * a dimension is.
 */
/**
 * Matches Rust's `u16` fields on `TerminalCreateMessage` / `TerminalResizeMessage`
 * (`pty.rs:263-267`, `:280-285`): serde rejects negatives, floats, zero, and
 * anything above 65535, and the dispatch site logs and drops
 * (`lib.rs:1439-1445`). node-pty accepts any number and delegates to ioctl,
 * so the bound is load-bearing in this adapter.
 */
function isPtyDimension(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 0xffff
  );
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The label gate and per-channel dispatch (B13).
 *
 * Three behaviours the Rust established and this keeps:
 *
 * - **One channel per label.** A second `terminal` channel is closed
 *   immediately. Two open `terminal` channels would deliver pty output to
 *   whichever the browser bound last, and the operator would see an apparently
 *   dead terminal.
 * - **`close()` takes no code argument.** Neither werift nor the Rust API
 *   accepts one; passing one compiles against a wider type and does nothing.
 * - **A `label()` that throws drops the channel without closing it.** werift
 *   throws when the SCTP stream is not yet ready; the channel is then not ours
 *   to close, and calling `close()` on it corrupts the peer connection.
 *
 * Input is **decoded before** the limiter and the injector: an undecodable frame
 * must not reach a platform FFI call, and must not consume rate-limit budget.
 */
export class DataChannelRouter {
  private readonly attached = new Map<string, RouterChannel>();
  /** The unsubscribe `attach` registered, keyed by label — `detach`'s teardown. */
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(private readonly deps: RouterDeps) {}

  attach(channel: RouterChannel): void {
    let label: string;
    try {
      label = channel.label;
    } catch {
      return;
    }
    if (!KNOWN.has(label)) {
      channel.close();
      return;
    }
    if (this.attached.has(label)) {
      channel.close();
      return;
    }
    this.attached.set(label, channel);
    // `on` returns the unsubscribe (the test fake's `handlerCount` reads the
    // same map); keeping it is what makes `detach` real rather than bookkeeping.
    this.unsubscribers.set(
      label,
      channel.on('message', (data) => this.handle(label as ChannelLabel, data)),
    );
  }

  /**
   * Removes the listener **and** the channel. Deleting the map entry alone
   * stopped nothing — the handler `attach` registered stayed on the channel and
   * kept delivering late frames after `detach`, which is the defect this
   * version fixes (measured: E2 with a gate-satisfying fixture reached
   * `write` after `detach`). The unsubscribe runs first so a frame already
   * dispatched on this tick's queue still finds `attached` gone.
   */
  detach(label: ChannelLabel): void {
    this.unsubscribers.get(label)?.();
    this.unsubscribers.delete(label);
    this.attached.delete(label);
  }

  private handle(
    label: ChannelLabel,
    data: ArrayBuffer | Uint8Array | string,
  ): void {
    const bytes = toBytes(data);

    /**
     * **R4: the inbound cap, on every channel, before any decode.**
     *
     * Three caps exist in this plan and none was consulted here.
     * `MAX_INBOUND_FRAME_BYTES` is enforced only on the signalling path (via
     * `guardSize()`; its three call sites are all in `signalling/inbound.ts`),
     * `MAX_DATA_CHANNEL_FRAME_BYTES` is **pinned but unenforced** (asserted at
     * `:1105`, consumed nowhere), and `MAX_FRAME_BYTES` (`:6133`) has no caller
     * at all. `MAX_DATA_CHANNEL_FRAME_BYTES` is the right one for a data
     * channel: it is the SCTP message cap the browser also enforces, and a
     * frame above it could not have arrived over a conforming channel.
     *
     * **Scope: every channel, not only files.** B-12g §1.5 scoped the cap to
     * the files path; this check runs for `terminal` and `control` too, and
     * that broadening is deliberate and declared here. An SCTP message cap is
     * per-channel by construction — a 64 KiB+1 "terminal-data" frame is exactly
     * as impossible as an oversized chunk — so gating it on `label === 'files'`
     * would re-arm the same unenforced-cap hole on the other two channels.
     * Authority did not forbid it; it just did not ask for it.
     *
     * **Drop, do not error.** The Rust's inbound path never answered an
     * oversized frame: the SCTP layer refused it before the handler ran, so
     * the peer is the side that learns. Emitting a `files-error` here would
     * describe a frame the agent did not accept as if it had parsed it far
     * enough to know what it was.
     */
    if (bytes.length > MAX_DATA_CHANNEL_FRAME_BYTES) {
      this.deps.logger.warn(
        `dropped a ${bytes.length}-byte ${label} frame over the cap`,
      );
      return;
    }

    if (
      label === CHANNEL_LABELS.files &&
      typeof data !== 'string' &&
      bytes[0] === 0x02
    ) {
      this.emit(this.deps.files.acceptBinaryChunk(bytes));
      return;
    }

    /**
     * **Input on the control channel: substring guard + admit BEFORE decode.**
     *
     * Input rides the control channel (ADR-26, input.rs:189, lib.rs:2411).
     * In Rust (`lib.rs:2406-2469`), inbound bytes receive a substring check
     * `text.contains("\"desktop-input\"")` before the gate (`allow_input`) and
     * the rate cap (`input_limiter.allow()`), and only then calls `apply_if_allowed`
     * which calls `decode_desktop_input` (the single full JSON parse).
     *
     * Gating on the substring pre-filter here preserves the DoS protection
     * without double-parsing: `admit()` runs BEFORE `decode(bytes)`, so a frame
     * refused by the limiter or closed gate never spends a JSON parse, and
     * non-input control frames bypass this block entirely.
     *
     * The return value of `apply` is the applied event's `seq` (ADR-47) or `null`
     * when the injector refused it; the runtime stores it in the holder
     * `buildCursorFrame` reads. This router does not own that holder.
     */
    if (label === CHANNEL_LABELS.control) {
      const text =
        typeof data === 'string' ? data : new TextDecoder().decode(bytes);
      if (text.includes('"desktop-input"')) {
        if (!this.deps.input.admit((this.deps.now ?? Date.now)())) return;
        const event = this.deps.input.decode(bytes);
        if (event === null) return;
        this.deps.input.apply(event, (this.deps.now ?? Date.now)());
        return;
      }
    }

    const parsed = parseJson(bytes);
    if (parsed === null) {
      this.deps.logger.warn(`dropped a malformed ${label} frame`);
      return;
    }

    /**
     * **R2: unwrap the envelope, read `type` off the envelope, merge it into
     * the body.**
     *
     * The wire frame is `{ channel, type, payload, timestamp }` with `type` a
     * **sibling** of `payload`, never a member of it: `webrtc-core`'s
     * `sendJson` builds exactly that for every channel
     * (`packages/webrtc-core/src/data-channel.ts:74-88`), and the Rust reads
     * the same shape (`files.rs:589-596` matches `envelope.r#type`, then
     * deserialises `envelope.payload` into a struct with no `type` field).
     * The body the session receives therefore carries `type` first and the
     * payload's own fields after — `{ type, ...payload }` — which is the shape
     * Task 11's `list()` reads (`message.path`) and `decodeFilesFrame()`
     * reads (`message.type`) off the **same object**.
     *
     * `type` is spread **first** so a payload that happens to carry its own
     * `type` cannot shadow the envelope's: the envelope's `type` is the wire
     * fact, a payload's would be unverified body data.
     *
     * The Rust drops a misfiled frame — `files.rs:590-592`:
     * `if envelope.channel != FILES_CHANNEL { return Ok(None); }`. The plan
     * handed `parseJson(bytes)` straight to the session and switched on
     * `message.type`, so a frame whose `type` is `files-list` but whose
     * `channel` is `terminal` was handled as a files frame. `attach` reads
     * `channel.label` — the **transport's** label, not the wire's field — so
     * the Rust's guard had no TS counterpart at all.
     *
     * The browser always emits this envelope (`webrtc-core`'s `sendJson`
     * builds it for every channel) but never reads it inbound: `file-core`
     * destructures `{ type, payload }` only and `webrtc-core` validates
     * `parsed.type` only. So the guard is **hardening the port lost**, not a
     * defence against a browser that would otherwise break.
     *
     * A frame with **no** `channel` field is treated as misfiled and dropped:
     * every browser-originated frame carries one, so its absence means the
     * sender is not this contract's sender.
     */
    const envelope = parsed as {
      type?: unknown;
      channel?: unknown;
      payload?: unknown;
    };
    if (envelope.channel !== label) {
      this.deps.logger.warn(
        `dropped a ${label} frame filed under channel ${String(envelope.channel)}`,
      );
      return;
    }
    if (typeof envelope.type !== 'string') {
      this.deps.logger.warn(`dropped a ${label} frame with no envelope type`);
      return;
    }
    const message =
      typeof envelope.payload === 'object' && envelope.payload !== null
        ? {
            type: envelope.type,
            ...(envelope.payload as Record<string, unknown>),
          }
        : null;
    if (message === null) {
      this.deps.logger.warn(`dropped a ${label} frame with no object payload`);
      return;
    }

    switch (label) {
      case CHANNEL_LABELS.terminal: {
        this.dispatchTerminal(message);
        return;
      }
      case CHANNEL_LABELS.files: {
        this.emit(this.deps.files.handle(message));
        return;
      }
      case CHANNEL_LABELS.control: {
        this.dispatchDesktop(message);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The terminal channel's inbound vocabulary (B41) — the four types the Rust
   * dispatches and the browser sends.
   *
   * **Decoded here, not in a separate module.** `dispatchDesktop`'s note
   * explains why the desktop side is about to grow a decoder file (Task 26):
   * two decoders of one contract drift. The terminal side has no vocabulary of
   * its own — three fields and an optional string each — so a decoder module
   * would be a second place for `terminalId` to be spelled differently. The
   * shape that *is* shared, the envelope, is already unwrapped above.
   *
   * **A refused spawn is answered, not thrown.** `create` rejects with
   * `PtyError` carrying one of the two pinned codes (`pty.ts:62-70`); the
   * Rust answers exactly that with `frame_pty_error` in the dispatcher
   * (`lib.rs:1390-1401` and `spawn_failure_frame` at `:2833-2849`) and never
   * propagates the error into the channel. Without the frame the browser shows
   * a blank terminal with no way to tell a refused shell from a slow one —
   * the Rust's own comment says so.
   *
   * `terminal-data` keeps its base64 decode and its drop-on-malformed contract
   * (`pty.rs:181-198` gates on both the channel and the type, then
   * STANDARD-decodes).
   */
  private dispatchTerminal(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'terminal-data': {
        const { terminalId, data } = message as {
          terminalId?: unknown;
          data?: unknown;
        };
        if (typeof terminalId !== 'string' || typeof data !== 'string') return;
        // Strict, as the Rust is: `STANDARD.decode` fails on a non-alphabet
        // character, a bad length or misplaced padding, and the Rust logs and
        // drops (`lib.rs:1474-1480`). `Buffer.from(x, 'base64')` would instead
        // hand the pty whatever prefix survived — the cast that used to sit
        // here wrapped it in a `try` that could never fire, because a lenient
        // decode does not throw. Dropping is the contract; writing garbage to a
        // shell is not, and the warning is kept distinct from the unknown-type
        // drop so an operator can tell routing from a corrupt payload.
        const bytes = decodeBase64Strict(data);
        if (bytes === null) {
          this.deps.logger.warn(
            'dropped a terminal-data frame with invalid base64',
          );
          return;
        }
        this.deps.terminal.write(terminalId, bytes);
        return;
      }
      case 'terminal-create': {
        const { terminalId, cols, rows, shell } = message as {
          terminalId?: unknown;
          cols?: unknown;
          rows?: unknown;
          shell?: unknown;
        };
        if (typeof terminalId !== 'string' || terminalId === '') return;
        if (!isPtyDimension(cols) || !isPtyDimension(rows)) {
          this.deps.logger.warn(
            `dropped a terminal-create frame with cols=${String(cols)} rows=${String(rows)}`,
          );
          return;
        }
        // `shell` is passed through **unvalidated**: `PtyManager.create`
        // resolves it against the `ShellPolicy` before any process exists
        // (`pty.ts:134-140`). Pre-validating here would be a second allowlist.
        this.createTerminal(terminalId, cols, rows, shell);
        return;
      }
      case 'terminal-resize': {
        const { terminalId, cols, rows } = message as {
          terminalId?: unknown;
          cols?: unknown;
          rows?: unknown;
        };
        if (typeof terminalId !== 'string' || terminalId === '') return;
        // The Rust's `cols`/`rows` are `u16`: serde rejects a negative or a
        // float and the dispatch site logs and drops (`lib.rs:1439-1445`).
        // **Drop, never clamp** — clamping would resize a live terminal to a
        // geometry the peer never asked for, and the peer has no way to learn
        // that its request was altered.
        if (!isPtyDimension(cols) || !isPtyDimension(rows)) {
          this.deps.logger.warn(
            `dropped a terminal-resize frame with cols=${String(cols)} rows=${String(rows)}`,
          );
          return;
        }
        this.deps.terminal.resize(terminalId, cols, rows);
        return;
      }
      case 'terminal-close': {
        const { terminalId } = message as { terminalId?: unknown };
        if (typeof terminalId !== 'string' || terminalId === '') return;
        // `close` is fire-and-forget here: `PtyManager.close` runs its body
        // synchronously and reports a failure as a rejection, but the channel
        // callback must not become a place a rejection can escape from.
        void Promise.resolve(this.deps.terminal.close(terminalId)).catch(() => {
          // A close that fails has no frame to answer with — the browser
          // already dropped its session — so it is a log, not an error frame.
          this.deps.logger.warn(
            `failed to close the pty for terminal ${terminalId}`,
          );
        });
        return;
      }
      default:
        // Mirrors the Rust's `_ => {}` (`lib.rs:1470-1480`): an unknown type on
        // the terminal channel is dropped, never answered.
        return;
    }
  }

  /**
   * Spawn, and turn a `PtyError` into the frame the browser reads.
   *
   * The error's `code` is read **off the thrown object** rather than inferred
   * from the message text, which is what the Rust does (`spawn_failure_frame`
   * matches the string `"maximum concurrent PTY sessions"`, `lib.rs:2835-2842`)
   * only because Rust's `anyhow::Error` erases the type. TS keeps the class,
   * so the discriminator is `code`. An error with no recognised code is
   * reported as `pty-spawn-failed`: the Rust's own fallback arm.
   */
  private createTerminal(
    terminalId: string,
    cols: number,
    rows: number,
    shell: unknown,
  ): void {
    void Promise.resolve(
      this.deps.terminal.create({
        terminalId,
        cols,
        rows,
        shell: typeof shell === 'string' ? shell : undefined,
      }),
    ).catch((error: unknown) => {
      const code =
        (error as { code?: unknown } | null)?.code === 'session-limit-reached'
          ? 'session-limit-reached'
          : 'pty-spawn-failed';
      const message =
        error instanceof Error ? error.message : 'the pty could not be spawned';
      this.deps.logger.warn(
        `terminal ${terminalId} could not be created: ${message}`,
      );
      this.send(
        CHANNEL_LABELS.terminal,
        buildTerminalErrorFrame(
          terminalId,
          code,
          message,
          (this.deps.now ?? Date.now)(),
        ),
      );
    });
  }

  /**
   * Desktop JSON control on the `control` channel — **one decoder, one clamp**.
   *
   * The browser sends `sendJson('control', 'desktop-select', { sourceId })`
   * and `sendJson('control', 'desktop-bitrate', { bitrateBps })`
   * (`desktop-core/src/client.ts:424,429`). There is no `stream-control` type
   * on the wire, and `sourceId` is the **scheme string** the Rust carries
   * verbatim: `desktop.rs:1986-1988` deserialises `{ source_id }` (camelCase)
   * into `StreamControl::SourceSwap(message.source_id)` and the test at
   * `:2951-2962` pins `{"sourceId": "window:0x4a00007"}` →
   * `SourceSwap("window:0x4a00007")`. So `onSelect` receives the raw id
   * string — `monitor:1` / `window:<id>` / `test:0` — and the scheme split
   * stays with the consumer (`source_for`, `desktop.rs:922-948`, splits the
   * same scheme), exactly where the Rust puts it.
   *
   * **This used to be a second implementation.** Under BASE the two arms were
   * hand-rolled here while `desktop/control.ts` shipped decoders that read a
   * vocabulary nobody sends (`stream-control`/`action`, `source: {kind, id}`),
   * and the two drifted exactly as two copies of one contract do. Task 26
   * repointed those decoders at the real wire and this boundary now calls
   * them, so the parse, the type match and the **clamp** all live in
   * `decodeStreamControl` — the same three steps `decode_control` performs in
   * one function (`desktop.rs:1998-2023`).
   *
   * **What stays here is the logging.** The decoder answers `null` for both
   * "unknown type" and "this known type but a malformed body", and the two
   * deserve different handling: an unknown type is dropped silently, the way
   * the Rust's `_ => Ok(None)` drops it (`desktop-e2ee-hello` really does
   * arrive on this channel, `desktop-core/src/client.ts:257`), while a
   * malformed `desktop-select`/`desktop-bitrate` warns, because there a peer
   * meant to do something and it did not happen.
   *
   * `desktop-input` does not come through here at all: the router's own arm
   * runs **admit → decode → apply** before any dispatch, which is the Rust's
   * real order — the operator gate, then the 120 Hz cap, then
   * `apply_if_allowed` (which is what calls `decode_desktop_input` and
   * injects), `lib.rs:2413-2469`. The landed comment said "decoded before the
   * limiter and the injector — the order the Rust established", which inverted
   * the Rust and put the JSON parse in front of the DoS control that exists to
   * bound it (MAJOR-5).
   */
  private dispatchDesktop(message: Record<string, unknown>): void {
    const control = decodeStreamControl(message);
    if (!control) {
      if (
        message.type === 'desktop-select' ||
        message.type === 'desktop-bitrate'
      ) {
        this.deps.logger.warn(
          `dropped a malformed ${String(message.type)} frame`,
        );
      }
      return;
    }
    if (control.kind === 'select') {
      this.deps.desktop.onSelect(control.sourceId);
      return;
    }
    this.deps.desktop.onControl({ kind: 'bitrate', bitrate: control.bitrate });
  }

  /**
   * **R1, the outbound half.** Every JSON frame the files session returns goes
   * out wrapped in `DataChannelMessage`; binary chunk frames go out untouched.
   *
   * `frameFiles` is called **here**, at the boundary, and not inside
   * `FilesSession`. The session is a state machine that answers in frames; the
   * router is the thing that knows what a data channel carries. Putting the
   * wrap in the session would make every session test assert an envelope its
   * subject does not own, and would leave the desktop path — which also emits
   * JSON on a data channel — without one.
   */
  private emit(frames: unknown[]): void {
    const now = this.deps.now ?? Date.now;
    for (const frame of frames ?? []) {
      this.send(
        CHANNEL_LABELS.files,
        frame instanceof Uint8Array || typeof frame === 'string'
          ? frame
          : frameFiles(frame as FilesFrame, now()),
      );
    }
  }

  /**
   * **R1's `send` half: the production implementation `deps.send` never had.**
   *
   * **The router owns the channel lookup** — `attached` is the map `attach`
   * maintains, so a send goes to the one open channel for that label without a
   * second registry anywhere. `deps.send` exists for the **tests** (and for
   * whatever process wiring finally owns the transport): it is the seam, this
   * method is the real producer, and Task 19's runtime binds the two by
   * constructing the router over deps whose `send` is `router.send`.
   *
   * **An absent channel is warned and dropped, never thrown.** The sending
   * side has no request to answer — a frame queued for a channel that has
   * closed (the browser tab navigating away, the peer connection failing) has
   * no consumer left, and throwing out of a channel callback would kill the
   * pump loop the frame came from. The Rust agrees by construction: its send
   * site (`lib.rs:1839-1848`) logs `files frame send failed` at debug and
   * breaks the pump, it does not propagate into the session.
   */
  send(label: ChannelLabel, frame: unknown): void {
    const channel = this.attached.get(label);
    if (!channel) {
      this.deps.logger.warn(`dropped a ${label} frame with no open channel`);
      return;
    }
    if (frame instanceof Uint8Array) {
      channel.send(frame);
      return;
    }
    // An already-serialised frame goes to the wire as-is. `emit()` above
    // passes strings through untouched (`typeof frame === 'string' ? frame :
    // frameFiles(…)`), and Task 17's builders all return `JSON.stringify(…)`,
    // so without this branch every `desktop-stats` / `desktop-cursor` /
    // `desktop-sources` frame is encoded a second time: the browser's typed
    // listener parses once (`webrtc-core/src/data-channel.ts:34-41`), gets a
    // string, gates on `typeof parsed.type === 'string'`, and never fires —
    // a silent drop on both ends (MAJOR-3).
    if (typeof frame === 'string') {
      channel.send(frame);
      return;
    }
    channel.send(JSON.stringify(frame));
  }
}

/**
 * `clampBitrate` comes from Task 17's module (`../desktop/control.js`). The
 * plan's earlier draft deferred the import behind a CommonJS `require()` —
 * apps/agent is `"type": "module"`, so that `require` never existed at
 * runtime. A static import is the honest shape: the router is attached to
 * every peer, including peers that never open a control channel, but an
 * import is not a branch — the module loads with everything else, and its
 * `clampBitrate` is the one piece of Task 17 this boundary reuses as-is. The
 * two wire decoders it ships are not on the wire the browser speaks (see
 * `dispatchDesktop`'s note) and are not used here.
 */
