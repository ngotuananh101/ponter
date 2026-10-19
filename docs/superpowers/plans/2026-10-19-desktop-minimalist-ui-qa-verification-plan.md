# QA Verification Plan — Minimalist Desktop UI Architecture (RustDesk/TeamViewer Model)

**Owner:** QA (independent verification)  
**Status:** WRITTEN — NOT EXECUTED. Execution starts on PM's relay of the frozen PR branch.  
**Spec (authority):** `docs/superpowers/specs/2026-10-19-desktop-minimalist-ui-design.md` (PR #163, ADR-85, ADR-86, ADR-88)  
**Baseline commit:** `main` @ `0bf3eeb4f3b37feca83ed712d540fe154c1c10e0` (`0bf3eeb`)  
**Desktop baseline:** 24 test files / 264 passed tests (Vitest)  
**QA Rule:** QA does not merge. QA does not edit production code. All claims must be independently proven by reproduction, execution, and raw logs.

---

## 0. Scope & Verification Strategy

### Purpose
Verify the implementation of the Minimalist Desktop UI Architecture across the Electron desktop client (`apps/desktop`):
1. **BE IPC Extension (Channel 21):** `desktop:open-remote-session` channel registered on `ipcMain`, validating input parameters, verifying safe URL protocols (`http:` and `https:` only), handling subpaths, safely delegating to Electron `shell.openExternal`, and exposing through preload contextBridge (`window.ponter.openRemoteSession`).
2. **FE Two-Column Layout:** Restructure `DevicesView.vue` into a RustDesk / TeamViewer operational model:
   - **Column 1 ("This Device"):** Machine hostname, platform badge (`linux` / `windows`), device ID with clipboard copy, real-time connection status indicator, and master toggle "Allow Remote Access" governing sidecar lifecycle (`AgentControlService`) and persisting sticky preference (`agentAutoStart`).
   - **Column 2 ("Remote Control"):** Partner device ID input, session mode selector (`Desktop` | `Terminal` | `Files`), and primary "Connect" button launching external session.
   - **Bottom Section ("My Devices"):** Compact account fleet ledger featuring 1-click connection and deletion modal.
3. **Zero-Click Onboarding Automation:** Automated background registration applying OS hostname and full capabilities (`['desktop', 'terminal', 'files']`) when `localAgentId` is absent, followed by automated sidecar start when remote access is enabled.
4. **Zero-Storage Compliance (R8):** Absolute zero webview storage (`localStorage` and `sessionStorage`) in desktop renderer views.

---

## 1. Repo-wide & Build Gates

All commands run independently on the frozen head commit from the repository root:

| # | Gate | Command | Pass Criteria |
|---|---|---|---|
| **G1** | Frozen Install | `pnpm install --frozen-lockfile` | Exit 0, lockfile untouched |
| **G2** | Code Formatting | `pnpm format:check` | Exit 0 (`All matched files use Prettier code style!`) |
| **G3** | Linter | `pnpm lint` | Exit 0 (all workspace packages clean) |
| **G4** | Workspace Typecheck | `pnpm typecheck` | Exit 0 (clean across 12 packages, including `vue-tsc`) |
| **G5** | Desktop Standalone Typecheck | `pnpm --filter @ponter/desktop typecheck` | Exit 0 |
| **G6** | Desktop Test Suite | `pnpm --filter @ponter/desktop test -- --run` | 100% passed, 0 failed |
| **G7** | Monorepo Regression Suites | `pnpm --filter @ponter/web test -- --run`<br>`pnpm --filter @ponter/ui-components test -- --run`<br>`pnpm --filter @ponter/api-client test -- --run` | All existing web (344), UI components (14), and API client (36) tests stay green |
| **G8** | Desktop Package Build | `pnpm --filter @ponter/desktop build` | Exit 0, electron-vite bundles `out/main`, `out/preload`, `out/renderer` cleanly |

---

## 2. Dedicated Focus Gates (In-Depth Technical Audits)

### Focus 1: BE IPC Channel 21 (`desktop:open-remote-session`) & Security Contract
**Authority:** Spec §5.1, ADR-85, Sonar S5144 / S2076 / S5334 (SSRF / Scheme Injection)

**Verification Points:**
1. **Channel Registration:**
   - Channel `desktop:open-remote-session` is actively registered on `ipcMain.handle`.
   - Total registered `desktop:*` channels increases from 20 to 21.
2. **Payload Validation:**
   - Parameter extraction safely handles missing, null, empty, whitespace-only, or malformed payloads.
   - Target ID validation: ensures valid string conforming to `^[a-zA-Z0-9_-]{1,64}$`. Disallows path traversal characters (`..`, `/`, `\`), control characters, or script tags.
   - Mode validation: accepts `'desktop' | 'terminal' | 'files'`, defaulting safely to `'desktop'` if unspecified or invalid.
   - Spec/Code Alignment: Supports `agentId` (or `targetId`) seamlessly without runtime undefined errors.
3. **URL Parsing & Protocol White-listing:**
   - Server URL retrieved via `config.load().serverUrl`. Returns `{ ok: false, message: 'Server URL not configured' }` if missing or unconfigured.
   - Protocol assertion: **STRICTLY requires `http:` or `https:` protocol**. Rejects `file:`, `javascript:`, `gopher:`, `data:`, `shell:`, or any unsanctioned schemes with `{ ok: false, message: 'Invalid server URL protocol' }`.
   - Subpath preservation: If server URL is configured with a subpath (e.g. `https://host:8443/prefix`), correctly constructs:
     `https://host:8443/prefix/workspace/${agentId}?mode=${mode}`
4. **External Delegation:**
   - Calls Electron `shell.openExternal(url)` with the fully constructed, sanitized URL.
   - Handles `shell.openExternal` rejections (e.g. no default browser found) gracefully without crashing main process, returning `{ ok: false, message: ... }`.
   - Returns `{ ok: true, url: ... }` on successful delegation.
5. **Preload Context Bridge:**
   - `apps/desktop/src/preload/index.ts` exposes `openRemoteSession(payload)` under `window.ponter`.
   - Preload unit test verifies `ipcRenderer.invoke('desktop:open-remote-session', payload)` mapping.

---

### Focus 2: FE Two-Column Hero Layout (`DevicesView.vue`)
**Authority:** Spec §3.1, §3.2, §3.3, §6.1, §6.2

**Verification Points:**
1. **Layout Structure:**
   - Hero container uses responsive grid (`grid grid-cols-1 md:grid-cols-2 gap-4`).
   - Clean presentation within 800x600 default window geometry without horizontal clipping or scrollbar leakage.
2. **Column 1 ("This Device"):**
   - Displays machine hostname (`localDevice.hostname` or system fallback).
   - Platform badge (`linux` / `windows`) using `@ponter/ui-components` `Badge`.
   - Monospace Device ID (`dev_xxxxxxxx`) with a dedicated "Copy ID" button.
   - Clicking "Copy ID" writes to `navigator.clipboard.writeText` and renders visual confirmation.
   - Real-time status indicator:
     - `connected` / `starting`: Pulsing emerald indicator with "Ready for connections".
     - `disconnected`: Amber indicator with "Connecting to server...".
     - `stopped`: Slate indicator with "Remote access disabled".
     - `error`: Destructive indicator with error summary.
   - Master toggle "Allow Remote Access" (`data-testid="toggle-remote-access"`):
     - Displays current active state of agent sidecar.
     - Toggling ON invokes `window.ponter.startAgent()` and sets `agentAutoStart: true`.
     - Toggling OFF invokes `window.ponter.stopAgent()` and sets `agentAutoStart: false`.
     - Disabled during in-flight start/stop operations.
3. **Column 2 ("Remote Control"):**
   - Partner Device ID input (`data-testid="remote-partner-id"`).
   - Trims whitespace, validates non-empty format.
   - Mode selector (`data-testid="remote-session-mode"`) providing Desktop, Terminal, and Files options.
   - "Connect" button (`data-testid="btn-remote-connect"`):
     - Disabled when partner ID is blank or invalid.
     - On click, dispatches `window.ponter.openRemoteSession({ agentId, mode })`.
     - Surfaces inline error alert if session opening fails.
4. **Bottom Section ("My Devices"):**
   - Renders compact fleet list/table bounded by container height (`max-h-56` or flex scrolling).
   - "This device" badge appears exclusively on the local machine row.
   - 1-click Connect button:
     - Enabled for online peer machines (`device.isOnline === true && device.id !== localAgentId`).
     - Disabled for offline machines and for this machine's own row.
     - On click, dispatches `window.ponter.openRemoteSession` with the target device ID.
   - Delete action:
     - Triggers standard `AlertDialog` confirmation modal before deleting.
     - Deleting this device clears `localAgentId` and halts sidecar execution.

---

### Focus 3: Zero-Click Onboarding Automation
**Authority:** Spec §4.1

**Verification Points:**
1. **Silent Background Registration:**
   - In `onMounted()`, checks `window.ponter.getLocalAgentId()`.
   - When `localAgentId === null`:
     - Dispatches silent registration via `store.register(['desktop', 'terminal', 'files'])`.
     - Sets device hostname automatically from system environment.
     - Saves generated credentials in keychain (`safeStorage`) and `localAgentId` in `config.json`.
     - Updates UI to display the new local device ID.
   - Does NOT block user from operating the "Remote Control" panel while registration is in progress.
2. **Automated Sidecar Launch:**
   - When `agentAutoStart !== false` (default for new installations):
     - Automatically invokes `window.ponter.startAgent()` following registration or on initial mount.
     - Verifies sidecar binary, manages 2000ms health grace period, and transitions runtime status to connected.
3. **Error Isolation:**
   - Registration failures (e.g. offline server, network timeout, `AGENT_LIMIT_REACHED`) are trapped cleanly.
   - Displays dismissible alert; does not trigger crashloops or freeze the application.

---

### Focus 4: Zero-Storage Gate (R8 Storage Constraint)
**Authority:** ADR-85, Memory Rule `R8 storage gate BINDING`

**Verification Points:**
- Execution of `DevicesView.vue` must produce **ZERO** entries in renderer `localStorage` and `sessionStorage`.
- Automated test assertion in `devices.test.ts`:
  ```ts
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  ```
- All configuration and persistence must route exclusively through IPC handlers to `config.json` and system keychain.

---

### Focus 5: SonarCloud Quality & Security Hotspots Audit
**Authority:** SonarCloud integration rules, project key `ngotuananh101_ponta-remote3`

**Verification Points:**
1. **SSRF / URL Injection (typescript:S5144):**
   - Verify `shell.openExternal` call site in `apps/desktop/src/main/ipc.ts` parses and asserts URL protocols prior to invocation.
   - Validate that no unvalidated protocol or arbitrary string can be passed to the system shell.
2. **Code Duplication & Cognitive Complexity:**
   - Verify 0.0% code duplication in new desktop routines.
   - Verify cognitive complexity remains below threshold for IPC handler and component script.
3. **Quality Gate Status:**
   - SonarCloud Code Analysis GitHub Action check must report **PASSED** with 0 open security hotspots, 0 vulnerabilities, 0 bugs, and 0 code smells on new code.

---

### Focus 6: TEST-INTEGRITY Audit
**Authority:** `test-integrity-rule.md`

**Baseline Comparison (vs `main` @ `0bf3eeb`):**
- Monorepo Baseline:
  - `apps/desktop`: 24 test files / 264 tests (Vitest)
  - `apps/web`: 42 test files / 344 tests (Vitest)
  - `packages/ui-components`: 3 test files / 14 tests (Vitest)
  - `packages/api-client`: 9 test files / 36 tests (Vitest)
- Test Integrity Criteria:
  - **Zero tests deleted.**
  - **Zero tests skipped, commented out, or marked `.todo` / `.only`.**
  - **Zero assertions weakened or relaxed.**
  - Net increase in desktop tests: **Target ≥ +25 new tests** across:
    * `apps/desktop/src/main/__tests__/ipc.test.ts` (at least +14 tests for channel 21)
    * `apps/desktop/src/preload/__tests__/preload.test.ts` (+1 test for bridge)
    * `apps/desktop/src/renderer/__tests__/devices.test.ts` (at least +10 tests for 2-column layout, zero-click onboarding, auto-start toggle, and quick connect)
  - If existing test assertions in `devices.test.ts` are updated due to UI restructuring (e.g. removing manual capability checkboxes), every single modification must be audited before/after with exact line diffs and functional justification.

---

### Focus 7: Commit Attribution & Technical Language Standards
**Authority:** `commit-author-attribution-rule.md`, `docs-standardize-all-english-merged.md`

**Verification Points:**
1. **Git Author:** 100% of commits authored by `Ngo Tuan Anh <ngotuananh2101@gmail.com>`.
2. **Trailers:** **STRICT ZERO `Co-authored-by` or AI trailers** in any commit message.
3. **Character Set:** **STRICT ZERO Vietnamese characters (U+00C0–U+1EF9)** in code files, tests, commit messages, or technical documentation.
4. **Documentation:** 100% technical English across all commit messages, PR descriptions, and markdown documentation.

---

## 3. QA Sign-Off Decision Matrix

| Gate | Scope | Required Outcome |
|---|---|---|
| **Repo G1–G5** | Build, format, lint, typechecks | 100% Clean (Exit 0) |
| **Repo G6–G8** | Desktop suite & monorepo regression suites | 100% Green, desktop build passes |
| **Focus 1** | IPC Channel 21 (`desktop:open-remote-session`) | 14+ unit tests pass, URL/protocol injection verified safe |
| **Focus 2** | Two-Column Hero Layout | Verified: "This Device" + "Remote Control" + "My Devices" |
| **Focus 3** | Zero-Click Onboarding | Verified: silent registration + auto-start |
| **Focus 4** | Zero-Storage Gate (R8) | 0 entries in `localStorage` & `sessionStorage` |
| **Focus 5** | SonarCloud Quality Gate | OK, 0 Security Hotspots, 0.0% Duplication |
| **Focus 6** | TEST-INTEGRITY | Net positive test count, 0 deleted/weakened tests audited |
| **Focus 7** | Attribution & Standards | Ngo Tuan Anh, 0 trailers, 0 Vietnamese characters |

**Final Binding Outcome:** QA will issue `RECOMMEND MERGE (unconditional)` only when all gates above are independently proven and GitHub Actions CI matrix is 100% green.
