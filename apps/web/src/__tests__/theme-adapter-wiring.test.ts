import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) =>
  readFileSync(resolve(__dirname, '..', rel), 'utf8');

// Regression guard for the theme-storage wiring (whole-branch review, Focus 2).
//
// `ThemeToggle` and the shared `useTheme` composable live in
// `@ponter/ui-components` and are storage-agnostic: they default to a no-op
// adapter. The ONLY thing that connects them to the web app's localStorage is
// the side-effect import in `main.ts`, which calls `configureThemeStorage`.
//
// QA proved this wiring had no safety net: deleting the import left the whole
// web suite green, because no test mounted the app entry point. This scan fails
// the moment that import is removed, renamed, or commented out — so the
// persistence path can no longer be silently unwired.
const MAIN = 'main.ts';
const ADAPTER = 'composables/useTheme.ts';

describe('web theme-storage adapter is wired', () => {
  it('main.ts imports the theme storage adapter as a side effect', () => {
    const source = read(MAIN);
    // Anchored to line start (`m`) so a commented-out `// import …` does NOT
    // satisfy the guard, and matched as a bare side-effect import (no binding),
    // which is the form the wiring relies on.
    expect(source).toMatch(/^\s*import\s+['"]\.\/composables\/useTheme['"]/m);
  });

  it('the imported adapter module exists (import is not dangling)', () => {
    expect(existsSync(resolve(__dirname, '..', ADAPTER))).toBe(true);
  });
});
