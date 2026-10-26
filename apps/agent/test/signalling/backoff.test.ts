import { describe, expect, it } from 'vitest';
import {
  BACKOFF_FACTOR,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  nextBackoff,
} from '../../src/signalling/backoff.js';

describe('nextBackoff', () => {
  it('grows by the factor from the initial value', () => {
    expect(BACKOFF_INITIAL_MS).toBe(200);
    expect(BACKOFF_FACTOR).toBe(1.5);
    let d = BACKOFF_INITIAL_MS;
    const seen = [d];
    for (let i = 0; i < 3; i += 1) {
      d = nextBackoff(d);
      seen.push(d);
    }
    expect(seen).toEqual([200, 300, 450, 675]);
  });

  it('caps at the maximum', () => {
    let d = BACKOFF_INITIAL_MS;
    for (let i = 0; i < 12; i += 1) d = nextBackoff(d);
    expect(d).toBe(BACKOFF_MAX_MS);
  });

  it('never returns a value below the initial value', () => {
    // The supervisor resets to BACKOFF_INITIAL_MS; this pins that the reset
    // target is the floor, not an arbitrary smaller number.
    expect(nextBackoff(BACKOFF_INITIAL_MS)).toBeGreaterThan(BACKOFF_INITIAL_MS);
  });

  it('returns an integer number of milliseconds', () => {
    let d = BACKOFF_INITIAL_MS;
    for (let i = 0; i < 10; i += 1) {
      d = nextBackoff(d);
      expect(Number.isInteger(d)).toBe(true);
    }
  });

  it('agrees with the Rust ladder to within one millisecond at every rung', () => {
    // The Rust computes `(current.as_secs_f64() * 1.5 * 1000).round()`; this
    // computes `Math.round(current * 1.5)`. Both reach 200/300/450/675/1013
    // exactly. They part at the rung after that: TS `1013 * 1.5` is exactly
    // 1519.5 and rounds up to 1520, while the Rust's `1.013 * 1.5 * 1000` is
    // 1519.4999999999998 and rounds down to 1519. The Rust's own test scopes
    // parity to factor/initial/cap/reset and explicitly not the fractional
    // milliseconds, so this asserts the tolerance rather than the value.
    const rust = [200, 300, 450, 675, 1013, 1519, 2000];
    let d = BACKOFF_INITIAL_MS;
    for (const expected of rust) {
      expect(Math.abs(d - expected)).toBeLessThanOrEqual(1);
      d = nextBackoff(d);
    }
  });

  it('does not add jitter', () => {
    // ReconnectBackoff in @ponter/webrtc-core jitters by ±50 ms by default.
    // The agent's ladder must be deterministic: the same input always yields
    // the same output, so a test can assert it and a log line can be trusted.
    const outputs = new Set(Array.from({ length: 50 }, () => nextBackoff(200)));
    expect(outputs.size).toBe(1);
  });
});
