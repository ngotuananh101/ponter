// apps/agent/test/logging/index.test.ts
import { describe, expect, it } from 'vitest';
import { isNoise, type NoiseRule } from '../../src/logging/index.js';

describe('isNoise', () => {
  // `NOISE` ships empty (the Rust rules name Rust crates), so a test that only
  // ever passes `[]` cannot distinguish a working matcher from `return false`.
  // These rules are the positive control: each cell below is a line the table
  // must *catch*, and the negative cells are lines it must *keep*.
  const sampleRules: readonly NoiseRule[] = [
    ['werift', 'known benign noise'],
    ['ponter_agent::peer', 'discarding candidate'],
  ];

  it('matches on target AND message, never the message alone', () => {
    expect(
      isNoise('ponter_agent::peer', 'discarding candidate', sampleRules),
    ).toBe(true);
    expect(isNoise('other_target', 'discarding candidate', sampleRules)).toBe(
      false,
    );
    expect(
      isNoise('ponter_agent::peer', 'different message', sampleRules),
    ).toBe(false);
  });

  it('keeps an unknown line from a known-noisy target', () => {
    expect(
      isNoise('werift', 'something the table has never seen', sampleRules),
    ).toBe(false);
    expect(isNoise('werift', 'known benign noise', sampleRules)).toBe(true);
  });

  it('keeps every line when the table is empty', () => {
    // The shipped default, and an explicit empty table, must agree.
    expect(isNoise('anything', 'anything at all')).toBe(false);
    expect(isNoise('anything', 'anything at all', [])).toBe(false);
  });
});
