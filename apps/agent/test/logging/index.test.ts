// apps/agent/test/logging/index.test.ts
import { describe, expect, it } from 'vitest';
import { isNoise } from '../../src/logging/index.js';

describe('isNoise', () => {
  it('matches on target AND message, never the message alone', () => {
    expect(isNoise('ponter_agent', 'no such remote')).toBe(false);
  });

  it('keeps an unknown line from a known-noisy target', () => {
    expect(isNoise('werift', 'something the table has never seen')).toBe(false);
  });

  it('keeps every line when the table is empty', () => {
    // The table ships empty for werift today: the Rust rules name Rust crates.
    // A port that fabricated ten rules that can never fire would be dead code.
    expect(isNoise('anything', 'anything at all')).toBe(false);
  });
});
