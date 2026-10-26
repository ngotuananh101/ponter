// apps/agent/test/base64.test.ts
import { describe, expect, it } from 'vitest';
import { decodeBase64Strict } from '../src/base64.js';

/**
 * The oracle is Rust's `base64::engine::general_purpose::STANDARD.decode`, which
 * is **strict**: a non-alphabet character, a length that is not a multiple of
 * four, or padding in the wrong place is an `Err`, never a best-effort prefix.
 *
 * Every `lenient` column below was measured on this repo's Node 24 — it is what
 * `Buffer.from(x, 'base64')` does on its own, and it is why the helper exists.
 * Two rows are the ones a naive regex gets wrong in opposite directions:
 * `"abc"` must be **refused** (on length) and `""` must be **accepted**
 * (`STANDARD.decode("")` is `Ok(vec![])`).
 *
 * `bytes` is present only for the accepted rows: for a refused one the point is
 * that there is no decoded value at all, not that it differs.
 */
const ORACLE: {
  input: string;
  accept: boolean;
  bytes?: number[];
  why: string;
}[] = [
  { input: 'YWJj', accept: true, bytes: [97, 98, 99], why: 'ordinary input' },
  { input: '', accept: true, bytes: [], why: 'empty decodes to zero bytes' },
  { input: 'AA==', accept: true, bytes: [0], why: 'two padding chars' },
  { input: 'AAA=', accept: true, bytes: [0, 0], why: 'one padding char' },
  {
    input: 'abc=',
    accept: true,
    bytes: [105, 183],
    why: 'padding over 3 data chars',
  },
  { input: 'abc', accept: false, why: 'length 3 is not a multiple of four' },
  {
    input: 'YWJjZA=',
    accept: false,
    why: 'length 7 is not a multiple of four',
  },
  { input: 'ab=c', accept: false, why: 'padding in the middle' },
  { input: 'a===', accept: false, why: 'three padding chars' },
  { input: '====', accept: false, why: 'no data at all' },
  {
    input: '!!!!',
    accept: false,
    why: 'non-alphabet silently decodes to empty',
  },
  { input: '-_', accept: false, why: 'URL-safe alphabet, not STANDARD' },
  { input: '-_==', accept: false, why: 'URL-safe alphabet with padding' },
  { input: 'YW Jj', accept: false, why: 'a space is skipped, not tolerated' },
  {
    input: 'YWJj\n',
    accept: false,
    why: 'a newline is skipped, not tolerated',
  },
  {
    input: 'AB==',
    accept: false,
    why: 'non-zero trailing bits are discarded, so Rust refuses',
  },
];

describe('decodeBase64Strict', () => {
  it.each(ORACLE)(
    'refuses/accepts $input ($why)',
    ({ input, accept, bytes }) => {
      const decoded = decodeBase64Strict(input);
      if (!accept) {
        expect(decoded).toBeNull();
        return;
      }
      // The bytes, not just the verdict: an implementation that accepted the
      // right inputs while decoding them wrongly would pass a verdict-only
      // assertion, and this is the primitive the pty and the file writer call.
      expect(decoded).not.toBeNull();
      expect([...(decoded as Uint8Array)]).toEqual(bytes);
    },
  );

  it('accepts an ordinary payload whose length is a multiple of four', () => {
    // Positive control for the whole table: every refusal above could equally
    // be produced by a helper that refuses everything.
    const decoded = decodeBase64Strict(
      Buffer.from('the quick brown fox', 'utf8').toString('base64'),
    );
    expect(Buffer.from(decoded as Uint8Array).toString('utf8')).toBe(
      'the quick brown fox',
    );
  });

  it('refuses the substituted-character payload that keeps its length', () => {
    // The corruption demonstrator, not the length case: `evil` is one character
    // longer than `good` and `Buffer.from` still yields exactly 32 bytes — the
    // right length with **different content**. A length check cannot see it;
    // this helper must.
    const good = Buffer.alloc(32, 7).toString('base64');
    const evil = `${good.slice(0, 20)}x!${good.slice(21)}`;
    expect(Buffer.from(evil, 'base64').length).toBe(
      Buffer.from(good, 'base64').length,
    );
    expect(decodeBase64Strict(evil)).toBeNull();
  });
});
