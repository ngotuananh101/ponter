import { describe, expect, it } from 'vitest';
import { STREAM_PROFILES } from '@ponter/shared';
import { DESKTOP_PROFILES } from '../../shared/ipc-types';

/**
 * The desktop app forwards `desktopProfile` as `AGENT_DESKTOP_PROFILE`, and the
 * agent looks it up in `@ponter/shared`'s `STREAM_PROFILES`. A name accepted by
 * one side and rejected by the other is a startup failure: the agent bails
 * inside `main()`, the supervisor reports "error", and the user loses streaming
 * with no hint that a string mismatch caused it.
 *
 * This test used to read `apps/agent/src/lib.rs` as text and regex the names out
 * of `impl std::str::FromStr for StreamProfile`, because the two lists lived in
 * different languages. They now live in one table, so both sides are imported
 * as values — the same guarantee, with nothing left to parse.
 */
describe('desktop/agent stream-profile parity (spec D12)', () => {
  it('exposes exactly the presets the shared table defines — no more, no fewer', () => {
    // The Rust version compared id strings extracted from source text. This
    // compares the same sets, as values. Zero loss: a preset added to one
    // side and not the other still fails here.
    expect([...DESKTOP_PROFILES].sort()).toEqual(
      STREAM_PROFILES.map((p) => p.id).sort(),
    );
  });

  it('agrees on every preset id', () => {
    for (const profile of STREAM_PROFILES) {
      expect(DESKTOP_PROFILES).toContain(profile.id);
    }
  });
});
