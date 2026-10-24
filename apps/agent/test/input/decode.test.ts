// apps/agent/test/input/decode.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  InputLimiter,
  applyInput,
  bindInputApply,
  clamp01,
  decodeInput,
  toAbsolute,
} from '../../src/input/decode.js';
import type {
  InputEvent,
  InputInjector,
  InputSource,
} from '../../src/input/decode.js';

/**
 * Fixtures carry the `DataChannelMessage` envelope
 * (`packages/webrtc-core/src/data-channel.ts:74-88`), exactly as the browser sends
 * via `sendJson('control', 'desktop-input', event)`.
 */
const frame = (payload: unknown, channel = 'control', type = 'desktop-input') =>
  new TextEncoder().encode(
    JSON.stringify({ channel, type, payload, timestamp: 0 }),
  );

/** A counting double, the Rust test's `CountingInjector` (`input.rs:756-770`). */
function double(
  fail?: keyof InputInjector,
): InputInjector & { calls: string[] } {
  const calls: string[] = [];
  const ok = (name: string) => () => {
    calls.push(name);
    if (name === fail) throw new Error('injected failure');
  };
  return {
    calls,
    pointerMove: ok('pointerMove'),
    pointerButton: ok('pointerButton'),
    wheel: ok('wheel'),
    key: ok('key'),
    text: ok('text'),
  };
}

/** The 1080p monitor rect `desktop-sources` publishes (`DesktopSourceInfo.x/y`). */
const source: InputSource = { x: 100, y: 50, width: 1920, height: 1080 };

/**
 * Fixtures are the payload `sendControl('desktop-input', event)` sends
 * (`desktop-core/src/client.ts:452,467`): the `kind`-tagged `DesktopInput`
 * itself, never a `type`-tagged flat frame.
 */
describe('clamp01', () => {
  it('clamps into [0,1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('maps NaN to 0 rather than propagating it', () => {
    // Rust's f64::clamp panics on NaN and the agent used `clamp` inside a
    // `catch_unwind`; JS `Math.min/max` propagate NaN, which would reach the
    // injector. Both are handled here by one explicit rule.
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('keeps the endpoints', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('decodeInput', () => {
  it('decodes pointer-move with normalized coordinates', () => {
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.25 })),
    ).toEqual({
      kind: 'pointer-move',
      x: 0.5,
      y: 0.25,
    });
  });

  it('carries the browser-assigned seq through untouched', () => {
    // The decoder decodes; it does not own seq. `applyInput` echoes it back
    // (ADR-47), so it must arrive here intact.
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 42 })),
    ).toEqual({
      kind: 'pointer-move',
      x: 0.5,
      y: 0.5,
      seq: 42,
    });
    // And it is absent when the wire omitted it — `Key`/`Text` never carry one.
    expect(
      decodeInput(frame({ kind: 'wheel', dx: 1, dy: -1, x: 0.5, y: 0.5 })),
    ).toEqual({
      kind: 'wheel',
      dx: 1,
      dy: -1,
      x: 0.5,
      y: 0.5,
    });
  });

  it('decodes pointer-button with pressed as a boolean, not a kind split', () => {
    expect(
      decodeInput(
        frame({
          kind: 'pointer-button',
          button: 'left',
          pressed: true,
          x: 0.1,
          y: 0.1,
        }),
      ),
    ).toEqual({
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.1,
      y: 0.1,
    });
    expect(
      decodeInput(
        frame({
          kind: 'pointer-button',
          button: 'right',
          pressed: false,
          x: 0,
          y: 0,
        }),
      ),
    ).toEqual({
      kind: 'pointer-button',
      button: 'right',
      pressed: false,
      x: 0,
      y: 0,
    });
  });

  it('decodes wheel with the real dx/dy fields', () => {
    // `deltaX`/`deltaY` are the plan's invention; the wire is `dx`/`dy`
    // (`desktop.ts:78-85`, `input.rs:90-97`).
    expect(
      decodeInput(frame({ kind: 'wheel', dx: -1, dy: 3, x: 0.5, y: 0.5 })),
    ).toEqual({
      kind: 'wheel',
      dx: -1,
      dy: 3,
      x: 0.5,
      y: 0.5,
    });
  });

  it('decodes key with code, pressed and modifiers — no key name, no down/up kind', () => {
    expect(
      decodeInput(
        frame({
          kind: 'key',
          code: 'KeyA',
          pressed: true,
          modifiers: { ctrl: true, alt: false, shift: false, meta: false },
        }),
      ),
    ).toEqual({
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
  });

  it('decodes the text kind the earlier draft lacked entirely', () => {
    // Multi-byte on purpose: the `text` kind carries a JS string through
    // `TextDecoder`, and a fixture with only ASCII would not catch a decoder
    // that dropped or mangled continuation bytes.
    const multiByte = '\u65e5\u672c\u8a9e'; // 3 chars, 9 UTF-8 bytes
    expect(decodeInput(frame({ kind: 'text', text: multiByte }))).toEqual({
      kind: 'text',
      text: multiByte,
    });
  });

  it('returns null for an unknown kind instead of throwing', () => {
    expect(decodeInput(frame({ kind: 'hover' }))).toBeNull();
    expect(decodeInput(frame({ type: 'something-else' }))).toBeNull();
  });

  it('rejects a crypted `{ data }` payload deterministically, not accidentally', () => {
    // When the desktop E2EE session is armed, the browser sends the payload
    // `{ data: <base64> }` (`desktop-core/src/client.ts:484-494`). A crypted
    // frame must not half-parse as an event: the fields it does carry
    // (`data`) match nothing, and the drop is a `null` either way — but the
    // test pins that it stays a null after the shape settles, so the
    // decrypt-before-decode owner (the follow-up register) cannot be
    // replaced by a silent partial decode.
    expect(decodeInput(frame({ data: 'AQID' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(decodeInput(new TextEncoder().encode('{not json'))).toBeNull();
  });

  it('returns null for an unknown mouse button', () => {
    expect(
      decodeInput(
        frame({
          kind: 'pointer-button',
          button: 'thumb',
          pressed: true,
          x: 0,
          y: 0,
        }),
      ),
    ).toBeNull();
  });

  it('does not validate geometry at decode — that moved to applyInput', () => {
    // The Rust decodes at `input.rs:180-245` with no rect in sight; the rect
    // enters at the application site (`apply_if_allowed`, `input.rs:267`).
    // A zero/absent rect is `applyInput`'s concern.
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5 })),
    ).not.toBeNull();
  });

  it('rejects a payload-level frame lacking the envelope wrapper (must-fail control)', () => {
    // Port fidelity: the wire contract is the DataChannelMessage envelope, exactly as
    // `decode_desktop_input` (`input.rs:180-198`) expects. A bare payload frame must
    // fail decode deterministically so the router-decoder seam cannot silently drift.
    const flatPayload = new TextEncoder().encode(
      JSON.stringify({ kind: 'pointer-move', x: 0.5, y: 0.5 }),
    );
    expect(decodeInput(flatPayload)).toBeNull();
  });

  it('rejects an envelope with wrong channel or wrong type', () => {
    expect(
      decodeInput(
        frame(
          { kind: 'pointer-move', x: 0.5, y: 0.5 },
          'terminal',
          'desktop-input',
        ),
      ),
    ).toBeNull();
    expect(
      decodeInput(
        frame(
          { kind: 'pointer-move', x: 0.5, y: 0.5 },
          'control',
          'desktop-select',
        ),
      ),
    ).toBeNull();
  });
});

describe('toAbsolute', () => {
  const source: InputSource = { x: 100, y: 50, width: 1920, height: 1080 };

  it('maps the endpoints to source.x + round(n * width) — x + width, NOT width-1', () => {
    // `input.rs:745-751` pins this exactly: `to_absolute(0.0,0.0)` is the
    // origin and `to_absolute(1.0,1.0)` is `x + width / y + height`. The
    // earlier draft clamped to `extent - 1` and justified it with a comment
    // that misquoted both the Rust (which does not clamp to width-1) and the
    // injector (which clamps to [0, display_width] at
    // `portal/injector.rs:37-42` — it never refuses).
    expect(toAbsolute(0, 0, source)).toEqual({ x: 100, y: 50 });
    expect(toAbsolute(1, 1, source)).toEqual({ x: 100 + 1920, y: 50 + 1080 });
  });

  it('maps a mid-frame point with the nonzero origin the Rust test pins', () => {
    // `input.rs:745-751`: source.x=100, width=1920 -> 0.5 lands at 1060.
    expect(toAbsolute(0.5, 0.5, source)).toEqual({ x: 100 + 960, y: 50 + 540 });
  });
});

describe('applyInput', () => {
  it('maps through the source rect and injects a pointer move', () => {
    const injector = double();
    const seq = applyInput(
      { kind: 'pointer-move', x: 0.5, y: 0.5, seq: 7 },
      source,
      injector,
      0,
    );
    expect(injector.calls).toEqual(['pointerMove']);
    expect(seq).toBe(7);
  });

  it('moves before button/wheel so the click lands on the intended point', () => {
    // The Rust's `apply_if_allowed` does `pointer_move` then
    // `pointer_button`/`wheel` for the anchored kinds (`input.rs:291-308`).
    const injector = double();
    applyInput(
      {
        kind: 'pointer-button',
        button: 'left',
        pressed: true,
        x: 0.1,
        y: 0.1,
        seq: 9,
      },
      source,
      injector,
      0,
    );
    expect(injector.calls).toEqual(['pointerMove', 'pointerButton']);
    applyInput(
      { kind: 'wheel', dx: 1, dy: 0, x: 0.1, y: 0.1 },
      source,
      injector,
      0,
    );
    expect(injector.calls).toEqual([
      'pointerMove',
      'pointerButton',
      'pointerMove',
      'wheel',
    ]);
  });

  it('injects key and text with no move and no seq', () => {
    const injector = double();
    expect(
      applyInput(
        {
          kind: 'key',
          code: 'KeyA',
          pressed: true,
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
        source,
        injector,
        0,
      ),
    ).toBeNull();
    expect(injector.calls).toEqual(['key']);
    expect(
      applyInput({ kind: 'text', text: 'x' }, source, injector, 0),
    ).toBeNull();
    expect(injector.calls).toEqual(['key', 'text']);
  });

  it('returns null — not a throw — when the injector fails, after any partial move', () => {
    // Fail-soft (`input.rs:316-331`): an injector error drops the frame and
    // the session continues. For pointer-button the move has already happened;
    // the button is the step that fails.
    const injector = double('pointerButton');
    expect(
      applyInput(
        {
          kind: 'pointer-button',
          button: 'left',
          pressed: true,
          x: 0.1,
          y: 0.1,
          seq: 3,
        },
        source,
        injector,
        0,
      ),
    ).toBeNull();
    expect(injector.calls).toEqual(['pointerMove', 'pointerButton']);
  });
});

describe('bindInputApply — the seam Task 18 consumes', () => {
  it('closes over source and injector at construction; apply takes only (event, now)', () => {
    // The router holds no geometry, so the implementation must carry it. This
    // is the Rust's `apply_if_allowed(allow_input, raw, &current_source,
    // injector, now_ms)` with the rect and injector bound at construction
    // (`input.rs:267-273`). `now` is the envelope-timestamp seam ADR-44 logs.
    const injector = double();
    const apply = bindInputApply({ allow: true, source, injector });
    const seq = apply(
      { kind: 'pointer-move', x: 0.5, y: 0.5, seq: 11 } as InputEvent,
      1234,
    );
    expect(seq).toBe(11);
    expect(injector.calls).toEqual(['pointerMove']);
  });

  it('drops everything when the gate is closed, and the limiter never sees the budget spent', () => {
    const injector = double();
    const apply = bindInputApply({ allow: false, source, injector });
    expect(
      apply({ kind: 'pointer-move', x: 0.5, y: 0.5 } as InputEvent, 1),
    ).toBeNull();
    expect(injector.calls).toEqual([]);
  });
});

describe('InputLimiter', () => {
  it('admits everything when input is enabled and under 120 Hz', () => {
    // The fixture starts mid-window and crosses a wall-clock second (990 ms
    // steps into window 1 at the third call). Starting at t=0 — the original
    // fixture — is the single instant where a wrong window anchoring is
    // invisible, so it must not be the only phase the fence exercises.
    let now = 990;
    const limiter = new InputLimiter(true);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.admit(now)).toBe(true);
      now += 9;
    }
  });

  it('drops events beyond 120 per fixed 1-second window and counts them', () => {
    // The Rust used a FIXED window that resets every second, not a sliding one:
    // 120 events are allowed in [0,1000) and another 120 in [1000,2000),
    // regardless of how they cluster. A sliding window would smooth this and is
    // a different policy; do not "improve" it.
    const limiter = new InputLimiter(true);
    let admitted = 0;
    for (let i = 0; i < 200; i += 1) if (limiter.admit(0)) admitted += 1;
    expect(admitted).toBe(120);
    expect(limiter.dropped()).toBe(80);
    expect(limiter.admit(1000)).toBe(true);
  });

  it('admits a fresh burst at every wall-clock second, not every 1000 ms since the first call', () => {
    // The discriminating anchor fixture (measurement case C): 120 frames at
    // t=5500 fill window 5; t=6000 is window 6 — a new wall-clock second — so
    // the count resets and two more frames are admitted although only 500 ms
    // have elapsed. An elapsed-since-first-call anchoring (windowStart=5500)
    // still has a full window at t=6000 and refuses both. `floor(now/1000)` is
    // the Rust's euclidean window index (`input.rs:142`).
    const limiter = new InputLimiter(true);
    let admitted = 0;
    for (let i = 0; i < 120; i += 1) if (limiter.admit(5_500)) admitted += 1;
    expect(admitted).toBe(120);
    expect(limiter.admit(6_000)).toBe(true);
    expect(limiter.admit(6_001)).toBe(true);
  });

  it('refuses every frame when the gate is closed, and does no rate accounting', () => {
    // The Rust never consults the limiter when allow_input is false
    // (`lib.rs:2430` sits inside `if allow_input`; the else branch just logs
    // and continues, `:2471-2473`), so a refusal while disabled is not a
    // rate-limit event: nothing is counted and the window never moves. The
    // landed fence asserted the opposite twice — one test named "does not
    // count a refusal" whose assertion was `dropped() === 1` — a
    // self-contradicting pair whose two halves both passed. `dropped()` counts
    // rate-limit refusals only, and is a declared agent-side addition, not a
    // port: `InputRateLimiter` has no drop counter.
    const limiter = new InputLimiter(false);
    expect(limiter.admit(0)).toBe(false);
    expect(limiter.admit(5_000)).toBe(false);
    expect(limiter.dropped()).toBe(0);
  });

  it('admits without decoding — it takes a timestamp, not an event', () => {
    // The ordering property, at the type level: `admit(now)` cannot depend on
    // a decoded event because it never receives one. The Rust runs this cap
    // before `decode_desktop_input` (`lib.rs:2428-2434`).
    const limiter = new InputLimiter(true);
    expect(limiter.admit(0)).toBe(true);
  });
});

describe('peer-supplied wire values — the strictness serde imposes', () => {
  it('clamps peer-supplied coordinates at decode, not only at apply', () => {
    // Rust clamps INSIDE the decode arm (`input.rs:197-222`:
    // `x: clamp01(x), y: clamp01(y)`), so an out-of-range pair never survives
    // as an event. The landed decoder does the same, but no cell fed it a value
    // outside [0,1] — a mutant that drops the clamp was green.
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 1.5, y: -0.5 })),
    ).toEqual({
      kind: 'pointer-move',
      x: 1,
      y: 0,
    });
    expect(
      decodeInput(
        frame({
          kind: 'pointer-button',
          button: 'left',
          pressed: true,
          x: 9,
          y: 4,
        }),
      ),
    ).toEqual({
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 1,
      y: 1,
    });
  });

  it('injects wheel deltas as integers, the way the Rust casts them', () => {
    // `injector.wheel(dx as i32, dy as i32)` (`input.rs:307`) truncates toward
    // zero. The landed port passed `f64` through, so a native binding received
    // a delta the Rust never produced.
    const wheelArgs: Array<[number, number]> = [];
    const injector: InputInjector = {
      pointerMove() {},
      pointerButton() {},
      wheel(dx: number, dy: number) {
        wheelArgs.push([dx, dy]);
      },
      key() {},
      text() {},
    };
    applyInput(
      { kind: 'wheel', dx: 1.7, dy: -2.7, x: 0.5, y: 0.5 },
      source,
      injector,
      0,
    );
    expect(wheelArgs).toEqual([[1, -2]]);
  });

  it('drops a frame whose seq is not an integer, as serde does', () => {
    // `#[serde(default)] seq: Option<u64>` — `"abc"` and `1.5` are both decode
    // errors, i.e. the frame is dropped, not silently unseq'd.
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 'abc' })),
    ).toBeNull();
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 1.5 })),
    ).toBeNull();
  });

  it('drops a frame whose modifiers are not booleans, as serde does', () => {
    // `KeyModifiers { ctrl: bool, .. }` — a string is a decode error. Accepting
    // it would inject a keystroke with a modifier state the peer never meant.
    expect(
      decodeInput(
        frame({
          kind: 'key',
          code: 'KeyA',
          pressed: true,
          modifiers: { ctrl: 'yes' },
        }),
      ),
    ).toBeNull();
    expect(
      decodeInput(
        frame({ kind: 'key', code: 'KeyA', pressed: true, modifiers: 'ctrl' }),
      ),
    ).toBeNull();
  });

  it('defaults every omitted modifier to false, not to undefined', () => {
    // `#[serde(default)] modifiers: KeyModifiers` with `KeyModifiers: Default`
    // — a key frame carrying no modifiers decodes to all-false booleans. The
    // declared `KeyModifiers` says `boolean`, so a defaulting rule of
    // `m.ctrl as boolean` hands the injector `undefined` and leaves the type
    // contract false at runtime. No plan cell sent a key frame without
    // modifiers, so that mutation was green.
    expect(
      decodeInput(frame({ kind: 'key', code: 'KeyA', pressed: true })),
    ).toEqual({
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    // A partial struct defaults only the fields it omits.
    expect(
      decodeInput(
        frame({
          kind: 'key',
          code: 'KeyA',
          pressed: true,
          modifiers: { shift: true },
        }),
      ),
    ).toEqual({
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: false, alt: false, shift: true, meta: false },
    });
  });

  it('accepts a null seq, because Option<u64> maps null to None', () => {
    // The guard must not be over-strict in the other direction: the oracle
    // (P6) shows `"seq": null` decodes OK as `seq: None`, so a frame carrying
    // it is a live pointer event, not a drop. Both polarities on one field —
    // `"abc"` drops, `null` passes — so neither the lax nor the strict
    // mutation survives.
    expect(
      decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: null })),
    ).toEqual({ kind: 'pointer-move', x: 0.5, y: 0.5 });
  });
});
