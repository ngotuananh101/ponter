# Desktop Installer Artifact Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking. Authored by the PM session; implementation is delegated to the FE role session per the project's delegation rule — the PM does not implement code.

**Goal:** Split the desktop CI artifact upload so each installer format is published as its own named artifact, instead of the current two grouped artifacts (`ponter-desktop-linux` = `.deb` + `.rpm` + `.AppImage`; `ponter-desktop-windows` = all `.exe`).

**Architecture:** The `build` job in `.github/workflows/build-desktop.yml` uploads artifacts per matrix OS. Today one step per OS uploads a multi-format glob. This plan replaces those two steps with one step per format, each with a single-format `path` and `if-no-files-found: error`. Windows produces two `.exe` variants (NSIS installer + portable) that a plain glob cannot distinguish, so `electron-builder.yml` gains explicit `nsis.artifactName` / `portable.artifactName` values and the workflow matches on those names.

**Tech Stack:** Electron 35, `electron-builder` 25.1.8, GitHub Actions (`actions/upload-artifact@v4.6.1`).

**Spec:** No new spec — bounded CI/config change to an existing, readable flow. Owner decisions recorded under "Owner Decisions" below.

**Depends on:** PR #138 (`fix/desktop-build-publish`) must be merged first — it touches the same workflow file. Base this branch on `main` **after** #138 lands.

---

## Owner Decisions (2026-10-16)

1. **Windows split = explicit naming.** Set `nsis.artifactName` and `portable.artifactName` in `apps/desktop/electron-builder.yml` so each `.exe` has a distinct, deterministic name the workflow can match. This also makes the release asset names clearer.
2. **Sequencing = separate PR after #138.** Do not add commits to #138 (it has a QA binding in flight); this is a follow-up PR based on post-#138 `main`.

## Current State (verified)

`.github/workflows/build-desktop.yml`:
- Step `Upload artifacts (Linux)` (`if: matrix.os == 'ubuntu-latest'`) → name `ponter-desktop-linux`, path glob `dist/*.deb` + `*.rpm` + `*.AppImage`.
- Step `Upload artifacts (Windows)` (`if: matrix.os == 'windows-latest'`) → name `ponter-desktop-windows`, path glob `dist/*.exe` + `*.msi` + `*.zip`.
- `.msi` and `.zip` patterns are **dead** — `electron-builder.yml` `win.target` is `[nsis, portable]`, neither of which emits `.msi`/`.zip`.
- `release` job downloads all artifacts with `merge-multiple: true` and uploads `dist/**/*.{deb,rpm,AppImage,msi,exe}` + `SHA256SUMS.txt` — **unchanged** by this plan (splitting uploads does not change what the release collects).

`apps/desktop/electron-builder.yml`:
- `win.target: [nsis, portable]`; `nsis.oneClick: false`, `nsis.allowToChangeInstallationDirectory: true`; **no `artifactName`** for either → both rely on electron-builder defaults, so both are `.exe` with no distinguishing token guaranteed.

## Global Constraints

- **PM does not implement.** Implementation is delegated to the FE role session via `SendMessage`; PM coordinates and cross-checks only.
- **Merge gate:** implementer (FE) → independent reviewer (BE) PASS → QA binding verdict (REQUIRED — CI change) → BA docs audit (only if a `.md` is touched) → PM cross-check → **all CI green**.
- **TEST-INTEGRITY:** no test is deleted, skipped, or weakened. This change touches no test file; the desktop suite must stay **15 files / 130 tests**.
- **Commit attribution:** author `Ngo Tuan Anh <ngotuananh2101@gmail.com>`; **zero** `Co-authored-by` trailers; zero Vietnamese characters in any committed text.
- **Branch/worktree:** new branch (e.g. `ci/desktop-artifact-split`) off post-#138 `main`, in a dedicated worktree; never commit to `main`.
- **English only** for all code, comments, commit messages, and docs.
- **Do not regress the #138 fix:** the `package` script keeps `--publish never`; the `Assert packaging did not attempt a publish` guard step stays.

## Review Focus

The failure modes most likely to bite:

1. **Every format still produced and uploaded** — after the split, Linux must yield 3 artifacts (`.deb`, `.rpm`, `.AppImage`) and Windows 2 (`nsis`, `portable`), each non-empty. A split that drops a format is a regression.
2. **Windows names are distinguishable and stable** — the NSIS and portable `.exe` names must be deterministic and mutually exclusive, or the two upload steps will both match the wrong file (or the same file).
3. **`if-no-files-found: error` stays on every step** — so a missing format fails CI loudly rather than silently uploading nothing.
4. **The release job still collects everything** — `merge-multiple: true` must still gather all five installer types into the release; splitting uploads must not change the release asset set.
5. **The #138 guard and `--publish never` survive** — this branch is based on post-#138 `main`; the fix must not be reverted.

---

### Task 1: Give the Windows installers deterministic names

**Files:**
- Modify: `apps/desktop/electron-builder.yml` (the `nsis:` block; add a `portable:` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: NSIS installer at `dist/${productName}-Setup-${version}.exe` and portable at `dist/${productName}-Portable-${version}.exe` (with `productName: Ponter Desktop` → `dist/Ponter Desktop-Setup-0.1.0.exe` and `dist/Ponter Desktop-Portable-0.1.0.exe`). Task 2 matches on the `Setup` / `Portable` tokens.

- [ ] **Step 1: Apply the config change**

In `apps/desktop/electron-builder.yml`, extend the `nsis:` block and add a `portable:` block:

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  # Explicit, deterministic name so the CI upload step can distinguish the NSIS
  # installer from the portable build (both are `.exe`).
  artifactName: ${productName}-Setup-${version}.${ext}
portable:
  # Explicit, deterministic name — see the `nsis` note above.
  artifactName: ${productName}-Portable-${version}.${ext}
```

Leave `win.target: [nsis, portable]` and every other field unchanged.

- [ ] **Step 2: Verify the names locally (Windows or Wine)**

Run from `apps/desktop` (agent sidecar present in `apps/desktop/resources/`):

```bash
pnpm --filter @ponter/desktop build
pnpm --filter @ponter/desktop package
```

Expected in `apps/desktop/dist/`: a file matching `*Setup*.exe` (NSIS) **and** a file matching `*Portable*.exe` (portable), each ≥ 10 KB, and the two are different files.

If a Windows host is unavailable, this step is verified by the CI matrix in Task 3 (the workflow's Windows assert step must be strengthened first — see Task 2 Step 1).

- [ ] **Step 3: Confirm the desktop test count is unchanged**

```bash
pnpm --filter @ponter/desktop test
```

Expected: **15 files / 130 tests**, all passing.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron-builder.yml
git commit -m "build(desktop): give Windows NSIS and portable installers explicit artifact names"
```

---

### Task 2: Split the artifact uploads per format

**Files:**
- Modify: `.github/workflows/build-desktop.yml` (replace the two `Upload artifacts (*)` steps with five single-format steps; strengthen the Windows assert step)

**Interfaces:**
- Consumes: Task 1's `*Setup*.exe` / `*Portable*.exe` names.
- Produces: artifacts `ponter-desktop-linux-deb`, `ponter-desktop-linux-rpm`, `ponter-desktop-linux-appimage`, `ponter-desktop-windows-nsis`, `ponter-desktop-windows-portable`. The `release` job (`merge-multiple: true`) is unchanged and still collects all five.

- [ ] **Step 1: Replace the two upload steps**

In `.github/workflows/build-desktop.yml`, replace the existing `Upload artifacts (Linux)` and `Upload artifacts (Windows)` steps (the block from `- name: Upload artifacts (Linux)` through the end of the Windows upload step's `retention-days: 7`) with these five steps:

```yaml
      - name: Upload artifact — Linux .deb
        if: matrix.os == 'ubuntu-latest'
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-deb
          path: apps/desktop/dist/*.deb
          if-no-files-found: error
          retention-days: 7

      - name: Upload artifact — Linux .rpm
        if: matrix.os == 'ubuntu-latest'
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-rpm
          path: apps/desktop/dist/*.rpm
          if-no-files-found: error
          retention-days: 7

      - name: Upload artifact — Linux .AppImage
        if: matrix.os == 'ubuntu-latest'
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-appimage
          path: apps/desktop/dist/*.AppImage
          if-no-files-found: error
          retention-days: 7

      - name: Upload artifact — Windows NSIS installer
        if: matrix.os == 'windows-latest'
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-windows-nsis
          path: apps/desktop/dist/*Setup*.exe
          if-no-files-found: error
          retention-days: 7

      - name: Upload artifact — Windows portable
        if: matrix.os == 'windows-latest'
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-windows-portable
          path: apps/desktop/dist/*Portable*.exe
          if-no-files-found: error
          retention-days: 7
```

- [ ] **Step 2: Strengthen the Windows assert step**

Replace the body of the existing `Assert installer artifacts (Windows)` step so it asserts **both** `.exe` variants exist (today it only checks that some `.exe` ≥ 10 KB exists, which cannot catch a dropped portable or a collapsed name):

```yaml
      - name: Assert installer artifacts (Windows)
        if: matrix.os == 'windows-latest'
        working-directory: apps/desktop
        shell: pwsh
        run: |
          Write-Host "dist/ contents:"
          Get-ChildItem -Recurse -File dist | Format-Table FullName, Length
          $nsis = Get-ChildItem -File dist -Filter '*Setup*.exe' | Where-Object { $_.Length -ge 10240 }
          $portable = Get-ChildItem -File dist -Filter '*Portable*.exe' | Where-Object { $_.Length -ge 10240 }
          if (-not $nsis) { throw "No NSIS installer (.exe matching *Setup*) found in dist/" }
          if (-not $portable) { throw "No portable build (.exe matching *Portable*) found in dist/" }
          Write-Host "Installer artifact check PASSED (Windows): NSIS + portable present."
```

- [ ] **Step 3: Verify YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-desktop.yml')); print('YAML OK')"
```

Expected: `YAML OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build-desktop.yml
git commit -m "ci(desktop): upload each installer format as its own artifact"
```

---

## Verification & Review Chain (Tasks 1-2)

1. **FE implementer** executes Tasks 1-2 on branch `ci/desktop-artifact-split` (worktree off post-#138 `main`).
2. **BE independent reviewer** — PASS required. Must independently re-derive: (a) each of the 5 upload steps matches exactly one format and cannot match another step's file; (b) the two Windows names are mutually exclusive and deterministic; (c) the `release` job still collects all five installer types via `merge-multiple: true`; (d) the #138 guard + `--publish never` are still present; (e) TEST-INTEGRITY (0 test changes, 130/15 unchanged); (f) attribution (0 trailers).
3. **QA binding verdict** — REQUIRED (CI change). The **discriminating** check is a `workflow_dispatch` with `dry_run=true` against the branch ref (a `pull_request` run is non-discriminating for the #138 publish path, but for *this* change the PR run IS discriminating for artifact production — QA must confirm on the run's artifact list that all 5 named artifacts are present and non-empty, and that the Windows run's assert step passes).
4. **BA docs audit** — only if a `.md` is touched. `apps/desktop/README.md` lists the `dist/` outputs but does not describe CI artifact names; verify no update is required.
5. **PM cross-check** — author, trailers, scope, CI.
6. **Merge** — squash to `main`.

**Acceptance:** on the PR run, the artifact list shows `ponter-desktop-linux-deb`, `ponter-desktop-linux-rpm`, `ponter-desktop-linux-appimage`, `ponter-desktop-windows-nsis`, `ponter-desktop-windows-portable` — 5 artifacts, each non-empty; and on a `workflow_dispatch` non-dry-run the release contains all installer files.

---

## Self-Review

- **Spec coverage:** No spec (bounded CI change). Owner decisions recorded. ✔
- **Placeholder scan:** No TBD/TODO; Tasks 1-2 contain exact YAML and commands. ✔
- **Type consistency:** the `*Setup*.exe` / `*Portable*.exe` tokens produced in Task 1 are matched identically in Task 2 (upload steps + assert step). ✔
- **Review Focus:** each of the 5 failure modes maps to a verification step (focus 1/2/3 → Task 2 Step 2 + QA artifact list; focus 4 → BE item (c); focus 5 → BE item (d)). ✔
