# Native Desktop Shell (Rust + egui) — Design Spec

- **Status:** Draft (under owner review)
- **Phase:** Post-Phase-8 — native desktop re-architecture (item B of the
  desktop workstream; item C is the viewer).
- **Owner decisions (locked 2026-10-13):**
  1. GUI toolkit = **egui / eframe** — pure Rust, no webview, no GTK, no Qt.
  2. Scope = the **full shell** (Login, Server Setup, Wizard, Devices,
     Settings). **No viewer** — the remote-desktop viewer is item C.
  3. The shell's logic is **Rust-ified**: the TypeScript packages stay as they
     are and remain web-only; the desktop app does not import them.
  4. Auto-update = **Rust self-update with minisign**, reusing the existing
     updater public key and the existing `latest.json` manifest format.
  5. `apps/desktop/` is **replaced in place** by a Rust-only crate named
     `ponter-desktop`.
  6. Supported platforms = **Windows + Linux** (ADR-78; macOS already dropped).
- **Related:** `apps/desktop/src-tauri/**` (the Tauri app being replaced),
  `apps/desktop/src/**` (the Vue UI being replaced), `apps/agent/**` (the
  `ponter-agent` crate the shell hosts), `packages/desktop-core`,
  `packages/ui-components`, `apps/web/src/stores/terminal.ts`,
  `.github/workflows/build-desktop.yml`, `.github/workflows/ci-node.yml`,
  `docs/ARCHITECTURE.md` §3 / §8, ADR-50..58, ADR-64..68, ADR-78.

---

## 1. Context & Motivation

The desktop app shipped in Phase 7 is a **Tauri v2** application: a Rust backend
(`apps/desktop/src-tauri`) plus a **Vue 3 webview frontend**
(`apps/desktop/src`). It works, but the stack carries two structural costs:

1. **A webview + WebKitGTK on the critical path.** Every Linux build links
   `libwebkit2gtk-4.1`, `libgtk-3`, and `libayatana-appindicator3` (see the
   Linux system-deps step in `build-desktop.yml`). The webview is the single
   heaviest runtime dependency in the repository, it is the only reason the
   desktop app has a JavaScript build (`vue-tsc` + Vite) at all, and it drags in
   a second language toolchain and a second test framework (Vitest) purely for
   an operator-facing shell that renders five screens.
2. **A split-brain logic surface.** The shell's behaviour lives in two places:
   Rust (`src-tauri/src`) for everything privileged, and TypeScript
   (`src/stores`, `src/views`) for state, routing, and error classification.
   The frontend/backend contract is a set of 16 `invoke` command names plus a
   `runtime-status` event, duplicated as string constants on both sides
   (`AUTH_FAILED_PREFIX`, `REFRESH_FAILED_PREFIX`, the `connected`/`disconnected`/
   `stopped` wire keys). Every behavioural change touches both languages.

The owner's decision is to **collapse the shell into a single Rust application
built on `egui`/`eframe`**: an immediate-mode GUI that is pure Rust, links no
webview, no GTK, and no Qt, and removes the JavaScript build and test surface
from `apps/desktop` entirely.

This is **not** a rewrite of the runtime. The `ponter-agent` crate
(`AgentRuntime`, `RuntimeHandle`, `RuntimeStatus`, `RuntimeConfig`,
`probe_capture`, `identity::AgentIdentity`, `logging::init`, `DesktopSource`,
`StreamProfile`) is already a library and is reused verbatim — the shell
**hosts** the runtime exactly as the Tauri app does today. The server API is
unchanged. What changes is the presentation and orchestration layer: Vue →
egui, `invoke` commands → direct Rust calls, the Tauri updater plugin → a Rust
self-updater.

**Goal:** a single-binary, webview-free desktop shell — the same five screens
with the same behaviour and the same security posture — that builds with one
toolchain (Rust), ships the same native artifacts, and keeps the existing
updater key and manifest so updates keep flowing.

---

## 2. Scope

### In scope

- A new Rust-only crate `ponter-desktop` replacing `apps/desktop/` in place.
- The five shell screens: **Server Setup, Login, Wizard, Devices, Settings**.
- The core logic they need, ported from `src-tauri/src` into GUI-free modules:
  persisted config, keychain access, login/refresh/retry HTTP, device
  registration/listing/deletion, wizard probes, autostart, agent lifecycle
  hosting, and the self-updater.
- The **tray icon** and its menu (Start/Stop agent, Open window, Open at login,
  Quit) with the runtime's three honest states.
- A **Rust self-updater** that verifies a minisign signature before replacing
  the running binary, reusing the existing public key and `latest.json` format.
- `build-desktop.yml` rewritten for a Rust binary; `ci-node.yml` de-triggered
  for `apps/desktop`.
- Deletion of the Vue app, the Tauri backend, and their build/test config.

### Out of scope (explicit non-goals)

- **No viewer (item C).** The shell does not render a remote desktop, does not
  open WebRTC sessions, and adds no video/decoder path. The `egui` texture
  plumbing for a future viewer is **not** built here; item C is a separate spec.
- **No macOS.** Windows + Linux only (ADR-78). No `#[cfg(target_os = "macos")]`
  anywhere in the new crate.
- **No changes to `apps/web`.** The web client is untouched. Its use of
  `@ponter/desktop-core` (`apps/web/src/stores/terminal.ts`) is unaffected.
- **No changes to `apps/agent`.** The `ponter-agent` crate is consumed as-is; no
  new public API, no new feature flag, no behavioural change.
- **No changes to `apps/server`.** No new endpoints, columns, or migrations.
  The shell calls the endpoints that already exist. This includes the **existing**
  WebSocket endpoints the shell now consumes for fleet updates —
  `POST /api/ws/ticket` and the `/api/ws/browser` upgrade
  (`apps/server/src/routes/ws.ts`, mounted in `apps/server/src/index.ts`) — which
  already emit `fleet-changed` to subscribed browser sockets. The shell adds no
  endpoint; it is a new *consumer* of the ones that exist (§5.2, §5.5).
- **No changes to the TypeScript packages' role.** `packages/desktop-core` and
  `packages/ui-components` stay exactly as they are. They are already web-only
  in practice (`desktop-core` is imported only by `apps/web`; `ui-components`
  is imported only by `apps/web` and the desktop app's Vue alias, which this
  spec deletes). Removing the desktop Vue app does not orphan either.
- **No new server-facing protocol.** Login, refresh, device CRUD, and the
  agent's WS connect are the same wires as today.
- **No re-solve of platform capture limitations.** Wayland portal dependency,
  the Windows WGC/DXGI/GDI fallback, and musl terminal-only builds are inherited
  from `ponter-agent` unchanged.
- **No mobile.** `apps/mobile` stays a stub.

---

## 3. Architecture Decisions

Four new ADRs. They are **proposed here** and recorded in
`docs/ARCHITECTURE.md` §8 when the implementation lands (the repo keeps ADRs
inline in that file).

### ADR-79: The desktop shell is a single Rust application on egui/eframe

- **Decision.** `apps/desktop/` becomes a single Rust crate, `ponter-desktop`,
  whose GUI is **egui** driven by **eframe**. There is no webview, no HTML/CSS,
  no JavaScript build, and no `invoke` IPC boundary. All privileged work
  (keychain, filesystem, process spawn, network, updater) is ordinary Rust
  function calls within the same process.
- **Rationale.** The shell renders five simple screens. A webview + WebKitGTK
  stack is disproportionate for that, is the repository's heaviest runtime
  dependency, and forces a second language toolchain and test framework into a
  component whose logic is already mostly Rust. egui/eframe is pure Rust,
  cross-platform (Windows + Linux via winit), and removes the webview from the
  build graph.
- **Alternatives rejected.**
  - *Keep Tauri, replace only the frontend framework.* Rejected — keeps the
    webview and the JS build; does not meet the owner's "pure Rust, no webview".
  - *GTK4 / `gtk-rs`.* Rejected — reintroduces a heavy C toolkit and a system
    dependency; the owner asked for neither GTK nor Qt.
  - *Qt (via `cxx-qt` / `qmetaobject`).* Rejected — same objection, plus a C++
    toolchain.
  - *Iced / Slint.* Viable Rust-native alternatives; egui was chosen for its
    minimal dependency surface, immediate-mode simplicity for a small shell, and
    first-class eframe windowing/tray integration story.
- **Consequences.**
  - (+) One toolchain (Rust); no Node build for the desktop app; no WebKitGTK /
    GTK link dependency; smaller artifact.
  - (+) The frontend/backend split (16 command names + duplicated error-prefix
    constants) disappears; state lives in one place.
  - (−) The Vue/Pinia UI and its Vitest suite are deleted (§9); the egui UI is
    thin and is **not** unit-tested (§7).
  - (−) Linux tray support now depends on a StatusNotifierItem/D-Bus route
    rather than the GTK appindicator (see ADR-81).

### ADR-80: Auto-update is a Rust self-updater that verifies minisign before replacing the binary

- **Decision.** The shell checks the existing updater endpoint
  (`https://github.com/ngotuananh101/ponter/releases/latest/download/latest.json`),
  parses the existing `latest.json` shape, compares versions with `semver`, and —
  only when a strictly newer signed version exists — downloads the platform
  artifact, **verifies its minisign signature against the compiled-in public
  key**, and only then replaces the running binary. The **existing keypair and
  public key are reused unchanged**; the existing `latest.json` format and
  release pipeline are preserved.
- **Rationale.** Tauri's updater plugin is not available once the webview/Tauri
  stack is gone, but the *security property* it provided — a downloaded update
  is refused unless it carries a valid minisign signature from our key — must be
  kept. Reusing the key and the manifest format means already-installed apps and
  the release job keep working.
- **Anti-downgrade / anti-substitution.** The verification is the same
  per-artifact minisign check Tauri performed during download; a version is
  applied only when it is **strictly newer** (the existing `should_apply`
  policy), and the binary is replaced only **after** the signature over the
  downloaded bytes verifies. A failed verification aborts with no filesystem
  change.
- **Consequences.**
  - (+) The updater keypair, `latest.json`, and CI release assembly are reused.
  - (−) The app now owns the download/verify/replace sequence; the "verify then
    swap" order is a load-bearing invariant and is covered by tests (§7).

### ADR-81: Tray is a dedicated thread over a native mechanism; no GTK appindicator on Linux

- **Decision.** The tray icon runs on its **own OS thread**, not the eframe
  event loop, and forwards menu events to the app over the same in-process
  message channel the rest of the shell uses. On **Linux** the tray is a
  **StatusNotifierItem** published over D-Bus (`ksni`), which links no GTK. On
  **Windows** the tray uses the Win32 notification-area API (`tray-icon` with a
  dedicated message-pump thread). Menu semantics are unchanged from today:
  Status (read-only), Start agent, Stop agent, Open window, "Open at login"
  (checkbox), Quit; the runtime's three real states only.
- **Rationale.** egui provides no tray, and the Tauri tray pulled in
  `libayatana-appindicator3` (GTK). A D-Bus SNI on Linux keeps the "no GTK"
  promise. The tray must survive the window being closed, so it cannot live on
  the eframe loop that owns the window.
- **Consequences.**
  - (+) No GTK on Linux; tray keeps working with the window hidden.
  - (−) Linux SNI variance: GNOME requires the AppIndicator extension to display
    SNI icons. This is a **documented limitation**, not a defect (§10).
  - Fallback if SNI proves unusable on a target DE: `tray-icon` (GTK
    appindicator) — recorded as the escape hatch, at the cost of the GTK link.

### ADR-82: Fleet updates are push-first over the existing browser WebSocket, with periodic polling as fallback

- **Decision.** The device list is **push-first with a polling fallback** — two
  layers, WS preferred.
  - **Primary (WS push).** The shell opens **one** browser WebSocket to
    `/api/ws/browser` — minting a one-time ticket via `POST /api/ws/ticket` on
    every (re)connect — sends `subscribe-fleet`, and **re-fetches
    `GET /api/agents` when it receives a `fleet-changed` frame**. The re-fetch is
    stale-while-revalidate (the existing list stays on screen while the new one
    loads — the posture from #96/#102).
  - **Fallback (polling).** When the WS is **unusable** — the upgrade is
    rejected by the `Origin` gate (403), the network/proxy blocks the upgrade,
    or the socket dies and reconnect fails after N attempts — the shell
    **automatically switches to periodic polling** of `GET /api/agents` (the
    same ~5 s interval the Tauri app used; the exact value is a plan-time
    detail) so the online/offline badges stay correct.
  - **Recovery.** When a WS reconnect **succeeds**, the shell **stops polling**
    and returns to push. The two layers **never run in parallel**: WS is
    preferred, polling is enabled only while WS is unusable. Exactly one of the
    two is active at any time.
- **Rationale.** The owner's decision is "move to WebSocket, no polling" *with
  the correction* that polling is kept as a safety net, not deleted: a native
  client cannot rely on the WS upgrade succeeding in every deployment (the
  `Origin` gate, proxies, restricted networks), and the device badges must stay
  correct even then. The server already pushes: `pushFleetToUser(userId)` emits
  `{type:'fleet-changed'}` to every browser socket subscribed for that user, and
  it is **already called** by device register/update/delete and agent
  online/offline (`routes/agents.ts`, `routes/devices.ts`, `routes/ws.ts`), so
  no server change is needed for either layer.
- **Mechanism (all existing on the server).**
  - Mint: `POST /api/ws/ticket` (auth middleware) → `{ ticket, expiresIn: 15 }`
    (`wsTicketRouter.post('/ticket')`).
  - Connect: `ws(s)://<host>/api/ws/browser?ticket=<ticket>`; the upgrade
    validates the ticket and the `Origin` (see the risk below).
  - Subscribe: send `{type:'subscribe-fleet'}`; the socket is keyed by `userId`.
  - Signal: receive `{type:'fleet-changed'}` → re-fetch `GET /api/agents`.
  - Fallback: `GET /api/agents` on a ~5 s interval, active only while WS is
    unusable.
- **"WS unusable" criteria** (any one enables the fallback): the upgrade returns
  403 (origin gate) or otherwise fails; the connect attempt times out; or the
  socket closes and reconnect fails after N consecutive attempts. **Recovery**
  clears it: a successful (re)connect disables polling.
- **Lifecycle.** This socket belongs to the **shell** (shared by the Devices and
  Settings screens). It reconnects with **backoff** and is **closed on logout**.
  It is **distinct from the agent-runtime WebSocket** that `ponter-agent` hosts
  (`/api/ws/agent`), which is untouched.
- **Auth.** The ticket is minted with the shell's current access token and is
  **one-time with a 15 s TTL**, so it is re-minted on each (re)connect; the
  access token itself never travels on the socket URL.
- **Consequences.**
  - (+) Push-first: the list updates on the server's own signal; less traffic
    when WS works.
  - (+) No server change — the endpoints and the push call sites already exist;
    the polling fallback reuses the existing `GET /api/agents`.
  - (+) Correctness does not depend on the WS upgrade succeeding — the fallback
    covers the `Origin`-gate / proxy / restricted-network cases.
  - (−) The shell owns WS reconnect/backoff state **and** the switch between the
    two layers; the "exactly one active" invariant is load-bearing and is
    covered by tests (§7).
  - (−) The `Origin` gate (below) remains a deployment-dependent limitation that
    triggers the fallback rather than a hard failure.

---

## 4. Architecture

### 4.1 Crate layout

`apps/desktop/` is replaced by a single binary crate:

```
apps/desktop/
├── Cargo.toml              # package "ponter-desktop"; [[bin]] ponter-desktop
├── Cargo.lock
├── README.md               # rewritten for the Rust app
├── icons/                  # app icons (PNG + .ico) embedded via include_bytes!
└── src/
    ├── main.rs             # entry: logging::init, build App, run eframe
    ├── app.rs              # `App` (impl eframe::App): owns CoreState + Screen
    ├── theme.rs            # light/dark tokens for egui visuals
    ├── tray.rs             # tray thread; menu events -> channel
    ├── autostart.rs        # Linux .desktop / Windows reg.exe (ported)
    ├── ui/
    │   ├── mod.rs          # `Screen` enum + router (which screen renders)
    │   ├── login.rs
    │   ├── server_setup.rs
    │   ├── wizard.rs
    │   ├── devices.rs
    │   └── settings.rs
    └── core/
        ├── mod.rs
        ├── state.rs        # CoreState: server_url, token, allow_input, config
        ├── config.rs       # PersistedConfig load/save + URL precedence (ported)
        ├── keychain.rs     # OS secret store wrapper (ported)
        ├── auth.rs         # login/logout HTTP (ported from commands/login.rs)
        ├── session.rs      # refresh + retry_once_on_401 (ported)
        ├── devices.rs      # register/list/delete HTTP (ported)
        ├── fleet_ws.rs     # browser WS: mint ticket, subscribe-fleet, fleet-changed (new)
        ├── wizard.rs       # probe_server/probe_capture/config payload (ported)
        ├── updater.rs      # check + minisign-verify + replace (new)
        ├── agent_host.rs   # hosts ponter-agent: start/stop/status
        └── error.rs        # AuthError classification (AUTH_FAILED_PREFIX etc.)
```

The split is deliberate: `ui/` renders and dispatches; `core/` does everything
else and is **GUI-free** so it can be unit-tested without a display (§7).

### 4.2 Data flow

```
   ui/*  ──dispatch──▶  App::handle(Command)  ──▶  core/*  ──▶  { HTTP (reqwest)
     ▲                                                │           agent runtime (ponter-agent)
     │                                                │           keychain (keyring)
     └──────────── Msg (channel) ◀────────────────────┘           config.json (std::fs) }
```

- The UI never performs I/O directly. It emits a `Command` (an enum) into the
  app, which runs it.
- Anything that can block or await is executed on the **tokio runtime**
  (§4.3) and reports back as a `Msg` on the channel; the UI stays responsive.
- The UI reads state from `CoreState` each frame and renders.

### 4.3 Threading and async model

eframe owns the main thread and runs a synchronous, immediate-mode `update()`
loop. `ponter-agent` and `reqwest` are async (tokio). The model is:

- **One tokio multi-thread runtime**, created at startup and held by the app.
  All async work (HTTP calls, `AgentRuntime::start/stop`, refresh/retry, the
  fleet WS) is spawned onto it.
- **One message channel** (`tokio::sync::mpsc`) from background tasks to the
  app. Each task holds an `egui::Context` clone and calls
  `ctx.request_repaint()` after sending a `Msg`, so the UI redraws when a task
  completes.
- **The app drains the channel** at the top of every `update()` and folds each
  `Msg` into `CoreState`.
- **Agent status is a local atomic read, not network polling.**
  `RuntimeHandle::status()` reads an in-process atomic (`Arc<AtomicU8>`), so the
  app reads it directly each frame and the tray reads the same atomic to update
  its status line — no network request and **no timer** is involved. (This is
  the only status path; it is not a poll of the server.)
- **The fleet WebSocket is a long-lived task**, not a timer: one background
  task owns the shell's browser WS (`core/fleet_ws.rs`), sends `Msg`s for
  connect/disconnect and each `fleet-changed` frame, and reconnects with backoff
  (§ADR-82). **Polling is a fallback, not the primary path**: a periodic
  `GET /api/agents` runs **only while the WS is unusable**, and is stopped as
  soon as a (re)connect succeeds — the two layers never run in parallel
  (§5.2, §10).
- **The tray** runs on its own thread (§ADR-81) and injects `Msg`s (menu
  actions) into the same channel.

### 4.4 State ownership

`CoreState` (in `core/state.rs`) holds: the effective `server_url`, the
in-memory access token, the `allow_input` preference, the loaded
`PersistedConfig`, the `config_path`, the `reqwest::Client`, the tokio
`Runtime` handle, and the agent `RuntimeHandle` slot. It is the direct successor
to the Tauri `AppState` + `TrayState` (the runtime slot moves out of the tray
into the core, since the tray is no longer the lifecycle owner).

---

## 5. Component-by-Component Specification

Each component lists its responsibility, inputs/outputs, and error contract.
"Ported" means the logic moves from `src-tauri/src` with no behavioural change.

### 5.1 Core modules (`src/core/`)

**`config.rs`** — *ported from `src-tauri/src/config.rs`.*
- Responsibility: the on-disk non-secret preference shape and the server-URL
  resolution chain.
- Shape: `PersistedConfig { server_url: Option<String>, allow_input: bool,
  theme: Option<String> }`, camelCase JSON, every field defaulted (ADR-65).
- `load_config(path) -> PersistedConfig`: missing/unreadable/corrupt ⇒ default;
  **never errors** (a bad config must not brick startup).
- `save_config(path, &cfg) -> Result<(), String>`: pretty JSON, creates parent
  dir.
- `resolve_server_url(env, persisted, build_default) -> String`: four-level
  precedence (runtime env → persisted → build default → `http://localhost:8787`),
  whitespace-only and slash-only treated as unset, trailing slashes trimmed
  (ADR-64).
- Error contract: `load` infallible; `save` returns a human string on I/O error.

**`keychain.rs`** — *ported from `src-tauri/src/keychain.rs`.*
- Responsibility: the OS secret store (`keyring` crate, feature `v1`).
- API: `set_secret/get_secret/delete_secret(service, account, …)`.
- Service/account constants are **kept identical** to today
  (`service = "ponter-desktop"`; accounts `"refresh-token"` and
  `"agent-credential"`) so an upgraded install keeps its stored credential.
- Error contract: a **missing** entry is `Ok(None)` / idempotent success
  (`keyring::Error::NoEntry`); `PlatformFailure` / `NoStorageAccess` bubble as
  `Err` (a locked store is not "no credential").

**`state.rs`** — *ported from `src-tauri/src/state.rs`, reshaped.*
- Responsibility: the single in-process state object (§4.4). Builds the
  `reqwest::Client`, installs the rustls ring provider once, resolves the
  effective server URL, and holds the agent-runtime slot.
- Config-dir resolution replaces Tauri's `app_config_dir()` with the platform
  config dir for the **same identifier** (`com.ponter.desktop`) — Linux
  `~/.config/com.ponter.desktop/`, Windows
  `%APPDATA%\com.ponter.desktop\` — so `config.json` is found in place after
  upgrade.
- Error contract: infallible construction; a missing config dir makes
  persistence a no-op (as today).

**`auth.rs`** — *ported from `src-tauri/src/commands/login.rs`.*
- Responsibility: `POST /api/auth/login`, keychain write of the refresh token,
  in-memory access token, logout.
- `parse_login_response(body) -> Result<LoginOutcome, String>`,
  `map_login_error(status, body) -> String` (pure, unit-tested).
- `login_impl(client, server_url, username, password, token_slot)`:
  POST, parse `{user, token, refreshToken, expiresIn}`, **write the refresh
  token to the keychain and fail loudly if the write fails** (a login that
  cannot persist recovery state must not report success), store the access token
  in memory only (ADR-52).
- Error contract: server `{error, code, details}` → the `error` string; a
  non-envelope body → `Login failed (HTTP <status>)`.

**`session.rs`** — *ported from `src-tauri/src/commands/session.rs`.*
- Responsibility: `POST /api/auth/refresh` and the shared
  `retry_once_on_401` helper used by every device call.
- `is_auth_fatal_status(status) -> bool` = `401 | 403` (refresh endpoint);
  `map_refresh_error` prefixes `REFRESH_FAILED_PREFIX = "session expired after
  refresh attempt"` for auth-fatal statuses and leaves 5xx/429/400 unprefixed
  (a flaky server must not log the user out).
- `retry_once_on_401`: run the op with the current token; on an auth-classified
  error, refresh **once**, then retry the op **once**; a failed refresh surfaces
  `REFRESH_FAILED_PREFIX` and **does not retry again** (no loop).
- Error contract: fail-closed — a missing keychain token, a non-200, a parse
  error, or a keychain rotate failure all return `Err` and leave the old tokens
  intact.

**`devices.rs`** — *ported from `src-tauri/src/commands/devices.rs`.*
- Responsibility: `POST /api/agents` (register), `GET /api/agents` (list),
  `DELETE /api/agents/:id` (delete).
- Registration: generate `{sanitized-hostname}-{8 hex}` from `ring` entropy,
  send `{id, hostname, platform, osVersion, agentVersion, capabilities}` (no
  fabricated `publicKey`), and **write the returned one-time credential to the
  keychain immediately**; the credential is **never** exposed to the UI layer
  (the returned `DesktopDevice` has no credential field).
- Re-registration **replaces** the keychain credential (latest wins).
- Auth-death classification is driven by the **stable signal** — HTTP `401` or
  the server's `code == "UNAUTHORIZED"` — never message text (issue #107);
  `map_devices_error` prepends `AUTH_FAILED_PREFIX = "unauthorized request"` and
  `is_auth_error` matches that marker. `403 AGENT_LIMIT_REACHED` is **not**
  auth-fatal.
- Every call runs through `session::retry_once_on_401`.
- Error contract: server `{error}` → string; non-envelope → `Request failed
  (HTTP <status>)`; not-logged-in → `not logged in`.

**`wizard.rs`** — *ported from `src-tauri/src/commands/wizard.rs`.*
- Responsibility: the wizard's three verification probes and the config payload.
- `map_health_response(status, body) -> ProbeResult`: success is a 2xx **and** a
  body parsing as `{"status":"ok"}`.
- `probe_server_impl(client, url)`: `GET {url}/health`, 5 s timeout, trailing
  slash trimmed; network failure is `ok:false`, never `Err`.
- `probe_capture()`: calls `ponter_agent::probe_capture()` (a real capture
  frame) and maps errors via `map_capture_error` (Wayland/portal guidance
  preserved; no macOS arm — ADR-78).
- `config_payload(state) -> ConfigPayload`: the effective (never-empty) server
  URL plus `has_server_url`, `allow_input`, `theme`.
- `save_config_impl(...)`: normalize, persist, mirror into `CoreState`; a blank
  URL never clobbers the resolved one.
- Error contract: probes return `ProbeResult { ok, message }` and do not raise;
  save returns a string error on I/O failure.

**`agent_host.rs`** — *ported from `src-tauri/src/tray.rs` lifecycle half.*
- Responsibility: host the `ponter-agent` runtime.
- `build_runtime_config(server_url, credential, allow_input, identity)`:
  derives the WS URL (`http(s)→ws(s)` + `/api/ws/agent`), defaults
  `shell`/`stun`/`cols`/`rows`, `DesktopSource::Screen`,
  `StreamProfile::DEFAULT_1080P30`, `desktop_default_source: "primary"`,
  `desktop_select_timeout: 5000 ms`, `files_root: None`; **errors when the
  credential is absent or blank** ("register this device first").
- `resolve_identity_path(xdg_config_home, home)`: XDG → HOME/.config → `.`,
  then `ponter/agent-identity.pkcs8` (parity with the CLI).
- `start()`: read credential from keychain, load/generate the Ed25519 identity,
  stop any stale handle, `AgentRuntime::start(config).await`, store the handle.
  Idempotent against concurrent starts (a guard).
- `stop()`: take the handle and `stop().await`; a no-op when none is running.
- `status()`: `handle.status()` → `Stopped` / `Disconnected` / `Connected`
  (the only three states — nothing fabricated).
- Error contract: `start` returns a string error if the credential, identity, or
  runtime start fails; `stop` is best-effort.

**`fleet_ws.rs`** — *new (the ADR-82 push-first fleet channel).*
- Responsibility: keep the device list current via the server's push signal,
  with polling as a fallback. Owns the shell's single browser WS and the
  layer-selection state machine.
- `mint_ticket(client, server_url, access_token) -> Result<String, String>`:
  `POST /api/ws/ticket`; returns the one-time ticket (TTL 15 s). A non-200 or
  parse failure is an `Err` (the caller then treats WS as unusable).
- `connect(server_url, ticket)`: open `ws(s)://<host>/api/ws/browser?ticket=...`
  (scheme derived from the server URL like `derive_ws_url`), send
  `{type:'subscribe-fleet'}`, and drive the socket: on each
  `{type:'fleet-changed'}` frame emit `Msg::FleetChanged` (the app then
  re-fetches `GET /api/agents`).
- **Layer state machine** (the load-bearing invariant): `Push` (WS connected —
  no timer) vs `Fallback` (WS unusable — a ~5 s `GET /api/agents` interval
  runs). Exactly one layer is active at a time. Transitions:
  - `Push -> Fallback` when the WS is **unusable**: the ticket mint or upgrade
    fails (incl. a 403 from the origin gate), the connect times out, or the
    socket closes and reconnect fails after **N consecutive attempts**.
  - `Fallback -> Push` when a (re)connect **succeeds**: the poll timer is
    cancelled **before** the WS is considered active.
  - Reconnect uses backoff while in `Push`; the fallback interval is the safety
    net, not a parallel path.
- `reconnect_attempts` / the interval value are **plan-time details**; the
  invariant (never both, WS preferred) is fixed here.
- Error contract: the module never panics; a failed mint/connect flips to
  `Fallback`; a failed poll leaves the last-good list on screen (stale-while-
  revalidate) and retries on the next tick.

**`updater.rs`** — *new (replaces `commands/updater.rs` + the Tauri plugin).*
- Responsibility: the ADR-80 self-update.
- `should_apply(current, latest) -> Option<UpdateInfo>`: **strictly newer**
  semver only (ported policy).
- `check()`: `GET` the endpoint, parse `latest.json`
  (`{version, notes, pub_date, platforms: {"{os}-{arch}-{bundle_type}": {url,
  signature}}}`), pick the entry for this platform, and return `UpdateInfo` when
  `should_apply` holds.
- `apply()`: download the artifact bytes; **verify the minisign signature over
  those bytes against the compiled-in public key**; only on success replace the
  running binary (Linux: overwrite; Windows: rename-swap of the running exe via
  the standard "rename self, write new, restart" dance). A verification failure
  aborts with **no filesystem change**.
- Public key: the existing base64 minisign key from `tauri.conf.json` is moved
  into the crate as a constant; the keypair and manifest format are unchanged.
- Error contract: `check` returns `Ok(None)` on "no newer version" and `Err` on
  a network/parse failure; `apply` returns `Err` and leaves the binary untouched
  on any verification or I/O failure.

**`error.rs`** — *new (centralizes the classification constants).*
- Responsibility: the two stable prefixes (`AUTH_FAILED_PREFIX`,
  `REFRESH_FAILED_PREFIX`) and the `is_auth_error` predicate, in one place, so
  the classification is not duplicated between modules (it was a Sonar dedup
  point in the Tauri code).

### 5.2 Screens (`src/ui/`)

Each screen is a `fn render(app: &mut App, ui: &mut egui::Ui)` that reads
`CoreState` and emits `Command`s. The **router** in `ui/mod.rs` mirrors today's
`App.vue` gate order exactly:

```
if !has_server_url || editing   -> ServerSetup
else if !authenticated          -> Login
else if !wizard_completed       -> Wizard
else                            -> Devices
```

The Vue app gated the whole tree behind `configStore.configLoaded` to avoid a
first-paint flash while `get_config` was in flight (ADR-66/D). In the Rust shell
`config::load_config` is **synchronous and infallible** (§5.1), so the config is
already in `CoreState` before the first frame — the async flash gate has no
subject and is **dropped**, not reimplemented.

**Server Setup** — *parity with `ServerSetupView.vue`.*
- Input: server URL (defaulted to the effective URL or
  `http://localhost:8787`); a "Connect" action.
- Behaviour: `probe_server`; on `ok`, persist via `save_config`; on failure,
  show the probe message inline. Enter submits.
- Output: `Msg::ServerProbed` / `Msg::ConfigSaved`.

**Login** — *parity with `LoginView.vue`.*
- Input: username, password; a server line with a "Change" affordance (sets
  `editing = true`); a theme toggle.
- Behaviour: non-empty guard, then `auth::login_impl`. Controls disabled while
  a login is in flight.
- Output: `Msg::LoggedIn(UserProfile)` / `Msg::LoginFailed(String)`.

**Wizard** — *parity with `WizardView.vue`; three steps.*
1. **Capture** — "Verify Capture" runs `probe_capture`; advancing requires an
   `ok` result.
2. **Input gate** — a checkbox bound to `allow_input` (default **off**), with
   the two-gate explanation (Gate A operator + Gate B verified peer, ADR-42).
3. **Auto-start** — a checkbox reflecting the real OS entry
   (`is_autostart_enabled`) and applying `set_autostart`; completion is recorded
   on "Done".
- Output: `Msg::CaptureProbed`, `Msg::WizardAdvanced`, `Msg::WizardCompleted`,
  `Msg::AutostartToggled`.

**Devices** — *parity with `DevicesView.vue`.*
- Renders: signed-in username, logout, a **live runtime-status indicator**
  (`connected`/`disconnected`/`stopped`/`unknown`), the device list
  (hostname, platform badge, online badge, id, createdAt), a per-row delete
  with a confirmation dialog, a **capabilities** selector
  (`terminal`/`desktop`/`files`, default `terminal`+`desktop`), and a "Register
  Device" action.
- Behaviour: refresh on entry, then stay current via **push-first with a polling
  fallback** (ADR-82): the shell subscribes to `fleet-changed` on
  `/api/ws/browser` and re-fetches `GET /api/agents` when it arrives; if the WS
  is unusable (origin-gate 403, blocked upgrade, or reconnect exhausted), it
  switches to a periodic `GET /api/agents` (~5 s — a plan-time detail) and
  switches back the moment a (re)connect succeeds. The two never run in
  parallel. Registration forwards the selected capabilities.
- Output: `Msg::DevicesLoaded`, `Msg::FleetChanged`, `Msg::DeviceRegistered`,
  `Msg::DeviceDeleted`.

**Settings** — *new screen (the Tauri app had no dedicated one).*
- Renders: server URL (edit + re-probe), theme (light/dark), the
  "Open at login" toggle, an **"allow input" toggle**, the app version, a
  "Check for updates" action, and a logout.
- **Allow-input toggle (owner decision).** Settings exposes the same
  `allow_input` preference the wizard sets — Settings is a **second place to
  control one preference**, not a second gate. The **two-gate model (ADR-42) is
  unchanged**: this toggle is Gate A (operator consent), and it still only
  permits input from a **verified peer** (Gate B); flipping it here does nothing
  a wizard flip would not. A change here is persisted via `save_config` and
  mirrored into `CoreState`, exactly like the wizard's.
- Rationale: with a native shell, the settings that were scattered across the
  login strip, wizard, and tray get one home. Content is limited to settings
  that already exist — no new behaviour beyond the second control surface for
  `allow_input`.
- Output: `Msg::ConfigSaved`, `Msg::UpdateChecked`, `Msg::UpdateApplied`.

### 5.3 Tray (`src/tray.rs`)

- *Ported semantics from `src-tauri/src/tray.rs`.* Menu: `Status` (disabled),
  Start agent, Stop agent, Open window, "Open at login" (checkbox), Quit.
- Pure functions carried over verbatim (they are the current unit-tested
  surface): `tray_label`, `status_text`, `status_key`, `action_for_menu_id`,
  `derive_ws_url`, `should_hide_on_close`.
- Threading per ADR-81: a dedicated thread publishes the tray; menu clicks and
  the autostart toggle are forwarded as `Msg`s. The "Open at login" checkbox is
  driven by the **real OS entry** (the entry is the source of truth), and is
  reverted if applying it fails, so the checkbox never lies.
- Close-to-tray: closing the window hides it **only when the tray is actually
  active**; otherwise the window closes normally rather than stranding the user.

### 5.4 Agent lifecycle hosting

The lifecycle is owned by `core/agent_host.rs` + `CoreState` (not the tray, as
in the Tauri app). Start/stop/quit semantics are unchanged: Quit stops the
runtime then exits; Start is idempotent; Stop is a no-op when nothing runs. The
status the tray and the Devices view both read is the single `RuntimeStatus`.

### 5.5 Fleet update flow (push-first, polling fallback)

```
Connect (primary)                      Fallback (WS unusable)
-----------------                      ----------------------
POST /api/ws/ticket  -> ticket         GET /api/agents  every ~5 s
  -> ws /api/ws/browser?ticket=...       (only while WS is unusable)
  -> send {type:'subscribe-fleet'}
  -> on {type:'fleet-changed'}:
       re-fetch GET /api/agents
       (stale-while-revalidate)
  -> on close: reconnect w/ backoff

WS unusable?  -> switch to Fallback (stop WS retry cadence, start timer)
WS reconnects -> switch to Push     (cancel timer BEFORE marking WS active)
```

- **Exactly one layer active.** `Push` and `Fallback` never run together; a
  successful (re)connect cancels the poll timer before the WS is considered
  active (§ADR-82, `core/fleet_ws.rs`).
- **"WS unusable"** = ticket mint or upgrade fails (incl. origin-gate 403),
  connect times out, or reconnect fails after N consecutive attempts.
- The socket is the **shell's**; it is separate from the agent-runtime WS
  (`/api/ws/agent`) hosted by `ponter-agent`.

### 5.6 Self-update flow

```
Check  -> GET latest.json -> parse -> should_apply? -> show UpdateInfo
Apply  -> download artifact -> minisign verify (compiled-in pubkey)
       -> OK  -> replace binary (Linux overwrite / Windows rename-swap)
       -> BAD -> abort, no filesystem change
```

---

## 6. Crate & Dependency List

The crate is `ponter-desktop` (bin). Dependencies, and what each replaces:

| Crate | Purpose | Replaces (Tauri world) |
|---|---|---|
| `eframe` (+ `egui`) | windowing + immediate-mode GUI | `tauri` + `tauri-build` + the webview |
| `tokio` (`rt-multi-thread`, `macros`, `time`, `sync`) | async runtime for HTTP + agent host | `tauri::async_runtime` |
| `reqwest` (`json`, `rustls-no-provider`) | HTTP client | unchanged |
| `tokio-tungstenite` (`rustls-tls-webpki-roots`) | browser-WS client for fleet push (`/api/ws/browser`) | new (the agent's WS is server-side inside `ponter-agent`); same version family as the agent |
| `rustls` (`ring`, `std`, `tls12`) + `ring` | TLS provider + entropy | unchanged |
| `serde` / `serde_json` | wire + config (de)serialization | unchanged |
| `anyhow` | error plumbing | unchanged |
| `keyring` (`default-features = false`, `features = ["v1"]`) | OS secret store | unchanged (same feature trap as ADR-78) |
| `ponter-agent` (`path = "../../agent"`) | **hosted runtime** (reused) | unchanged |
| `directories` | app config dir | `app.path().app_config_dir()` |
| `semver` | update version comparison | unchanged |
| `minisign-verify` | verify update signatures | `tauri-plugin-updater` verification |
| `ksni` (Linux) | StatusNotifierItem tray | `tauri` tray (appindicator) |
| `tray-icon` (Windows) | Win32 notification-area tray | `tauri` tray |
| `single-instance` (or an OS lock) | one-instance guard | `tauri-plugin-single-instance` |
| `open` | open URLs in the default browser | `tauri-plugin-opener` (if used) |

Notes:
- The `[patch.crates-io] xcap = { path = "../../agent/vendor/xcap" }` block
  **stays** in the new `Cargo.toml` — Cargo reads `[patch]` only from the root
  manifest, and the vendored Wayland fix must be linked.
- The `keyring` feature must be `["v1"]` with `default-features = false`; a bare
  store list does **not** compile (verified in ADR-78).
- Exact crate versions are pinned at plan time; the list above fixes the
  *choices*, not the numbers.
- **No webview, GTK, Qt, or Node dependency is introduced.** A CI guard asserts
  the crate's dependency graph contains none of `webkit`, `gtk`, `qt`, `wry`,
  `tao` (§8).

---

## 7. Testing Strategy & TEST-INTEGRITY Declaration

### 7.1 Strategy

| Area | What proves it |
|---|---|
| `core/*` (config, keychain, auth, session, devices, wizard, agent_host) | Ported Rust unit tests + `spawn_stub` HTTP integration tests, unchanged in spirit. These are GUI-free and run headless. |
| `fleet_ws` | New tests: ticket mint (200/parse, non-200 ⇒ Err), the `subscribe-fleet` frame shape, `fleet-changed` ⇒ a re-fetch is requested, and the **layer state machine** — WS-unusable ⇒ `Fallback` (poll active, WS retry stops), reconnect ⇒ `Push` (timer cancelled first), and the invariant that the two never run in parallel. A stub WS/HTTP server drives the transitions. |
| `updater` | New unit tests: `should_apply` (older/equal/newer), manifest platform selection, and **signature verification** (a valid minisign signature accepts; a tampered/absent signature refuses and leaves the binary untouched). |
| `autostart` | Ported pure-function + temp-dir round-trip tests (Linux `.desktop`; Windows `reg.exe` argv). |
| `tray` | Ported pure-function tests (label/status_key/action/ws-url/hide-on-close). The tray *lifecycle* is not unit-tested (it needs a real tray) — same as today; covered by the manual smoke. |
| `ui/*` (egui screens) | **Not unit-tested.** The egui UI is a thin render/dispatch layer; its logic lives in `core/*` and is tested there. A headless smoke test may boot the app under Xvfb (Linux CI) as a liveness check — a plan detail. |
| Packaging | `build-desktop.yml` produces the expected artifacts; the post-build size assertions are kept. |
| Security gate (R8) | With no webview, webview storage is **structurally impossible**. A CI guard (grep) asserts the crate introduces no webview/storage dependency, and the existing R8 webview-storage tests are retired with their subject (the Vue app). |

### 7.2 TEST-INTEGRITY declaration

This change **moves** the Rust test suite (subject code is preserved) and
**deletes** the Vue test suite (subject code is deleted by design). Every change
is declared before→after with a reason. No test is deleted to make a suite pass.

**Baseline (before):**
- `apps/desktop/src-tauri/src/**` — **100** `#[test]` functions across
  `config.rs` (12), `state.rs` (2), `keychain.rs` (1), `autostart.rs` (12),
  `tray.rs` (18), `lib.rs` (1), `commands/{login (5), session (9),
  devices (20), wizard (19), updater (1)}`.
- `apps/desktop/src/__tests__/**` — **84** `it()`/`test()` declarations
  (**89** executed cases; `devices.test.ts` has an `it.each` expanding 1 → 5)
  across 7 files (app 7, config 4, devices 42, login 4, serverSetup 5,
  theme 4, wizard 23).

**After (target):**

| Source | Fate | Reason |
|---|---|---|
| `config.rs` 12 | **Ported** → `core/config.rs` | Pure URL/precedence logic; unchanged. |
| `state.rs` 2 | **Ported** → `core/state.rs` | Defaults/localhost-fallback assertions; unchanged in substance. |
| `keychain.rs` 1 | **Ported** → `core/keychain.rs` | Round-trip test; unchanged. |
| `commands/login.rs` 5 | **Ported** → `core/auth.rs` | 2 pure (parse/map) + 3 keychain/stub integration; `tauri::async_runtime::block_on` → tokio `block_on`. |
| `commands/session.rs` 9 | **Ported** → `core/session.rs` | Refresh/retry/no-loop assertions; unchanged. |
| `commands/devices.rs` 20 | **Ported** → `core/devices.rs` | Classification + CRUD integration; unchanged. |
| `commands/wizard.rs` 19 | **Ported** → `core/wizard.rs` | Probe mapping + config payload; unchanged. |
| `autostart.rs` 12 | **Ported** → `core/autostart.rs` | Pure fns + temp-dir round-trips; unchanged. |
| `tray.rs` 18 | **Ported** → `tray.rs` + `core/agent_host.rs` | The 18 are pure fns (label/status_key/action/ws-url/hide/identity-path/runtime-config); re-homed, not rewritten. |
| `lib.rs` 1 | **Ported or dropped** | Trivial; exact fate pinned at plan time. |
| `commands/updater.rs` 1 | **Replaced** → `core/updater.rs` | `should_apply` kept; **new** tests for minisign verification + manifest selection added. |
| `fleet_ws` (new) | **Added** | New module (ADR-82): ticket mint, `subscribe-fleet`, `fleet-changed` ⇒ re-fetch, and the push/fallback layer invariant. No prior test to port; new coverage. |
| `__tests__/**` 84 (89 cases) | **Deleted** | Subject (Vue views, Pinia stores, the Tauri `invoke` contract, the webview storage gate) is deleted with the Vue app. The behaviour they pinned moves to `core/*` Rust tests; the egui UI is thin and not unit-tested. |

**Net:** the **Rust suite is preserved** (≈100 tests carried over, some
re-homed; exact per-module count fixed when the plan enumerates it), **plus new
updater tests**; the **84 Vue `it()` (89 cases) are deleted** because their
subject is deleted. There is **no net loss of behavioural coverage of the
ported logic** — every ported module keeps its assertions.

**Load-bearing guards (mutation discipline).** The following must turn a test
red when mutated: (a) the input-gate default (open → closed), (b) the updater
`should_apply` comparison (newer-only), (c) the minisign check (a bad signature
must refuse **and** not touch the binary), (d) the auth-death classification
(401 / `code == "UNAUTHORIZED"` ⇒ auth-fatal; `403 AGENT_LIMIT_REACHED` ⇒ not),
(e) the no-retry-loop invariant (a failed refresh does not retry), (f) the
credential-never-leaves-the-keychain property (no credential field on the
returned device), (g) the fleet **push/fallback** invariant — WS-unusable
switches to polling, a successful reconnect cancels the poll timer before the
WS is marked active, and the two layers are never active together.

---

## 8. CI Changes

`.github/workflows/build-desktop.yml` is **rewritten for a Rust binary**:

- **Drop the Node steps.** No `pnpm install`, no `pnpm build`, no
  `@tauri-apps/cli`. The `beforeBuildCommand`/`frontendDist` concept is gone.
- **Drop the Tauri system deps on Linux.** `libwebkit2gtk-4.1-dev`,
  `libgtk-3-dev`, `libayatana-appindicator3-dev` are removed. The remaining
  Linux deps are the **agent capture stack** the runtime needs
  (`libpipewire-0.3-dev`, `libspa-0.2-dev`, `libwayland-dev`, `libegl-dev`,
  `libgbm-dev`, `libdrm-dev`, `libxcb1-dev`, `libxrandr-dev`, `pkg-config`,
  `libclang-dev`, `build-essential`) plus whatever eframe/egui needs
  (`libxkbcommon-dev`, GL/X11 dev headers — exact list fixed at plan time).
- **Matrix unchanged at 2 legs**: `ubuntu-latest` + `windows-latest`.
- **Build**: `cargo build --release` (the binary is `ponter-desktop` /
  `ponter-desktop.exe`). The `PONTER_DEFAULT_SERVER_URL` build-time default is
  supplied the same way (as a compile-time env the crate reads via
  `option_env!`).
- **Artifacts** (installer generation replaces the Tauri bundler; the set is
  fixed by the owner — all three per platform):
  - Linux: **AppImage** (`appimagetool`) + **`.deb`** (`cargo-deb`) + **`.rpm`**
    (`cargo-generate-rpm`, or `cargo-rpm`).
  - Windows: **portable `.exe`** (the raw release binary) + **NSIS installer**
    (`.exe` setup, `makensis`) + **`.msi`** (`cargo-wix`).
  - The per-format split-artifact layout and the ≥10 KB size assertions are
    **kept** (adapted to the new artifact paths).
  - Exact tool versions and the NSIS script wiring are **plan-time details**;
    the artifact *set* above is fixed.
- **Updater signing + `latest.json` are kept.** The release job still assembles
  `latest.json` with per-platform entries keyed `{os}-{arch}-{bundle_type}` and
  per-platform minisign signatures. The signing step uses the **existing**
  `TAURI_SIGNING_PRIVATE_KEY` secret (a minisign secret key) via a minisign
  signing tool (`rsign2`/`minisign`), producing `.sig` files beside each
  installer. The manifest-assembly Node script is kept (it is release-only and
  layout-agnostic) or ported to a shell/Node step — a plan detail.
- **`ci-node.yml`**: remove `apps/desktop/**` from its `paths` filters (the
  desktop app is no longer a Node workspace). The `apps/agent/**` and other
  filters are unchanged.
- **New guard step**: assert the crate's dependency graph contains no
  `webkit`/`gtk`/`qt`/`wry`/`tao` (the "no webview/GTK/Qt" invariant), e.g. a
  `cargo tree` grep that fails on a match.

The detailed step-by-step rewrite is the implementation plan's job; this section
fixes the shape.

---

## 9. Migration & Deletion

### 9.1 Deleted (with what replaces each)

| Deleted | Replaced by |
|---|---|
| `apps/desktop/src/**` (Vue app: `App.vue`, `main.ts`, `style.css`, `views/`, `stores/`, `components/`, `composables/`, `types.ts`, `__tests__/`) | `src/ui/**` (egui screens) + `src/core/**` (logic) |
| `apps/desktop/src-tauri/**` (Tauri backend, `Cargo.toml`, `tauri.conf.json`, `build.rs`, `capabilities/`, `gen/schemas/`, `icons/*` Tauri set, `Cargo.lock`) | `src/**` (same modules, GUI-free) + a new `Cargo.toml` |
| `apps/desktop/package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `components.json`, `public/` | nothing — the app is no longer a Node workspace |
| `apps/desktop/scripts/build-self.sh` | a Rust-equivalent self-build (the updater endpoint/pubkey become compile-time constants or a build-time env; the ADR-61 self-build story is re-expressed in the plan) |
| `apps/desktop/src-tauri/Cargo.lock` | a new `apps/desktop/Cargo.lock` |

`apps/desktop/README.md` is **rewritten** (not deleted) for the Rust app.

### 9.2 Preserved (explicitly untouched)

- `apps/agent/**` — the hosted runtime, unchanged.
- `apps/server/**` — no server change.
- `apps/web/**` — no web change; its `@ponter/desktop-core` use is unaffected.
- `packages/desktop-core` — stays; it is already web-only.
- `packages/ui-components` — stays; `apps/web` is its consumer (the desktop
  Vue alias that also consumed it is deleted with the Vue app).
- The `[patch.crates-io] xcap` vendoring under `apps/agent/vendor/xcap`.

### 9.3 Continuity invariants (must not break on upgrade)

- **Config dir identifier** stays `com.ponter.desktop`, so an existing
  `config.json` is found in place.
- **Keychain service/accounts** stay `ponter-desktop` /
  `refresh-token` / `agent-credential`, so an existing credential and refresh
  token keep working.
- **Updater public key** stays the same base64 minisign key, so an installed
  app can still verify and apply updates.
- **Agent identity path** stays `ponter/agent-identity.pkcs8` under the config
  dir, so the device's Ed25519 identity is preserved.

### 9.4 Web still builds

Removing the desktop Vue app does **not** touch `apps/web`, `packages/*`, or
`pnpm-workspace.yaml`'s ability to build the web workspace. Verification: the
web typecheck/test suite stays green and `apps/desktop` no longer appears as a
pnpm workspace package (no `package.json`).

---

## 10. Risks & Open Questions

| # | Risk / question | Likelihood | Impact | Mitigation / default |
|---|---|---|---|---|
| 1 | **Linux tray (SNI) variance.** GNOME shows no SNI icon without the AppIndicator extension; some DEs differ. | Medium | Medium | Documented limitation (ADR-81); fallback to `tray-icon` (GTK appindicator) if a target DE proves unusable — recorded as the escape hatch. |
| 2 | **Installer generation without the Tauri bundler.** The full artifact set — AppImage/`.deb`/`.rpm` and `.exe`/NSIS/`.msi` — now comes from `cargo-deb`/`cargo-generate-rpm`/`appimagetool`/`cargo-wix`/`makensis`. | Medium | Medium | Concrete tooling chosen (§8); artifact size assertions kept; the release path stays CI-proven on tag/dispatch. |
| 3 | **Windows binary self-replace.** Replacing a running `.exe` needs the rename-swap dance. | Medium | High | Standard rename-self → write-new → relaunch; verified in CI smoke where possible; a failed replace leaves the old binary in place. |
| 4 | **egui theming vs the existing design.** The Vue UI had shadcn-vue tokens; egui needs its own light/dark visuals. | Medium | Low | `theme.rs` maps the existing light/dark intent to egui visuals; parity is "same intent, native rendering", not pixel-parity. |
| 5 | **Video texture deferred (item C).** The viewer is not built here. | Low | Low | Explicit non-goal (§2); the spec does not claim a viewer. |
| 6 | **Keyring backends.** Linux Secret Service must be present at runtime. | Low | Medium | Same posture as today; `NoEntry` vs `PlatformFailure` distinction preserved (§5.1). |
| 7 | **Wayland vs X11 for the shell window.** eframe/winit support both; tray (SNI) is Wayland-friendly. | Low | Low | Inherit winit defaults; document any X11-only path if it surfaces. |
| 8 | **First-run UX on an upgraded install.** An existing Tauri user upgrades to the Rust app. | Low | Medium | Continuity invariants (§9.3) keep config, keychain, identity, and updater key; the app version resets to the crate version — confirm the manifest version aligns. |
| 9 | **Browser-WS origin gate blocks native clients.** `handleBrowserUpgrade` rejects a missing/mismatched `Origin` with **403** when `CORS_ORIGIN` is set to a concrete value (`getAllowedOrigins()` returns a list, not `*`). A native shell sends no `Origin`. Default self-hosted (`CORS_ORIGIN` unset → `*`) is unaffected. | Medium | Medium | This is **why the polling fallback exists** (ADR-82): a 403 flips the shell to polling, so badges stay correct. Documented limitation; the deployment fix is to leave `CORS_ORIGIN` unset for the WS or add the native client's origin policy — a plan/ops note. |

Open questions for the owner / plan time:
- **Resolved — artifact set.** Owner fixed all three per platform (§8): Linux
  AppImage + `.deb` + `.rpm`; Windows portable `.exe` + NSIS installer + `.msi`.
  Only exact tool versions and NSIS wiring remain plan-time details.
- **Resolved — Settings allow-input.** Settings **does** expose the `allow_input`
  toggle (a second control surface for the one preference; the two-gate model
  ADR-42 is unchanged) — see §5.2.
- **Resolved — device refresh.** No fixed primary interval: push-first via WS,
  with a ~5 s polling **fallback** only while the WS is unusable (ADR-82); the
  exact interval and reconnect count are plan-time details.

---

## 11. Rollout

Proposed split (the owner confirms at plan time; a single PR is possible but a
two-PR split keeps each review tractable):

- **PR 1 — Rust core + updater + fleet WS + CI (non-GUI-first).**
  Port `core/*` (config, keychain, state, auth, session, devices, wizard,
  agent_host, error), the new `updater` and `fleet_ws` (push-first fleet
  channel, ADR-82), `autostart`, and the crate skeleton (`main.rs` booting a
  minimal eframe window). Rewrite `build-desktop.yml` and de-trigger
  `ci-node.yml`. **Carries the Rust tests** (the port), the new updater tests,
  and the new `fleet_ws` tests. QA binding required (test files change).
- **PR 2 — UI screens + tray + deletion of the Tauri/Vue tree.**
  The five egui screens, the tray thread, `theme.rs`, the README rewrite, and
  the removal of `apps/desktop/src/**` + `apps/desktop/src-tauri/**` + the Node
  config. QA binding required (Vue tests deleted, declared in §7.2).

Alternative: one PR. The dependency is one-directional (UI needs core), so the
split is clean either way.

Docs (ADRs 79–82 recorded in `docs/ARCHITECTURE.md` §8, the §8 trail entry, the
README/guides touch-ups) land with the PR(s) that make them true, following the
repo's existing convention. A docs-only follow-up PR may be used if the code
PR(s) land first.

**Owner action required before implementation:** confirm the PR split. The
artifact set (§8) and the Settings/fleet decisions (§5.2, §10) are now fixed.
