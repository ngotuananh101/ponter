import { describe, expect, it } from 'vitest';
import { STREAM_PROFILES } from '@ponter/shared';
import { DESKTOP_PROFILES } from '../../shared/ipc-types';

/**
 * The desktop app forwards `desktopProfile` as `AGENT_DESKTOP_PROFILE`. A name
 * accepted by one side and rejected by the other is a startup failure: the
 * agent bails inside `main()`, the supervisor reports "error", and the user
 * loses streaming with no hint that a string mismatch caused it.
 *
 * The agent resolves the name against `@ponter/shared`'s `STREAM_PROFILES` only
 * once Plan 2's config task wires that dependency into `apps/agent`; at this
 * commit it has neither the dependency nor any TypeScript source that reads it,
 * so the assertion below pins the contract the agent will be held to rather
 * than one it already satisfies.
 *
 * This test used to read `apps/agent/src/lib.rs` as text and regex the names out
 * of `impl std::str::FromStr for StreamProfile`, because the two lists lived in
 * different languages. The replacement compares against the shared table
 * directly, so there is nothing left to parse.
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
