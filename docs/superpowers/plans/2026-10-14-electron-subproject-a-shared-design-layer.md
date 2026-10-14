# Shared Design Layer (Electron Migration, Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the web design tokens, the theme composable, and the environment-independent presentational components into `@ponter/ui-components` so `apps/web` and the future Electron renderer share one design layer, with **zero visual change** to the web app.

**Architecture:** `packages/ui-components` becomes the single source of truth for design: a shared `styles/tokens.css` (every CSS custom property, `@theme` mapping, base layer, brand palette), a storage-agnostic `useTheme` composable configured by an app-supplied adapter, and an `app/` directory of presentational components (props/emits only). `apps/web` imports this shared layer; its runtime code (stores, router, `/config.js`) is untouched.

**Tech Stack:** Vue 3.5.43, Tailwind CSS 4.3.3, `@tailwindcss/vite` 4.3.3, shadcn-vue 2.8.2, Vitest 5.0.3, `@vue/test-utils` 2.5.1, happy-dom 20.14.5, Vite 8.3.1, vue-tsc 3.3.11, pnpm 12.6.0, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md` (§6 "Shared Design Layer", ADR-88)

## Global Constraints

- **Node >= 24, pnpm >= 12** (root `package.json` `engines`).
- **Do NOT edit generated shadcn-vue primitives** under `packages/ui-components/src/components/ui/**` (project rule: custom wrappers go outside `ui/`). That directory is also `.prettierignore`d.
- **Web visual parity is mandatory:** the token extraction must be faithful (every custom property, in the same order and value); `apps/web` must render identically after the change.
- **TEST-INTEGRITY:** no test may be deleted, skipped, or weakened. Moving a test to the package is a relocation, not a removal — declare before/after counts for every task that touches tests.
- **All technical writing in English** (code, comments, commits, docs). Conversation replies stay Vietnamese.
- **Commit messages:** no `Co-authored-by` trailer, author only, identity `Ngo Tuan Anh <ngotuananh2101@gmail.com>`.
- **Stage specific files** with `git add <paths>`; never `git add -A`.
- **Formatting is gating in CI** (`ci-node.yml` runs `pnpm format:check`). Every new/edited file outside `.prettierignore` must pass prettier; run `pnpm exec prettier --write <paths>` before each commit.
- **Consumers of `@ponter/ui-components` must alias `@/lib/utils` → `packages/ui-components/src/lib/utils`** (the primitives import `cn` through it) **and `@/components/ui/*` → `packages/ui-components/src/components/ui/*`** (the primitives import each other through it). `apps/web` already does both, in `vite.config.ts`, `vitest.config.ts`, and `tsconfig.json` `paths`.
- **Tailwind v4 resolves the bare-specifier `@import`** of the shared CSS through the package `exports` map (the entry already resolves `@import 'shadcn-vue/tailwind.css'`). Task 1 Step 6's build assertion is the gate that proves resolution.

## Review Focus

- **A token dropped or renamed during extraction** → the web app loses a color/radius silently. Pinned by Task 1 Step 6's built-CSS assertion for every custom property.
- **Web theme persistence silently broken by the move** → `ThemeToggle` no longer imports the web adapter, so `configureThemeStorage(localStorage)` never runs and the theme stops persisting. Pinned by Task 2 Step 9 (entry import) + Task 2 Step 10 and Task 4 Step 6 (retained web tests 12–15) + Task 4 Step 7 (grep guard).
- **`useTheme` storage throws** (private mode / quota) → the app must not crash and must still apply the theme class. Pinned by the retained web test 15 and the package test in Task 2 Step 3.
- **`useTheme` called before an adapter is configured** → must fall back to `prefers-color-scheme` without throwing. Pinned by the package test in Task 2 Step 3.
- **A lifted component resolves primitives through a consumer-only alias** → the package no longer builds standalone. Pinned by Task 3 Step 6 / Task 4 Step 6 (package `vitest run` compiles the `.vue`) and Task 2 Step 12 (package `vue-tsc`).

---

### Task 1: Extract shared design tokens

**Files:**
- Create: `packages/ui-components/src/styles/tokens.css`
- Modify: `packages/ui-components/package.json` (add `exports`)
- Modify: `apps/web/src/style.css`
- Modify: `apps/web/package.json` (add `@ponter/ui-components` dependency)

**Interfaces:**
- Consumes: nothing.
- Produces: `@ponter/ui-components/styles/tokens.css` — the shared design tokens, imported by every app's Tailwind entry after the framework imports.

- [ ] **Step 1: Create the shared tokens file**

Create `packages/ui-components/src/styles/tokens.css` with exactly this content (the project tokens lifted from `apps/web/src/style.css`, minus the font `@import` and the framework `@import`s and the `@source` line — those stay in each app's entry because `@source` is app-relative and Tailwind's framework entry belongs at the top of the consuming entry):

```css
/*
 * Shared Ponter design tokens.
 *
 * Holds every project-specific design token: the semantic @theme mapping, the
 * light/dark custom-property palettes, the base layer, and the additive brand
 * palette. Imported by each app's Tailwind entry AFTER the framework imports
 * (@import 'tailwindcss' / 'tw-animate-css' / 'shadcn-vue/tailwind.css'), which
 * stay per-app because content detection (@source) is app-relative.
 *
 * Extracted from apps/web/src/style.css so the web app renders identically.
 * Do not rename or reorder custom properties.
 */

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', Menlo, Monaco, Consolas, monospace;
  --font-heading: var(--font-sans);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-foreground: var(--foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-danger: var(--danger);
  --color-danger-foreground: var(--danger-foreground);
  --color-terminal-bg: var(--terminal-bg);
  --color-background: var(--background);
  --radius-sm: calc(var(--radius) - 3px);
  --radius-md: calc(var(--radius) - 1px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 3px);
}

:root {
  --background: oklch(0.985 0.005 250);
  --foreground: oklch(0.16 0.02 260);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.16 0.02 260);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.16 0.02 260);
  --primary: oklch(0.52 0.19 235);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.94 0.01 250);
  --secondary-foreground: oklch(0.2 0.02 260);
  --muted: oklch(0.95 0.01 250);
  --muted-foreground: oklch(0.52 0.02 260);
  --accent: oklch(0.94 0.015 240);
  --accent-foreground: oklch(0.2 0.02 260);
  --destructive: oklch(0.56 0.22 25);
  --border: oklch(0.89 0.01 250);
  --input: oklch(0.89 0.01 250);
  --ring: oklch(0.52 0.19 235);
  --chart-1: oklch(0.52 0.19 235);
  --chart-2: oklch(0.65 0.18 160);
  --chart-3: oklch(0.7 0.18 80);
  --chart-4: oklch(0.6 0.22 300);
  --chart-5: oklch(0.56 0.22 25);
  --radius: 0.5rem;
  --sidebar: oklch(0.97 0.008 250);
  --sidebar-foreground: oklch(0.16 0.02 260);
  --sidebar-primary: oklch(0.52 0.19 235);
  --sidebar-primary-foreground: oklch(0.99 0 0);
  --sidebar-accent: oklch(0.93 0.015 250);
  --sidebar-accent-foreground: oklch(0.2 0.02 260);
  --sidebar-border: oklch(0.89 0.01 250);
  --sidebar-ring: oklch(0.52 0.19 235);
  --header-height: 3.5rem;
  --success: oklch(0.55 0.15 155);
  --success-foreground: oklch(0.99 0 0);
  --warning: oklch(0.7 0.16 75);
  --warning-foreground: oklch(0.2 0.02 260);
  --danger: oklch(0.56 0.22 25);
  --danger-foreground: oklch(0.99 0 0);
  --terminal-bg: oklch(0.14 0.02 260);
}

.dark {
  --background: oklch(0.11 0.015 260);
  --foreground: oklch(0.98 0.005 260);
  --card: oklch(0.15 0.018 260);
  --card-foreground: oklch(0.98 0.005 260);
  --popover: oklch(0.15 0.018 260);
  --popover-foreground: oklch(0.98 0.005 260);
  --primary: oklch(0.7 0.17 215);
  --primary-foreground: oklch(0.11 0.015 260);
  --secondary: oklch(0.2 0.02 260);
  --secondary-foreground: oklch(0.96 0.008 260);
  --muted: oklch(0.19 0.018 260);
  --muted-foreground: oklch(0.68 0.02 260);
  --accent: oklch(0.22 0.025 250);
  --accent-foreground: oklch(0.98 0.005 260);
  --destructive: oklch(0.64 0.22 25);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 14%);
  --ring: oklch(0.7 0.17 215);
  --chart-1: oklch(0.7 0.17 215);
  --chart-2: oklch(0.72 0.17 155);
  --chart-3: oklch(0.78 0.16 80);
  --chart-4: oklch(0.68 0.2 300);
  --chart-5: oklch(0.64 0.22 25);
  --sidebar: oklch(0.13 0.016 260);
  --sidebar-foreground: oklch(0.98 0.005 260);
  --sidebar-primary: oklch(0.7 0.17 215);
  --sidebar-primary-foreground: oklch(0.11 0.015 260);
  --sidebar-accent: oklch(0.19 0.02 260);
  --sidebar-accent-foreground: oklch(0.98 0.005 260);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.7 0.17 215);
  --success: oklch(0.72 0.17 155);
  --success-foreground: oklch(0.14 0.02 260);
  --warning: oklch(0.78 0.16 80);
  --warning-foreground: oklch(0.14 0.02 260);
  --danger: oklch(0.64 0.22 25);
  --danger-foreground: oklch(0.14 0.02 260);
  --terminal-bg: oklch(0.14 0.02 260);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
    @apply font-sans;
  }
}

/* Project palette — additive, does not replace shadcn tokens */
@theme {
  --color-brand-50: oklch(0.97 0.02 259);
  --color-brand-500: oklch(0.62 0.19 259);
  --color-brand-600: oklch(0.55 0.19 259);
  --color-brand-700: oklch(0.48 0.18 259);
}
```

- [ ] **Step 2: Add the package `exports` map**

Replace the `exports` block in `packages/ui-components/package.json` (currently `"exports": { ".": "./src/index.ts" }`) with:

```json
  "exports": {
    ".": "./src/index.ts",
    "./styles/tokens.css": "./src/styles/tokens.css"
  },
```

- [ ] **Step 3: Add the package as a web dependency**

In `apps/web/package.json`, add `"@ponter/ui-components": "workspace:*",` to `dependencies` in **alphabetical** order — immediately after `"@ponter/terminal-core": "workspace:*",` and before `"@ponter/webrtc-core": "workspace:*",`.

- [ ] **Step 4: Point the web Tailwind entry at the shared tokens**

Replace the entire contents of `apps/web/src/style.css` with:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

@import 'tailwindcss';
@import 'tw-animate-css';
@import 'shadcn-vue/tailwind.css';
@import '@ponter/ui-components/styles/tokens.css';

@source "../../../packages/ui-components/src";
```

- [ ] **Step 5: Install the new workspace dependency**

Run: `pnpm install`
Expected: completes; `@ponter/ui-components` is linked into `apps/web/node_modules`.

- [ ] **Step 6: Build the web app and assert the tokens survive**

Run:
```bash
pnpm --filter @ponter/web build
echo "--- built css ---"; ls apps/web/dist/assets/*.css
for tok in --background --foreground --primary --primary-foreground --destructive --ring --radius --terminal-bg --success --warning --danger --sidebar --chart-1 --header-height; do
  grep -q -- "$tok" apps/web/dist/assets/*.css || { echo "MISSING $tok"; exit 1; }
done
grep -q '\.dark' apps/web/dist/assets/*.css || { echo "MISSING .dark"; exit 1; }
echo "ALL TOKENS PRESENT"
```
Expected: `ALL TOKENS PRESENT`.

If the build fails resolving `@import '@ponter/ui-components/styles/tokens.css'` (Tailwind did not honor the package `exports` map), replace that line in `apps/web/src/style.css` with the equivalent relative path and re-run this step:
```css
@import '../../../packages/ui-components/src/styles/tokens.css';
```
(This mirrors the relative style already used by the `@source` line and resolves to the same file; record the substitution in the commit message.)

- [ ] **Step 7: Typecheck the web app**

Run: `pnpm --filter @ponter/web typecheck`
Expected: PASS (no errors).

- [ ] **Step 8: Format the changed files**

Run: `pnpm exec prettier --write apps/web/src/style.css packages/ui-components/src/styles/tokens.css packages/ui-components/package.json apps/web/package.json`
Expected: files rewritten in place (or unchanged if already formatted).

- [ ] **Step 9: Commit**

```bash
git add packages/ui-components/src/styles/tokens.css packages/ui-components/package.json apps/web/src/style.css apps/web/package.json pnpm-lock.yaml
git commit -m "refactor(ui-components): extract shared design tokens (ADR-88)"
```

---

### Task 2: Shared theme composable with a storage adapter

**Files:**
- Create: `packages/ui-components/src/composables/useTheme.ts`
- Create: `packages/ui-components/src/composables/useTheme.test.ts`
- Create: `packages/ui-components/vitest.config.ts`
- Modify: `packages/ui-components/package.json` (test script + devDependencies)
- Modify: `packages/ui-components/src/index.ts` (export the composable)
- Modify: `apps/web/src/composables/useTheme.ts` (configure the localStorage adapter + re-export)
- Modify: `apps/web/src/main.ts` (import the adapter so it configures at startup)
- Test (unchanged, must stay green): `apps/web/src/__tests__/use-theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Theme = 'light' | 'dark'`
  - `interface ThemeStorage { get(): Theme | null; set(theme: Theme): void }`
  - `interface UseTheme { theme: Ref<Theme>; isDark: ComputedRef<boolean>; toggle(): void; set(theme: Theme): void }`
  - `configureThemeStorage(storage: ThemeStorage): void`
  - `useTheme(): UseTheme`
  - `resetTheme(): void`

- [ ] **Step 1: Add the package test tooling**

In `packages/ui-components/package.json`, add to `scripts`: `"test": "vitest run"`. Add to `devDependencies` (keep alphabetical):

```json
    "@vitejs/plugin-vue": "6.0.9",
    "@vue/test-utils": "2.5.1",
    "happy-dom": "20.14.5",
    "vite": "8.3.1",
    "vitest": "5.0.3",
```

- [ ] **Step 2: Create the package vitest config**

Create `packages/ui-components/vitest.config.ts`:

```ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing composable tests**

Create `packages/ui-components/src/composables/useTheme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  configureThemeStorage,
  resetTheme,
  useTheme,
  type Theme,
  type ThemeStorage,
} from './useTheme';

/** In-memory adapter — mirrors what an app supplies. */
function memoryStorage(initial: Theme | null = null): ThemeStorage {
  let value = initial;
  return {
    get: () => value,
    set: (t: Theme) => {
      value = t;
    },
  };
}

describe('useTheme (shared core)', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    configureThemeStorage(memoryStorage(null));
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it('falls back to prefers-color-scheme when storage is empty', () => {
    resetTheme();
    expect(useTheme().theme.value).toBe('dark');
  });

  it('a stored value wins over prefers-color-scheme', () => {
    configureThemeStorage(memoryStorage('light'));
    resetTheme();
    expect(useTheme().theme.value).toBe('light');
  });

  it('set() persists through the configured adapter and updates the ref', () => {
    const storage = memoryStorage(null);
    configureThemeStorage(storage);
    useTheme().set('dark');
    expect(useTheme().theme.value).toBe('dark');
    expect(storage.get()).toBe('dark');
  });

  it('toggle() flips the theme and applies the class on <html>', () => {
    configureThemeStorage(memoryStorage('light'));
    resetTheme();
    useTheme().toggle();
    expect(useTheme().theme.value).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    useTheme().toggle();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('does not throw when the adapter set() throws', () => {
    configureThemeStorage({
      get: () => null,
      set: () => {
        throw new Error('storage unavailable');
      },
    });
    // The core must guard storage writes; a throwing adapter is a realistic
    // failure (private mode, quota). If the core does not guard, this throws.
    expect(() => useTheme().toggle()).not.toThrow();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/ui-components test`
Expected: FAIL — `./useTheme` module not found.

- [ ] **Step 5: Write the composable**

Create `packages/ui-components/src/composables/useTheme.ts`:

```ts
/**
 * Shared theme state for Ponter apps.
 *
 * The composable owns the light/dark state, computes `isDark`, and applies the
 * `.dark` class on <html>. Persistence is injected: an app calls
 * `configureThemeStorage` once at startup with an adapter (web: localStorage;
 * Electron renderer: IPC to the main process). Until then a no-op adapter is
 * used, so `useTheme` is always safe to call.
 */
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';

export type Theme = 'light' | 'dark';

export interface ThemeStorage {
  /** The persisted theme, or null when none is stored. */
  get(): Theme | null;
  /** Persist the theme. May throw (private mode, quota); the core guards it. */
  set(theme: Theme): void;
}

export interface UseTheme {
  theme: Ref<Theme>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: Theme): void;
}

const noopStorage: ThemeStorage = {
  get: () => null,
  set: () => {},
};

let storage: ThemeStorage = noopStorage;

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

function safeGet(): Theme | null {
  try {
    return storage.get();
  } catch {
    return null;
  }
}

function safeSet(theme: Theme): void {
  try {
    storage.set(theme);
  } catch {
    // A failing store must never break theming (private mode, quota).
  }
}

function getInitialTheme(): Theme {
  const stored = safeGet();
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark() ? 'dark' : 'light';
}

const theme = ref<Theme>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

if (typeof document !== 'undefined') {
  watchEffect(
    () => {
      const el = document.documentElement;
      if (theme.value === 'dark') {
        el.classList.add('dark');
      } else {
        el.classList.remove('dark');
      }
    },
    { flush: 'sync' },
  );
}

/**
 * Wire the app's persistence backend. Call once at app start. Re-reads the
 * initial theme so a stored value takes effect immediately.
 */
export function configureThemeStorage(next: ThemeStorage): void {
  storage = next;
  theme.value = getInitialTheme();
}

function setTheme(next: Theme): void {
  theme.value = next;
  safeSet(next);
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return { theme, isDark, toggle: toggleTheme, set: setTheme };
}

/**
 * Reset the in-memory theme to what storage/prefers-color-scheme currently
 * imply. Tests use this to re-read a changed storage/preference.
 */
export function resetTheme(): void {
  theme.value = getInitialTheme();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/ui-components test`
Expected: PASS — 5 tests.

- [ ] **Step 7: Export the composable from the package**

In `packages/ui-components/src/index.ts`, after the `export { cn } from './lib/utils';` line, add:

```ts
export {
  configureThemeStorage,
  useTheme,
  resetTheme,
  type Theme,
  type ThemeStorage,
  type UseTheme,
} from './composables/useTheme';
```

- [ ] **Step 8: Rewrite the web composable as a thin adapter**

Replace the entire contents of `apps/web/src/composables/useTheme.ts` with:

```ts
/**
 * Web binding for the shared theme composable.
 *
 * Supplies the localStorage adapter and re-exports the shared API so existing
 * imports (`@/composables/useTheme`) keep working unchanged. Importing this
 * module configures the shared core's storage as a side effect, so a runtime
 * import is REQUIRED for web theme persistence (see main.ts).
 */
import {
  configureThemeStorage,
  resetTheme,
  useTheme,
  type Theme,
  type ThemeStorage,
  type UseTheme,
} from '@ponter/ui-components';

const STORAGE_KEY = 'remote.theme';

const localStorageThemeStorage: ThemeStorage = {
  get() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === 'light' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  },
  set(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage failure (e.g. private mode / quota).
    }
  },
};

configureThemeStorage(localStorageThemeStorage);

export { useTheme, resetTheme };
export type { Theme, UseTheme };
```

- [ ] **Step 9: Import the adapter at the web entry point**

In `apps/web/src/main.ts`, add a side-effect import of the adapter module so `configureThemeStorage(localStorage)` runs before mount. Place it with the other side-effect imports, after `import './style.css';`:

```ts
// Configures the shared theme composable with the localStorage adapter.
// Required: the only other importer is ThemeToggle, which moves to the shared
// package in the next task and will no longer pull in this web adapter.
import './composables/useTheme';
```

- [ ] **Step 10: Run the retained web theme tests**

Run: `pnpm --filter @ponter/web exec vitest run use-theme`
Expected: PASS — tests 12–15 unchanged (the web adapter preserves the localStorage key `remote.theme` and the throw-safety).

- [ ] **Step 11: Format the new/changed files**

Run: `pnpm exec prettier --write packages/ui-components/src/composables/useTheme.ts packages/ui-components/src/composables/useTheme.test.ts packages/ui-components/vitest.config.ts packages/ui-components/package.json packages/ui-components/src/index.ts apps/web/src/composables/useTheme.ts apps/web/src/main.ts`
Expected: files rewritten in place (or unchanged if already formatted).

- [ ] **Step 12: Typecheck both packages**

Run: `pnpm --filter @ponter/ui-components typecheck && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/ui-components/src/composables/useTheme.ts packages/ui-components/src/composables/useTheme.test.ts packages/ui-components/vitest.config.ts packages/ui-components/package.json packages/ui-components/src/index.ts apps/web/src/composables/useTheme.ts apps/web/src/main.ts pnpm-lock.yaml
git commit -m "refactor(ui-components): shared theme composable with storage adapter (ADR-88)"
```

---

### Task 3: Lift the auth presentational components

**Files:**
- Create: `packages/ui-components/src/components/app/LoginForm.vue`
- Create: `packages/ui-components/src/components/app/RegisterForm.vue`
- Move: `apps/web/src/__tests__/LoginForm.test.ts` → `packages/ui-components/src/components/app/LoginForm.test.ts`
- Move: `apps/web/src/__tests__/RegisterForm.test.ts` → `packages/ui-components/src/components/app/RegisterForm.test.ts`
- Modify: `packages/ui-components/src/index.ts` (export the components)
- Modify: `apps/web/src/views/LoginView.vue` (import path)
- Modify: `apps/web/src/views/RegisterView.vue` (import path)
- Delete: `apps/web/src/components/auth/LoginForm.vue`
- Delete: `apps/web/src/components/auth/RegisterForm.vue`

**Interfaces:**
- Consumes: `../ui/card`, `../ui/input`, `../ui/label`, `../ui/button` (package-relative; these primitives import `@/lib/utils`, satisfied by the package's `@ → ./src` alias in `vitest.config.ts` and `paths` in `tsconfig.json`).
- Produces:
  - `LoginForm` — props `{ loading?: boolean; errorMessage?: string | null }`; emits `submit` with `{ username: string; password: string }`.
  - `RegisterForm` — props `{ loading?: boolean; errorMessage?: string | null }`; emits `submit` with `{ username: string; email?: string; password: string }`.

- [ ] **Step 1: Move the component tests (relocation, not removal)**

Move the two test files, changing only the import path:

```bash
git mv apps/web/src/__tests__/LoginForm.test.ts packages/ui-components/src/components/app/LoginForm.test.ts
git mv apps/web/src/__tests__/RegisterForm.test.ts packages/ui-components/src/components/app/RegisterForm.test.ts
```

Then in `packages/ui-components/src/components/app/LoginForm.test.ts`, change:
```ts
import LoginForm from '@/components/auth/LoginForm.vue';
```
to:
```ts
import LoginForm from './LoginForm.vue';
```
And in `packages/ui-components/src/components/app/RegisterForm.test.ts`, change:
```ts
import RegisterForm from '@/components/auth/RegisterForm.vue';
```
to:
```ts
import RegisterForm from './RegisterForm.vue';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/ui-components test -- LoginForm RegisterForm`
Expected: FAIL — `./LoginForm.vue` not found.

- [ ] **Step 3: Create the lifted LoginForm**

Create `packages/ui-components/src/components/app/LoginForm.vue` — the exact markup from `apps/web/src/components/auth/LoginForm.vue`, with the primitive imports rewritten to package-relative paths:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { ShieldCheck, Lock, User, Terminal, Loader2 } from '@lucide/vue';
import { toast } from 'vue-sonner';

const props = defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: 'submit', payload: { username: string; password: string }): void;
}>();

const username = ref('');
const password = ref('');

watch(
  () => props.errorMessage,
  (msg) => {
    if (msg) toast.error(msg);
  },
);

function handleSubmit() {
  if (!username.value.trim() || !password.value) {
    toast.error('Please enter both username and password');
    return;
  }
  emit('submit', { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <Card
    class="w-full max-w-md mx-auto border-border/80 bg-card/95 shadow-xl backdrop-blur-sm"
  >
    <CardHeader class="space-y-2 pb-4">
      <div class="flex items-center justify-between">
        <div
          class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
        >
          <Terminal class="w-5 h-5" />
        </div>
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
        >
          <ShieldCheck class="w-3.5 h-3.5 text-primary" />
          <span>Token Auth</span>
        </div>
      </div>
      <div>
        <CardTitle class="text-2xl font-bold tracking-tight">Login</CardTitle>
        <CardDescription class="text-sm text-muted-foreground mt-0.5">
          Enter your credentials to access your account
        </CardDescription>
      </div>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label
            for="username"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <User class="w-3.5 h-3.5 text-muted-foreground" />
            Username
          </Label>
          <Input
            id="username"
            v-model="username"
            type="text"
            placeholder="Username"
            autocomplete="username"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Password
          </Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            placeholder="Password"
            autocomplete="current-password"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3 pt-2">
        <Button type="submit" class="w-full font-medium" :disabled="loading">
          <span v-if="loading" class="flex items-center gap-2">
            <Loader2 class="w-4 h-4 animate-spin" />
            Signing in...
          </span>
          <span v-else>Sign In</span>
        </Button>
        <div class="text-center text-xs text-muted-foreground">
          Don't have an account?
          <router-link
            to="/register"
            class="text-primary hover:underline font-medium ml-1"
          >
            Register
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
```

- [ ] **Step 4: Create the lifted RegisterForm**

Create `packages/ui-components/src/components/app/RegisterForm.vue` — the exact markup from `apps/web/src/components/auth/RegisterForm.vue`, with the primitive imports rewritten to `../ui/card`, `../ui/input`, `../ui/label`, `../ui/button`. The `<script setup>` block is identical to the source except those four import lines:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Shield, KeyRound, User, Mail, Lock, Loader2 } from '@lucide/vue';
import { toast } from 'vue-sonner';

const props = defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (
    e: 'submit',
    payload: { username: string; email?: string; password: string },
  ): void;
}>();

const username = ref('');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');

watch(
  () => props.errorMessage,
  (msg) => {
    if (msg) toast.error(msg);
  },
);

function validateEmail(val: string): boolean {
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(val);
}

function handleSubmit() {
  const trimmedUser = username.value.trim();
  const trimmedEmail = email.value.trim();

  if (!trimmedUser || trimmedUser.length < 3) {
    toast.error('Username must be at least 3 characters');
    return;
  }

  if (trimmedEmail && !validateEmail(trimmedEmail)) {
    toast.error('Please enter a valid email address');
    return;
  }

  if (password.value.length < 8) {
    toast.error('Password must be at least 8 characters');
    return;
  }

  if (password.value !== confirmPassword.value) {
    toast.error('Passwords do not match');
    return;
  }

  emit('submit', {
    username: trimmedUser,
    email: trimmedEmail || undefined,
    password: password.value,
  });
}
</script>

<template>
  <Card
    class="w-full max-w-md mx-auto border-border/80 bg-card/95 shadow-xl backdrop-blur-sm"
  >
    <CardHeader class="space-y-2 pb-4">
      <div class="flex items-center justify-between">
        <div
          class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
        >
          <KeyRound class="w-5 h-5" />
        </div>
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
        >
          <Shield class="w-3.5 h-3.5 text-primary" />
          <span>Password-Derived Keys</span>
        </div>
      </div>
      <div>
        <CardTitle class="text-2xl font-bold tracking-tight"
          >Create an account</CardTitle
        >
        <CardDescription class="text-sm text-muted-foreground mt-0.5">
          Enter your details to generate your secure identity
        </CardDescription>
      </div>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label
            for="reg-username"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <User class="w-3.5 h-3.5 text-muted-foreground" />
            Username
          </Label>
          <Input
            id="reg-username"
            v-model="username"
            type="text"
            placeholder="Username (min 3 chars)"
            autocomplete="username"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-email"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Mail class="w-3.5 h-3.5 text-muted-foreground" />
            Email (optional)
          </Label>
          <Input
            id="reg-email"
            v-model="email"
            type="email"
            placeholder="name@example.com"
            autocomplete="email"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Password
          </Label>
          <Input
            id="reg-password"
            v-model="password"
            type="password"
            placeholder="Password (min 8 chars)"
            autocomplete="new-password"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-confirm-password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Confirm Password
          </Label>
          <Input
            id="reg-confirm-password"
            v-model="confirmPassword"
            type="password"
            placeholder="Repeat password"
            autocomplete="new-password"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3 pt-2">
        <Button type="submit" class="w-full font-medium" :disabled="loading">
          <span v-if="loading" class="flex items-center gap-2">
            <Loader2 class="w-4 h-4 animate-spin" />
            Generating Keys & Registering...
          </span>
          <span v-else>Register</span>
        </Button>
        <div class="text-center text-xs text-muted-foreground">
          Already have an account?
          <router-link
            to="/login"
            class="text-primary hover:underline font-medium ml-1"
          >
            Sign In
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
```

- [ ] **Step 5: Export the components from the package**

In `packages/ui-components/src/index.ts`, add after the `useTheme` export block:

```ts
export { default as LoginForm } from './components/app/LoginForm.vue';
export { default as RegisterForm } from './components/app/RegisterForm.vue';
```

- [ ] **Step 6: Run the relocated tests to verify they pass**

Run: `pnpm --filter @ponter/ui-components test -- LoginForm RegisterForm`
Expected: PASS — 4 LoginForm tests + 4 RegisterForm tests, same assertions as before relocation.

- [ ] **Step 7: Point the web views at the shared components**

In `apps/web/src/views/LoginView.vue`, change:
```ts
import LoginForm from '@/components/auth/LoginForm.vue';
```
to:
```ts
import { LoginForm } from '@ponter/ui-components';
```

In `apps/web/src/views/RegisterView.vue`, change:
```ts
import RegisterForm from '@/components/auth/RegisterForm.vue';
```
to:
```ts
import { RegisterForm } from '@ponter/ui-components';
```

- [ ] **Step 8: Remove the superseded web files**

```bash
git rm apps/web/src/components/auth/LoginForm.vue apps/web/src/components/auth/RegisterForm.vue
```

- [ ] **Step 9: Verify no dangling imports remain**

Run: `grep -rn "components/auth/LoginForm\|components/auth/RegisterForm" apps/web/src || echo "no dangling imports"`
Expected: `no dangling imports`.

- [ ] **Step 10: Run the web suite and typecheck**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS. `LoginView.test.ts` and `RegisterView.test.ts` still pass (they mount the views, which now import the shared forms).

- [ ] **Step 11: Format the new/changed files**

Run: `pnpm exec prettier --write packages/ui-components/src/components/app/LoginForm.vue packages/ui-components/src/components/app/RegisterForm.vue packages/ui-components/src/components/app/LoginForm.test.ts packages/ui-components/src/components/app/RegisterForm.test.ts packages/ui-components/src/index.ts apps/web/src/views/LoginView.vue apps/web/src/views/RegisterView.vue`
Expected: files rewritten in place (or unchanged if already formatted).

- [ ] **Step 12: Commit**

```bash
git add packages/ui-components/src/components/app/LoginForm.vue packages/ui-components/src/components/app/RegisterForm.vue packages/ui-components/src/components/app/LoginForm.test.ts packages/ui-components/src/components/app/RegisterForm.test.ts packages/ui-components/src/index.ts apps/web/src/views/LoginView.vue apps/web/src/views/RegisterView.vue
git commit -m "refactor(ui-components): lift auth presentational components (ADR-88)"
```

---

### Task 4: Lift the ThemeToggle component

**Files:**
- Create: `packages/ui-components/src/components/app/ThemeToggle.vue`
- Modify: `packages/ui-components/src/index.ts` (export the component)
- Modify: `apps/web/src/components/layout/AppHeader.vue` (import path)
- Delete: `apps/web/src/components/layout/ThemeToggle.vue`
- Test (unchanged, must stay green): `apps/web/src/__tests__/AppHeader.test.ts`, `apps/web/src/__tests__/use-theme.test.ts`

**Interfaces:**
- Consumes: `../ui/button`, `../../composables/useTheme`.
- Produces: `ThemeToggle` — no props, no emits; renders a button that toggles the shared theme.

- [ ] **Step 1: Create the lifted ThemeToggle**

Create `packages/ui-components/src/components/app/ThemeToggle.vue` — the exact markup from `apps/web/src/components/layout/ThemeToggle.vue`, with imports rewritten to package-relative paths:

```vue
<script setup lang="ts">
import { useTheme } from '../../composables/useTheme';
import { Button } from '../ui/button';

const { isDark, toggle } = useTheme();
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
    @click="toggle"
  >
    <svg
      v-if="isDark"
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </Button>
</template>
```

- [ ] **Step 2: Export the component**

In `packages/ui-components/src/index.ts`, add after the `RegisterForm` export:

```ts
export { default as ThemeToggle } from './components/app/ThemeToggle.vue';
```

- [ ] **Step 3: Point AppHeader at the shared component**

In `apps/web/src/components/layout/AppHeader.vue`, change:
```ts
import ThemeToggle from './ThemeToggle.vue';
```
to:
```ts
import { ThemeToggle } from '@ponter/ui-components';
```

- [ ] **Step 4: Remove the superseded web file**

```bash
git rm apps/web/src/components/layout/ThemeToggle.vue
```

- [ ] **Step 5: Verify no dangling imports remain**

Run: `grep -rn "layout/ThemeToggle\|'./ThemeToggle" apps/web/src || echo "no dangling imports"`
Expected: `no dangling imports`.

- [ ] **Step 6: Run the web suite and typecheck**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS — `AppHeader.test.ts` and `use-theme.test.ts` still pass (the shared `ThemeToggle` uses the same shared composable the web adapter configured in Task 2 Step 9).

- [ ] **Step 7: Guard the adapter wiring**

Run: `grep -n "composables/useTheme" apps/web/src/main.ts`
Expected: one line — the side-effect import added in Task 2 Step 9. If it is missing, web theme persistence is broken; add it before proceeding.

- [ ] **Step 8: Format the new/changed files**

Run: `pnpm exec prettier --write packages/ui-components/src/components/app/ThemeToggle.vue packages/ui-components/src/index.ts apps/web/src/components/layout/AppHeader.vue`
Expected: files rewritten in place (or unchanged if already formatted).

- [ ] **Step 9: Commit**

```bash
git add packages/ui-components/src/components/app/ThemeToggle.vue packages/ui-components/src/index.ts apps/web/src/components/layout/AppHeader.vue
git commit -m "refactor(ui-components): lift ThemeToggle presentational component (ADR-88)"
```

---

### Task 5: Document the shared design layer (package README)

**Files:**
- Create: `packages/ui-components/README.md`

**Interfaces:**
- Consumes: everything produced by Tasks 1–4.
- Produces: documentation only.

> Note: the ARCHITECTURE.md ADR-88 entry and the §8 trail entry are **out of scope** for this sub-project — they are owned by sub-project F (docs + ADR + §8 trail), which also records the PR SHAs and PR #126 `bf5ff8a`. This task documents only the package's consumption contract.

- [ ] **Step 1: Write the package README**

Create `packages/ui-components/README.md`:

```markdown
# @ponter/ui-components

The shared design layer for every Ponter UI (web today; the Electron desktop
renderer next). ADR-88.

## What lives here

- `src/styles/tokens.css` — the single source of truth for design tokens: the
  semantic `@theme` mapping, the light/dark custom-property palettes, the base
  layer, and the additive brand palette. Extracted from the web app.
- `src/components/ui/**` — generated shadcn-vue primitives. Do not hand-edit
  (the directory is `.prettierignore`d and kept byte-identical to the registry).
- `src/components/app/**` — environment-independent presentational components
  (props/emits only; no store, router, or API client).
- `src/composables/useTheme.ts` — the storage-agnostic theme composable.

## How an app consumes it

1. Depend on the package (`"@ponter/ui-components": "workspace:*"`).
2. Alias `@/lib/utils` to `packages/ui-components/src/lib/utils` and
   `@/components/ui/*` to `packages/ui-components/src/components/ui/*` (the
   primitives import `cn` and each other through those aliases). Do this in the
   app's `vite.config.ts`, `vitest.config.ts`, and `tsconfig.json` `paths`.
3. Import the tokens from the Tailwind entry, after the framework imports:

   ```css
   @import 'tailwindcss';
   @import 'tw-animate-css';
   @import 'shadcn-vue/tailwind.css';
   @import '@ponter/ui-components/styles/tokens.css';
   @source "../../../packages/ui-components/src";
   ```

4. Configure the theme storage once at startup (importing the module that calls
   it is enough):

   ```ts
   import { configureThemeStorage } from '@ponter/ui-components';
   configureThemeStorage(myStorageAdapter); // web: localStorage; desktop: IPC
   ```

## Adding a component to `app/`

Only lift a component that communicates purely through props and emits. If it
imports a store, `vue-router`, or an API client, it stays in its app.
```

- [ ] **Step 2: Format the new file**

Run: `pnpm exec prettier --write packages/ui-components/README.md`
Expected: file rewritten in place (or unchanged if already formatted).

- [ ] **Step 3: Check the whole-repo formatting gate**

Run: `pnpm format:check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui-components/README.md
git commit -m "docs(ui-components): document the shared design layer (ADR-88)"
```

---

## Self-Review

**1. Spec coverage (ADR-88, spec §6):**
- §6.1 Tokens → Task 1. ✅
- §6.2 `useTheme` + storage adapter → Task 2. ✅
- §6.3 Presentational components (`LoginForm`, `RegisterForm`, `ThemeToggle`) → Tasks 3–4. ✅
- "Web visual parity, no runtime change" → Task 1 Step 6 assertion; the only web runtime files touched are `style.css` (entry, tokens import) and `main.ts` (adapter import) — stores, router, and `/config.js` are untouched. ✅
- **Deliberate deviation from spec §6.1:** the spec lists the font `@import` and the framework `@import`s inside `tokens.css`. This plan keeps them in each app's entry and puts only the token set (`@custom-variant`, `@theme inline`, `:root`, `.dark`, `@layer base`, `@theme`) in `tokens.css`, because Tailwind v4 needs its framework entry at the top of the consuming entry and `@source` is app-relative. The spec's intent — every design token shared in one file — is preserved. Recorded as a plan ruling, not a contradiction.
- **Deferred to other sub-projects (out of scope here):** the desktop IPC storage adapter and desktop-only presentational components (sub-project B); the ARCHITECTURE.md ADR-88 entry and §8 trail (sub-project F).
- **Deferred within A (not lifted):** `RegisterAgentDialog`, `DeleteAgentDialog`, `EditAgentDialog` (import `apiClient`), and `ResetIdentityKeyDialog` (imports `useAuthStore`) — not environment-independent, so they stay in `apps/web`.

**2. Placeholder scan:** No "TBD"/"TODO"; every code step carries full content. ✅

**3. Type consistency:** `ThemeStorage.get(): Theme | null` / `set(theme: Theme): void`, `UseTheme`, `configureThemeStorage`, `useTheme`, `resetTheme` are used identically in Task 2's tests, the composable, the web adapter, and the README. `LoginForm`/`RegisterForm`/`ThemeToggle` named exports match their import sites. The web adapter's module path `@/composables/useTheme` is unchanged, so `use-theme.test.ts` needs no edit. ✅

**4. Review Focus coverage:** each of the five lines is pinned by a named task/step (Task 1 Step 6; Task 2 Steps 3, 9, 10 + Task 4 Steps 6, 7; Task 2 Step 12 + Task 3 Step 6 + Task 4 Step 6; Task 1 Step 6). ✅

**TEST-INTEGRITY ledger (before → after):**
- Task 2: web `use-theme.test.ts` retained in place (4 tests). Package gains `useTheme.test.ts` (5 tests). Net: **+5 tests, 0 removed**.
- Task 3: `LoginForm.test.ts` (**4 tests**) and `RegisterForm.test.ts` (**4 tests**) **relocated** web → package (same assertions; import path only). Net: **0 removed, 0 added**.
- Task 4: no test change; `AppHeader.test.ts` and `use-theme.test.ts` stay green.
- No test is deleted, skipped, or weakened at any point.
