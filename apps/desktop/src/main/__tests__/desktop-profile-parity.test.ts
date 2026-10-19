// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESKTOP_PROFILES } from '../../shared/ipc-types';

/**
 * The desktop app forwards `desktopProfile` as `AGENT_DESKTOP_PROFILE`, and the
 * sidecar parses it with `StreamProfile::from_str`. A name accepted by one side
 * and rejected by the other is a startup failure: the agent bails inside
 * `main()`, the supervisor reports "error", and the user loses streaming with
 * no hint that a string mismatch caused it.
 *
 * The two lists live in different languages and different packages, so nothing
 * at compile time can tie them together. This test reads the Rust source and
 * compares the accepted names, the same way
 * `apps/server/test/device-code-mirror.test.ts` pins the server's mirror of a
 * shared helper.
 */
describe('desktop profile name parity (ADR-92)', () => {
  const rustSourcePath = existsSync(
    resolve(process.cwd(), '../agent/src/lib.rs'),
  )
    ? resolve(process.cwd(), '../agent/src/lib.rs')
    : resolve(__dirname, '../../../../agent/src/lib.rs');

  const rustSource = readFileSync(rustSourcePath, 'utf8');

  /** The string literals matched by `impl FromStr for StreamProfile`. */
  function rustProfileNames(): string[] {
    const start = rustSource.indexOf(
      'impl std::str::FromStr for StreamProfile',
    );
    expect(start).toBeGreaterThan(-1);
    const end = rustSource.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const body = rustSource.slice(start, end);
    return [...body.matchAll(/"([0-9]+p[0-9]+)"\s*=>/g)].map((m) => m[1]!);
  }

  it('accepts exactly the profile names the desktop contract offers', () => {
    expect(rustProfileNames().sort()).toEqual([...DESKTOP_PROFILES].sort());
  });

  it('rejects nothing the app can persist', () => {
    const accepted = new Set(rustProfileNames());
    for (const profile of DESKTOP_PROFILES) {
      expect(accepted.has(profile)).toBe(true);
    }
  });
});
