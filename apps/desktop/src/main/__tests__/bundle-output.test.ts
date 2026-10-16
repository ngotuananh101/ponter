/**
 * Regression guard for the packaged Electron entry points.
 *
 * Three distinct defects have shipped from this build config, each masked by
 * the one before it, and each of which only surfaces at runtime (a built app
 * that launches and immediately dies):
 *
 * 1. `electron` was inlined into the main/preload bundles instead of being
 *    externalized, so the packaged app threw
 *    `Error: Electron failed to install correctly` on launch. The inlined
 *    `electron` shim pulls in `getElectronPath()` / `path.txt` handling that
 *    only exists for the development loader.
 * 2. The `@ponter/*` workspace packages are consumed as raw TypeScript (their
 *    `main`/`exports` point at `./src/index.ts`). Externalizing them emitted
 *    `import { ... } from "@ponter/api-client"` into the main bundle, which
 *    Electron's Node loader cannot resolve — it throws
 *    `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` and the main
 *    process crashes before the first window.
 * 3. `electron-updater` is CommonJS-only and exposes `autoUpdater` through a
 *    getter, which Node's ESM named-export detection cannot see. Left
 *    external, the ESM main bundle emitted
 *    `import { autoUpdater } from "electron-updater"` and died with
 *    `SyntaxError: Named export 'autoUpdater' not found`.
 *
 * All three are invisible to the unit suite (every main-process module is
 * imported through Vite, which transpiles the workspace TypeScript and does
 * not exercise the packaging boundary) and to a naive "did the process stay
 * alive" smoke test (each crash leaves the process alive long enough to hit
 * the timeout). This test asserts on the real build output: the main/preload
 * bundles may only import `electron` and Node built-ins as externals — every
 * other bare specifier must be bundled, because at runtime Electron's Node
 * loader cannot resolve a raw `.ts` entry or a CJS-only named export.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { builtinModules, createRequire } from 'node:module';

// Vitest runs with `apps/desktop` as the working directory.
const APP_ROOT = process.cwd();
const MAIN_BUNDLE = resolve(APP_ROOT, 'out/main/index.js');
const PRELOAD_BUNDLE = resolve(APP_ROOT, 'out/preload/index.js');

// Resolve the electron-vite CLI script via package.json so the child process
// can be invoked portably via `process.execPath` on Windows, Linux, and macOS
// without hitting `spawnSync ENOENT` on `./node_modules/.bin/electron-vite`.
const require = createRequire(import.meta.url);
const electronVitePkgPath = require.resolve('electron-vite/package.json');
const electronVitePkg = JSON.parse(readFileSync(electronVitePkgPath, 'utf8'));
const electronViteBinRel =
  typeof electronVitePkg.bin === 'string'
    ? electronVitePkg.bin
    : (electronVitePkg.bin?.['electron-vite'] ?? 'bin/electron-vite.js');
const ELECTRON_VITE_CLI = resolve(
  dirname(electronVitePkgPath),
  electronViteBinRel,
);

/** Matches the development-only `electron` loader that must never be inlined. */
const ELECTRON_DEV_LOADER_MARKERS =
  /getElectronPath|path\.txt|failed to install correctly/g;

/** Node built-ins, with and without the `node:` prefix, plus `electron`. */
const ALLOWED_EXTERNALS = new Set([
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/**
 * Extract every bare (non-relative, non-absolute) module specifier a bundle
 * imports via static `import ... from "x"` or `require("x")`.
 */
function externalSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const staticImport = /\bfrom\s*["']([^"']+)["']/g;
  const requireCall = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticImport, requireCall]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

let mainBundle: string;
let preloadBundle: string;

describe('electron-vite bundle output', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [ELECTRON_VITE_CLI, 'build'], {
      cwd: APP_ROOT,
      stdio: 'pipe',
    });
    mainBundle = readFileSync(MAIN_BUNDLE, 'utf8');
    preloadBundle = readFileSync(PRELOAD_BUNDLE, 'utf8');
  }, 180_000);

  it('externalizes electron instead of inlining the dev loader (main)', () => {
    // The entry must import electron as an external module...
    expect(mainBundle).toMatch(/from ["']electron["']/);
    // ...and must not contain the bundled development loader.
    expect(mainBundle.match(ELECTRON_DEV_LOADER_MARKERS) ?? []).toHaveLength(0);
  });

  it('externalizes electron instead of inlining the dev loader (preload)', () => {
    expect(preloadBundle.match(ELECTRON_DEV_LOADER_MARKERS) ?? []).toHaveLength(
      0,
    );
  });

  it('bundles every non-builtin dependency into the main bundle', () => {
    const external = externalSpecifiers(mainBundle).filter(
      (s) => !ALLOWED_EXTERNALS.has(s),
    );
    expect(external).toEqual([]);
  });

  it('bundles every non-builtin dependency into the preload bundle', () => {
    const external = externalSpecifiers(preloadBundle).filter(
      (s) => !ALLOWED_EXTERNALS.has(s),
    );
    expect(external).toEqual([]);
  });
});
