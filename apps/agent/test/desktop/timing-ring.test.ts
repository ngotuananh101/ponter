import { describe, expect, it } from 'vitest';
import { FrameTimingRing } from '../../src/desktop/timing-ring.js';

describe('FrameTimingRing', () => {
  it('reports no medians for an empty ring', () => {
    expect(new FrameTimingRing(32).medians()).toBeNull();
  });

  it('takes the middle value for an odd count', () => {
    const ring = new FrameTimingRing(32);
    for (const ms of [5, 1, 3]) ring.record(ms, 0, ms, 0);
    expect(ring.medians()?.encodeMsP50).toBe(3);
  });

  it('averages the two middle values for an even count', () => {
    const ring = new FrameTimingRing(32);
    for (const ms of [1, 2, 3, 4]) ring.record(ms, 0, ms, 0);
    expect(ring.medians()?.encodeMsP50).toBe(2.5);
  });

  it('keeps only the last `capacity` samples', () => {
    const ring = new FrameTimingRing(4);
    for (let i = 1; i <= 10; i += 1) ring.record(i, 0, i, 0);
    expect(ring.orderedSamples().map((s) => s.seq)).toEqual([7, 8, 9, 10]);
  });

  it('returns wrapped samples oldest to newest, not in slot order', () => {
    const ring = new FrameTimingRing(3);
    for (let i = 1; i <= 5; i += 1) ring.record(i, i * 1000, 1, 1);
    const seqs = ring.orderedSamples().map((s) => s.seq);
    expect(seqs).toEqual([3, 4, 5]);
    for (let i = 1; i < seqs.length; i += 1)
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('carries the camelCase wire fields', () => {
    const ring = new FrameTimingRing(1);
    ring.record(42, 1_700_000_000_000, 7, 3);
    expect(JSON.parse(JSON.stringify(ring.orderedSamples()))[0]).toEqual({
      seq: 42,
      captureEpochMs: 1_700_000_000_000,
      encodeMs: 7,
    });
  });
});
