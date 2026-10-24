import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
 * server URL, and no hand-rolled error envelope, each outside the module
 * allowed to know about transports, envelopes and URLs.
 *
 * It lives in `@ponter/api-client` for the same reason the generic gate does:
 * that package is inside the GATING test step of `ci-node.yml`, while
 * `@ponter/shared` and `@ponter/web` run with `continue-on-error: true`.
 *
 * **The sanctioned set is per rule, not one shared directory.** The Rust gate
 * sanctioned `src/main.rs` (whose clap default carries the server URL) and
 * `src/api.rs` (the shared transport/envelope module). One shared `api/` cannot
 * express that: it is too narrow for the URL rule, which would then fire on the
 * port of that clap default, and too wide for the HTTP-client rule, which would
 * sanction a module that opens no client at all.
 */
const AGENT_SRC = join(
  fileURLToPath(import.meta.url),
  '../../../../apps/agent/src',
);

/**
 * Every rule names a **class**, not one spelling of it. A pattern written
 * against a single spelling reports zero offenders on a tree that spells the
 * class another way, and that reads as a green gate.
 */
const HTTP_CLIENT =
  /(?:from|require\(|import\()\s*['"]node:(?:http|https)['"]|from\s*['"]undici['"]|require\(\s*['"]undici['"]\s*\)|import\(\s*['"]undici['"]\s*\)/;
const LITERAL_URL = /['"`](?:https?|wss?):\/\//;
const ERROR_ENVELOPE =
  /\bdetails\s*\??\s*:|\{[^{}]*\berror\s*:[^{}]*\bstatus\s*:|\{[^{}]*\bstatus\s*:[^{}]*\berror\s*:/;

/**
 * `config.ts` holds the port of `main.rs`'s clap default
 * (`DEFAULT_SERVER = 'ws://…'`); measured, it is the only file in the tree a
 * `wss?://` literal appears in.
 */
const SANCTIONED_URL = ['api/', 'config.ts'];
/**
 * The module that will own the error contract, mirroring `api.rs`. It does not
 * exist yet, so this set excludes **0** files today — which is why the
 * "the envelope filter removes at least one file" assertion is deliberately
 * absent: it is false until that module lands, and writing it now would need a
 * skipped cell. It belongs to the commit that adds `apps/agent/src/api/`.
 */
const SANCTIONED_ENVELOPE = ['api/'];
/** Empty: the Rust's `api.rs` was the only module allowed a client, and it has
 * no TypeScript counterpart — sanctioning `api/` here would sanction an absence. */
const SANCTIONED_HTTP: readonly string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Always `/`-joined. `relative()` returns backslash-joined paths on Windows, so
 * comparing raw `relative()` output against `'api/'` would make this gate pass
 * on one runner and fail on another.
 */
function relPath(file: string): string {
  return relative(AGENT_SRC, file).split(sep).join('/');
}

/** A key names either a directory prefix (`api/`) or one exact file (`config.ts`). */
function isSanctioned(file: string, keys: readonly string[]): boolean {
  const path = relPath(file);
  return keys.some((key) =>
    key.endsWith('/') ? path.startsWith(key) : path === key,
  );
}

/** The files a rule governs: every agent source file but that rule's sanctioned set. */
function governed(keys: readonly string[]): string[] {
  return walk(AGENT_SRC).filter((f) => !isSanctioned(f, keys));
}

describe('the agent API-access boundary gate (spec D13 / ADR-89)', () => {
  it('the agent source tree exists AND holds TypeScript — this gate must never pass vacuously', () => {
    // A gate that finds nothing to guard is not a green gate, and asserting
    // only that `statSync(AGENT_SRC)` does not throw is exactly that mistake:
    // `apps/agent/src/` held 20 `.rs` files and zero `.ts` files before Task 3
    // landed, so `statSync` passed, `walk()` returned `[]`, and all three scans
    // below reported zero offenders on a tree containing no TypeScript at all.
    // Counting the walked files is what turns the directory's existence into
    // evidence that there is something to guard (Plan 1 audit C8).
    const files = walk(AGENT_SRC);
    expect(files.length).toBeGreaterThan(0);
    // This replaces an earlier `files.every((f) => f.endsWith('.ts'))`, which
    // could not fail: `walk()` pushes only paths that already end in `.ts`, so
    // it restated the filter that produced the list. The property that actually
    // distinguishes the right root from the wrong one is `node_modules`: one
    // level up, `walk('apps/agent')` descends into it and returns thousands of
    // foreign files, whose imports and URLs would then be reported as this
    // repo's offenders.
    expect(files.some((f) => relPath(f).includes('node_modules/'))).toBe(false);
  });

  it('no hand-rolled HTTP client outside the sanctioned module', () => {
    const offenders = governed(SANCTIONED_HTTP).filter((f) =>
      HTTP_CLIENT.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no literal server URL outside the sanctioned module', () => {
    const offenders = governed(SANCTIONED_URL).filter((f) =>
      LITERAL_URL.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no hand-rolled error envelope outside the sanctioned module', () => {
    const offenders = governed(SANCTIONED_ENVELOPE).filter((f) =>
      ERROR_ENVELOPE.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the URL rule sanctions something real, so it is not unconditionally strict', () => {
    // A sanctioned set that names nothing real makes its rule bite everywhere,
    // and no fixture can show that: the control describe below drives the
    // patterns, not the sets. Asserting the set is load-bearing without pinning
    // a file count keeps this cell green on every legitimate source addition —
    // a pinned count would red on each one, which is the failure mode this
    // whole plan keeps paying for.
    expect(governed(SANCTIONED_URL).length).toBeLessThan(
      walk(AGENT_SRC).length,
    );
  });
});

/**
 * Positive controls. The scans above assert "no offenders", and a negative check
 * with no positive control cannot be falsified: a pattern that matches nothing
 * at all would pass every scan in this file. These cells drive the **same
 * `RegExp` objects** the scans use, against fixture strings.
 */
describe('the gate rules fire on what they name', () => {
  it('the HTTP-client rule sees every spelling of an import', () => {
    expect(HTTP_CLIENT.test(`import { request } from 'node:https';`)).toBe(
      true,
    );
    expect(HTTP_CLIENT.test(`const http = require('node:http');`)).toBe(true);
    expect(HTTP_CLIENT.test(`const u = await import('node:http');`)).toBe(true);
    expect(HTTP_CLIENT.test(`import { Agent } from 'undici';`)).toBe(true);
    // The rule must not fire on the filesystem, which is the only `node:`
    // import the agent actually takes.
    expect(HTTP_CLIENT.test(`import { readFileSync } from 'node:fs';`)).toBe(
      false,
    );
  });

  it('the URL rule sees a literal in any quote style', () => {
    expect(
      LITERAL_URL.test(`const s = 'ws://localhost:8787/api/ws/agent';`),
    ).toBe(true);
    expect(LITERAL_URL.test('const s = `https://api.example.com/v1`;')).toBe(
      true,
    );
    // A composed URL is the sanctioned way to build one.
    expect(LITERAL_URL.test('const s = toWsUrl(base, path);')).toBe(false);
  });

  it('the envelope rule sees envelopes and stays silent on logging and wire frames', () => {
    // Fires: `details` as a property key, which is the Rust gate's own
    // discriminator (`build-agent.yml:95-98`).
    expect(
      ERROR_ENVELOPE.test(
        `const b = { status: 500, code: 'X', error: 'y', details: null };`,
      ),
    ).toBe(true);
    expect(
      ERROR_ENVELOPE.test(
        [
          'const b = {',
          '  status: 500,',
          "  error: 'boom',",
          '  details: null,',
          '};',
        ].join('\n'),
      ),
    ).toBe(true);
    // The type-annotation form, which has no object literal at all.
    expect(
      ERROR_ENVELOPE.test(
        'function f(x: unknown) { return x as { error?: string; details?: unknown }; }',
      ),
    ).toBe(true);
    // Fires: a payload that omits `details` but carries both `error` and
    // `status` inside one brace level, in either order.
    expect(ERROR_ENVELOPE.test(`return { error: 'boom', status: 500 };`)).toBe(
      true,
    );
    expect(ERROR_ENVELOPE.test(`return { status: 500, error: 'boom' };`)).toBe(
      true,
    );

    // Silent: structured logging. `logger.warn({ error }, …)` is what the
    // Rust's `tracing::warn!(error = %e, …)` compiles to — the same shape, and
    // the reason the old `{ error|code|message :` rule was a false positive.
    expect(
      ERROR_ENVELOPE.test(`logger.warn({ error: String(err) }, 'boom');`),
    ).toBe(false);
    expect(
      ERROR_ENVELOPE.test(`logger.debug({ code: c, error: String(e) }, 'x');`),
    ).toBe(false);
    // Silent: the logger's own level table and method map.
    expect(
      ERROR_ENVELOPE.test(`const ORDER = { error: 0, warn: 1, info: 2 };`),
    ).toBe(false);
    expect(
      ERROR_ENVELOPE.test(
        `return { error: (f, m) => e('error'), warn: (f, m) => e('warn') };`,
      ),
    ).toBe(false);
    // Silent: the agent's own outbound wire frames, which pair `error`-ish
    // codes with `type` — including this is what would fire on the agent
    // rather than on a hand-rolled envelope.
    expect(
      ERROR_ENVELOPE.test(
        `out.push({ type: 'files-error', code: 'TRANSFER_TIMEOUT', message: 'timed out' });`,
      ),
    ).toBe(false);
    // Silent: the word in prose. The bare word has exactly two hits in the
    // tree and both are docblock English, which is why the rule is narrowed to
    // property-key position.
    expect(ERROR_ENVELOPE.test(' * Four details that are not obvious:')).toBe(
      false,
    );
    // Silent — an **accepted gap**, pinned so it stays a decision: an envelope
    // carrying `error` + `code` and neither `details` nor `status` is not seen.
    // Including that pair would fire on the agent's own frames and logs above.
    expect(
      ERROR_ENVELOPE.test(`const b = { error: 'boom', code: 'SERVER_ERROR' };`),
    ).toBe(false);
  });
});
