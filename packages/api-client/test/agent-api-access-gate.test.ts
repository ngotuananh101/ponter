import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent-specific half of the TypeScript API-access boundary gate (spec
 * D13 / ADR-89).
 *
 * `packages/api-client/test/api-access-gate.test.ts` already enforces "no raw
 * fetch/axios" across every `src/` tree, and therefore already covers
 * `apps/agent/src/**` — this file does not duplicate it. What it carries are
 * the three rules of `.github/workflows/build-agent.yml`'s Rust boundary gate
 * that the generic gate cannot express: no hand-rolled HTTP client, no literal
 * server URL, and no hand-rolled error envelope, each outside the one module
 * allowed to know about transports, envelopes and URLs.
 *
 * It lives in `@ponter/api-client` for the same reason the generic gate does:
 * that package is inside the GATING test step of `ci-node.yml`, while
 * `@ponter/shared` and `@ponter/web` run with `continue-on-error: true`.
 */
const AGENT_SRC = join(
  fileURLToPath(import.meta.url),
  '../../../../apps/agent/src',
);

/** The one module allowed to know about transports, envelopes and URLs. */
const SANCTIONED = 'api/';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The files this gate governs: every agent source file but the sanctioned one. */
function governed(): string[] {
  return walk(AGENT_SRC).filter(
    (f) => !relative(AGENT_SRC, f).startsWith(SANCTIONED),
  );
}

describe('the agent API-access boundary gate (spec D13 / ADR-89)', () => {
  it('the agent source tree exists AND holds TypeScript — this gate must never pass vacuously', () => {
    // A gate that finds nothing to guard is not a green gate, and
    // `expect(() => statSync(AGENT_SRC)).not.toThrow()` alone is exactly that
    // mistake: `apps/agent/src/` held 20 `.rs` files and zero `.ts` files
    // before Task 3 landed, so `statSync` passed, `walk()` returned `[]`, and
    // all three scans below reported zero offenders on a tree containing no
    // TypeScript at all. Counting the walked files is what turns the
    // directory's existence into evidence that there is something to guard
    // (Plan 1 audit C8).
    const files = walk(AGENT_SRC);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
  });

  it('no hand-rolled HTTP client outside the sanctioned module', () => {
    const offenders = governed().filter((f) =>
      /from\s+['"]node:(http|https)['"]|from\s+['"]undici['"]/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('no literal server URL outside the sanctioned module', () => {
    const offenders = governed().filter((f) =>
      /['"`](https?|wss?):\/\//.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no hand-rolled error envelope outside the sanctioned module', () => {
    const offenders = governed().filter((f) =>
      /\{\s*(error|code|message)\s*:/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
