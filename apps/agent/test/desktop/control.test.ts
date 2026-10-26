// apps/agent/test/desktop/control.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_BITRATE,
  MIN_BITRATE,
  clampBitrate,
  decodeDesktopSelect,
  decodeStreamControl,
  gopForFps,
} from '../../src/desktop/control.js';

/**
 * **The decoders take the merged body, not bytes.**
 *
 * `DataChannelRouter.handleFrame` has already parsed the envelope and gated on
 * `channel === 'control'` (`session/data-channels.ts:399-409`) by the time
 * `dispatchDesktop` runs, and what it hands on is `{ type, ...payload }`
 * (`:409-419`). The Rust's `decode_control` does all three steps in one
 * function because it takes `raw: &str` (`desktop.rs:1998-2007`); the TS
 * router does the first two, so re-parsing here would duplicate both the parse
 * and the gate.
 *
 * **The vocabulary is the browser's, not the plan's.** The literal type strings
 * and field names below are copied from `desktop-core/src/client.ts:424,429`
 * (`selectSource` → `sendControl('desktop-select', { sourceId })`,
 * `setBitrate` → `sendControl('desktop-bitrate', { bitrateBps })`) and from the
 * Rust the port is measured against (`desktop.rs:2011-2023`). If either side
 * renames a field, this file must change — which is the point: the cells this
 * file replaced encoded a `stream-control`/`action` vocabulary that **no
 * producer on this wire ever sent**, so they stayed green while the real frames
 * decoded to `null`.
 */

describe('clampBitrate', () => {
  it('clamps to [250 kbps, 20 Mbps]', () => {
    expect(clampBitrate(1_000_000)).toBe(1_000_000);
    expect(clampBitrate(1)).toBe(MIN_BITRATE);
    expect(clampBitrate(Number.MAX_SAFE_INTEGER)).toBe(MAX_BITRATE);
  });

  it('rounds to an integer', () => {
    expect(clampBitrate(1_000_000.6)).toBe(1_000_001);
  });
});

describe('decodeStreamControl', () => {
  it('decodes a desktop-select into the scheme string the Rust carries verbatim', () => {
    // `{"sourceId": "window:0x4a00007"}` → `SourceSwap("window:0x4a00007")`
    // (`desktop.rs:2951-2962`). The id is NOT split into `{kind, id}` here:
    // the Rust splits it in `source_for` (`desktop.rs:922-948`), and the port
    // leaves that split to the consumer for the same reason.
    expect(
      decodeStreamControl({
        type: 'desktop-select',
        sourceId: 'window:0x4a00007',
      }),
    ).toEqual({ kind: 'select', sourceId: 'window:0x4a00007' });
    expect(
      decodeStreamControl({ type: 'desktop-select', sourceId: 'monitor:1' }),
    ).toEqual({ kind: 'select', sourceId: 'monitor:1' });
    expect(
      decodeStreamControl({ type: 'desktop-select', sourceId: 'test:0' }),
    ).toEqual({ kind: 'select', sourceId: 'test:0' });
  });

  it('clamps a bitrate at the wire boundary, inside the decoder', () => {
    // The clamp lives here and nowhere else (`desktop.rs:2015-2019`). A clamp
    // at the call site is a clamp at none: there is more than one caller, and
    // an out-of-range target is what makes the encoder refuse the retarget.
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: 99_000_000 }),
    ).toEqual({ kind: 'bitrate', bitrate: MAX_BITRATE });
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: 1 }),
    ).toEqual({ kind: 'bitrate', bitrate: MIN_BITRATE });
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: 3_000_000 }),
    ).toEqual({ kind: 'bitrate', bitrate: 3_000_000 });
  });

  it('drops a control type the Rust has no arm for', () => {
    // `desktop-e2ee-hello` really does arrive on `control`
    // (`desktop-core/src/client.ts:257`) and is not a stream control at all;
    // an unknown type is dropped, never answered (`desktop.rs:2021-2023`).
    expect(
      decodeStreamControl({ type: 'desktop-e2ee-hello', publicKey: 'abc' }),
    ).toBeNull();
  });

  it('does not accept the dead stream-control vocabulary', () => {
    // Neither of these exists on the wire or in the Rust: `StreamControl` has
    // exactly two variants, `SetBitrate` and `SourceSwap`
    // (`desktop.rs:1938-1947`). The pre-fix decoder answered
    // `{kind:'pause'}` for the first of these.
    expect(
      decodeStreamControl({ type: 'stream-control', action: 'pause' }),
    ).toBeNull();
    expect(
      decodeStreamControl({
        type: 'stream-control',
        action: 'set-quality',
        profile: '720p30',
      }),
    ).toBeNull();
  });

  it('refuses a bitrate that is not a u32 instead of clamping it', () => {
    // The Rust deserialises `bitrate_bps: u32` (`desktop.rs:1966-1970`), so a
    // negative, fractional or oversized target is a malformed payload — not a
    // value to coerce into range. Clamping these would apply a control the
    // Rust refuses.
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: -1 }),
    ).toBeNull();
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: 3_000_000.5 }),
    ).toBeNull();
    expect(
      decodeStreamControl({
        type: 'desktop-bitrate',
        bitrateBps: 4_294_967_296,
      }),
    ).toBeNull();
    expect(
      decodeStreamControl({ type: 'desktop-bitrate', bitrateBps: '3000000' }),
    ).toBeNull();
    // Positive control through the SAME call: the bound is `u32`-inclusive, so
    // `u32::MAX` is a legal target and clamps, while `u32::MAX + 1` above is
    // malformed. Without this, a decoder that refused every large number would
    // pass the four cases above.
    expect(
      decodeStreamControl({
        type: 'desktop-bitrate',
        bitrateBps: 4_294_967_295,
      }),
    ).toEqual({ kind: 'bitrate', bitrate: MAX_BITRATE });
  });

  it('refuses a desktop-select with no sourceId', () => {
    expect(decodeStreamControl({ type: 'desktop-select' })).toBeNull();
  });
});

describe('decodeDesktopSelect', () => {
  it('returns the scheme string rather than a parsed {kind, id} pair', () => {
    expect(
      decodeDesktopSelect({
        type: 'desktop-select',
        sourceId: 'window:0x4a00007',
      }),
    ).toBe('window:0x4a00007');
  });

  it('refuses a missing, non-string or empty sourceId', () => {
    // Neither an absent nor an empty id names a source. The Rust accepts an
    // empty `source_id` at decode and refuses it in `source_for`
    // (`desktop.rs:922-948`); this decoder refuses it one step earlier, since
    // the port has no swap path yet — no source is selected either way.
    expect(decodeDesktopSelect({ type: 'desktop-select' })).toBeNull();
    expect(
      decodeDesktopSelect({ type: 'desktop-select', sourceId: 1 }),
    ).toBeNull();
    expect(
      decodeDesktopSelect({ type: 'desktop-select', sourceId: '' }),
    ).toBeNull();
  });

  it('refuses a body of another control type', () => {
    expect(
      decodeDesktopSelect({ type: 'desktop-bitrate', bitrateBps: 3_000_000 }),
    ).toBeNull();
  });
});

describe('gopForFps', () => {
  it('is two seconds of frames, never zero', () => {
    expect(gopForFps(60)).toBe(120);
    expect(gopForFps(30)).toBe(60);
    expect(gopForFps(0.2)).toBe(1);
  });
});
