# Electron Desktop Migration — Design Spec

- **Status:** Draft (ready for owner review)
- **Phase:** Desktop Shell Re-platform (Electron + shared Vue/shadcn design system)
- **Date:** 2026-10-14
- **Supersedes:** ADR-79 (Native egui/eframe Desktop Shell)
- **Related ADRs:** ADR-52 (OS keychain), ADR-55 (in-process agent runtime), ADR-64/65 (desktop config), ADR-66 (startup-flash gate), ADR-67 (build-time default server URL), ADR-69..72 (desktop/web UI parity), ADR-80 (minisign self-updater), ADR-81 (independent tray), ADR-82 (push-primary fleet)
- **Related Files:** `apps/desktop/**`, `apps/agent/**`, `apps/web/**`, `packages/ui-components/**`, `packages/desktop-core/**`, `.github/workflows/build-desktop.yml`, `docs/ARCHITECTURE.md`, `docs/guides/{self-hosting,development,deployment}.md`

---

## 1. Context & Motivation

The current desktop client (`apps/desktop`) is a pure-Rust `egui`/`eframe` shell (ADR-79). It ships a small (~27.5 MB) binary with no webview or Node runtime, and it hosts the `ponter-agent` runtime **in-process** (ADR-55), keeps the refresh token in the OS keychain (ADR-52), self-updates via a minisign-verified updater (ADR-80), runs a tray on an independent thread (ADR-81), and consumes fleet push over WebSocket (ADR-82).

The owner's requirement has changed: the desktop UI must look like the **web UI** and **reuse the Vue 3 + shadcn-vue design system**, with **minimal custom UI**. On Linux, Tauri cannot bundle a webview (it uses the system WebKitGTK package), so a Tauri path would not run consistently across machines. The owner therefore chose **Electron** — the one option that truly bundles its webview (Chromium) so the app runs everywhere, accepting a large installer.

**The Goal:** Replace `apps/desktop` with an Electron application whose renderer is Vue 3 built on the **shared** `@ponter/ui-components` design system, so web and desktop are visually identical and share as much UI code as possible; the Rust `ponter-agent` becomes a bundled **sidecar** process; and all native capabilities (keychain, config, updater, tray, autostart, single-instance) move to Electron's native APIs.

---

## 2. Locked Owner Decisions

The following decisions were approved by the owner and are non-negotiable:

1. **Electron, not Tauri.** The desktop shell becomes an Electron app that bundles its own webview (Chromium) and runs on Linux and Windows.
2. **Full replacement.** `apps/desktop` is replaced entirely — the `egui`/`eframe` shell, its ~164 Rust tests, and its native Rust modules are removed. There is no parallel `egui` app.
3. **Agent as a sidecar.** Electron cannot embed the Rust runtime in-process. The `ponter-agent` CLI is spawned and supervised as a child process; the agent binary is **bundled into the installer** (CI builds it on the same runner).
4. **Electron owns all native features.** Tray, autostart, keychain, single-instance, and the updater are Electron's responsibility. Rust is only the agent binary.
5. **UI source: shared design system.** The desktop renderer is written against the shared shadcn-vue primitives, and the web UI is reviewed so both apps draw on a single design layer.
6. **Maximum sharing with minimal web risk.** Design tokens and environment-independent presentational components are lifted into the shared package; the shell and stores stay per-app.
7. **Support matrix unchanged:** Linux (x86_64) and Windows (x86_64) (ADR-78). No macOS.

---

## 3. Architecture Decisions

### ADR-85: Electron Desktop Shell (supersedes ADR-79)

- **Decision:** Replace the `egui`/`eframe` shell with an Electron application in `apps/desktop`. The main process (Node ESM) owns the window, native integrations, and the agent sidecar; the renderer is a Vue 3 + Vite app; a preload script exposes a typed `contextBridge` surface. Renderer security is `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, with a strict CSP.
- **Rationale:** Electron bundles Chromium, so the same binary runs on every Linux/Windows host without a system webview dependency, and the renderer can reuse the project's existing Vue + shadcn-vue stack verbatim.
- **Alternatives Rejected:**
  - *Tauri with bundled WebView2:* Rejected — Tauri can pin WebView2 on Windows but **not** on Linux (it uses the system WebKitGTK), so it fails the "runs everywhere including Linux" goal.
  - *Tauri with system webview:* Rejected for the same reason plus inconsistent rendering across distros.
  - *Keep egui:* Rejected — the owner requires web-UI parity and reuse, which a Rust immediate-mode GUI cannot provide.

### ADR-86: Agent as a Supervised Sidecar

- **Decision:** The Electron main process spawns `ponter-agent` as a child process and supervises it (spawn, health-watch, stop, restart with bounded backoff). Configuration is passed via the same environment variables the CLI already accepts (`AGENT_ID`, `AGENT_SERVER`, `AGENT_CREDENTIAL`, `AGENT_IDENTITY_PATH`, `AGENT_SHELL`, `AGENT_ALLOW_INPUT`, `AGENT_FILES_ROOT`, STUN, desktop profile/source). The agent crate (`apps/agent`) is **not modified** in this migration.
- **Rationale:** The agent's runtime is already a library plus a thin CLI (ADR-50). Spawning the CLI preserves every behavior (Wayland input, three-tier capture, shell policy) with zero code change, and keeps a process boundary that isolates a capture/PTY crash from the UI.
- **Alternatives Rejected:**
  - *Add a JSON-RPC/stdio control protocol to the agent now:* Rejected as YAGNI — v1 needs only spawn/stop/health. A control protocol is a follow-up if the UI needs live agent telemetry.
  - *Node native addon wrapping the Rust lib:* Rejected — heavier build (N-API) and it re-introduces in-process coupling that the sidecar removes.

### ADR-87: electron-updater Replaces the minisign Self-Updater (amends ADR-80)

- **Decision:** Auto-update is handled by `electron-updater` against a release feed (`latest.yml`), replacing the minisign manifest (`latest.json`) and `self_replace`. The existing GitHub Releases pipeline keeps producing per-platform installers; the updater manifest format changes from the Tauri-compatible `latest.json` to electron-builder's `latest.yml`.
- **Rationale:** Electron's packaging toolchain and updater are a single coherent unit; `electron-updater` verifies the downloaded artifact and applies it per platform without a bespoke self-replace step.
- **Alternatives Rejected:**
  - *Keep minisign + self_replace:* Rejected — Electron apps are packaged by electron-builder; maintaining a second, non-native updater adds divergence with no benefit.
  - *No auto-update:* Rejected — it is an existing product capability.

### ADR-88: Shared Design Tokens and Presentational Components

- **Decision:** The design layer is extracted into `@ponter/ui-components` as the single source of truth: a `styles/tokens.css` file holding every CSS custom property, `@theme` mapping, base layer, and font import (lifted **verbatim** from `apps/web/src/style.css`), plus an `app/` directory of environment-independent presentational components and a storage-agnostic `useTheme` composable. Both `apps/web` and the Electron renderer import this shared layer. The app shell (header, layout, routing) and state stores remain per-app.
- **Rationale:** Today `apps/web` and the desktop client share only primitives; tokens and theme logic live in `apps/web` alone, so there is no shared design layer. Lifting tokens and pure presentational components makes "desktop looks like web" a structural guarantee rather than a manual copy, while keeping environment-bound code (stores, shell) out of the shared package.
- **Alternatives Rejected:**
  - *Share tokens only:* Rejected by owner — leaves presentational components duplicated and drift-prone.
  - *Share the whole web app (`apps/web`) as the desktop renderer:* Rejected — the web app is coupled to `vue-router`, localStorage token storage, and a runtime `/config.js` URL that are meaningless in the desktop's keychain/IPC environment; it would force both environments into one shell.
  - *Extract a full `packages/desktop-views` shared by both apps:* Rejected as the largest refactor with the highest blast radius on a shipping web app; the `app/` presentational directory achieves most of the sharing with a smaller surface.

### Amended ADRs (no decision reversal, environment substitution only)

- **ADR-52 (Keychain):** `keyring` → Electron `safeStorage` (DPAPI on Windows, Secret Service/libsecret on Linux). The secret never reaches the renderer.
- **ADR-55 (Agent runtime):** in-process → sidecar (see ADR-86). The *capability* is unchanged.
- **ADR-64/65 (Config):** `config.json` keeps the same path (`com.ponter.desktop`) and the same non-secret contents; the main process reads/writes it.
- **ADR-81 (Tray):** `ksni`/`tray-icon` → Electron `Tray`.
- **ADR-82 (Fleet push):** Rust WS client → main-process WebSocket via `@ponter/desktop-core`.

---

## 4. Target Structure

### 4.1 `apps/desktop` (Electron application)

```
apps/desktop/
├── package.json                 @ponter/desktop (private, type: module)
├── electron.vite.config.ts      builds three targets: main / preload / renderer
├── electron-builder.yml         packaging, updater feed, extraResources (agent binary)
├── tsconfig.json / tsconfig.node.json
├── components.json              shadcn-vue config, aliases to @ponter/ui-components
├── index.html                   renderer entry + strict CSP
├── icons/
├── resources/
│   └── ponter-agent             (built by CI, copied into the app bundle)
└── src/
    ├── main/                    Electron main process (Node ESM)
    │   ├── index.ts             lifecycle, single-instance lock, app ready
    │   ├── window.ts            BrowserWindow + webPreferences + CSP
    │   ├── ipc.ts               typed ipcMain handlers
    │   ├── keychain.ts          safeStorage-backed secret store (set/get/delete)
    │   ├── config.ts            config.json read/write (same path as today)
    │   ├── session.ts           login / refresh (via @ponter/desktop-core)
    │   ├── devices.ts           register / list / delete (via @ponter/desktop-core)
    │   ├── fleet.ts             fleet push WS + polling fallback (ADR-82)
    │   ├── agent-supervisor.ts  spawn/supervise ponter-agent; health + restart
    │   ├── tray.ts              Electron Tray + context menu
    │   ├── autostart.ts         app.setLoginItemSettings
    │   └── updater.ts           electron-updater check/apply
    ├── preload/
    │   └── index.ts             contextBridge → window.ponter (typed)
    ├── renderer/                Vue 3 + Vite
    │   ├── App.vue              startup-flash gate (ADR-66) + route switch
    │   ├── main.ts              createApp + Pinia
    │   ├── style.css            @import '@ponter/ui-components/styles/tokens.css'
    │   ├── views/               ServerSetup, Login, Wizard, Devices
    │   ├── stores/              config, auth, wizard, devices (Pinia)
    │   └── composables/         theme adapter over IPC
    └── shared/
        └── ipc-types.ts         IPC contract shared by main and renderer
```

### 4.2 `packages/ui-components` (shared design layer)

```
packages/ui-components/src/
├── styles/
│   └── tokens.css               NEW — verbatim extraction of apps/web/src/style.css
├── components/
│   ├── ui/**                    shadcn-vue primitives (unchanged)
│   └── app/**                   NEW — presentational components (props/emits only)
└── composables/
    └── useTheme.ts              NEW — theme state + storage adapter
```

- `apps/web/src/style.css` reduces to `@import '@ponter/ui-components/styles/tokens.css';` plus its `@source` line. No visual change.
- The desktop renderer imports the same `tokens.css` and the same primitives/components.

---

## 5. Native Capability Migration

| Capability | Current (Rust egui) | Electron |
|---|---|---|
| Agent runtime (ADR-55) | in-process `AgentRuntime::start` | sidecar `ponter-agent` (spawn + supervise) |
| Keychain (ADR-52) | `keyring` crate | `safeStorage` |
| Config (ADR-64/65) | `config.json` at `com.ponter.desktop` | same path, main process |
| Updater (ADR-80) | minisign + `self_replace` | `electron-updater` (+ `latest.yml`) |
| Tray (ADR-81) | `ksni` / `tray-icon` | Electron `Tray` |
| Autostart | registry / `.desktop` | `app.setLoginItemSettings` |
| Single-instance | `single-instance` crate | `app.requestSingleInstanceLock` |
| Fleet push (ADR-82) | Rust WS client | main-process WS via `@ponter/desktop-core` |
| Auth / Devices | `core/auth.rs`, `core/devices.rs` | main via `@ponter/desktop-core` HTTP |

### 5.1 Agent sidecar contract (v1)

- **Spawn:** main process spawns the bundled `ponter-agent` with an environment assembled from stored settings: `AGENT_ID` (the registered device id), `AGENT_SERVER` (WS URL derived from the server URL — the existing `derive_ws_url` rule), `AGENT_CREDENTIAL` (from keychain), `AGENT_IDENTITY_PATH`, `AGENT_ALLOW_INPUT` (the input gate), `AGENT_FILES_ROOT` (files gate), plus STUN and desktop profile/source defaults.
- **Health:** "running" = child process alive. The main process watches `exit` and applies bounded-backoff restart. Agent stdout/stderr are captured and surfaced as the last log line.
- **Stop:** SIGTERM on Unix / taskkill on Windows, with a kill fallback.
- **No protocol:** v1 has no stdin/stdout control channel. If the UI later needs live agent telemetry, a control protocol is a separate change.

---

## 6. Shared Design Layer

### 6.1 Tokens

`packages/ui-components/src/styles/tokens.css` contains, unchanged from `apps/web/src/style.css`:

- the Inter/JetBrains Mono font `@import`,
- `@import 'tailwindcss'`, `@import 'tw-animate-css'`, `@import 'shadcn-vue/tailwind.css'`,
- the `@theme inline` color/radius mapping,
- the `:root` and `.dark` custom-property blocks (oklch palette, sidebar, chart, `--terminal-bg`, `--radius`, `--header-height`),
- the `@layer base` rules, and
- the additive brand palette `@theme`.

The extraction is **verbatim** so that `apps/web` renders byte-identically. `apps/web` keeps its `@source "../../../packages/ui-components/src";` line (it must still scan the shared sources for classes).

### 6.2 Theme composable

`useTheme` is a shared composable that owns theme state (`light` | `dark`), computes `isDark`, and applies the `.dark` class. It takes a **storage adapter** so the backing store is injectable:

- web adapter → `localStorage` (current behavior),
- desktop adapter → IPC to `config.json` through the main process (satisfies the R8 "no webview storage for config" rule).

The composable's logic is identical for both; only the adapter differs.

### 6.3 Presentational components

Components may be lifted to `components/app/**` only when they are **environment-independent**: they communicate purely through props/emits and do not import a store, `vue-router`, or an API client. Candidates: `LoginForm`, `RegisterAgentDialog`, `DeleteAgentDialog`, `EditAgentDialog`, `ResetIdentityKeyDialog`, device/agent cards, badges, and similar. The app shell (`AppHeader`, `AppLayout`), routing, and stores stay per-app.

---

## 7. Packaging & Release

- **electron-builder** produces: Linux AppImage, `.deb`, `.rpm`; Windows NSIS and portable `.exe`. The `ponter-agent` binary is added via `extraResources` and resolved at runtime from `process.resourcesPath`.
- **Auto-update:** `electron-updater` reads `latest.yml` from GitHub Releases. The release workflow publishes installers plus `latest.yml`.
- **Identifiers:** app id `com.ponter.desktop`, product name "Ponter Desktop", version from the same source as today.

---

## 8. CI

`build-desktop.yml` is rewritten:

1. Matrix: `ubuntu-latest`, `windows-latest`.
2. Steps: checkout → Node 24 + pnpm → install → **build `ponter-agent` (Rust)** → build renderer + main (electron-vite) → **Vitest (renderer + main)** and **`cargo test` (agent)** → `electron-builder` → upload artifacts.
3. **Removed:** `cargo deb`/`cargo generate-rpm`, `cargo wix`, NSIS-via-chocolatey, `appimagetool`, the minisign signing step, the `latest.json` assembly, and the **"no webview/GTK/Qt in the dependency graph" guard** (Electron intentionally ships Chromium).

---

## 9. Testing

- **Renderer:** Vitest + `@vue/test-utils` + happy-dom. The ~1815 lines of legacy Vue desktop tests (recoverable from `git show fc4754b^:apps/desktop/src/__tests__/`) are ported and adapted to the new IPC surface.
- **Main:** Vitest for pure logic — config read/write shape, updater decision (`should_apply`), agent-supervisor argument/env assembly, server-URL derivation, devices error mapping.
- **Agent:** the existing `cargo test` suite is retained unchanged.
- **Shared package:** `@ponter/ui-components` gains tests for the `useTheme` composable (both adapters) and any lifted presentational component.

### 9.1 TEST-INTEGRITY declaration

Replacing the egui shell **removes ~164 Rust unit tests** from `apps/desktop`. This is declared explicitly:

- **Before:** `apps/desktop` egui suite ≈ 164 Rust tests.
- **After:** the same behavioral coverage is re-established as Vitest tests in `apps/desktop` (renderer + main), ported from the legacy Vue suite plus new main-process tests; the agent's Rust tests are untouched.
- **Reason:** the tests are removed **together with the code they test** (the egui shell is deleted). No test is skipped or weakened; coverage moves to the new stack. The exact before/after `it()`/`expect()` counts are pinned in the implementation plan.

---

## 10. Risks & Trade-offs

- **Installer size ~150–250 MB** (owner-accepted): Chromium + Node + the agent binary.
- **Chromium CVE surface:** Electron must be version-pinned and watched with Dependabot; this is the cost of bundling a real webview.
- **One-time manual upgrade:** an installed minisign-updated egui build cannot auto-update to the Electron build; users reinstall once.
- **Two runtimes** (Node + Rust sidecar): packaging and CI are heavier (Chromium download per OS, agent build).
- **ADR-79 reversal:** the "~27.5 MB, zero webview/Node" advantage is lost; regained as web-UI parity and reuse.
- **Web app touched:** mitigated by extracting tokens **verbatim** (no visual change) and adding rather than moving primitives; the web app's runtime code (stores, router, `/config.js`) is unchanged.

---

## 11. Out of Scope

- macOS support (ADR-78).
- Changing the `ponter-agent` crate or its CLI surface.
- A live agent control/telemetry protocol (follow-up if needed).
- Changing the server, signaling, WebRTC, E2EE, or file-transfer protocols.
- Redesigning the web UI beyond the token extraction and component lifting.
