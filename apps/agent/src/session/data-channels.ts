// apps/agent/src/session/data-channels.ts
import { MAX_DATA_CHANNEL_FRAME_BYTES } from '../signalling/constants.js';
import { frameFiles } from '../files/protocol.js';
import type { FilesFrame } from '../files/session.js';
import { clampBitrate } from '../desktop/control.js';
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
   */
  terminal: {
    write(terminalId: string, bytes: Uint8Array): void;
    resize(terminalId: string, cols: number, rows: number): void;
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
      !(typeof data === 'string') &&
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
        // **Ruling 1: the terminal vocabulary is `terminal-data`, not
        // `terminal-input`.** The browser's only inbound terminal write is
        // `sendJson('terminal', 'terminal-data', { terminalId, data:
        // uint8ArrayToBase64(bytes) })` (`terminal-core/src/client.ts:179,189`),
        // and the Rust's decoder matches exactly that: `decode_pty_input_with_id`
        // (`pty.rs:181-198`) gates `channel == "terminal" && type ==
        // "terminal-data"`, then STANDARD-decodes `payload.data` and returns
        // `(terminal_id, bytes)`. The plan's previous arm read `message.data`
        // as a plain string and had no terminalId — bytes would have been the
        // base64 **text**, and one channel's stream would have gone to one
        // implicit pty. `terminal-input` has **no producer anywhere** — it now
        // appears in this document only inside comments recording its
        // retirement (no fence constructs one) — so the
        // type is retired here rather than kept as a dead alternative.
        if (message.type !== 'terminal-data') return;
        const { terminalId, data } = message as {
          terminalId?: unknown;
          data?: unknown;
        };
        if (typeof terminalId !== 'string' || typeof data !== 'string') return;
        try {
          this.deps.terminal.write(
            terminalId,
            new Uint8Array(Buffer.from(data, 'base64')),
          );
        } catch {
          // Non-standard base64 (`Buffer` is lenient where Rust's STANDARD is
          // strict) or a malformed payload: drop, never throw into the channel.
        }
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
   * Desktop JSON control on the `control` channel, dispatched by the **real
   * wire types**.
   *
   * The browser sends `sendJson('control', 'desktop-select', { sourceId })`
   * and `sendJson('control', 'desktop-bitrate', { bitrateBps })`
   * (`desktop-core/src/client.ts:423-430`) — there is no `stream-control` type
   * on the wire, and `sourceId` is the **scheme string** the Rust carries
   * verbatim: `desktop.rs:1986-1988` deserialises `{ source_id }` (camelCase)
   * into `StreamControl::SourceSwap(message.source_id)` and the test at
   * `:2951-2962` pins `{"sourceId": "window:0x4a00007"}` →
   * `SourceSwap("window:0x4a00007")`. So `onSelect` receives the raw id
   * string — `monitor:1` / `window:<id>` / `test:0` — and the scheme split
   * stays with the consumer (`source_for`, `desktop.rs:922-948`, splits the
   * same scheme), exactly where the Rust puts it.
   *
   * **Byte source, stated: neither the envelope bytes nor a re-serialisation.**
   * The body is already parsed (`message`); the two real types are decoded
   * here. The comment this replaces claimed the decoders read the top-level
   * frame; they never did — and handing them the envelope's bytes made every
   * decode return `null`, because the envelope's `type` is not a field of the
   * body they match.
   *
   * **Task 17 must follow.** Its `decodeStreamControl` / `decodeDesktopSelect`
   * port (`:7587-7639`) reads a vocabulary the browser never sends —
   * `stream-control`/`action` and `source: { kind, id }`. Re-porting those two
   * decoders to the real vocabulary (`desktop-select { sourceId }`,
   * `desktop-bitrate { bitrateBps }`) is **Task 17's own change** and is out of
   * scope here (its fence is untouched). Until it lands, this boundary decodes
   * the two real types itself and reuses only Task 17's `clampBitrate` — the
   * one piece that is already right, and the same clamp the Rust runs inside
   * `decode_control` (`desktop.rs:2016-2019`). `desktop-input` does not come
   * through here at all: the router's own arm runs **admit → decode → apply**
   * before any dispatch, which is the Rust's real order — the operator gate,
   * then the 120 Hz cap, then `apply_if_allowed` (which is what calls
   * `decode_desktop_input` and injects), `lib.rs:2413-2469`. The landed
   * comment said "decoded before the limiter and the injector — the order the
   * Rust established", which inverted the Rust and put the JSON parse in front
   * of the DoS control that exists to bound it (MAJOR-5). `desktop-e2ee-hello`
   * also
   * arrives on `control` (`desktop-core/src/client.ts:257`); answering it is
   * the e2ee wiring's job, unfenced here, so an unknown type is dropped the
   * way the Rust's `_ => Ok(None)` arm drops it.
   */
  private dispatchDesktop(message: Record<string, unknown>): void {
    if (message.type === 'desktop-select') {
      if (typeof message.sourceId !== 'string') {
        this.deps.logger.warn(
          'dropped a desktop-select frame with no sourceId',
        );
        return;
      }
      this.deps.desktop.onSelect(message.sourceId);
      return;
    }
    if (message.type === 'desktop-bitrate') {
      if (
        typeof message.bitrateBps !== 'number' ||
        !Number.isFinite(message.bitrateBps)
      ) {
        this.deps.logger.warn(
          'dropped a desktop-bitrate frame with no bitrateBps',
        );
        return;
      }
      this.deps.desktop.onControl({
        kind: 'bitrate',
        bitrate: clampBitrate(message.bitrateBps),
      });
    }
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
