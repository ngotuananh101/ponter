// apps/agent/src/input/decode.ts
export const INPUT_RATE_LIMIT_HZ = 120;

/**
 * One input event, **the wire's own union** (`DesktopInput`,
 * `packages/shared/src/types/desktop.ts:68-87`, mirrored by the Rust's
 * `DesktopInputWire`, `input.rs:75-107`).
 *
 * The wire frame arrives as the `DataChannelMessage` envelope
 * (`{ channel: 'control', type: 'desktop-input', payload, timestamp }`),
 * exactly as `decode_desktop_input` (`input.rs:180-198`) expects. The decoder
 * receives the raw frame bytes, verifies `channel === 'control'` and
 * `type === 'desktop-input'`, and unwraps `envelope.payload`. Inside the
 * payload, the discriminator is the `kind` tag, **kebab-case** — matching
 * serde's internally-tagged enum (`#[serde(tag = "kind", rename_all = "kebab-case")]`,
 * `input.rs:73-74`).
 *
 * Coordinates are **normalized 0..1 within the streamed source** and stay
 * that way: the Rust's decoder clamps them (`clamp01`, `input.rs:197-222`)
 * and the normalized→absolute mapping happens at the **application site**
 * with the live rect (`to_absolute`, `input.rs:247-257`, called from
 * `apply_if_allowed`). Mapping here would need a rect the decoder does not
 * have, and the previous version's guess (`extent - 1`) contradicted the
 * pinned endpoint test at `input.rs:745-751`.
 *
 * `seq` is carried through **untouched** where the wire carries it — the
 * pointer kinds only (`Key`/`Text` have none, `input.rs:98-106`). The decoder
 * does not own it; `applyInput` echoes it back for the cursor latency meter
 * (ADR-47).
 */
export type InputEvent =
  | { kind: 'pointer-move'; x: number; y: number; seq?: number }
  | {
      kind: 'pointer-button';
      button: 'left' | 'middle' | 'right';
      pressed: boolean;
      x: number;
      y: number;
      seq?: number;
    }
  | {
      kind: 'wheel';
      dx: number;
      dy: number;
      x: number;
      y: number;
      seq?: number;
    }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/** The keyboard modifier state the `key` kind carries (`desktop.ts:55-60`). */
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * The capture rect the mapping needs: the `x`/`y` origin and the `width`/
 * `height` of the streamed source. This is the geometry `desktop-sources`
 * publishes (`DesktopSourceInfo`, `desktop.ts:11-27`) and the only place the
 * real wiring can get it — which is why `applyInput` takes it as a parameter
 * rather than `decodeInput` guessing one.
 */
export interface InputSource {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The platform seam, the port of the Rust's `InputInjector` trait
 * (`input.rs:62-68`). One platform implementation sits behind it; tests use a
 * counting double. Each call returns nothing and throws on failure, which is
 * the fail-soft signal `applyInput` turns into a `null`.
 */
export interface InputInjector {
  pointerMove(x: number, y: number): void;
  pointerButton(button: 'left' | 'middle' | 'right', pressed: boolean): void;
  wheel(dx: number, dy: number): void;
  key(code: string, pressed: boolean, modifiers: KeyModifiers): void;
  text(text: string): void;
}

/**
 * `Math.min(Math.max(v, 0), 1)` with NaN forced to 0.
 *
 * Written out rather than using a helper so the NaN rule is visible: `NaN`
 * compared with `>` and `<` is false on both sides, so a naive clamp silently
 * returns `NaN` and the injector receives it. Rust's `f64::clamp` *panics* on
 * NaN, which the agent turned into a dropped frame via `catch_unwind`
 * (`input.rs:155-161`); the explicit branch reproduces the drop without the
 * unwind.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Map a normalized point to absolute source pixels — the Rust's `to_absolute`
 * (`input.rs:247-257`): `abs = source.x + round(n * dimension)`.
 *
 * **`x + width`, not `width - 1`.** The pinned endpoint test
 * (`input.rs:745-751`) asserts `to_absolute(1.0, 1.0) == (source.x + 1920,
 * source.y + 1080)` for a 1920×1080 source at origin (100, 50). The earlier
 * draft clamped to `extent - 1` and justified it with a comment claiming the
 * Rust clamped to `width-1` and the injector refused out-of-bounds outright —
 * **both halves false**: the Rust does not clamp to `width-1`, and the portal
 * injector *clamps* to `[0, display_width]` rather than refusing
 * (`portal/injector.rs:37-42`). The right edge is reachable because the source
 * rectangle is half-open, and the injector is what bounds it.
 *
 * `clamp01` is applied to the fraction first, so an out-of-range or NaN input
 * cannot overflow the rect even though the decoder already clamped it — this
 * function is pure and must not depend on its caller for that.
 */
export function toAbsolute(
  nx: number,
  ny: number,
  source: InputSource,
): { x: number; y: number } {
  return {
    x: source.x + Math.round(clamp01(nx) * source.width),
    y: source.y + Math.round(clamp01(ny) * source.height),
  };
}

const BUTTONS = new Set(['left', 'middle', 'right']);

/**
 * Decodes one `desktop-input` payload (B28–B30) — the port of
 * `decode_desktop_input` (`input.rs:180-245`).
 *
 * **The wire frame is an envelope:** `DataChannelMessage`
 * (`{ channel: 'control', type: 'desktop-input', payload, timestamp }`),
 * exactly as `decode_desktop_input` (`input.rs:187-191`) validates. The decoder
 * receives the raw frame bytes, verifies `channel === 'control'` and
 * `type === 'desktop-input'`, unwraps `envelope.payload`, and decodes the event.
 *
 * **Decode before inject, always.** The Rust decoded the JSON first and only
 * then called into the platform injector, so an unknown message could never
 * reach an FFI boundary with unvalidated fields. Every rejection here is a
 * `null` — an input frame that does not parse is dropped, never surfaced as an
 * error, because a hostile peer must not be able to elicit a response by
 * sending garbage.
 *
 * **Inside the payload, the discriminator is `kind`,** exactly as serde's
 * internally-tagged enum works (`#[serde(tag = "kind", rename_all = "kebab-case")]`,
 * `input.rs:73-74`): an unknown `kind` is a decode error, which is this
 * function's `null`. The plan's previous vocabulary (`input-pointer` etc. on a
 * `type` field) has **zero producers anywhere** on either side of the wire.
 *
 * **A crypted payload is rejected deterministically.** With the desktop E2EE
 * session armed the browser sends `{ data: <base64> }` as `payload` instead of
 * the event (`desktop-core/src/client.ts:484-494`), and the Rust decrypts
 * **before** decode (`lib.rs:2413-2427`, fail-closed). Nothing in this plan
 * owns that decryption yet, so a crypted frame must not be able to half-parse
 * into an event: it has no `kind`, so it falls out of the `switch` as `null`.
 * The `{ data }` shape is named in the test so the drop is pinned rather than
 * incidental, and the missing owner is recorded in the follow-up register.
 */
export function decodeInput(
  bytes: ArrayBuffer | Uint8Array,
): InputEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof (bytes as Uint8Array).byteLength === 'number'
        ? new TextDecoder().decode(bytes as Uint8Array)
        : new TextDecoder().decode(new Uint8Array(bytes as ArrayBuffer)),
    );
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.channel !== 'control' || envelope.type !== 'desktop-input')
    return null;
  if (typeof envelope.payload !== 'object' || envelope.payload === null)
    return null;
  const message = envelope.payload as Record<string, unknown>;

  // serde is STRICT about these two fields, and a rejection drops the WHOLE
  // frame (`input.rs:75-107`): `#[serde(default)] seq: Option<u64>` and
  // `#[serde(default)] modifiers: KeyModifiers` whose fields are `bool`.
  // Measured against the real wire types (`../t15-oracle-rs`): `seq: "abc"` is
  // `invalid type: string, expected u64` and `modifiers: {ctrl: "yes"}` is
  // `invalid type: string, expected bool`. Accepting either produces an event
  // the Rust would have dropped — for `modifiers` that means injecting a
  // keystroke whose modifier state the peer mis-encoded.
  if (
    'seq' in message &&
    message.seq !== undefined &&
    message.seq !== null &&
    (typeof message.seq !== 'number' || !Number.isInteger(message.seq))
  ) {
    return null;
  }
  if ('modifiers' in message && message.modifiers !== undefined) {
    const raw = message.modifiers;
    if (typeof raw !== 'object' || raw === null) return null;
    for (const key of ['ctrl', 'alt', 'shift', 'meta']) {
      const value = (raw as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== 'boolean') return null;
    }
  }

  switch (message.kind) {
    case 'pointer-move': {
      if (typeof message.x !== 'number' || typeof message.y !== 'number')
        return null;
      return {
        kind: 'pointer-move',
        x: clamp01(message.x),
        y: clamp01(message.y),
        ...seqOf(message),
      };
    }
    case 'pointer-button': {
      if (typeof message.button !== 'string' || !BUTTONS.has(message.button))
        return null;
      if (typeof message.pressed !== 'boolean') return null;
      if (typeof message.x !== 'number' || typeof message.y !== 'number')
        return null;
      return {
        kind: 'pointer-button',
        button: message.button as 'left' | 'middle' | 'right',
        pressed: message.pressed,
        x: clamp01(message.x),
        y: clamp01(message.y),
        ...seqOf(message),
      };
    }
    case 'wheel': {
      // The real field names: `dx`/`dy` (`desktop.ts:78-85`, `input.rs:90-97`).
      if (typeof message.dx !== 'number' || typeof message.dy !== 'number')
        return null;
      if (typeof message.x !== 'number' || typeof message.y !== 'number')
        return null;
      return {
        kind: 'wheel',
        dx: message.dx,
        dy: message.dy,
        x: clamp01(message.x),
        y: clamp01(message.y),
        ...seqOf(message),
      };
    }
    case 'key': {
      // `code` + `pressed` + `modifiers`; there is no `key` name and no
      // down/up `kind` split on this wire (`desktop.ts:86`, `input.rs:98-103`).
      if (
        typeof message.code !== 'string' ||
        typeof message.pressed !== 'boolean'
      )
        return null;
      return {
        kind: 'key',
        code: message.code,
        pressed: message.pressed,
        modifiers: modifiersOf(message.modifiers),
      };
    }
    case 'text': {
      if (typeof message.text !== 'string') return null;
      return { kind: 'text', text: message.text };
    }
    default:
      return null;
  }
}

/** `{ seq }` when the wire carried one, `{}` otherwise — `skip_serializing_if`'s inverse. */
function seqOf(message: Record<string, unknown>): { seq?: number } {
  return typeof message.seq === 'number' ? { seq: message.seq } : {};
}

/** The modifier struct, defaulting every field the wire omitted (`KeyModifiers: Default`). */
function modifiersOf(raw: unknown): KeyModifiers {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    ctrl: m.ctrl === true,
    alt: m.alt === true,
    shift: m.shift === true,
    meta: m.meta === true,
  };
}

/**
 * Apply one event to the injector — the port of `apply_if_allowed`
 * (`input.rs:267-333`).
 *
 * This is where the normalized→absolute mapping lives, because this is where
 * the geometry is: the Rust passes `&current_source` in and calls
 * `to_absolute` per event (`input.rs:287-308`). Returns the applied event's
 * `seq` when the wire carried one, `null` when the event was not applied
 * (injector error) — the Rust's `Ok(()) => Some(seq)` / `Err => None`
 * (`input.rs:316-331`). The caller continues the session either way; an
 * injector failure is never fatal.
 *
 * **The gate is not here.** `apply_if_allowed`'s `allow_input` first argument
 * and its rate cap are the caller's, because the Rust runs both **before**
 * decoding (`lib.rs:2427-2434`) — see `bindInputApply` and the router arm.
 *
 * **Move before click.** `pointer-button` and `wheel` issue a `pointerMove`
 * first so the click or scroll lands on the intended point, exactly as the
 * Rust does (`input.rs:291-308`).
 *
 * `now` is the ADR-44 logging seam (`delta_ms = now_ms - envelope_timestamp`,
 * `input.rs:320-325`). The plan's decoder does not yet return the envelope
 * timestamp, so it is accepted and unused; it is in the signature so the seam
 * does not have to change when the timestamp is threaded through.
 */
export function applyInput(
  event: InputEvent,
  source: InputSource,
  injector: InputInjector,
  _now: number,
): number | null {
  try {
    switch (event.kind) {
      case 'pointer-move': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        return event.seq ?? null;
      }
      case 'pointer-button': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        injector.pointerButton(event.button, event.pressed);
        return event.seq ?? null;
      }
      case 'wheel': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        // The Rust hands the injector `i32` (`input.rs:307`): `dx as i32`
        // truncates toward zero, so 1.7 -> 1 and -2.7 -> -2. A fractional
        // delta reaches a platform binding the Rust never sent one to.
        injector.wheel(Math.trunc(event.dx), Math.trunc(event.dy));
        return event.seq ?? null;
      }
      case 'key':
        injector.key(event.code, event.pressed, event.modifiers);
        return null;
      case 'text':
        injector.text(event.text);
        return null;
    }
  } catch {
    // Fail-soft: an injector error drops the frame and the session continues
    // (`input.rs:328-331`). The partial walk above is deliberate — a click
    // whose move succeeded and whose button failed has still moved.
    return null;
  }
}

/**
 * Bind `applyInput` to the live source rect and injector, producing the
 * `(event, now) => number | null` seam Task 18's router consumes.
 *
 * The router holds **no geometry** — it should not, it is a wire dispatcher —
 * so the implementation that closes over the rect and the injector is built
 * where they exist. This is the Rust's shape with the two arguments bound at
 * construction instead of per call (`apply_if_allowed(allow_input, raw,
 * &current_source, injector, now_ms)`, `input.rs:267-273`), and it is how
 * `current_source` and the lazily created `injector` are hoisted in
 * `lib.rs:2435-2462`.
 *
 * `allow` is the operator's gate, folded in here rather than as a separate
 * seam: a closed gate means every event is not-applied, which is what `null`
 * already means. The rate cap is **not** here — it runs before decode (see
 * `InputLimiter`), so by the time an event reaches this function it has
 * already been admitted.
 *
 * `now` is the ADR-44 logging seam: the Rust logs `delta_ms = now_ms -
 * envelope_timestamp` on the success path (`input.rs:320-325`). The envelope
 * timestamp is not decoded yet (the plan's decoder returns the event alone),
 * so it is carried through unused; it is in the signature because the seam must
 * not drift when the timestamp is threaded through.
 */
export function bindInputApply(deps: {
  allow: boolean;
  source: InputSource;
  injector: InputInjector;
}): (event: InputEvent, now: number) => number | null {
  return (event, now) => {
    if (!deps.allow) return null;
    return applyInput(event, deps.source, deps.injector, now);
  };
}

/**
 * The 120 Hz admission cap (B34), the port of `InputRateLimiter::allow`
 * (`input.rs:124-152`).
 *
 * **The gate and the cap run BEFORE decode, not after.** The Rust's inbound
 * arm (`lib.rs:2427-2434`) checks `allow_input`, then `input_limiter.allow(now)`,
 * and only then calls `apply_if_allowed` — which is what decodes and injects.
 * Its own comment says so: *"cap AFTER decrypt and the Gate-A check, **BEFORE
 * decode/inject**"* (`lib.rs:2428-2430`). The reason is the point: this is a
 * DoS control, so it must sit in front of the JSON parser, not behind it. The
 * plan's earlier version put `accept(decode(bytes))` first, which spent the
 * parse on work the cap existed to refuse, and its `accept(_event)` signature
 * could not express the gate-before-decode order at all. Hence `admit(now)`:
 * no event, no bytes, just the decision.
 *
 * **The closed gate is a refusal with no rate accounting.** The Rust never
 * consults the limiter when `allow_input` is false — `lib.rs:2430` sits inside
 * `if allow_input { … } else { log; continue }` (`:2471-2473`) — so a host with
 * input disabled does **no rate accounting at all**: no window movement, no
 * count, no drop. The landed version checked `allow` here and incremented its
 * drop counter on the refusal, which its own doc said was wrong; that inverted
 * the Rust and pinned a self-contradicting pair of tests (one named "does not
 * count a refusal" whose assertion was `dropped() === 1`). So: `allow` is
 * carried and checked, but a closed-gate refusal returns before any counting —
 * `dropped()` therefore counts **rate-limit** refusals only, and is a declared
 * agent-side addition, not a port (`InputRateLimiter` has no drop counter).
 *
 * The window is **fixed**, reset per whole second (`window = floor(now/1000)`,
 * the euclidean division at `input.rs:142`), not sliding: 120 events are
 * admitted in `[0, 1000)` and another 120 in `[1000, 2000)` regardless of
 * clustering. A sliding window would smooth this and is a different policy;
 * do not "improve" it.
 */
export class InputLimiter {
  private windowIndex = Number.NaN;
  private count = 0;
  private droppedCount = 0;

  constructor(private readonly allow: boolean) {}

  /** `allow(now_ms)` from `input.rs:141`. `true` iff the frame may be parsed. */
  admit(now: number): boolean {
    if (!this.allow) return false;
    const window = Math.floor(now / 1000);
    if (window !== this.windowIndex) {
      this.windowIndex = window;
      this.count = 0;
    }
    if (this.count >= INPUT_RATE_LIMIT_HZ) {
      this.droppedCount += 1;
      return false;
    }
    this.count += 1;
    return true;
  }

  dropped(): number {
    return this.droppedCount;
  }
}
