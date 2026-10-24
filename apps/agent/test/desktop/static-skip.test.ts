import { describe, expect, it } from 'vitest';
import {
  StaticFrameSkip,
  frameSignature,
  statsDueWhileSkipping,
} from '../../src/desktop/static-skip.js';

function frame(width: number, height: number, fill: number, seq = 0) {
  return {
    width,
    height,
    rgba: new Uint8Array(width * height * 4).fill(fill),
    seq,
  };
}

describe('frameSignature', () => {
  it('is equal for identical pixels with a different seq', () => {
    expect(frameSignature(frame(4, 4, 9, 0))).toBe(
      frameSignature(frame(4, 4, 9, 1)),
    );
  });

  it('distinguishes geometry even with identical pixels', () => {
    expect(frameSignature(frame(4, 4, 9))).not.toBe(
      frameSignature(frame(8, 2, 9)),
    );
  });

  it('detects a single changed byte', () => {
    const a = frame(4, 4, 9);
    const b = frame(4, 4, 9);
    b.rgba[7] = 10;
    expect(frameSignature(a)).not.toBe(frameSignature(b));
  });

  it('folds the trailing bytes when the length is not a multiple of 8', () => {
    // 3x1 RGBA = 12 bytes: one 8-byte word plus a 4-byte tail. A hashing scheme
    // that ignored the tail would call these identical.
    const a = { width: 3, height: 1, rgba: new Uint8Array(12), seq: 0 };
    const b = { width: 3, height: 1, rgba: new Uint8Array(12), seq: 0 };
    b.rgba[11] = 1;
    expect(frameSignature(a)).not.toBe(frameSignature(b));
  });
});

describe('StaticFrameSkip', () => {
  it('lets a changed frame through', () => {
    const skip = new StaticFrameSkip(30);
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false);
    expect(skip.shouldSkip(frame(4, 4, 2))).toBe(false);
  });

  it('skips repeats up to fps then forces one encode', () => {
    const skip = new StaticFrameSkip(30);
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false); // baseline
    const decisions: boolean[] = [];
    for (let i = 0; i < 32; i += 1)
      decisions.push(skip.shouldSkip(frame(4, 4, 1)));
    // 30 skips, then the 31st repeat is forced through, then skips resume.
    expect(decisions.slice(0, 30).every(Boolean)).toBe(true);
    expect(decisions[30]).toBe(false);
    expect(decisions[31]).toBe(true);
  });

  it('keeps the keepalive a FRAME count, not a wall clock', () => {
    // The cap is `round(fps)`, evaluated only on skipped frames. A stream that
    // stalls never advances the counter, which is exactly the Rust behaviour
    // and is why "1 s" is a consequence rather than the rule.
    const slow = new StaticFrameSkip(1);
    slow.shouldSkip(frame(4, 4, 1));
    expect(slow.shouldSkip(frame(4, 4, 1))).toBe(true);
  });

  it('reset forces the next frame through', () => {
    const skip = new StaticFrameSkip(30);
    skip.shouldSkip(frame(4, 4, 1));
    for (let i = 0; i < 5; i += 1) skip.shouldSkip(frame(4, 4, 1));
    skip.reset();
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false);
  });

  it('rounds a fractional fps and never yields a cap of zero', () => {
    const skip = new StaticFrameSkip(0.4);
    skip.shouldSkip(frame(4, 4, 1));
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(true);
  });
});

describe('statsDueWhileSkipping', () => {
  it('fires once per second', () => {
    expect(statsDueWhileSkipping(0, 999)).toBe(false);
    expect(statsDueWhileSkipping(0, 1000)).toBe(true);
  });
});
