# QA Verification Plan — Sub-project A: Shared Design Layer (Electron migration)

**Owner:** QA (independent verification)
**Status:** WRITTEN — NOT EXECUTED. Execution starts only on PM's relay of FE's **frozen tip**.
**Implementation plan (authority):** `docs/superpowers/plans/2026-10-14-electron-subproject-a-shared-design-layer.md`
**Spec (authority over the plan):** `docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md` (§6, ADR-88)
**QA does not merge. QA does not edit product files** (a temporary in-place edit is allowed ONLY to prove a red→green regression, and MUST be restored with `git checkout -- <path>` and verified clean before reporting).

---

## 0. Scope & method

Verify that lifting the design tokens, the storage-agnostic `useTheme` composable, and three presentational components from `apps/web` into `packages/ui-components` (with `apps/web` importing them back) is:

1. **faithful** — no token lost/renamed; web renders identically;
2. **not silently broken** — web theme persistence still configured at startup;
3. **robust** — `useTheme` survives a throwing/absent storage adapter;
4. **standalone-buildable** — the package builds/typechecks without a consumer-only alias;
5. **test-integral** — relocated tests keep identical assertions; net **+5 tests, 0 removed**.

Method: run every gate **independently** on the frozen tip (never trust the implementer's report); capture raw command output verbatim; diff artifacts (built CSS, test lists, `it()`/`expect()` counts) between the **base** (current `main` = `519db47` at plan-write time; re-pin at execution) and the **frozen head**.

### Files in scope (from the impl plan)
- `packages/ui-components/src/styles/tokens.css` (new)
- `packages/ui-components/package.json` (exports + test tooling)
- `packages/ui-components/vitest.config.ts` (new)
- `packages/ui-components/src/composables/useTheme.ts` (new)
- `packages/ui-components/src/composables/useTheme.test.ts` (new)
- `packages/ui-components/src/components/app/{LoginForm,RegisterForm,ThemeToggle}.vue` (new)
- `packages/ui-components/src/components/app/{LoginForm,RegisterForm}.test.ts` (moved from web)
- `packages/ui-components/src/index.ts` (exports)
- `packages/ui-components/README.md` (new)
- `apps/web/src/style.css`, `apps/web/src/main.ts`, `apps/web/src/composables/useTheme.ts`
- `apps/web/src/views/{LoginView,RegisterView}.vue`, `apps/web/src/components/layout/AppHeader.vue`
- Deleted: `apps/web/src/components/auth/{LoginForm,RegisterForm}.vue`, `apps/web/src/components/layout/ThemeToggle.vue`, `apps/web/src/__tests__/{LoginForm,RegisterForm}.test.ts` (moved)

### Baseline captured at plan-write time (re-confirm on the frozen base)
| Metric | Baseline value |
|---|---|
| web test files | 38 |
| web `it(` total | 326 |
| web `expect(` total | 766 |
| `packages/ui-components` test files | 0 |
| `packages/ui-components` `scripts.test` | *(absent)* |
| web `use-theme.test.ts` | 4 tests (12–15) |
| web `LoginForm.test.ts` | 4 tests (16–19) |
| web `RegisterForm.test.ts` | 4 tests (19–22) |
| `@ponter/ui-components` in web deps | absent |

---

## 1. Repo-wide gates (run first, on the frozen tip)

All commands run from the repo root on the frozen head. Capture exit code + tail of output for each.

| # | Gate | Command | Pass condition |
|---|---|---|---|
| G1 | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | exit 0; `@ponter/ui-components` linked into `apps/web/node_modules` |
| G2 | Prettier (CI-gating) | `pnpm format:check` | exit 0 (new files under `src/composables`, `src/styles`, `src/components/app`, `vitest.config.ts`, README must be formatted; `src/components/ui/**` is `.prettierignore`d) |
| G3 | Lint | `pnpm lint` | exit 0 (12 packages) |
| G4 | Typecheck (workspace) | `pnpm typecheck` | exit 0 (12 packages) — includes package `vue-tsc` (Focus 4) |
| G5 | Web build | `pnpm --filter @ponter/web build` | exit 0 |
| G6 | Node test suites (gating step) | `pnpm exec turbo run test --filter='!@ponter/agent' --filter='!@ponter/web' --filter='!@ponter/shared' --continue=always` | all pass; **note this step now includes `@ponter/ui-components`** once it gains a `test` script |
| G7 | Web test suite | `pnpm --filter @ponter/web test` | exit 0 |
| G8 | Package test suite | `pnpm --filter @ponter/ui-components test` | exit 0 (new) |
| G9 | Package typecheck standalone | `pnpm --filter @ponter/ui-components typecheck` | exit 0 |

> G6 is the CI gating test step (`ci-node.yml` lines 95–101). Because it filters only `agent`/`web`/`shared`, adding `scripts.test` to `@ponter/ui-components` pulls it into the **gating** step automatically — confirm it actually ran there (grep the turbo output for `@ponter/ui-components:test`).

---

## 2. Focus-gate checks (each maps to a named regression gate in the impl plan)

### Focus 1 — Every design token survives into the built web CSS (plan Task 1 Step 6)
**Claim:** token extraction is faithful; the built CSS still contains every custom property.

**Evidence to capture:**
```bash
pnpm --filter @ponter/web build
echo "--- built css ---"; ls apps/web/dist/assets/*.css
for tok in --background --foreground --primary --primary-foreground --destructive --ring \
           --radius --terminal-bg --success --warning --danger --sidebar --chart-1 --header-height; do
  grep -q -- "$tok" apps/web/dist/assets/*.css || { echo "MISSING $tok"; exit 1; }
done
grep -q '\.dark' apps/web/dist/assets/*.css || { echo "MISSING .dark"; exit 1; }
echo "ALL TOKENS PRESENT"
```
**Independent strengthening (QA-added):** do NOT trust the 14-token spot-check alone. Diff the **full token set** base vs head:
```bash
# Extract every custom property declaration (name+value) from the built CSS, sorted, both revisions.
# Base: build at the frozen base into a temp dir. Head: build at the frozen head.
# Then: comm -23 <(base tokens) <(head tokens)  -> must be EMPTY (nothing dropped)
```
Also verify the source extraction is **verbatim** per spec §6.1: `packages/ui-components/src/styles/tokens.css` must contain the `@theme inline` mapping, `:root`/`.dark` blocks, `@layer base`, and additive `@theme` **in the same order and value** as the pre-extraction `apps/web/src/style.css`. `git show <base>:apps/web/src/style.css` vs the new tokens file — the token body must be byte-equal modulo the documented split (font `@import` + framework `@import`s + `@source` stay in the web entry, per the plan's Self-Review ruling).

**Pass condition:** `ALL TOKENS PRESENT`; full-set diff empty; verbatim check clean.

---

### Focus 2 — Web theme persistence NOT silently broken by the ThemeToggle move
**Claim:** `apps/web/src/main.ts` imports the adapter so `configureThemeStorage(localStorage)` runs; retained web tests 12–15 stay green.

**Evidence to capture:**
```bash
# (a) The adapter side-effect import exists in the web entry.
grep -n "composables/useTheme" apps/web/src/main.ts     # expect exactly the side-effect import line
# (b) The adapter module actually configures storage at import time.
grep -n "configureThemeStorage(localStorageThemeStorage)" apps/web/src/composables/useTheme.ts
# (c) No dangling importers of the removed web ThemeToggle.
grep -rn "layout/ThemeToggle\|'./ThemeToggle" apps/web/src || echo "no dangling imports"
# (d) Retained web theme tests.
pnpm --filter @ponter/web exec vitest run use-theme      # tests 12–15 green
```
**Independent strengthening:** prove the *wiring*, not just presence — a runtime proof that importing the web entry module configures the shared core's storage:
- In a throwaway test/REPL, import `@ponter/ui-components` and `apps/web/src/composables/useTheme`, then assert `useTheme().set('dark')` writes `localStorage['remote.theme'] === 'dark'`. This is the real persistence contract the move could break.
- Also confirm `ThemeToggle` (now in the package) reads the SAME shared core the web adapter configured (single module instance — check the package `useTheme` is not duplicated via a second resolution path).

**Pass condition:** import present; adapter calls `configureThemeStorage`; 0 dangling imports; tests 12–15 green; runtime write-back to `remote.theme` observed.

---

### Focus 3 — `useTheme` does not throw on storage throw; falls back to `prefers-color-scheme` pre-adapter (plan Task 2 Step 3)
**Claim:** the package tests pin both.

**Evidence to capture:**
```bash
pnpm --filter @ponter/ui-components test      # 5 tests, incl. "does not throw when the adapter set() throws"
```
**Independent strengthening:**
- Read the 5 package tests; confirm each asserts real behavior (not empty): fallback-to-dark, stored-wins, `set()` persists through adapter, `toggle()` flips ref **and** `<html>.dark`, throwing-adapter no-throw.
- Confirm the pre-adapter path is exercised: with the default `noopStorage`, `getInitialTheme()` must fall back to `prefers-color-scheme` **without throwing**. Verify by inspection + the package test that runs before any adapter is configured (or add a throwaway assertion in the worktree; restore after).
- Confirm `safeGet`/`safeSet` wrap the adapter (the guard the test depends on).

**Pass condition:** 5/5 package tests green; guards present; pre-adapter fallback observed.

---

### Focus 4 — `@ponter/ui-components` builds/typechecks standalone (plan Task 2 Step 12, Task 3/4 Step 6)
**Claim:** the package compiles its `.vue` and typechecks without a consumer-only alias.

**Evidence to capture:**
```bash
pnpm --filter @ponter/ui-components test        # vitest compiles the lifted .vue (via package vitest.config.ts alias @ -> ./src)
pnpm --filter @ponter/ui-components typecheck   # vue-tsc --noEmit
```
**Independent strengthening:** the lifted components import primitives package-relative (`../ui/card`, `../ui/input`, …) and the primitives import `@/lib/utils` (48 files) and `@/components/ui/*` (4 files). Prove the package resolves these **on its own**:
- `packages/ui-components/tsconfig.json` `paths` must map `@/*` → `./src/*` (already present) — confirm.
- `packages/ui-components/vitest.config.ts` must alias `@` → `./src` — confirm.
- Negative control: grep the lifted `app/` components for any **consumer-only** alias (`@/components/ui/*`, `@/lib/utils`, `@/stores/*`, `@/composables/*`, `vue-router`, `pinia`). The plan mandates package-relative imports in `app/`; any `@/…` import in a lifted component is a BLOCK (package won't build standalone). `ThemeToggle` is allowed `../../composables/useTheme` (package-relative), NOT `@/composables/useTheme`.

**Pass condition:** package `test` + `typecheck` green; 0 consumer-only aliases in lifted components; aliases present in both configs.

---

### Focus 5 — TEST-INTEGRITY (plan ledger: net +5, 0 removed)

**Claim:** relocated tests keep identical assertions; declared before→after match; nothing deleted/skipped/weakened.

**Evidence to capture:**
```bash
# (a) File moves are relocations, not removals (git rename detection).
git diff --stat -M <base>..<head>
git log --diff-filter=D --name-only <base>..<head>          # deletions must be ONLY the superseded web files
# (b) The moved test files' bodies are identical except the import path.
git show <base>:apps/web/src/__tests__/LoginForm.test.ts   > /tmp/qa/lf.before
git show <head>:packages/ui-components/src/components/app/LoginForm.test.ts > /tmp/qa/lf.after
diff /tmp/qa/lf.before /tmp/qa/lf.after     # expect ONLY the import line to differ
# (same for RegisterForm.test.ts)
# (c) Counts.
grep -rhoE '\bit\('   apps/web/src/__tests__ | wc -l        # head web it()  (baseline 326)
grep -rhoE '\bexpect\(' apps/web/src/__tests__ | wc -l      # head web expect() (baseline 766)
grep -rhoE '\bit\('   packages/ui-components/src | wc -l    # new package tests
grep -rhoE '\bexpect\(' packages/ui-components/src | wc -l
# (d) No weakened/disabled tests anywhere in the range.
git diff <base>..<head> | grep -nE '^\+.*(#\[ignore|\.skip\(|it\.skip|describe\.skip|xit\(|xdescribe\(|todo\()' || echo "no skips"
# (e) Run each suite and record the pass counts.
pnpm --filter @ponter/web test
pnpm --filter @ponter/ui-components test
```

**Ledger to reconcile (plan Self-Review, TEST-INTEGRITY):**
| Task | Movement | Expected |
|---|---|---|
| Task 2 | web `use-theme.test.ts` retained (4); package `useTheme.test.ts` added (5) | **+5, 0 removed** |
| Task 3 | `LoginForm.test.ts` (4) + `RegisterForm.test.ts` (4) relocated web→package | **0 removed, 0 added** |
| Task 4 | no test change; `AppHeader.test.ts`, `use-theme.test.ts` stay green | **0** |
| **Net** | | **+5 tests, 0 removed** |

**Web-side expectation:** web `it()` drops by exactly the 8 relocated tests (4 LoginForm + 4 RegisterForm) → **326 → 318**; web `expect()` drops by the exact number of `expect()` calls in those two files (count them at base and confirm the drop equals that number). Package gains 5 (`useTheme.test.ts`) + 8 (relocated) = **13** `it()`. **Every delta must be exactly accounted for**; any unaccounted change (a dropped assertion, a renamed test, a softened matcher) is **BLOCKING**.

**Pass condition:** moved test bodies identical (import-only diff); deltas exactly as above; 0 skips/ignores added; all suites green.

---

## 3. SonarCloud audit

Per `.sonarcloud.properties` (read from `main`): the generated primitives tree `packages/ui-components/src/components/ui/**` is **excluded** from analysis and duplication. The **new** code — `src/composables/useTheme.ts`, `src/styles/tokens.css`, `src/components/app/*.vue` — is **NOT** excluded, so it is analyzed.

**Checks:**
1. `gh pr checks <PR#>` → SonarCloud Quality Gate result for the PR.
2. If the gate fails, pull the failing condition (new-code duplication / coverage / issues) via the Sonar API and report `file:line`.
3. Confirm no new duplication is introduced by the lifted components (they are near-copies of the deleted web files — Sonar may flag the copy-paste pair). If duplication rises, note whether the deleted originals offset it; a net duplication regression is a finding to raise, not auto-BLOCK unless the Quality Gate fails.
4. Coverage: the package gains tests; confirm the PR's new-code coverage is not dragged below the gate by the large new `.vue` files.

---

## 4. Red→green regression methodology (optional, only if a focus needs a live proof)

The plan's own gates are static + suite-based, so a red→green is not strictly required for every focus. If PM asks for one (e.g. to prove Focus 2's wiring gate is real):

1. In a **throwaway worktree** at the frozen head, remove the `apps/web/src/main.ts` side-effect import (the exact regression the plan guards against).
2. Run `pnpm --filter @ponter/web test` and the runtime write-back probe → expect the persistence probe to FAIL.
3. Restore with `git checkout -- apps/web/src/main.ts`; confirm `git status` clean and the file blob equals the committed blob.
4. Re-run → PASS.
**Never commit; never leave the edit.**

---

## 5. BLOCK criteria (any one ⇒ verdict BLOCK)

- A design token present at base is **absent** from the head built CSS, or the extraction is not verbatim (spec §6.1).
- `apps/web/src/main.ts` lacks the adapter side-effect import, OR the adapter does not call `configureThemeStorage`, OR web theme persistence fails a runtime probe.
- A lifted component imports a **consumer-only** alias (`@/…`, `vue-router`, `pinia`, a store, or an API client) → package does not build standalone.
- `pnpm --filter @ponter/ui-components test` or `typecheck` fails.
- Any test **deleted/skipped/weakened**, or any test-body change beyond the declared import-path edit, or an **unaccounted** `it()`/`expect()` delta.
- Any repo-wide gate (G1–G9) fails, or CI (2-OS) is red.

---

## 6. Verdict template (to be filled at execution)

- **TEST-INTEGRITY:** PASS/FAIL — before→after `it()`/`expect()` with evidence.
- **Focus 1 (tokens):** PASS/FAIL — token diff evidence.
- **Focus 2 (persistence):** PASS/FAIL — import + runtime probe evidence.
- **Focus 3 (throw/fallback):** PASS/FAIL — package test evidence.
- **Focus 4 (standalone build):** PASS/FAIL — test/typecheck evidence.
- **SonarCloud:** QG status.
- **CI:** `gh pr checks` status (2-OS).
- **Binding verdict:** RECOMMEND MERGE / BLOCK (with `file:line` per finding).

---

## 7. Execution preconditions

- Wait for PM's relay of the **frozen tip** (branch + commit). If the tip moves after verification starts, re-verify to the new tip (docs-only deltas that do not touch test/CI files may reuse the prior verdict, stated explicitly).
- Re-pin the base: use the merge-base of the frozen head and `main`, not the plan-write-time `519db47`.
- Work in throwaway worktrees under `/mnt/Data/Ponta/qaA-*` (the `/tmp` tmpfs is too small for `pnpm`/build output). Remove all worktrees, `node_modules`, and `dist` artifacts after; leave peer sessions' worktrees untouched.
- Do NOT merge. Do NOT edit product files (except a restored temporary edit for a red→green proof).
