// apps/agent/src/desktop/control.ts
export const MIN_BITRATE = 250_000;
export const MAX_BITRATE = 20_000_000;

/**
 * The inbound `control`-channel commands, mirroring the Rust's `StreamControl`
 * (`desktop.rs:1938-1947`) — exactly two, `SetBitrate` and `SourceSwap`.
 *
 * The two members this type used to carry besides these — `pause`/`resume`/
 * `stop` and a `quality` profile change — were a plan defect (B63, QA's Task 17
 * F-1): no producer on this wire sends them, and the Rust has no arm for them,
 * so nothing could ever construct them. `quality` in particular is not an
 * inbound command at all — a profile change comes from the sustain ladder
 * inside `DesktopSession`.
 */
export type StreamControl =
  { kind: 'select'; sourceId: string } | BitrateControl;

/** The one member of `StreamControl` a `DesktopSession` applies itself. */
export type BitrateControl = { kind: 'bitrate'; bitrate: number };

/**
 * A capture source, as the capture layer takes it.
 *
 * Unrelated to the wire: the wire carries a **scheme string**
 * (`monitor:1` / `window:<id>` / `test:0`) and the Rust splits it at the
 * capture boundary (`source_for`, `desktop.rs:922-948`). This type is the
 * capture layer's own input, used by `resolveDefaultSource` and
 * `DesktopSourceList` — not a decode result.
 */
export type DesktopSource =
  | { kind: 'monitor'; id: string }
  | { kind: 'window'; id: string }
  | { kind: 'test' };

export function clampBitrate(bps: number): number {
  return Math.round(Math.min(Math.max(bps, MIN_BITRATE), MAX_BITRATE));
}

/**
 * The Rust deserialises the bitrate as `bitrate_bps: u32`
 * (`desktop.rs:1966-1970`), so a negative, fractional or oversized target is a
 * **malformed payload** and `decode_control` returns `Err` — it is clamped
 * only once it is a `u32`. Accepting these here and clamping them instead
 * would apply a control the Rust refuses, which is the kind of drift that
 * makes two implementations of one contract disagree.
 */
function isU32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

/**
 * Decode one inbound control message into a `StreamControl`
 * (`decode_control`, `desktop.rs:1998-2023`).
 *
 * **Takes the merged body, not bytes.** `DataChannelRouter.handleFrame` has
 * already parsed the envelope and gated on `channel === 'control'`
 * (`session/data-channels.ts:399-409`) and hands on `{ type, ...payload }`
 * (`:409-419`). The Rust does all three in one function because it takes
 * `raw: &str`; the TS router does the first two, so re-parsing here would
 * duplicate both the parse and the channel gate that already ran.
 *
 * The bitrate clamp lives **in the decoder**, not at the call site — the Rust
 * puts it here too (`desktop.rs:2015-2019`). There is more than one caller of
 * this union, and an out-of-range target is what makes the encoder refuse the
 * retarget; a clamp at one call site is a clamp at none.
 *
 * An unknown type returns `null`, dropped and never answered — the Rust's
 * `_ => Ok(None)` (`desktop.rs:2021-2023`). `desktop-e2ee-hello` really does
 * arrive on this channel (`desktop-core/src/client.ts:257`).
 */
export function decodeStreamControl(
  message: Record<string, unknown>,
): StreamControl | null {
  const sourceId = decodeDesktopSelect(message);
  if (sourceId !== null) return { kind: 'select', sourceId };
  if (message.type === 'desktop-bitrate') {
    if (!isU32(message.bitrateBps)) return null;
    return { kind: 'bitrate', bitrate: clampBitrate(message.bitrateBps) };
  }
  return null;
}

/**
 * The `sourceId` of a `desktop-select`, or `null` for any other body.
 *
 * Returns the **scheme string** the browser sends and the Rust carries
 * verbatim: `{"sourceId": "window:0x4a00007"}` → `SourceSwap("window:0x4a00007")`
 * (`desktop.rs:2951-2962`). Splitting it into `{ kind, id }` here would put the
 * parse in the wrong layer — the Rust splits it in `source_for`
 * (`desktop.rs:922-948`) and validates the id against the enumeration, which
 * this decoder cannot do.
 */
export function decodeDesktopSelect(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== 'desktop-select') return null;
  if (typeof message.sourceId !== 'string' || message.sourceId === '') {
    return null;
  }
  return message.sourceId;
}

/** Two seconds of frames, rounded, floored at 1. */
export function gopForFps(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}
