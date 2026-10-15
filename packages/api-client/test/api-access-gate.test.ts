import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * TS enforcement gate (ADR-89, spec §6.1): no raw `fetch(`/`axios` against a
 * backend endpoint in app code. A vitest source-scan guard, modelled on
 * `apps/web/src/__tests__/e2ee-claims.test.ts`.
 *
 * It lives in `@ponter/api-client` because that package is inside the GATING
 * test step of `ci-node.yml`; `@ponter/web` and `@ponter/shared` run with
 * `continue-on-error: true` and could never fail the build.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// Spec §3.1 TS-2: the backend itself, and the two sanctioned injected-fetch
// helpers. Everything else must go through @ponter/api-client.
const ALLOWED_PREFIXES = ['apps/server/'];
const ALLOWED_FILES = new Set([
  'packages/webrtc-core/src/ws-ticket.ts',
  'packages/webrtc-core/src/transport.ts',
]);

const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  'target',
]);
const SOURCE_EXT = ['.ts', '.vue'];

function isTestFile(rel: string): boolean {
  return (
    rel.includes('/__tests__/') ||
    rel.endsWith('.test.ts') ||
    rel.endsWith('.spec.ts')
  );
}

function isAllowed(rel: string): boolean {
  if (ALLOWED_FILES.has(rel)) return true;
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

/** Collect `<root>/<pkg>/src/**` source files, relative to the repo root. */
function collect(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    let pkgs: string[];
    try {
      pkgs = readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      const srcDir = join(rootDir, pkg, 'src');
      walk(srcDir, out);
    }
  }
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!SOURCE_EXT.some((ext) => entry.endsWith(ext))) continue;
    const rel = relative(REPO_ROOT, full);
    if (isTestFile(rel)) continue;
    out.push(rel);
  }
}

// `(?<![.\w])` excludes method calls: `app.fetch(`, `opts.fetch(`,
// `this.customFetch(` are NOT the global `fetch`.
const RAW_FETCH = /(?<![.\w])fetch\s*\(/;
const RAW_AXIOS = /(?<![.\w])axios/;

describe('no raw fetch/axios in app code (ADR-89 §6.1)', () => {
  it('scans a non-empty set of source files', () => {
    // Guards against the walker silently returning nothing (a broken gate).
    expect(collect().length).toBeGreaterThan(0);
  });

  it('finds no direct fetch( or axios outside the allow-list', () => {
    const offenders: string[] = [];
    for (const rel of collect()) {
      if (isAllowed(rel)) continue;
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (RAW_FETCH.test(source) || RAW_AXIOS.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
