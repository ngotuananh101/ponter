# Desktop Build Publish Fix + Remaining Backlog Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement Task 1 (and Task 2). Steps use checkbox (`- [ ]`) syntax for tracking. This plan is authored by the PM session; implementation is delegated to the FE role session per the project's delegation rule — the PM does not implement code.

**Goal:** Turn the `Build Desktop` workflow green on `main` by stopping `electron-builder` from attempting a GitHub Release publish on non-release events, and record the remaining backlog as prioritized workstreams.

**Architecture:** `electron-builder` is configured with a `publish: {provider: github}` block (needed by the deferred `electron-updater` work, issue #136) that makes it auto-publish whenever it detects a CI environment. Release publishing is already owned by the workflow's dedicated `release` job (`softprops/action-gh-release`), so `electron-builder`'s implicit publish is both redundant and harmful. The fix makes packaging never publish; the `release` job remains the single publish path.

**Tech Stack:** Electron 35, `electron-builder` 25.1.8, `electron-vite` 4, pnpm 12.6.0, GitHub Actions.

**Spec:** No new spec — this is a bounded defect fix to an existing, readable flow. Root cause is recorded in "Root Cause (verified)" below. Issue #136 is the tracking issue for the deferred `electron-updater` work referenced by the `publish:` block.

---

## Root Cause (verified)

Reproduced from run `38769014743` on `main` @ `4ae0095` (both `ubuntu-latest` job `116539634725` and `windows-latest` job `116539635015`):

```
• electron-builder  version=25.1.8 os=6.17.0-1022-azure
• artifacts will be published if draft release exists  reason=CI detected
• loaded configuration  file=/home/runner/work/ponter/ponter/apps/desktop/electron-builder.yml
...
Error: GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"
    at new GitHubPublisher (electron-publish@25.1.7/src/gitHubPublisher.ts:51:15)
    at createPublisher (app-builder-lib@25.1.8/src/publish/PublishManager.ts:302:14)
    at PublishManager.getOrCreatePublisher (PublishManager.ts:221:19)
    at PublishManager.scheduleUpload (PublishManager.ts:151:28)
    at PublishManager.artifactCreatedWithoutExplicitPublishConfig (PublishManager.ts:201:14)
```

**Chain:**
1. `apps/desktop/electron-builder.yml:43-46` — `publish: {provider: github, owner: ngotuananh101, repo: ponter}` (introduced by PR #135 `4ae0095`; `electron-builder.yml` first appears in that commit).
2. `apps/desktop/package.json:19` — `"package": "electron-builder"` (no `--publish never`).
3. `.github/workflows/build-desktop.yml:159-161` — step `Package desktop app (electron-builder)` runs `pnpm package` on **every** trigger, including branch push to `main`.
4. With a `publish:` config present and a CI environment detected, `electron-builder` resolves the implicit publish path → constructs `GitHubPublisher` → requires `GH_TOKEN` → **throws → job fails**.
5. PR run `38766042368` (head `0c8d5df`, same tree as `4ae0095`) **succeeded** because `electron-builder` auto-skips publishing on the `pull_request` event. This proves the failure is event-dependent and is *not* a code/test/build defect.
6. Installers (`.deb`, `.rpm`, `.AppImage`, `.exe`) build successfully; only the implicit upload step fails.

**Latent second defect:** on a real tag push, `electron-builder` would *also* try to publish (creating a draft release) at the same time as the workflow's `release` job (`softprops/action-gh-release`), a double-publish race. It has never fired because no `v*` tag has been pushed. This fix removes it.

---

## Global Constraints

- **PM does not implement.** Implementation is delegated to the FE role session via `SendMessage`; PM coordinates and cross-checks only.
- **Merge gate:** implementer (FE) → independent reviewer (BE) PASS → QA binding verdict (REQUIRED — this is a CI change) → BA docs audit (only if any `.md` changes) → PM cross-check → **all CI green**.
- **TEST-INTEGRITY:** no test is deleted, skipped, or weakened. This fix changes zero test files; the desktop suite count must stay **130 tests / 15 files** before and after.
- **Commit attribution:** author `Ngo Tuan Anh <ngotuananh2101@gmail.com>`; **zero** `Co-authored-by` trailers; zero Vietnamese characters in any committed text.
- **Branch/worktree:** work on a feature branch (e.g. `fix/desktop-build-publish`) off `main` in a dedicated worktree; never commit directly to `main`.
- **English only** for all code, comments, commit messages, and docs.

## Review Focus

The fix touches CI configuration, where the failure mode is a silent regression rather than a crash. The conditions most likely to bite:

1. **Tag/dispatch release still publishes** — after `--publish never`, a tag push must still produce a GitHub Release with all installer assets (via the `release` job). A fix that disables *all* publishing would silently break releases.
2. **PR builds stay green** — PR events were already green; the fix must not change that.
3. **Branch-push builds turn green** — the regression guard: a push to `main` touching `apps/desktop/**` must complete the `Package` step without a `GH_TOKEN` error.
4. **Installer artifacts still produced** — `--publish never` must not stop `.deb/.rpm/.AppImage/.exe` from being written to `dist/` (the `Assert installer artifacts` steps must still pass).
5. **No new secret required** — the fix must not add a `GH_TOKEN` requirement to the `build` job.

---

### Task 1: Disable implicit publish in the desktop packaging script

**Files:**
- Modify: `apps/desktop/package.json:19`
- Test: none (verification is the CI run; see Task 2 for the guard)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pnpm package` (and `pnpm --filter @ponter/desktop package`) never attempts a GitHub publish; the `dist/` installer artifacts are unchanged. The workflow `release` job (`softprops/action-gh-release`) remains the sole publish path.

**Rationale for changing the script, not the workflow:** putting `--publish never` in `package.json` makes local `pnpm package` and CI identical and safe in one place. The `publish:` block in `electron-builder.yml` is **kept** because it drives `latest*.yml` metadata generation for the deferred `electron-updater` work (issue #136); it is the *upload* that must be suppressed, and `--publish never` does exactly that.

- [ ] **Step 1: Apply the change**

In `apps/desktop/package.json`, change line 19 from:

```json
    "package": "electron-builder"
```

to:

```json
    "package": "electron-builder --publish never"
```

Leave every other field untouched (`package:dir` stays `electron-builder --dir`; the `publish:` block in `electron-builder.yml` stays as-is).

- [ ] **Step 2: Verify locally that packaging no longer attempts a publish**

Run from `apps/desktop` (Rust sidecar binary must already be present in `apps/desktop/resources/`; see `apps/desktop/README.md`):

```bash
pnpm --filter @ponter/desktop build
pnpm --filter @ponter/desktop package
```

Expected:
- No line containing `artifacts will be published` / `reason=CI detected`.
- No `GitHub Personal Access Token is not set` error.
- Exit code 0.
- `apps/desktop/dist/` contains the platform installers (`.deb`, `.rpm`, `.AppImage` on Linux; `.exe` on Windows).

Note: if the local shell has `CI=true` set, the old behavior would try to publish; with the fix it must not. Confirm the absence of the publish line.

- [ ] **Step 3: Confirm the desktop test count is unchanged**

```bash
pnpm --filter @ponter/desktop test
```

Expected: **15 test files / 130 tests**, all passing — identical to `main` (no test touched).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json
git commit -m "fix(desktop): disable implicit electron-builder publish in packaging script"
```

Author must be `Ngo Tuan Anh <ngotuananh2101@gmail.com>`, zero `Co-authored-by` trailers.

---

### Task 2: Add a CI-level regression guard against re-enabling implicit publish

**Files:**
- Modify: `.github/workflows/build-desktop.yml` (add one step in the `build` job, immediately after `Package desktop app (electron-builder)`)
- Test: the guard step itself

**Interfaces:**
- Consumes: Task 1's `package.json` script contract.
- Produces: a failing CI step if the packaging script is ever changed to publish implicitly again.

- [ ] **Step 1: Add the guard step**

Insert after the `Package desktop app (electron-builder)` step (after line 161) in `.github/workflows/build-desktop.yml`:

```yaml
      - name: Assert packaging did not attempt a publish
        working-directory: apps/desktop
        shell: bash
        run: |
          set -e
          # The packaging script must never publish implicitly: on non-release
          # events electron-builder would fail with "GitHub Personal Access
          # Token is not set". Release publishing is owned by the `release` job.
          script=$(node -p "require('./package.json').scripts.package")
          echo "package script: $script"
          case "$script" in
            *"--publish never"*) echo "OK: implicit publish disabled." ;;
            *) echo "::error::apps/desktop package script must pass --publish never"; exit 1 ;;
          esac
```

- [ ] **Step 2: Verify the guard is meaningful**

Temporarily (locally, do not commit) revert the script to `"package": "electron-builder"` and run the guard body; it must exit 1 with the `::error::` message. Restore the fix.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-desktop.yml
git commit -m "ci(desktop): guard against re-enabling implicit electron-builder publish"
```

---

## Verification & Review Chain (Tasks 1-2)

1. **FE implementer** executes Tasks 1-2 on branch `fix/desktop-build-publish` (worktree off `main`).
2. **BE independent reviewer** — PASS required. Must independently re-derive: (a) `electron-builder --publish never` suppresses the upload path; (b) the `release` job still publishes on tag/dispatch; (c) no other workflow/script depends on the implicit publish; (d) TEST-INTEGRITY (0 test changes, 130/15 unchanged); (e) attribution (0 trailers).
3. **QA binding verdict** — REQUIRED (CI change). Must confirm on the pushed HEAD: `Build Desktop` **green on a branch push** (not just PR), all installers produced, `release` job correctly skipped on non-tag events.
4. **BA docs audit** — only if a `.md` is touched. `apps/desktop/README.md` currently documents `pnpm --filter @ponter/desktop package`; verify it does not need a note that packaging never publishes (add a one-line note if the reviewer judges it warranted; otherwise no docs change).
5. **PM cross-check** — author, trailers, scope, CI.
6. **Merge** — squash to `main`; then confirm `Build Desktop` is **green on `main`** for the first push after merge.

**Acceptance:** `gh run list --branch main` shows `Build Desktop` = `success` on the post-merge `main` SHA.

---

## Subsequent Workstreams (backlog — each needs its own spec/plan)

These are recorded for sequencing only; none is specified here. Ordered by recommended priority.

### Workstream 2 (P1): Issue #136 — `electron-updater` auto-update + tray/autostart test coverage

- **What:** implement the deferred ADR-87 auto-update path (`electron-updater`), and add the coverage QA-F2 flagged as phantom: `tray.ts` (0 tests today), plus updater and autostart coverage.
- **Status:** Architectural (new subsystem) → requires a spec (`docs/superpowers/specs/`) then a plan.
- **Depends on:** Task 1 (the `publish:` block must remain, and `latest*.yml` must be generated and uploaded). The `release` job's `files:` list currently omits `latest*.yml` — that is part of this workstream.
- **Current state:** `apps/desktop/src/main/tray.ts` and `autostart.ts` exist; `electron-updater` is an unused dependency; no `updater.ts`.

### Workstream 3 (P2): ADR-25 — hardware codec (H.264 hardware / AV1)

- **What:** the only unchecked box in the §8 living roadmap (`docs/ARCHITECTURE.md:972`).
- **Status:** Spikes already committed (`docs/spikes/2026-10-11-hardware-encode-h265.md`, `docs/spikes/2026-10-11-quality-speed-optimization.md`). Findings: top lever = vectorise `downscale` (7.07 ms/frame scalar box filter > ~4 ms encode); AV1 = CONDITIONAL GO (opt-in, not default); H.265 blocked by browser support.
- **Next step:** owner decision on scope → spec → plan. The highest-value, lowest-risk item is the `downscale` vectorisation (does not change codec negotiation).

### Workstream 4 (P3): §8 trail — record PR #137 squash SHA `11cc5d8`

- **What:** append PR #137's squash SHA to the §8 trail in `docs/ARCHITECTURE.md` (convention: a docs PR's own SHA is recorded by the *next* docs PR, since it is unknowable pre-merge).
- **Status:** docs-only. Fold into the next docs PR (e.g. the docs leg of Workstream 2) rather than opening a standalone PR. Chain for a standalone docs PR: BA implement → independent reviewer PASS → PM cross-check (no QA binding, no CI — no workflow `paths:` matches `docs/**`).

### Workstream 5 (deferred): Item C — viewer surface

- **What:** a dedicated viewer experience. **No spec or plan exists.**
- **Status:** Deferred. Requires brainstorming → spec before any planning.

---

## Self-Review

- **Spec coverage:** No spec (bounded fix). Root cause fully documented and reproduced. ✔
- **Placeholder scan:** No TBD/TODO; Task 1 and Task 2 contain exact edits and commands. ✔
- **Type consistency:** `package` script contract (`--publish never`) is referenced identically in Task 1 and Task 2's guard. ✔
- **Review Focus:** each of the 5 listed failure modes maps to a verification step (Task 1 Step 2 = focus 3/4; Review Chain step 2 = focus 1; Task 1 Step 3 = focus 2/5). ✔
