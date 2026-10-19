# QA Independent Verification Plan: Desktop Vertical Scrolling & System Tray Minimize

**Initiative:** Desktop App Usability & Lifecycle Hardening (Vertical Scrolling & Tray Minimize on Close)  
**Authority:** Owner approved scope (2026-10-19)  
**Target Package:** `apps/desktop`  
**Base:** `main` @ `caa6205`  
**Branch:** `feat/desktop-scroll-and-tray-minimize`  
**Verifier:** QA (independent binding verification)

---

## 1. Executive Summary & Objective

This plan establishes the independent verification criteria and automated test matrices for two critical usability and lifecycle enhancements in the Ponter Desktop App (`apps/desktop`):

1. **FE Layout Vertical Scrolling:**
   Ensure the renderer layout adapts smoothly when view height exceeds the application window boundaries (default 800x600, minimum 480x500, or when the account fleet contains numerous devices). The shell and inner views must provide clean vertical scrolling without content clipping or horizontal overflow.
2. **BE Window Close 'X' Minimize to System Tray:**
   Ensure clicking the standard window close button ('X') hides the window to the System Tray instead of terminating the process. The local agent sidecar and background fleet connection must continue operating uninterrupted. The window must restore cleanly on tray click, tray menu "Show Window", and secondary instance activation. Full application termination must occur strictly when "Quit" is chosen from the tray context menu or during system shutdown.

---

## 2. Repo-Wide Quality & Security Gates (Mandatory G1–G8)

| Gate | Check | Command | Pass Criteria |
|---|---|---|---|
| **G1** | Formatter | `pnpm format:check` | Exit 0, 100% conformant with Prettier |
| **G2** | Typecheck | `pnpm --filter @ponter/desktop typecheck` | Exit 0, 0 TypeScript errors across Node & Web |
| **G3** | Desktop Unit Tests | `pnpm --filter @ponter/desktop test -- --run` | Exit 0, 100% passed (baseline: 24 files / 287 tests) |
| **G4** | Regression Suite | `pnpm test` (monorepo packages) | Exit 0, Web (344), UI Components (14), API Client (36) green |
| **G5** | Desktop Build | `pnpm --filter @ponter/desktop build` | Exit 0, bundles main, preload, and renderer cleanly |
| **G6** | SonarCloud QG | `mcp_sonarqube_get_project_quality_gate_status` | Status `OK`, new code duplication `<= 3.0%`, 0 open issues |
| **G7** | TEST-INTEGRITY | Diff audit of all `it()` and `expect()` counts | 0 tests deleted, 0 tests skipped, 0 tests weakened |
| **G8** | Attribution & Lang | Git log & diff audit | Author `Ngo Tuan Anh`, 0 AI trailers, 0 Vietnamese chars in code |

---

## 3. Specialized Focus Verification Gates

### Focus 1: FE Responsive Vertical Scrolling Layout

#### Target Files:
- `apps/desktop/src/renderer/App.vue`
- `apps/desktop/src/renderer/style.css`
- `apps/desktop/src/renderer/views/DevicesView.vue` (and related views)

#### Verification Criteria:
1. **Container Overflow:**
   - App shell (`[data-testid="app-shell"]`) must support vertical scrolling when content exceeds viewport height.
   - No top-clipping caused by rigid flex centering (`items-center` without scroll clearance).
   - Horizontal scrolling must remain suppressed (`overflow-x-hidden`).
2. **Compact Viewport Compatibility (480x500 & 800x600):**
   - Header, two-column hero cards ("This Device" and "Remote Control"), and bottom fleet ledger ("My Devices") remain reachable via vertical scroll.
   - Dialog modals (`AlertDialog`, etc.) remain centered and operable within the scrollable viewport.
3. **Automated Test Coverage:**
   - Unit tests in `app.test.ts` or view tests asserting scrollable container attributes or styling classes.

---

### Focus 2: BE Window Close 'X' Minimize to System Tray

#### Target Files:
- `apps/desktop/src/main/window.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/tray.ts`

#### Verification Criteria:
1. **Window Close Interception:**
   - Window `'close'` event must check an `isQuitting` flag.
   - When `isQuitting === false`:
     * Calls `event.preventDefault()`.
     * Calls `window.hide()`.
     * Does NOT emit `'closed'` or trigger `'window-all-closed'`.
     * App process does NOT terminate.
2. **Sidecar Continuity:**
   - Agent sidecar process remains running in the background when the window is hidden.
   - `AgentSupervisor` status remains intact; tray status menu reflects live state (`Agent: connected` / `Agent: starting` / etc.).
3. **Window Restoration Mechanisms:**
   - **Tray Click:** Left-clicking tray icon restores window from hidden/minimized state and grants focus.
   - **Tray Context Menu:** Clicking "Show Window" restores window and brings to foreground.
   - **Second Instance Launch:** Launching a second application executable triggers `app.on('second-instance')`, restoring existing window and focusing it.
4. **Clean Application Termination:**
   - Selecting "Quit" from the Tray context menu sets `isQuitting = true` and calls `app.quit()`.
   - `before-quit` lifecycle handler properly awaits `agentControl.stop()`, cleans up `fleet`, destroys `tray`, and closes the window.

---

## 4. TEST-INTEGRITY Baseline & Accounting Matrix

| Test File | Baseline `it()` | Baseline `expect()` | Expected Delta | Focus |
|---|---|---|---|---|
| `apps/desktop/src/renderer/__tests__/app.test.ts` | 9 | 24 | $\ge 0$ | Scrollable container styling & structure |
| `apps/desktop/src/main/__tests__/window.test.ts` | 2 | 6 | $+2$ to $+4$ | Close interception, hide on close, restore |
| `apps/desktop/src/main/__tests__/tray.test.ts` | 10 | 25 | $\ge 0$ | Restore delegation & quit lifecycle |
| **Total Desktop Suite** | **287 passed** | **--** | **Net positive** | Zero test deletions |

---

## 5. Execution Protocol

1. **FE Review & Verification:**
   - Monitor `feat/desktop-scroll-and-tray-minimize` commits from FE.
   - Run Vitest renderer suite and inspect CSS / DOM structure for scroll compliance.
2. **BE Review & Verification:**
   - Monitor subsequent commits from BE implementing window close interception and second-instance handling.
   - Run Vitest main process suite (`window.test.ts`, `tray.test.ts`, `index.ts`).
3. **Integrated SonarCloud Quality Gate:**
   - Query SonarCloud MCP to verify 0 code smells, 0 ReDoS issues, and duplication `<= 3.0%`.
4. **CI Matrix Tracking:**
   - Monitor GitHub Actions `build-desktop.yml` across Ubuntu and Windows runners.
5. **Final Binding Report:**
   - Deliver unconditional `RECOMMEND MERGE` once all G1–G8 gates pass.
