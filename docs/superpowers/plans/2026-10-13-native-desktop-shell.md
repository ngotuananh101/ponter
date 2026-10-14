# Native Desktop Shell (Rust + egui) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri + Vue desktop app at `apps/desktop/` with a single Rust crate `ponter-desktop` on `egui`/`eframe` — the same five shell screens (Server Setup, Login, Wizard, Devices, Settings), the same tray, the same security posture, and a Rust self-updater that verifies a minisign signature before replacing the binary — building with one toolchain, linking no webview/GTK/Qt, and shipping the same native artifacts.

**Architecture:** One binary crate. `src/ui/*` renders egui and dispatches a `Command`; `src/core/*` is GUI-free logic (config, keychain, state, auth, session, devices, wizard, fleet WS, updater, agent host) run on one tokio multi-thread runtime; results return as `Msg`s over one `tokio::sync::mpsc` channel the app drains at the top of every frame. `ponter-agent` is hosted in-process, unchanged. The tray runs on its own OS thread (Linux `ksni`/StatusNotifierItem, Windows `tray-icon`) and injects `Msg`s into the same channel. Fleet state is push-first over the existing `/api/ws/browser` WebSocket with a polling fallback (ADR-82). **Two PRs:** PR1 = crate + `core/*` + `updater` + `fleet_ws` + CI (non-GUI-first); PR2 = `ui/*` + tray + README + deletion of the Tauri/Vue tree.

**Tech Stack:** Rust `1.98.1` (`rustfmt`, `clippy`); `eframe`/`egui` 0.36.2; `tokio` 1.53.1; `reqwest` 0.13.5; `tokio-tungstenite` 0.30; `rustls` 0.23.45 + `ring` 0.17.14; `serde` 1.0.229 / `serde_json` 1.0.151; `anyhow` 1.0.104; `keyring` 4.2.0 (feature `v1`); `ponter-agent` (path `../../agent`); `directories` 6.0.0; `semver` 1.0.28; `minisign-verify` 0.3.0; `ksni` 0.3.6 (Linux); `tray-icon` 0.26.1 (Windows); `single-instance` 0.3.3. GitHub Actions (2 legs: `ubuntu-latest`, `windows-latest`).

**Spec:** `docs/superpowers/specs/2026-10-13-native-desktop-shell-design.md`

## Global Constraints

Copied verbatim from the spec (§2, §6, §8, §9.3). Every task's requirements implicitly include this section.

- **No webview, GTK, Qt, or Node dependency is introduced.** A CI guard asserts the crate's dependency graph contains none of `webkit`, `gtk`, `qt`, `wry`, `tao` (spec §6, §8).
- **No macOS.** Windows + Linux only (ADR-78). No `#[cfg(target_os = "macos")]` anywhere in the new crate.
- **No changes to `apps/agent`, `apps/server`, `apps/web`.** `packages/desktop-core` and `packages/ui-components` stay exactly as they are. No new server endpoint, column, or migration — the shell consumes `POST /api/auth/login`, `POST /api/auth/refresh`, `GET/POST/DELETE /api/agents`, `GET /health`, `POST /api/ws/ticket`, and `/api/ws/browser` as they exist today.
- **Continuity invariants (must not break on upgrade, spec §9.3):**
  - Config dir identifier stays `com.ponter.desktop` (Linux `~/.config/com.ponter.desktop/`, Windows `%APPDATA%\com.ponter.desktop\`), so an existing `config.json` is found in place.
  - Keychain service stays `ponter-desktop`; accounts stay `refresh-token` and `agent-credential`.
  - Updater public key stays the same base64 minisign key: `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3QUZGQzFCNTgzRTM1NTEKUldSUk5UNVlHL3l2Unp3cTc0SE1ETWUxTlRPZ3FGUHI1cVoxN2d6a0xzL3J2V2dmOEJvczVaMkIK`.
  - Agent identity path stays `ponter/agent-identity.pkcs8` under the config dir.
- **The `[patch.crates-io] xcap = { path = "../../agent/vendor/xcap" }` block stays** in the new `Cargo.toml` (Cargo reads `[patch]` only from the root manifest; the vendored Wayland fix must link).
- **`keyring` must be `default-features = false, features = ["v1"]`** — a bare store list does not compile (ADR-78).
- **No dead code ships.** Every crate the dependency list names is actually called, and every public item a task produces is called by another task or exercised by a test. CI runs `cargo clippy --all-targets --locked -- -D warnings`, which turns an unused dependency-free `pub` item into a warning only when it is private; a genuinely unused *dependency* or an unused private item must be removed, not `#[allow]`-ed. (This is why `open` is not a dependency: the spec marks it optional — "if used" — and no screen opens an external URL, so it is dropped rather than declared-and-unused.)
- **Ported arity is preserved.** A function ported from `apps/desktop/src-tauri/src/**` keeps its **exact parameter list and return type** unless a task explicitly states the change. The ported unit tests are the contract; silently changing a signature (e.g. collapsing a 4-argument `save_config_impl` to 2) breaks them.
- **Toolchain:** Rust `1.98.1` with components `["rustfmt", "clippy"]` (matching `apps/agent/rust-toolchain.toml`).
- **Commit attribution:** NEVER add a `Co-authored-by` trailer (for a person or an AI). Author identity: `Ngo Tuan Anh <ngotuananh2101@gmail.com>`.
- **Language:** all code, identifiers, comments, commit messages, and repo docs in **English**.
- **TEST-INTEGRITY (spec §7.2).** Baseline Rust `apps/desktop/src-tauri/src/**` = **100** `#[test]`; baseline Vue `apps/desktop/src/__tests__/**` = **84** `it()`/`test()` declarations (**89** executed cases). After **both PRs**: Rust = **99 ported + 53 new = 152**; Vue = **84 → 0** (deleted with the app). Split: **PR1** = 87 ported + 26 new = **113**; **PR2** = 12 ported + 27 new = **39**. Exactly **one** Rust test is dropped, declared with reason in Task 12: `lib.rs:83` (1, compile-time `ponter_agent_runtime_api_is_wired` contract test, superseded by the real `AgentRuntime` host integration in Task 10) — so 99 of 100 carry over (`commands/updater.rs:87`'s `refuses_an_older_version` is ported as Task 12's `should_apply_older_version_returns_none`). No test is deleted or weakened to make a suite pass; every per-task delta is declared in that task.

## Review Focus

These are the input classes / failure modes the spec implies but that no *existing* test pins. Each is pinned by a test added to the task that owns the code (named below), most likely to bite first:

1. **A keyring read that fails for a reason other than "no entry"** (locked store, `PlatformFailure`, `NoStorageAccess`) must **not** be reported as "no credential". If it is, the agent-start path shows a spurious *"register this device in the Devices view first"* and the user re-registers a device they already have. Owned by `core/keychain.rs` → pinned by `classify_distinguishes_no_entry_from_other_errors` (Task 3).
2. **A `fleet-changed` frame that arrives while a `GET /api/agents` is already in flight** must not start a second fetch and must not drop the signal — the newer list must win. Owned by `core/fleet_ws.rs` → pinned by `signal_during_in_flight_fetch_coalesces_and_replays` (Task 11).
3. **A 403 from the browser-WS `Origin` gate** (a native client sends no `Origin`; `CORS_ORIGIN` set to a concrete value) must switch the shell to the polling fallback, not retry the upgrade forever or surface a hard error. Owned by `core/fleet_ws.rs` → pinned by `origin_gate_403_switches_to_fallback` (Task 11).
4. **An updater manifest that has no entry for this platform** must yield `Ok(None)` ("no update for you"), not an error and not a panic. Owned by `core/updater.rs` → pinned by `manifest_without_this_platform_yields_none` (Task 12).
5. **Closing the window while the tray is *not* active** must close the app, not hide it into a tray that is not there (stranding the user with a process they cannot reach). Owned by `src/tray.rs` + `src/app.rs` → pinned by the ported `should_hide_on_close_false_when_no_tray` (Task 17) and the close handler in Task 17.

---

## PR 1 — Rust core + updater + fleet WS + CI

### Task 1: Crate skeleton, `core::error`, and a minimal eframe boot

**Files:**
- Create: `apps/desktop/Cargo.toml`
- Create: `apps/desktop/src/main.rs`
- Create: `apps/desktop/src/app.rs`
- Create: `apps/desktop/src/core/mod.rs`
- Create: `apps/desktop/src/core/error.rs`
- Move: `apps/desktop/src-tauri/icons/` → `apps/desktop/icons/` (spec §4.1)
- Test: `apps/desktop/src/core/error.rs` (in-file `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `ponter_agent::logging::init()` (from the agent crate).
- Produces:
  - `core::error::{AUTH_FAILED_PREFIX, REFRESH_FAILED_PREFIX}` — `pub const … : &str`.
  - `core::error::is_auth_error(err: &str) -> bool`.
  - `app::App` — the `eframe::App` impl that owns the message channel and the tokio runtime; `app::App::new(cc: &eframe::CreationContext<'_>) -> App`.
  - `app::{Command, Msg, Screen}` enums (defined here, filled in by later tasks).

**TEST-INTEGRITY declaration (this file):** adds **2** tests to a new module
(`core/error.rs`); the Tauri code has no counterpart to port. File test count
**0 → 2**. No existing test changes.

- [ ] **Step 1: Write the crate manifest**

Create `apps/desktop/Cargo.toml`:

```toml
[package]
name = "ponter-desktop"
version = "0.1.0"
edition = "2021"
rust-version = "1.85"

[[bin]]
name = "ponter-desktop"
path = "src/main.rs"

[dependencies]
anyhow = "1.0.104"
base64 = "0.22.1"
directories = "6.0.0"
eframe = "0.36.2"
futures-util = { version = "0.3.34", default-features = false, features = ["sink", "std"] }
keyring = { version = "4.2.0", default-features = false, features = ["v1"] }
minisign-verify = "0.3.0"
ponter-agent = { path = "../../agent" }
reqwest = { version = "0.13.5", default-features = false, features = ["json", "rustls-no-provider"] }
ring = "0.17.14"
rustls = { version = "0.23.45", default-features = false, features = ["ring", "std", "tls12"] }
semver = "1.0.28"
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
single-instance = "0.3.3"
tokio = { version = "1.53.1", features = ["rt-multi-thread", "macros", "time", "sync"] }
tokio-tungstenite = { version = "0.30", features = ["rustls-tls-webpki-roots"] }

# Linux tray: StatusNotifierItem over D-Bus — links no GTK (ADR-81).
# `blocking` gives the synchronous `spawn()` that runs the SNI on its own thread.
[target.'cfg(target_os = "linux")'.dependencies]
ksni = { version = "0.3.6", default-features = false, features = ["blocking"] }

# Windows tray: Win32 notification area. `default-features = false` drops the
# default `libappindicator` feature, which would pull GTK on Linux — this
# dependency is target-gated to Windows precisely so the GTK link never appears.
[target.'cfg(target_os = "windows")'.dependencies]
tray-icon = { version = "0.26.1", default-features = false }

# The vendored Wayland capture fix must be linked (Cargo reads [patch] only from
# the root manifest).
[patch.crates-io]
xcap = { path = "../../agent/vendor/xcap" }

[dev-dependencies]
# Used only by the updater test that signs a payload with a throwaway keypair
# and asserts `verify` accepts it (the positive path of guard (c)).
minisign = "0.9.1"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Notes for the implementer:
- `tray-icon` 0.26.1 is **not** in the local cargo cache (0.25.1 is). CI and a networked local build download it; the API used here (`TrayIconBuilder`) is identical in both. Do not downgrade to match the cache.
- `futures-util` is declared here because `core::fleet_ws::run` (Task 11) uses `SinkExt`/`StreamExt` over the `tokio-tungstenite` split socket — the same pair the agent crate uses (`apps/agent/Cargo.toml`). Same version and feature set as the agent.
- There is deliberately **no `open` dependency**: the spec lists it as optional ("if used"), and no screen opens an external URL, so it is omitted rather than declared-and-unused (Global Constraints — no dead code).
- `eframe`'s default features (wgpu renderer, `wayland`, `x11`, `accesskit`, `default_fonts`, `links`) are kept — none of them pulls a webview/GTK/Qt crate.
- There is **no** `[workspace]` table: `apps/desktop` is a standalone package (there is no root `Cargo.toml` in this repository). During PR1 `apps/desktop/src-tauri/` still exists as its own separate package; Cargo does not scan it because this manifest declares no workspace.

- [ ] **Step 2: Write the failing tests for `core::error`**

Create `apps/desktop/src/core/error.rs`:

```rust
//! Centralized auth-error classification. The two prefixes are the stable
//! markers the shell matches on; they are shared so no module re-declares them
//! (this was a Sonar duplication point in the Tauri code).

/// Prefix prepended to an error whose cause is an authentication failure.
pub const AUTH_FAILED_PREFIX: &str = "unauthorized request";

/// Prefix prepended to an error from a failed session refresh.
pub const REFRESH_FAILED_PREFIX: &str = "session expired after refresh attempt";

/// True when `err` carries the auth-failure marker. Callers use this to decide
/// whether a device call is worth one refresh-and-retry.
pub fn is_auth_error(err: &str) -> bool {
    err.starts_with(AUTH_FAILED_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failed_prefix_is_the_stable_marker() {
        assert_eq!(AUTH_FAILED_PREFIX, "unauthorized request");
        assert_eq!(
            REFRESH_FAILED_PREFIX,
            "session expired after refresh attempt"
        );
    }

    #[test]
    fn is_auth_error_matches_only_the_marker() {
        assert!(is_auth_error("unauthorized request: token expired"));
        assert!(is_auth_error("unauthorized request"));
        assert!(!is_auth_error("session expired after refresh attempt"));
        assert!(!is_auth_error("Request failed (HTTP 500)"));
        assert!(!is_auth_error(""));
    }
}
```

Create `apps/desktop/src/core/mod.rs`:

```rust
//! GUI-free core logic. Every module here is unit-testable without a display.

pub mod error;
```

- [ ] **Step 3: Run the tests to verify they fail to compile**

Run (from `apps/desktop`):

```bash
cargo test --locked core::error
```

Expected: **compile error** — `src/main.rs` does not exist yet, so the package
has no target. (This is the "fails first" step for a brand-new crate.)

- [ ] **Step 4: Write `main.rs` and the minimal `app.rs`**

Create `apps/desktop/src/main.rs`:

```rust
//! `ponter-desktop` — the native desktop shell (ADR-79).

mod app;
mod core;

use eframe::egui;

fn main() -> eframe::Result<()> {
    ponter_agent::logging::init();

    // One-instance guard (ADR-79, replaces `tauri-plugin-single-instance`): a
    // second launch must not open a second window over the same tray/agent.
    // Held for the whole process — the lock releases on exit.
    let _singleton = single_instance::SingleInstance::new("ponter-desktop")
        .expect("acquire the single-instance lock");

    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Ponter Desktop")
            .with_inner_size([800.0, 600.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Ponter Desktop",
        native_options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}
```

Create `apps/desktop/src/app.rs`:

```rust
//! The application object. Owns the message channel, the tokio runtime, and the
//! screen router state. `logic` drains the channel and dispatches commands;
//! `ui` renders the current screen. (eframe 0.36 calls `logic` before each
//! `ui`, and also while the window is hidden when a repaint was requested — so
//! background `Msg`s are still folded in with the window hidden.)

use crate::core::error;
use eframe::egui;

/// Which top-level screen is showing. The router in `ui::mod` picks it from
/// `CoreState` each frame; this field only carries the manual overrides
/// (`editing_server`, wizard step).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    ServerSetup,
    Login,
    Wizard,
    Devices,
    Settings,
}

/// A user intent emitted by a screen or the tray. The app turns each into
/// background work on the tokio runtime.
#[derive(Debug)]
pub enum Command {
    Login { username: String, password: String },
    Logout,
    ProbeServer { url: String },
    SaveServer { url: String },
    ProbeCapture,
    RegisterDevice { capabilities: Vec<String> },
    DeleteDevice { id: String },
    RefreshDevices,
    CheckUpdate,
    ApplyUpdate,
    SetAutostart { enabled: bool },
    ToggleAllowInput { enabled: bool },
    SetTheme { theme: String },
    /// Start the hosted agent runtime (§5.4). Idempotent: a second start while
    /// one runs is a no-op.
    StartAgent,
    /// Stop the hosted agent runtime (§5.4). A no-op when nothing runs.
    StopAgent,
    /// Stop the agent (if any) and exit the process.
    Quit,
}

/// A tray menu action, injected by the tray thread (Task 17) as
/// `Msg::Tray(..)` so the app can turn it into the matching `Command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayRequest {
    StartAgent,
    StopAgent,
    OpenWindow,
    ToggleAutostart,
    Quit,
}

/// A result reported back from a background task (or the tray) to the app.
#[derive(Debug)]
pub enum Msg {
    ServerProbed(crate::core::wizard::ProbeResult),
    ConfigSaved(Result<(), String>),
    LoggedIn(crate::core::auth::UserProfile),
    LoginFailed(String),
    CaptureProbed(crate::core::wizard::ProbeResult),
    WizardAdvanced,
    WizardCompleted,
    AutostartToggled(bool),
    DevicesLoaded(Result<Vec<crate::core::devices::DesktopDevice>, String>),
    FleetChanged,
    DeviceRegistered(Result<crate::core::devices::DesktopDevice, String>),
    DeviceDeleted(Result<String, String>),
    UpdateChecked(Result<Option<crate::core::updater::UpdateInfo>, String>),
    UpdateApplied(Result<(), String>),
    AgentStarted(Result<(), String>),
    AgentStopped(Result<(), String>),
    /// A tray menu action (Task 17).
    Tray(TrayRequest),
}

/// The shell's root object.
pub struct App {
    /// Background task -> app channel.
    pub(crate) tx: tokio::sync::mpsc::Sender<Msg>,
    rx: tokio::sync::mpsc::Receiver<Msg>,
    /// The single multi-thread runtime all async work is spawned onto.
    pub(crate) rt: tokio::runtime::Runtime,
    /// Current screen (overridden by the router each frame).
    pub screen: Screen,
}

impl App {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("building the tokio runtime");
        Self {
            tx,
            rx,
            rt,
            screen: Screen::ServerSetup,
        }
    }

    /// Fold one background message into the app state.
    pub(crate) fn handle_msg(&mut self, msg: Msg) {
        // Populated by later tasks (auth, devices, updater, ...). Task 1 only
        // needs the drain to exist and compile.
        let _ = msg;
    }
}

impl eframe::App for App {
    fn logic(&mut self, _ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(msg) = self.rx.try_recv() {
            self.handle_msg(msg);
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Task 1: a placeholder. The router (Task 14) replaces this body.
        ui.heading("Ponter Desktop");
        ui.label(format!("screen: {:?}", self.screen));
        let _ = error::AUTH_FAILED_PREFIX;
    }
}
```

- [ ] **Step 5: Move the icon set to the crate root**

The new crate's icons live at `apps/desktop/icons/` (spec §4.1), but the set
currently sits at `apps/desktop/src-tauri/icons/` and that whole tree is deleted
in Task 18. Copy it now, so the tray (Task 17), the AppImage script, and the
Windows tray all reference a path that survives the deletion:

```bash
git mv apps/desktop/src-tauri/icons apps/desktop/icons
```

The PNG set and `icon.ico` are what the tray and the packaging scripts consume;
keep them byte-identical.

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `apps/desktop`):

```bash
cargo test --locked
```

Expected: `test result: ok. 2 passed`, `0 failed`.

- [ ] **Step 7: Verify the crate formats and lints clean**

Run (from `apps/desktop`):

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/Cargo.toml apps/desktop/Cargo.lock \
        apps/desktop/src/main.rs apps/desktop/src/app.rs \
        apps/desktop/src/core/mod.rs apps/desktop/src/core/error.rs \
        apps/desktop/icons
git commit -m "feat(desktop): add ponter-desktop crate skeleton on eframe (ADR-79)"
```

---

### Task 2: `test_util` + `core::config` (ported)

**Files:**
- Create: `apps/desktop/src/core/test_util.rs`
- Create: `apps/desktop/src/core/config.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/config.rs` (in-file tests)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `config::PersistedConfig` — `{ server_url: Option<String>, allow_input: bool, theme: Option<String> }`, `serde` camelCase, `Default`.
  - `config::load_config(path: &Path) -> PersistedConfig` (never errors).
  - `config::save_config(path: &Path, cfg: &PersistedConfig) -> Result<(), String>`.
  - `config::resolve_server_url(env: Option<&str>, persisted: Option<&str>, build_default: Option<&str>) -> String`.
  - `test_util::{keychain_lock, ensure_provider, spawn_stub, spawn_stub_routing, spawn_stub_capturing_body, spawn_stub_capturing}`.

**TEST-INTEGRITY declaration (this file):** ports all **12** tests from
`config.rs` (names preserved) and adds **1** test
(`default_config_has_input_gate_closed`, pinning guard (a)). File test count
**12 → 13**.

- [ ] **Step 1: Port `test_util.rs` verbatim**

Copy `apps/desktop/src-tauri/src/test_util.rs` to `apps/desktop/src/core/test_util.rs` **unchanged**, except add the module attribute at the top so it is only compiled for tests:

```rust
#![cfg(test)]
```

Insert that line above the existing `//!` module doc. The file is `#[cfg(test)]`-only support code (0 `#[test]` functions). Its public items (`KEYCHAIN_TEST_LOCK`, `keychain_lock`, `ensure_provider`, `spawn_stub`, `spawn_stub_routing`, `spawn_stub_capturing_body`, `spawn_stub_capturing`) keep their exact names and signatures — later tasks import them.

- [ ] **Step 2: Write the failing test (port `config.rs`)**

Copy `apps/desktop/src-tauri/src/config.rs` to `apps/desktop/src/core/config.rs` and change **only** the module's use paths: the file has no `crate::` imports to fix (it uses `std` + `serde`), so the body is byte-identical apart from the module doc first line. Keep the module doc, the `PersistedConfig` shape, and all four functions exactly as they are.

The 12 tests move verbatim — do not rename or edit them:

`resolve_prefers_runtime_env`, `resolve_falls_to_persisted_when_env_absent`,
`resolve_falls_to_build_default`, `resolve_falls_to_localhost_when_all_unset`,
`resolve_treats_whitespace_only_as_unset`, `resolve_trims_trailing_slashes`,
`resolve_treats_slash_only_as_unset`, `resolve_slash_only_all_levels_falls_to_localhost`,
`load_missing_file_is_default`, `load_corrupt_json_is_default`,
`load_partial_json_defaults_absent_fields`,
`save_then_load_round_trips_and_creates_parent_dir`.

Then add **one** new test (guard (a)) — the input gate must default to closed.
No ported test pins this, because `load_missing_file_is_default` compares two
`PersistedConfig::default()` values and moves with the derive:

```rust
    #[test]
    fn default_config_has_input_gate_closed() {
        // Guard (a): remote input is gated off by default. Flipping the default
        // to `true` must turn this red.
        assert!(!PersistedConfig::default().allow_input);
    }
```

- [ ] **Step 3: Wire the modules into `core/mod.rs`**

Edit `apps/desktop/src/core/mod.rs` to:

```rust
//! GUI-free core logic. Every module here is unit-testable without a display.

pub mod config;
pub mod error;

#[cfg(test)]
pub mod test_util;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `apps/desktop`):

```bash
cargo test --locked core::config
```

Expected: `test result: ok. 13 passed`, `0 failed`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `15 passed` (2 error + 13 config), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/config.rs \
        apps/desktop/src/core/test_util.rs
git commit -m "feat(desktop): port config + HTTP test harness to core (ADR-79)"
```

---

### Task 3: `core::keychain` (ported) + error classification

**Files:**
- Create: `apps/desktop/src/core/keychain.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/keychain.rs` (in-file tests)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `keychain::set_secret(service: &str, account: &str, secret: &str) -> anyhow::Result<()>`
  - `keychain::get_secret(service: &str, account: &str) -> anyhow::Result<Option<String>>`
  - `keychain::delete_secret(service: &str, account: &str) -> anyhow::Result<()>`
  - `keychain::classify(err: keyring::Error) -> KeychainError` where `enum KeychainError { NoEntry, Other(String) }` — the pure classifier Review Focus #1 pins.

**TEST-INTEGRITY declaration (this file):** ports **1** test
(`round_trips_a_secret`, unchanged) and adds **1** new test
(`classify_distinguishes_no_entry_from_other_errors`) for Review Focus #1. File
test count **1 → 2**.

- [ ] **Step 1: Port `keychain.rs` and add the pure classifier**

Copy `apps/desktop/src-tauri/src/keychain.rs` to `apps/desktop/src/core/keychain.rs`. Keep `set_secret` / `get_secret` / `delete_secret` and the `round_trips_a_secret` test byte-identical. Add, above the `#[cfg(test)]` block:

```rust
/// The two outcomes that matter to a caller: the entry is absent (a normal
/// "no credential yet"), or the store failed for some other reason (locked,
/// denied, backend error). A locked store must NOT read as "no credential".
#[derive(Debug, PartialEq, Eq)]
pub enum KeychainError {
    /// `keyring::Error::NoEntry` — the account simply has nothing stored.
    NoEntry,
    /// Any other failure, rendered for display.
    Other(String),
}

/// Classify a keyring error. Pure, so it is unit-tested without a real store.
pub fn classify(err: keyring::Error) -> KeychainError {
    match err {
        keyring::Error::NoEntry => KeychainError::NoEntry,
        other => KeychainError::Other(other.to_string()),
    }
}
```

Then make `get_secret` use it, so the distinction is load-bearing (replace its body's error handling):

```rust
pub fn get_secret(service: &str, account: &str) -> anyhow::Result<Option<String>> {
    let entry = keyring::Entry::new(service, account)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(e) => match classify(e) {
            KeychainError::NoEntry => Ok(None),
            KeychainError::Other(msg) => Err(anyhow::anyhow!("{msg}")),
        },
    }
}
```

Apply the same `classify` split in `delete_secret` (idempotent on `NoEntry`; `Other` bubbles as `Err`) so both entry points share one classification. If the ported file's existing body already matches this behaviour, this is a refactor to route both through `classify` — keep the observable contract identical.

- [ ] **Step 2: Write the failing test for the classifier**

Add to the `tests` module in `core/keychain.rs`:

```rust
#[test]
fn classify_distinguishes_no_entry_from_other_errors() {
    assert_eq!(classify(keyring::Error::NoEntry), KeychainError::NoEntry);
    let other = keyring::Error::PlatformFailure(Box::new(std::io::Error::other("store locked")));
    match classify(other) {
        KeychainError::Other(msg) => assert!(msg.contains("store locked")),
        KeychainError::NoEntry => panic!("a platform failure must not classify as NoEntry"),
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run (from `apps/desktop`):

```bash
cargo test --locked core::keychain
```

Expected: `test result: ok. 2 passed`, `0 failed` (`round_trips_a_secret` is
skipped when `PONTER_KEYCHAIN_SKIP` is set, but still counts as passed).
If the `PlatformFailure` variant does not accept a `Box<dyn Error + Send + Sync>`
in keyring 4.2.0, use the variant's real payload type — inspect
`keyring::Error` in the crate source and adapt the constructor; the assertion
(the two arms differ) is what must hold.

- [ ] **Step 4: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `17 passed`, `0 failed`; fmt and clippy exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/keychain.rs
git commit -m "feat(desktop): port keychain with explicit no-entry vs failure classification"
```

---

### Task 4: `core::state` (CoreState) + wire it into `App`

**Files:**
- Create: `apps/desktop/src/core/state.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Modify: `apps/desktop/src/app.rs`
- Test: `apps/desktop/src/core/state.rs` (in-file tests)

**Interfaces:**
- Consumes: `config::{PersistedConfig, load_config, resolve_server_url}`, `keychain`.
- Produces:
  - `state::CoreState` — the single in-process state object (§4.4).
  - `state::CoreState::with_config(config_path: Option<PathBuf>) -> CoreState` (infallible).
  - `state::CoreState::config_dir() -> Option<PathBuf>` — resolves `<config_dir>/com.ponter.desktop` via `directories::BaseDirs`.
  - `state::CoreState::wizard_completed(&self) -> bool` — reads a `wizard_completed: Mutex<bool>` flag (default `false`), set when `Msg::WizardCompleted` is folded in (Task 16). The router (Task 14) reads it.
  - `state::CoreState::mark_wizard_completed(&self)` — sets the flag; the `Msg::WizardCompleted` arm (Task 16) calls it.
  - `state::CoreState::set_has_server_url(&self, value: bool)` — sets the `has_server_url` flag (an `AtomicBool`); the `SaveServer`/`ToggleAllowInput`/`SetTheme` arms (Task 16) call it after a save so the router leaves Server Setup in-session. Mirrors the Tauri `save_config` regression (`save_config_impl_sets_has_server_url_for_same_session_get_config`).
  - Fields read by later tasks: `http: reqwest::Client`, `server_url: Mutex<String>`, `access_token: Mutex<Option<String>>`, `allow_input: Mutex<bool>`, `config_path: Option<PathBuf>`, `persisted: Mutex<PersistedConfig>`, `theme: Mutex<Option<String>>`. The `has_server_url` field is private; readers call `state.has_server_url()` (an `AtomicBool::load`).

**TEST-INTEGRITY declaration (this file):** ports **2** tests
(`with_config_none_defaults_to_localhost`,
`with_config_loads_persisted_server_url_and_sets_has_server_url`, unchanged in
substance) and adds **1** continuity test
(`config_dir_uses_com_ponter_desktop_identifier`). File test count **2 → 3**.

- [ ] **Step 1: Port `state.rs` and add config-dir resolution**

Copy `apps/desktop/src-tauri/src/state.rs` to `apps/desktop/src/core/state.rs`, then:

1. Rename `AppState` → `CoreState` (and the `impl`/`Default` blocks).
2. Add a `theme: Mutex<Option<String>>` field, initialized from
   `persisted.theme` in `with_config`.
3. Change `has_server_url: bool` to `has_server_url: std::sync::atomic::AtomicBool`
   (the router reads it across threads from spawned tasks, which take a
   `&CoreState`; a plain `bool` cannot be mutated there), with two accessors:

```rust
/// Whether a real source supplied the URL. Read by the router (Task 14).
pub fn has_server_url(&self) -> bool {
    self.has_server_url.load(std::sync::atomic::Ordering::Relaxed)
}

/// Mark that a real server URL is now set (called after a successful save, so
/// the router leaves Server Setup within the same session — the Tauri
/// `save_config` regression).
pub fn set_has_server_url(&self, value: bool) {
    self.has_server_url.store(value, std::sync::atomic::Ordering::Relaxed);
}
```

4. Add a `wizard_completed: Mutex<bool>` field (default `false`) and the two
   methods the router and the `Msg::WizardCompleted` arm use:

```rust
/// True once the setup wizard's "Done" step has run this session. The router
/// uses it to pick the Devices screen; it is not persisted (matching the Vue
/// app, where the wizard re-shows until the config is saved).
pub fn wizard_completed(&self) -> bool {
    *self.wizard_completed.lock().unwrap()
}

/// Set by the `Msg::WizardCompleted` arm (Task 16) when the wizard's Done step
/// runs.
pub fn mark_wizard_completed(&self) {
    *self.wizard_completed.lock().unwrap() = true;
}
```

4. Replace Tauri's `app.path().app_config_dir()` usage: the struct no longer
   takes a resolved dir from Tauri — `with_config(config_path)` already takes
   one. Add the resolver the app uses at startup:

```rust
/// The per-platform config directory for this app's identifier, matching the
/// Tauri app's `app_config_dir()` so an upgraded install finds `config.json`
/// in place (continuity invariant §9.3).
///
/// Linux:   `$XDG_CONFIG_HOME/com.ponter.desktop` (usually `~/.config/...`)
/// Windows: `%APPDATA%\com.ponter.desktop`
pub fn config_dir() -> Option<PathBuf> {
    directories::BaseDirs::new()
        .map(|b| b.config_dir().join("com.ponter.desktop"))
}
```

4. Keep the `with_config` body otherwise identical: install the rustls ring
   provider once, read `PONTER_SERVER_URL` and `option_env!("PONTER_DEFAULT_SERVER_URL")`,
   compute `has_server_url` (any non-blank of the three sources), resolve the
   URL via `config::resolve_server_url`.

- [ ] **Step 2: Write the continuity test**

Add to `core/state.rs`'s `tests` module:

```rust
#[test]
fn config_dir_uses_com_ponter_desktop_identifier() {
    // Continuity invariant (§9.3): the identifier must not change, or an
    // upgraded install loses its config.json.
    let dir = config_dir().expect("a home dir exists in the test environment");
    assert!(
        dir.ends_with("com.ponter.desktop"),
        "config dir must end with the app identifier, got {dir:?}"
    );
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run (from `apps/desktop`):

```bash
cargo test --locked core::state
```

Expected: `test result: ok. 3 passed`, `0 failed`.

- [ ] **Step 4: Wire `CoreState` into `App`**

Edit `apps/desktop/src/app.rs`:

- Add `pub state: std::sync::Arc<crate::core::state::CoreState>` to `App`.
- In `App::new`, build it before the runtime (Task 16 replaces `App::new`
  wholesale with the complete field-initialization block; this step is the
  minimal version that compiles and passes through Task 15):

```rust
let config_path = crate::core::state::config_dir().map(|d| d.join("config.json"));
let state = std::sync::Arc::new(crate::core::state::CoreState::with_config(config_path));
```

- Set the initial screen from the state so first paint is correct without an
  async gate (the Vue `configLoaded` gate is dropped, §5.2):

```rust
let screen = if !state.has_server_url() {
    Screen::ServerSetup
} else {
    Screen::Login
};
```

- Add `mod config; mod keychain; mod state;` to `core/mod.rs`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `20 passed` (2 error + 13 config + 2 keychain + 3 state), `0 failed`;
fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/state.rs \
        apps/desktop/src/app.rs
git commit -m "feat(desktop): add CoreState with config-dir continuity (ADR-79)"
```

---

### Task 5: `core::auth` (ported) + keychain-identifier continuity

**Files:**
- Create: `apps/desktop/src/core/auth.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/auth.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::keychain::{set_secret, get_secret, delete_secret}`, `core::state::CoreState`.
- Produces:
  - `auth::KEYCHAIN_SERVICE` — `pub const KEYCHAIN_SERVICE: &str = "ponter-desktop"`.
  - `auth::KEYCHAIN_REFRESH_ACCOUNT` — `pub const KEYCHAIN_REFRESH_ACCOUNT: &str = "refresh-token"`.
  - `auth::UserProfile` — `{ id: String, username: String, email: Option<String>, role: String }`, `Serialize` + `Deserialize`, `serde(rename_all = "camelCase")`.
  - `auth::ServerUser` — the login-response shape (`id`, `username`, `email: Option<String>`, `role`), `Deserialize`, camelCase.
  - `auth::LoginSuccess { user: ServerUser, token: String, refresh_token: String, expires_in: i64 }`.
  - `auth::LoginOutcome { user: UserProfile, token: String, refresh_token: String }`.
  - `auth::parse_login_response(body: &str) -> Result<LoginOutcome, String>`.
  - `auth::map_login_error(status: u16, body: &str) -> String`.
  - `auth::login_impl(client: &reqwest::Client, server_url: &str, username: &str, password: &str, access_slot: &std::sync::Mutex<Option<String>>) -> Result<LoginOutcome, String>`.
  - `auth::logout_impl(state: &CoreState) -> Result<(), String>`.

**TEST-INTEGRITY declaration (this file):** ports **5** tests from
`commands/login.rs` (`parses_success_response`, `maps_server_error`,
`login_stores_refresh_token_in_keychain`, `login_surfaces_server_error`,
`logout_impl_clears_token_and_deletes_keychain` — names preserved) and adds
**1** continuity test (`keychain_identifiers_are_unchanged`). File test count
**5 → 6**.

- [ ] **Step 1: Port `login.rs` to `core/auth.rs`**

Copy `apps/desktop/src-tauri/src/commands/login.rs` to
`apps/desktop/src/core/auth.rs`, then make exactly these changes:

1. Delete the Tauri imports; use `use crate::core::{keychain, state::CoreState};`.
2. `KEYCHAIN_SERVICE` and `KEYCHAIN_REFRESH_ACCOUNT` keep their exact values.
3. `login_impl` takes `client: &reqwest::Client` as its first parameter (the
   Tauri version pulled it from managed state) and returns
   `Result<LoginOutcome, String>`. Its body is unchanged: `POST {server_url}/api/auth/login`
   with JSON `{username, password}`, non-2xx → `map_login_error(status, body)`,
   2xx → `parse_login_response(body)`, then `keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, &outcome.refresh_token)`
   (a failed write is a loud `Err`, never swallowed), and
   `*access_slot.lock().unwrap() = Some(outcome.token.clone())` (access token in
   memory only — never persisted).
4. `logout_impl(state: &CoreState)` clears `state.access_token` and calls
   `keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)`.
5. Replace every `tauri::async_runtime::block_on(fut)` in the tests with
   `tokio::runtime::Runtime::new().unwrap().block_on(fut)`.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `pub mod auth;` to `apps/desktop/src/core/mod.rs`. Run (from `apps/desktop`):

```bash
cargo test --locked core::auth
```

Expected: `test result: ok. 5 passed`, `0 failed`.

- [ ] **Step 3: Write the continuity test (fails: identifier not asserted)**

Add to `core/auth.rs`'s `tests` module:

```rust
#[test]
fn keychain_identifiers_are_unchanged() {
    // Continuity invariant (§9.3): an upgraded install must still find its
    // stored refresh token under the same service + account.
    assert_eq!(KEYCHAIN_SERVICE, "ponter-desktop");
    assert_eq!(KEYCHAIN_REFRESH_ACCOUNT, "refresh-token");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --locked core::auth`
Expected: `test result: ok. 6 passed`, `0 failed`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `26 passed` (20 + 6), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/auth.rs
git commit -m "feat(desktop): port auth (login/logout) to core with keychain continuity"
```

---

### Task 6: `core::session` (ported) — refresh, retry-once, auth-death classification

**Files:**
- Create: `apps/desktop/src/core/session.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/session.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::auth::{KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT}`, `core::keychain`, `core::error::{AUTH_FAILED_PREFIX, REFRESH_FAILED_PREFIX, is_auth_error}`, `core::state::CoreState`.
- Produces:
  - `session::is_auth_fatal_status(status: u16) -> bool` — **guard (d)**: `true` for `401`, `false` for `403` and everything else.
  - `session::map_refresh_error(status: u16, body: &str) -> String` — `401` or a body whose `code == "UNAUTHORIZED"` ⇒ returns `format!("{REFRESH_FAILED_PREFIX}: …")`; `403` with `code == "AGENT_LIMIT_REACHED"` ⇒ returns the server message (not auth-fatal).
  - `session::retry_once_on_401<T, F>(...)` — runs `F`; on `401` refreshes once and retries exactly once; if the refresh fails it returns the `REFRESH_FAILED_PREFIX` error and **does not retry again** — **guard (e)**.
  - Re-uses `error::REFRESH_FAILED_PREFIX`; it does **not** re-declare the constant (Task 1 owns it).

**TEST-INTEGRITY declaration (this file):** ports all **9** tests from
`commands/session.rs` verbatim (names preserved). No test is added or removed.
File test count **9 → 9**. Guards (d) and (e) are pinned by the ported
`is_auth_fatal_status_*` and `retry_once_on_401_*` tests respectively — confirm
on port that each is present; if the source names differ, keep the source names.

- [ ] **Step 1: Port `session.rs` to `core/session.rs`**

Copy `apps/desktop/src-tauri/src/commands/session.rs` to
`apps/desktop/src/core/session.rs`, then:

1. Delete the Tauri imports; use `crate::core::{auth, error, keychain, state::CoreState}`.
2. Delete any local `REFRESH_FAILED_PREFIX`/`AUTH_FAILED_PREFIX` declaration and
   use `crate::core::error::{REFRESH_FAILED_PREFIX, AUTH_FAILED_PREFIX, is_auth_error}`.
3. Keep `is_auth_fatal_status`, `map_refresh_error`, and `retry_once_on_401`
   bodies byte-identical (only import paths change). `retry_once_on_401` must
   call `keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)` to
   obtain the refresh token and `keychain::set_secret(...)` to rotate it.
4. Replace `tauri::async_runtime::block_on` in tests with
   `tokio::runtime::Runtime::new().unwrap().block_on`.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `pub mod session;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::session
```

Expected: `test result: ok. 9 passed`, `0 failed`.

- [ ] **Step 3: Verify the two guards are pinned**

Read the ported `tests` module and confirm both of these hold (they pin guards
(d) and (e)); if either is missing, add the test shown, otherwise leave the
ported tests untouched:

```rust
#[test]
fn is_auth_fatal_status_classifies_401_fatal_and_403_not() {
    assert!(is_auth_fatal_status(401));
    assert!(!is_auth_fatal_status(403)); // AGENT_LIMIT_REACHED is not auth-fatal
    assert!(!is_auth_fatal_status(500));
}
```

- [ ] **Step 4: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `35 passed`, `0 failed`; fmt and clippy exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/session.rs
git commit -m "feat(desktop): port session (refresh, retry-once, auth-death) to core"
```

---

### Task 7: `core::devices` (ported) — registration, listing, deletion, no-credential invariant

**Files:**
- Create: `apps/desktop/src/core/devices.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/devices.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::keychain`, `core::error::{AUTH_FAILED_PREFIX, is_auth_error}`, `core::session::retry_once_on_401`, `core::state::CoreState`.
- Produces:
  - `devices::AGENT_CREDENTIAL_ACCOUNT` — `pub const AGENT_CREDENTIAL_ACCOUNT: &str = "agent-credential"`.
  - `devices::DesktopDevice` — `{ id: String, user_id: String, hostname: String, platform: String, os_version: String, agent_version: String, public_key: String, signing_public_key: Option<String>, is_online: bool, last_heartbeat: Option<String>, capabilities: Vec<String>, created_at: String }` — the **exact** shape of the Tauri `DesktopDevice`, `Serialize` + `Deserialize`, camelCase. **No credential/token/secret field** — **guard (f)**.
  - `devices::generate_device_id(hostname: &str, random: [u8; 4]) -> String`.
  - `devices::map_devices_error(status: u16, body: &str) -> String`.
  - `devices::is_auth_error(err: &str) -> bool` — delegates to `error::is_auth_error`.
  - `devices::register_device_impl(client, server_url, token, capabilities) -> Result<DesktopDevice, String>` — stores the returned credential in the keychain under `AGENT_CREDENTIAL_ACCOUNT`; returns the device **without** the credential.
  - `devices::list_devices_impl(client, server_url, token) -> Result<Vec<DesktopDevice>, String>`.
  - `devices::delete_device_impl(client, server_url, token, id) -> Result<String, String>`.

**TEST-INTEGRITY declaration (this file):** ports all **20** tests from
`commands/devices.rs` verbatim (names preserved) and adds **1** test
(`device_payload_has_no_credential_and_account_is_unchanged`, pinning guard (f)
and the §9.3 agent-credential continuity). File test count **20 → 21**.

- [ ] **Step 1: Port `devices.rs` to `core/devices.rs`**

Copy `apps/desktop/src-tauri/src/commands/devices.rs` to
`apps/desktop/src/core/devices.rs`, then:

1. Delete the Tauri imports; use `crate::core::{error, keychain, session, state::CoreState}`.
2. Keep `AGENT_CREDENTIAL_ACCOUNT`, `generate_device_id`, `map_devices_error`,
   and the three `*_impl` functions' bodies byte-identical apart from import
   paths. `register_device_impl` must write the credential to the keychain
   (`keychain::set_secret(auth::KEYCHAIN_SERVICE, AGENT_CREDENTIAL_ACCOUNT, &credential)`)
   and return a `DesktopDevice` that has **no** credential field.
3. `is_auth_error` becomes a thin delegate to `crate::core::error::is_auth_error`
   (so the prefix lives in one place).
4. Replace `tauri::async_runtime::block_on` in tests with
   `tokio::runtime::Runtime::new().unwrap().block_on`.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `pub mod devices;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::devices
```

Expected: `test result: ok. 20 passed`, `0 failed`.

- [ ] **Step 3: Write the guard-(f) + continuity test**

Add to `core/devices.rs`'s `tests` module:

```rust
#[test]
fn device_payload_has_no_credential_and_account_is_unchanged() {
    // Guard (f): the credential stays in the keychain; the device object the
    // shell holds must carry no secret of any kind.
    let device = DesktopDevice {
        id: "d1".into(),
        user_id: "u1".into(),
        hostname: "workstation".into(),
        platform: "linux".into(),
        os_version: "unknown".into(),
        agent_version: "0.1.0".into(),
        public_key: "pk".into(),
        signing_public_key: None,
        is_online: true,
        last_heartbeat: None,
        capabilities: vec!["terminal".into(), "desktop".into()],
        created_at: "2026-10-13T00:00:00Z".into(),
    };
    let json = serde_json::to_string(&device).unwrap();
    for forbidden in ["credential", "token", "secret", "password"] {
        assert!(
            !json.contains(forbidden),
            "serialized device must not contain `{forbidden}`: {json}"
        );
    }
    // Continuity invariant (§9.3): the agent credential account is unchanged.
    assert_eq!(AGENT_CREDENTIAL_ACCOUNT, "agent-credential");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --locked core::devices`
Expected: `test result: ok. 21 passed`, `0 failed`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `56 passed`, `0 failed`; fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/devices.rs
git commit -m "feat(desktop): port devices with no-credential-on-device invariant"
```

---

### Task 8: `core::wizard` (ported) — health probe, capture probe, config payload

**Files:**
- Create: `apps/desktop/src/core/wizard.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/wizard.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::state::CoreState`, `core::config::PersistedConfig`, `ponter_agent::probe_capture` (`#[cfg(not(target_env = "musl"))]`).
- Produces:
  - `wizard::ProbeResult` — `{ ok: bool, message: String }`, `Serialize` + `Deserialize`, camelCase (used as the `Msg::ServerProbed`/`Msg::CaptureProbed` payload in `app.rs`).
  - `wizard::map_health_response(status: u16, body: &str) -> ProbeResult`.
  - `wizard::probe_server_impl(client: &reqwest::Client, url: &str) -> Result<ProbeResult, String>` — `GET {url}/health`.
  - `wizard::probe_capture() -> Result<ProbeResult, String>` — an **async** wrapper (the agent's probe is `pub async fn probe_capture() -> Result<CaptureProbe, String>`): `.await` it and map `CaptureProbe { source_id, width, height, kind }` into a `ProbeResult`. The `Command::ProbeCapture` arm (Task 16) awaits it inside its spawned task.
  - `wizard::ConfigPayload { server_url: Option<String>, allow_input: bool, theme: Option<String>, has_server_url: bool }`, `Serialize`, camelCase — the **exact four fields** of the Tauri `ConfigPayload` (the ported `config_payload_*` tests assert on `server_url` and `has_server_url`).
  - `wizard::config_payload(state: &CoreState) -> Result<ConfigPayload, String>`.
  - `wizard::save_config_impl(state: &CoreState, server_url: Option<&str>, allow_input: bool, theme: Option<&str>) -> Result<(), String>` — the **exact four-argument** signature of the Tauri impl. Normalizes + persists via `config::save_config`, mirrors into `CoreState` (`server_url`, `allow_input`, `theme`), and a blank `server_url` is ignored; `None` leaves the URL unchanged (a theme-only save). The `has_server_url` flag is left to the caller (Task 16's arms call `state.set_has_server_url(true)` after a successful save), matching the Tauri in-session regression.

**TEST-INTEGRITY declaration (this file):** ports all **19** tests from
`commands/wizard.rs` verbatim (names preserved). No test is added or removed.
File test count **19 → 19**.

- [ ] **Step 1: Port `wizard.rs` to `core/wizard.rs`**

Copy `apps/desktop/src-tauri/src/commands/wizard.rs` to
`apps/desktop/src/core/wizard.rs`, then:

1. Delete the Tauri imports; use `crate::core::{config, state::CoreState}` and
   `ponter_agent::probe_capture` where the capture probe is invoked.
2. Keep `map_health_response`, `probe_server_impl`, `config_payload`, and
   `save_config_impl` bodies byte-identical apart from import paths — **same
   signatures** (`config_payload(state) -> Result<ConfigPayload, String>`,
   `save_config_impl(state, server_url: Option<&str>, allow_input, theme:
   Option<&str>) -> Result<(), String>`). `CoreState` mirrors `AppState`'s field
   names (`persisted`, `server_url`, `allow_input`, `config_path`,
   `has_server_url`), so the ported bodies compile unchanged.
3. `probe_capture()` is `pub async fn probe_capture() -> Result<ProbeResult, String>`:
   it `.await`s `ponter_agent::probe_capture()` and maps
   `CaptureProbe { source_id, width, height, kind }` into a `ProbeResult`
   (success message names the source and dimensions). The `probe_capture`
   import is gated `#[cfg(not(target_env = "musl"))]`; the musl build is not
   produced by CI, so a `#[cfg]`-guarded stub returning
   `Err("capture probe unsupported on this target".into())` is acceptable for
   the musl path.
4. Replace `tauri::async_runtime::block_on` in tests with
   `tokio::runtime::Runtime::new().unwrap().block_on`.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `pub mod wizard;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::wizard
```

Expected: `test result: ok. 19 passed`, `0 failed`.

- [ ] **Step 3: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `75 passed`, `0 failed`; fmt and clippy exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/wizard.rs
git commit -m "feat(desktop): port wizard (health/capture probe, config payload) to core"
```

---

### Task 9: `autostart` (ported) — Linux `.desktop` / Windows Run key

**Files:**
- Create: `apps/desktop/src/autostart.rs` (follows the authoritative directory layout of Spec §4.1; Spec §7.2's `core/autostart.rs` is an editorial typo)
- Modify: `apps/desktop/src/main.rs`
- Test: `apps/desktop/src/autostart.rs` (in-file tests)

**Interfaces:**
- Consumes: nothing from other tasks (pure `std` + platform APIs).
- Produces (the **exact** names the ported file already uses — do not rename):
  - `autostart::set_autostart(enabled: bool) -> Result<(), String>` — installs/removes the real platform entry.
  - `autostart::is_autostart_enabled() -> bool` — reflects the entry's presence.
  - `autostart::render_linux_desktop_entry(binary: &Path) -> String`.
  - `autostart::windows_run_add_args(binary: &Path) -> Vec<String>` and
    `autostart::windows_run_delete_args() -> Vec<String>`.
  - `autostart::linux_autostart_dir(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf`
    and the file helpers `write_entry` / `remove_entry` / `entry_exists` (the
    ported tests exercise these).
  - Constants `LINUX_ENTRY_FILE`, `WINDOWS_RUN_VALUE`, `WINDOWS_RUN_KEY`.

**Caller (Task 16):** the `Command::SetAutostart` arm calls
`crate::autostart::set_autostart(enabled)` — **not** `enable()`/`disable()`.
The single `set_autostart(bool)` entry point is the ported API; the boolean
argument replaces the two-command split.

**Path note (spec §4.1 vs §7.2):** the spec's §4.1 crate layout lists
`src/autostart.rs` as a sibling of `main.rs`; §7.2's table calls it
`core/autostart.rs`. **§4.1 is authoritative** — `autostart` touches the OS
autostart surface directly (filesystem / registry) and is a top-level concern,
not GUI-free core logic. §7.2's `core/autostart.rs` is treated as a typo. The
module therefore lives at `apps/desktop/src/autostart.rs`.

**TEST-INTEGRITY declaration (this file):** ports all **12** tests from
`apps/desktop/src-tauri/src/autostart.rs` verbatim (names preserved). No test is
added or removed. File test count **12 → 12**.

- [ ] **Step 1: Port `autostart.rs`**

Copy `apps/desktop/src-tauri/src/autostart.rs` to
`apps/desktop/src/autostart.rs`, then delete the Tauri imports
(`use tauri::...`, `#[tauri::command]` attributes — drop the attributes, keep
the functions; the ported file otherwise uses only `std`, `std::path`, and on
Windows the registry via `std::process`). Keep `set_autostart`,
`is_autostart_enabled`, `render_linux_desktop_entry`, `windows_run_add_args`,
`windows_run_delete_args`, and the file helpers byte-identical. If the source
gated a block on `target_os = "macos"`, **delete that block** (ADR-78); the
Linux and Windows arms are the only ones that remain. The 12 tests port verbatim
and still compile because the ported function names are unchanged.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `mod autostart;` to `apps/desktop/src/main.rs`. Run (from `apps/desktop`):

```bash
cargo test --locked autostart
```

Expected: `test result: ok. 12 passed`, `0 failed`.

- [ ] **Step 3: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `87 passed` (75 + 12), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main.rs apps/desktop/src/autostart.rs
git commit -m "feat(desktop): port autostart (Linux .desktop / Windows Run key)"
```

---

### Task 10: `core::agent_host` — host `ponter-agent` in-process

**Files:**
- Create: `apps/desktop/src/core/agent_host.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/agent_host.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::state::CoreState`, `core::keychain`, `ponter_agent::{AgentRuntime, RuntimeConfig, RuntimeHandle, RuntimeStatus, DesktopSource, StreamProfile, identity::AgentIdentity}`.
- Produces:
  - `agent_host::resolve_identity_path(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf` — continuity: the last segment is `ponter/agent-identity.pkcs8` under the config dir.
  - `agent_host::default_shell() -> String`.
  - `agent_host::build_runtime_config(server_url: &str, credential: Option<&str>, allow_input: bool, identity: std::sync::Arc<AgentIdentity>) -> Result<ponter_agent::RuntimeConfig, String>` — **byte-identical to the ported `tray.rs` body**, so its real values are `stun: "stun:stun.l.google.com:19302"`, `desktop_default_source: "primary"`, `desktop_select_timeout: Duration::from_millis(5000)` (asserted by the ported `build_runtime_config_ok_has_parity_values`).
  - `agent_host::start(state: &CoreState) -> Result<RuntimeHandle, String>` — **async**. Reads the credential from the keychain (`agent-credential`), builds the config, and calls `AgentRuntime::start(config).await` (the real API — there is **no** free `ponter_agent::start`). The caller (Task 16) spawns this on the tokio runtime and sends `Msg::AgentStarted` when it resolves.
  - `agent_host::stop(handle: &RuntimeHandle) -> Result<(), String>` — **async**; calls `handle.stop().await`.
  - `agent_host::load_identity(config_dir: &Path) -> anyhow::Result<Arc<AgentIdentity>>` — `AgentIdentity::load_or_generate(&resolve_identity_path(...))`.

**Status is read from the handle, not a shell-side atomic (spec §4.3).** `RuntimeHandle::status()` already reads the in-process `Arc<AtomicU8>` the agent crate owns; the tray (Task 17) and the Devices view both call `status_text(&handle.status())` on the live handle. The shell therefore does **not** keep a second status atomic — the live handle in `App.agent` (`Arc<Mutex<Option<RuntimeHandle>>>`) is the single source, and reading it is a local atomic read (no network, no timer).

**TEST-INTEGRITY declaration (this file):** ports **6** tests from
`src-tauri/src/tray.rs` — the identity/config half, not the menu half:
`resolve_identity_path_xdg_wins`, `resolve_identity_path_home_fallback`,
`resolve_identity_path_neither`, `build_runtime_config_missing_credential_errs`,
`build_runtime_config_blank_credential_errs`,
`build_runtime_config_ok_has_parity_values` (names preserved). The other 12
`tray.rs` tests move to Task 17. No test is added or removed here. File test
count **0 → 6**.

- [ ] **Step 1: Extract the lifecycle half of `tray.rs`**

Copy from `apps/desktop/src-tauri/src/tray.rs` into the new
`apps/desktop/src/core/agent_host.rs` these items and their tests:
`resolve_identity_path`, `default_shell`, `build_runtime_config`, and the six
tests named above. Delete the Tauri imports; `RuntimeStatus`, `RuntimeConfig`,
`AgentIdentity`, etc. now come from `ponter_agent`. The `build_runtime_config`
body is byte-identical — its real values are
`stun: "stun:stun.l.google.com:19302".to_string()`, `cols: 80`, `rows: 24`,
`desktop_source: DesktopSource::Screen`,
`desktop_profile: StreamProfile::DEFAULT_1080P30`,
`desktop_default_source: "primary".to_string()`,
`desktop_select_timeout: Duration::from_millis(5000)`,
`allow_input`, `files_root: None`, `identity`. (Do **not** "correct" these to
empty strings or whole seconds — the ported test
`build_runtime_config_ok_has_parity_values` asserts exactly these.)

Then add the thin async wrappers (`start`, `stop`) and `load_identity`:

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ponter_agent::identity::AgentIdentity;
use ponter_agent::{AgentRuntime, RuntimeHandle};

/// Read the agent credential, build the config, and start the agent runtime.
/// The credential is read from the keychain; it is never taken from the shell.
/// Async: the caller (Task 16) spawns this on the app's tokio runtime and sends
/// `Msg::AgentStarted` when it resolves.
pub async fn start(state: &crate::core::state::CoreState) -> Result<RuntimeHandle, String> {
    let credential = crate::core::keychain::get_secret(
        crate::core::auth::KEYCHAIN_SERVICE,
        crate::core::devices::AGENT_CREDENTIAL_ACCOUNT,
    )
    .map_err(|e| e.to_string())?;
    let server_url = state.server_url.lock().unwrap().clone();
    let allow_input = *state.allow_input.lock().unwrap();
    let config_dir = crate::core::state::config_dir()
        .ok_or_else(|| "no config directory available".to_string())?;
    let identity = load_identity(&config_dir).map_err(|e| e.to_string())?;
    let config = build_runtime_config(&server_url, credential.as_deref(), allow_input, identity)?;
    // The real agent API is the associated `AgentRuntime::start` — there is no
    // free `ponter_agent::start`.
    let handle = AgentRuntime::start(config).await.map_err(|e| e.to_string())?;
    Ok(handle)
}

pub async fn stop(handle: &RuntimeHandle) -> Result<(), String> {
    handle.stop().await.map_err(|e| e.to_string())
}

pub fn load_identity(config_dir: &Path) -> anyhow::Result<Arc<AgentIdentity>> {
    let path = resolve_identity_path(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    );
    let _ = config_dir; // identity path is derived from XDG/HOME, per §9.3
    let identity = AgentIdentity::load_or_generate(&path)?;
    Ok(Arc::new(identity))
}
```

**Status (spec §4.3).** There is no shell-side status atomic: `RuntimeHandle::status()`
returns a `RuntimeStatus` read from the agent's own in-process atomic, and the
tray (Task 17) calls `status_text(&handle.status())` on the live handle each
time it rebuilds its menu. `AgentRuntime::start` is `async`; `stop` is `async`
— both are awaited by the spawned task, never `block_on`-ed inside another
runtime.

**Note on `PathBuf`:** `resolve_identity_path` returns a `PathBuf` ending in
`ponter/agent-identity.pkcs8`; `load_identity` uses it directly. If the ported
`resolve_identity_path` already takes `(xdg, home)`, keep its signature exactly.

- [ ] **Step 2: Declare the module and run the ported tests**

Add `pub mod agent_host;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::agent_host
```

Expected: `test result: ok. 6 passed`, `0 failed`.

- [ ] **Step 3: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `93 passed` (87 + 6), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/agent_host.rs
git commit -m "feat(desktop): host ponter-agent in-process via core::agent_host"
```

---

### Task 11: `core::fleet_ws` — push-first fleet updates with polling fallback (ADR-82)

**Files:**
- Create: `apps/desktop/src/core/fleet_ws.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/fleet_ws.rs` (in-file tests)

**Interfaces:**
- Consumes: `core::state::CoreState`.
- Produces:
  - `fleet_ws::TicketResponse { ticket: String, expires_in: u64 }`, `Deserialize`, camelCase.
  - `fleet_ws::mint_ticket(client: &reqwest::Client, server_url: &str, access_token: &str) -> Result<String, String>` — `POST {server_url}/api/ws/ticket` with `Authorization: Bearer <token>`; 2xx → parse `TicketResponse` and return `.ticket`; else `Err(format!("ticket request failed (HTTP {status})"))`.
  - `fleet_ws::browser_ws_url(server_url: &str, ticket: &str) -> Result<String, String>` — `http→ws`, `https→wss`, path `/api/ws/browser?ticket=<ticket>`.
  - `fleet_ws::Layer` — `enum Layer { Push, Fallback }`.
  - `fleet_ws::FleetLayerState` — the pure state machine (guard (g)):
    - `FleetLayerState::new() -> Self` — starts in `Push`, poll disarmed.
    - `layer(&self) -> Layer`
    - `poll_armed(&self) -> bool`
    - `on(&mut self, ev: FleetEvent)` where
      `enum FleetEvent { WsConnected, WsUnusable, OriginGateRejected, PollTick, FleetChanged, FetchStarted, FetchFinished }`
    - `should_fetch(&self) -> bool` — true when a fetch is due (a `FleetChanged`
      while idle, or a `PollTick` in `Fallback`), false while a fetch is in flight.
    - `take_dirty(&mut self) -> bool` — consumes the coalesced signal.
  - `fleet_ws::run(state: Arc<CoreState>, tx: Sender<Msg>)` — the long-lived task: mint a ticket, connect, subscribe `fleet-changed`; on any WS failure switch to `Fallback`; poll `GET /api/agents` on the interval; on a successful reconnect disarm the poll **before** marking `Push` active.

**TEST-INTEGRITY declaration (this file):** this is a **new** module with no
Tauri counterpart; adds **10** tests (8 state-machine + 2 network-helper). File
test count **0 → 10**. Guards (g) are
pinned by `ws_unusable_switches_to_fallback_and_arms_poll` and
`successful_reconnect_disarms_poll_before_push_active`; Review Focus #2 by
`signal_during_in_flight_fetch_coalesces_and_replays`; Review Focus #3 by
`origin_gate_403_switches_to_fallback`.

- [ ] **Step 1: Write the pure state machine and its tests**

Create `apps/desktop/src/core/fleet_ws.rs`:

```rust
//! Fleet updates: push-first over the existing browser WebSocket, with a
//! polling fallback (ADR-82). The two layers are mutually exclusive: while the
//! WS is active no poll timer is armed, and switching to the fallback disarms
//! the WS. The transition logic is a pure state machine so it is unit-tested
//! without a socket.

/// Which layer is currently delivering fleet changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// Long-lived `/api/ws/browser` connection is delivering `fleet-changed`.
    Push,
    /// The WS is unusable; a periodic `GET /api/agents` is the source.
    Fallback,
}

/// Inputs to the layer state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetEvent {
    /// The browser WS is connected and subscribed.
    WsConnected,
    /// The WS dropped or the upgrade failed for a non-fatal reason.
    WsUnusable,
    /// The upgrade was rejected by the server's Origin gate (HTTP 403).
    OriginGateRejected,
    /// One fallback poll interval elapsed.
    PollTick,
    /// A `fleet-changed` frame arrived (or a poll found a change).
    FleetChanged,
    /// A `GET /api/agents` started.
    FetchStarted,
    /// That `GET /api/agents` finished.
    FetchFinished,
}

/// The layer state machine. Invariant: `layer == Push` implies
/// `!poll_armed` — the push layer and the poll layer are never active together.
#[derive(Debug)]
pub struct FleetLayerState {
    layer: Layer,
    poll_armed: bool,
    fetch_in_flight: bool,
    dirty: bool,
}

impl FleetLayerState {
    pub fn new() -> Self {
        Self { layer: Layer::Push, poll_armed: false, fetch_in_flight: false, dirty: false }
    }

    pub fn layer(&self) -> Layer {
        self.layer
    }

    pub fn poll_armed(&self) -> bool {
        self.poll_armed
    }

    pub fn on(&mut self, ev: FleetEvent) {
        match ev {
            // A successful (re)connect disarms the poll FIRST, then makes the
            // push layer active — so the two are never both active.
            FleetEvent::WsConnected => {
                self.poll_armed = false;
                self.layer = Layer::Push;
            }
            // Any WS failure — drop, or the Origin gate's 403 — hands over to
            // the fallback and arms the poll.
            FleetEvent::WsUnusable | FleetEvent::OriginGateRejected => {
                self.layer = Layer::Fallback;
                self.poll_armed = true;
            }
            FleetEvent::PollTick => {
                if self.layer == Layer::Fallback {
                    self.dirty = true;
                }
            }
            FleetEvent::FleetChanged => self.dirty = true,
            FleetEvent::FetchStarted => {
                self.fetch_in_flight = true;
                self.dirty = false;
            }
            FleetEvent::FetchFinished => self.fetch_in_flight = false,
        }
        debug_assert!(
            !(self.layer == Layer::Push && self.poll_armed),
            "push layer and poll layer must never be active together"
        );
    }

    /// A fetch is due when a signal is pending and none is in flight. A signal
    /// that arrives mid-flight is coalesced (kept dirty) and replayed after.
    pub fn should_fetch(&self) -> bool {
        self.dirty && !self.fetch_in_flight
    }

    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }
}

impl Default for FleetLayerState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_in_push_layer_with_poll_disarmed() {
        let s = FleetLayerState::new();
        assert_eq!(s.layer(), Layer::Push);
        assert!(!s.poll_armed());
    }

    #[test]
    fn ws_unusable_switches_to_fallback_and_arms_poll() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::WsUnusable);
        assert_eq!(s.layer(), Layer::Fallback);
        assert!(s.poll_armed(), "the fallback must arm its poll");
    }

    #[test]
    fn origin_gate_403_switches_to_fallback() {
        // Review Focus #3: a native client sends no Origin; if CORS_ORIGIN is a
        // concrete value the upgrade is rejected with 403. That must fall back,
        // not retry forever.
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::OriginGateRejected);
        assert_eq!(s.layer(), Layer::Fallback);
        assert!(s.poll_armed());
    }

    #[test]
    fn successful_reconnect_disarms_poll_before_push_active() {
        // Guard (g): a successful reconnect must cancel the poll timer before
        // the WS is marked active, so the two layers are never both active.
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::WsUnusable);
        assert!(s.poll_armed());
        s.on(FleetEvent::WsConnected);
        assert_eq!(s.layer(), Layer::Push);
        assert!(!s.poll_armed(), "reconnect must disarm the poll");
        // Invariant holds after every transition.
        assert!(!(s.layer() == Layer::Push && s.poll_armed()));
    }

    #[test]
    fn signal_during_in_flight_fetch_coalesces_and_replays() {
        // Review Focus #2: a second signal while a fetch is in flight must not
        // start a second fetch and must not be lost.
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::FleetChanged);
        assert!(s.should_fetch());
        s.on(FleetEvent::FetchStarted);
        assert!(!s.should_fetch(), "no second fetch while one is in flight");
        s.on(FleetEvent::FleetChanged); // arrives mid-flight
        assert!(!s.should_fetch());
        s.on(FleetEvent::FetchFinished);
        assert!(s.should_fetch(), "the mid-flight signal must replay");
    }

    #[test]
    fn poll_tick_only_signals_in_fallback() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::PollTick); // in Push: ignored
        assert!(!s.should_fetch());
        s.on(FleetEvent::WsUnusable);
        s.on(FleetEvent::PollTick);
        assert!(s.should_fetch());
    }

    #[test]
    fn take_dirty_consumes_the_signal() {
        let mut s = FleetLayerState::new();
        s.on(FleetEvent::FleetChanged);
        assert!(s.take_dirty());
        assert!(!s.take_dirty());
    }

    #[test]
    fn layers_are_never_both_active_across_a_full_cycle() {
        let mut s = FleetLayerState::new();
        for ev in [
            FleetEvent::WsUnusable,
            FleetEvent::PollTick,
            FleetEvent::WsConnected,
            FleetEvent::WsUnusable,
            FleetEvent::OriginGateRejected,
            FleetEvent::WsConnected,
        ] {
            s.on(ev);
            assert!(
                !(s.layer() == Layer::Push && s.poll_armed()),
                "invariant broke after {ev:?}"
            );
        }
    }
}
```

- [ ] **Step 2: Declare the module and run the tests**

Add `pub mod fleet_ws;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::fleet_ws
```

Expected: `test result: ok. 8 passed`, `0 failed` (the 8 state-machine tests).

- [ ] **Step 3: Add the network helpers (mint + URL) and their tests**

Append to `core/fleet_ws.rs`:

```rust
use serde::Deserialize;

/// The `/api/ws/ticket` response. Field names match the server (camelCase).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketResponse {
    pub ticket: String,
    pub expires_in: u64,
}

/// Mint a one-use browser-WS ticket. `POST {server_url}/api/ws/ticket` with the
/// access token as a bearer credential.
pub async fn mint_ticket(
    client: &reqwest::Client,
    server_url: &str,
    access_token: &str,
) -> Result<String, String> {
    let url = format!("{}/api/ws/ticket", server_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("ticket request failed (HTTP {})", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let parsed: TicketResponse =
        serde_json::from_str(&body).map_err(|e| format!("invalid ticket response: {e}"))?;
    Ok(parsed.ticket)
}

/// Build the browser-WS URL for a minted ticket.
pub fn browser_ws_url(server_url: &str, ticket: &str) -> Result<String, String> {
    let base = server_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if base.starts_with("wss://") || base.starts_with("ws://") {
        base.to_string()
    } else {
        return Err(format!("unsupported server scheme: {server_url}"));
    };
    Ok(format!("{ws_base}/api/ws/browser?ticket={ticket}"))
}
```

Add these two tests to the same `tests` module:

```rust
    #[test]
    fn browser_ws_url_converts_http_and_https() {
        assert_eq!(
            browser_ws_url("http://host:8787", "T").unwrap(),
            "ws://host:8787/api/ws/browser?ticket=T"
        );
        assert_eq!(
            browser_ws_url("https://host/", "T").unwrap(),
            "wss://host/api/ws/browser?ticket=T"
        );
        assert!(browser_ws_url("ftp://host", "T").is_err());
    }

    #[test]
    fn mint_ticket_parses_ticket_and_maps_error() {
        use crate::core::test_util::spawn_stub_routing;
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let server = spawn_stub_routing(vec![
                (
                    "/api/ws/ticket",
                    200,
                    r#"{"ticket":"abc","expiresIn":15}"#,
                ),
            ])
            .await;
            let client = reqwest::Client::new();
            let ticket = mint_ticket(&client, &server.url, "tok").await.unwrap();
            assert_eq!(ticket, "abc");

            let server = spawn_stub_routing(vec![("/api/ws/ticket", 401, r#"{"error":"no"}"#)]).await;
            let err = mint_ticket(&client, &server.url, "tok").await.unwrap_err();
            assert!(err.contains("401"), "got: {err}");
        });
    }
```

(Use whatever request-routing stub `test_util` provides — `spawn_stub_routing`
takes `(path, status, body)` rows and serves the matching one. If its real
signature differs, adapt the call; the two assertions are what must hold.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --locked core::fleet_ws`
Expected: `test result: ok. 10 passed`, `0 failed` (8 state-machine + 2 helper).

- [ ] **Step 5: Add `run` — the long-lived task that drives the state machine and reports `Msg::FleetChanged`**

Append to `core/fleet_ws.rs`. This is the **only** producer of
`Msg::FleetChanged`; without it the Devices screen's push path never fires (the
`Msg::FleetChanged => RefreshDevices` fold in Task 16 would be dead). The task
owns the shell's browser WS, drives the pure `FleetLayerState` with the events
above, and sends exactly one `Msg::FleetChanged` per delivered change.

```rust
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::Sender;

use crate::app::Msg;
use crate::core::state::CoreState;

/// Fallback poll interval — a plan-time detail (spec §5.2): a `GET /api/agents`
/// every 5 s while the WS is unusable.
const FALLBACK_POLL: Duration = Duration::from_secs(5);

/// Connect the browser WS, subscribe to `fleet-changed`, and report each change
/// as `Msg::FleetChanged`. When the WS is unusable (mint/upgrade failure, the
/// Origin gate's 403, or a dropped socket) it switches to the polling fallback
/// and reconnects with backoff; the poll runs **only** while the WS is unusable
/// and stops the moment a reconnect succeeds (ADR-82 — the two layers never run
/// together; the pure `FleetLayerState` enforces the ordering, this loop is its
/// driver). The task runs for the process lifetime; it stops when the channel
/// closes.
pub async fn run(state: Arc<CoreState>, tx: Sender<Msg>) {
    let mut layers = FleetLayerState::new();
    loop {
        // --- Push attempt: mint a ticket, connect, subscribe. ---
        let token = state.access_token.lock().unwrap().clone().unwrap_or_default();
        let server_url = state.server_url.lock().unwrap().clone();
        let client = state.http.clone();
        let ticket = match mint_ticket(&client, &server_url, &token).await {
            Ok(t) => t,
            Err(_) => {
                layers.on(FleetEvent::WsUnusable);
                if poll_once(&client, &server_url, &token, &tx, &mut layers).await.is_err() {
                    return; // channel closed
                }
                continue;
            }
        };
        let url = match browser_ws_url(&server_url, &ticket) {
            Ok(u) => u,
            Err(_) => {
                layers.on(FleetEvent::WsUnusable);
                if poll_once(&client, &server_url, &token, &tx, &mut layers).await.is_err() {
                    return;
                }
                continue;
            }
        };
        let ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _resp)) => ws,
            // The Origin gate answers 403 when `CORS_ORIGIN` is a concrete
            // value; a native client sends no Origin. That is "WS unusable",
            // not a fatal error — fall back, do not retry forever.
            Err(_) => {
                layers.on(FleetEvent::OriginGateRejected);
                if poll_once(&client, &server_url, &token, &tx, &mut layers).await.is_err() {
                    return;
                }
                continue;
            }
        };
        let (mut sink, mut stream) = ws.split();
        // Subscribe to the fleet channel on this socket.
        let subscribe = r#"{"type":"subscribe-fleet"}"#;
        if sink
            .send(tokio_tungstenite::tungstenite::Message::Text(subscribe.into()))
            .await
            .is_err()
        {
            layers.on(FleetEvent::WsUnusable);
            if poll_once(&client, &server_url, &token, &tx, &mut layers).await.is_err() {
                return;
            }
            continue;
        }
        // Connected and subscribed: disarm the poll BEFORE marking push active.
        layers.on(FleetEvent::WsConnected);
        // --- Read loop: one `Msg::FleetChanged` per `fleet-changed` frame. ---
        while let Some(frame) = stream.next().await {
            match frame {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text))
                    if text.contains("\"fleet-changed\"") =>
                {
                    layers.on(FleetEvent::FleetChanged);
                    if tx.send(Msg::FleetChanged).await.is_err() {
                        return; // the app is gone; stop the task
                    }
                }
                Ok(_) => {}
                Err(_) => break, // dropped socket -> fall back below
            }
        }
        layers.on(FleetEvent::WsUnusable);
        // Reconnect with a short backoff so a hard-down server does not spin.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// One fallback poll iteration: wait the interval, fetch `GET /api/agents`, and
/// emit `Msg::FleetChanged` so the app re-fetches. Returns `Err(())` when the
/// channel closed (the task should stop). Drives the same `FleetLayerState` so
/// the pure invariant is exercised on the real path too.
async fn poll_once(
    client: &reqwest::Client,
    server_url: &str,
    token: &str,
    tx: &Sender<Msg>,
    layers: &mut FleetLayerState,
) -> Result<(), ()> {
    tokio::time::sleep(FALLBACK_POLL).await;
    layers.on(FleetEvent::PollTick);
    if !layers.should_fetch() {
        return Ok(());
    }
    layers.on(FleetEvent::FetchStarted);
    let url = format!("{}/api/agents", server_url.trim_end_matches('/'));
    let _ = client.get(&url).bearer_auth(token).send().await;
    layers.on(FleetEvent::FetchFinished);
    let _ = layers.take_dirty();
    tx.send(Msg::FleetChanged).await.map_err(|_| ())
}
```

Wire it in Task 16: after `App::new`, the app spawns
`self.rt.spawn(crate::core::fleet_ws::run(self.state.clone(), self.tx.clone()))`
once (guarded by an `Arc<AtomicBool>` so a re-login does not spawn a second
task). The task itself loops until the channel closes.

- [ ] **Step 6: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `103 passed` (93 + 10), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/fleet_ws.rs
git commit -m "feat(desktop): add fleet push-first WS layer with polling fallback (ADR-82)"
```

---

### Task 12: `core::updater` — minisign-verified self-update (ADR-80)

**Files:**
- Create: `apps/desktop/src/core/updater.rs`
- Modify: `apps/desktop/src/core/mod.rs`
- Test: `apps/desktop/src/core/updater.rs` (in-file tests)

**Interfaces:**
- Consumes: `minisign_verify::{PublicKey, Signature}`, `semver::Version`.
- Produces:
  - `updater::UPDATER_PUBKEY_B64` — `pub const UPDATER_PUBKEY_B64: &str` = the
    verbatim key from §9.3 (see Step 1).
  - `updater::UPDATE_ENDPOINT` — `pub const UPDATE_ENDPOINT: &str = "https://github.com/ngotuananh101/ponter/releases/latest/download/latest.json"`.
  - `updater::UpdateInfo { version: String, url: String, signature: String }`.
  - `updater::should_apply(current: &str, latest: &str) -> Option<UpdateInfo>` — **guard (b)**: `Some` only when `latest` is strictly newer than `current` by semver; `None` on equal, older, or an unparsable version.
  - `updater::manifest_entry(manifest: &serde_json::Value, platform_key: &str) -> Option<UpdateInfo>` — **Review Focus #4**: `None` when the manifest has no entry for this platform.
  - `updater::platform_key() -> &'static str` — `"linux-x86_64-appimage"` on Linux, `"windows-x86_64-msi"` on Windows (matching the release job's `targetFor`).
  - `updater::verify(public_key_b64: &str, payload: &[u8], signature_text: &str) -> Result<(), String>` — **guard (c)**: decodes the key + signature, verifies `payload`; any failure is `Err`.
  - `updater::check(client: &reqwest::Client, current_version: &str) -> Result<Option<UpdateInfo>, String>`.
  - `updater::apply(client: &reqwest::Client, info: &UpdateInfo) -> Result<(), String>` — downloads to a temp file, `verify`es **before** replacing, then swaps the running binary.

**TEST-INTEGRITY declaration (this file):** replaces Tauri `commands/updater.rs`
(which had **1** pure semver test, `refuses_an_older_version`, ported here as
`should_apply_older_version_returns_none`) with the standalone Rust updater
(ADR-80). Adds **10** tests: **1** ported semver test (`refuses_an_older_version`
→ `should_apply_older_version_returns_none`) + **9** new tests (3 additional
`should_apply` semver edge cases, 2 manifest selection, 3 signature
verification, 1 apply-refuses). File test count **0 → 10** (1 ported + 9 new).

- [ ] **Step 1: Write the version comparison + manifest selection (guard b, Review Focus #4)**

Create `apps/desktop/src/core/updater.rs`:

```rust
//! Self-update: fetch the release manifest, and replace the binary only after a
//! minisign signature over the artifact verifies (ADR-80). The public key is
//! compiled in and must never change (§9.3 continuity).

use serde::Deserialize;

/// The updater public key, verbatim from the Tauri app's `tauri.conf.json`
/// (`plugins.updater.pubkey`). Continuity invariant §9.3: this value must not
/// change, or existing installs stop trusting new releases.
pub const UPDATER_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3QUZGQzFCNTgzRTM1NTEKUldSUk5UNVlHL3l2Unp3cTc0SE1ETWUxTlRPZ3FGUHI1cVoxN2d6a0xzL3J2V2dmOEJvczVaMkIK";

/// The release manifest endpoint (unchanged from the Tauri app).
pub const UPDATE_ENDPOINT: &str =
    "https://github.com/ngotuananh101/ponter/releases/latest/download/latest.json";

/// One platform's update artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    pub signature: String,
}

/// Guard (b): apply only a strictly newer version. Equal, older, or an
/// unparsable `latest` yields `None`.
pub fn should_apply(current: &str, latest: &str) -> Option<UpdateInfo> {
    let current = semver::Version::parse(current).ok()?;
    let latest = semver::Version::parse(latest).ok()?;
    if latest > current {
        Some(UpdateInfo { version: latest.to_string(), url: String::new(), signature: String::new() })
    } else {
        None
    }
}

/// The manifest platform key this build uses, matching the release job's
/// `targetFor` mapping (§8).
pub fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x86_64-msi"
    } else {
        "linux-x86_64-appimage"
    }
}

/// Review Focus #4: a manifest with no entry for this platform is "no update
/// for you" (`None`), never an error or a panic.
pub fn manifest_entry(manifest: &serde_json::Value, platform_key: &str) -> Option<UpdateInfo> {
    let version = manifest.get("version")?.as_str()?.to_string();
    let entry = manifest.get("platforms")?.get(platform_key)?;
    let url = entry.get("url")?.as_str()?.to_string();
    let signature = entry.get("signature")?.as_str()?.to_string();
    Some(UpdateInfo { version, url, signature })
}

/// The manifest as parsed from the endpoint.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub platforms: std::collections::BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestEntry {
    pub url: String,
    pub signature: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_apply_newer_version_returns_update() {
        let info = should_apply("0.1.0", "0.2.0").expect("a newer version applies");
        assert_eq!(info.version, "0.2.0");
    }

    #[test]
    fn should_apply_equal_version_returns_none() {
        assert!(should_apply("0.1.0", "0.1.0").is_none());
    }

    #[test]
    fn should_apply_older_version_returns_none() {
        assert!(should_apply("0.2.0", "0.1.9").is_none());
    }

    #[test]
    fn should_apply_rejects_unparsable_version() {
        assert!(should_apply("0.1.0", "not-a-version").is_none());
        assert!(should_apply("garbage", "0.2.0").is_none());
    }

    #[test]
    fn manifest_selects_the_platform_entry() {
        let manifest: serde_json::Value = serde_json::from_str(
            r#"{
                "version": "0.2.0",
                "platforms": {
                    "linux-x86_64-appimage": {"url": "https://x/app.AppImage", "signature": "sigL"},
                    "windows-x86_64-msi": {"url": "https://x/app.msi", "signature": "sigW"}
                }
            }"#,
        )
        .unwrap();
        let entry = manifest_entry(&manifest, "linux-x86_64-appimage").unwrap();
        assert_eq!(entry.version, "0.2.0");
        assert_eq!(entry.url, "https://x/app.AppImage");
        assert_eq!(entry.signature, "sigL");
    }

    #[test]
    fn manifest_without_this_platform_yields_none() {
        // Review Focus #4.
        let manifest: serde_json::Value = serde_json::from_str(
            r#"{"version":"0.2.0","platforms":{"darwin-aarch64":{"url":"u","signature":"s"}}}"#,
        )
        .unwrap();
        assert!(manifest_entry(&manifest, "linux-x86_64-appimage").is_none());
    }
}
```

- [ ] **Step 2: Run these tests to verify they pass**

Run (from `apps/desktop`):

```bash
cargo test --locked core::updater
```

Expected: `test result: ok. 6 passed`, `0 failed` (the 4 `should_apply` + 2
manifest-selection tests).

- [ ] **Step 3: Add the signature verification (guard c) and its tests**

Append to `core/updater.rs`:

```rust
use base64::Engine as _;

/// Guard (c): verify `payload` against `signature_text` with the compiled-in or
/// supplied public key. Any failure (bad key, bad signature, key-id mismatch,
/// tampering) is an `Err`; the caller must not touch the binary on `Err`.
///
/// `public_key_b64` is the base64 of the whole `minisign.pub` file — the same
/// value the Tauri updater carried in `tauri.conf.json`. Decoding it yields the
/// file's two lines; the last line is the raw base64 public key that
/// `minisign_verify` wants.
pub fn verify(public_key_b64: &str, payload: &[u8], signature_text: &str) -> Result<(), String> {
    let pub_file = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("invalid updater public key: {e}"))?;
    let pub_file = String::from_utf8(pub_file)
        .map_err(|e| format!("invalid updater public key: {e}"))?;
    let key_line = pub_file
        .lines()
        .next_back()
        .ok_or_else(|| "updater public key is empty".to_string())?;

    let public_key = minisign_verify::PublicKey::from_base64(key_line)
        .map_err(|e| format!("invalid updater public key: {e}"))?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|e| format!("invalid update signature: {e}"))?;
    public_key
        .verify(payload, &signature, false)
        .map_err(|e| format!("update signature verification failed: {e}"))
}
```

Note for the implementer: `Signature::decode` expects the whole minisign
signature file text (comment line + signature line), which is what the release
job stores in `latest.json`'s `signature` field. If the manifest instead carries
only the bare base64 signature line, use the crate's `from_base64_line`; inspect
the released `latest.json` to confirm which form is present and adapt the one
call. The refusal behaviour is what must hold.

Add these tests to the `tests` module:

```rust
    /// Sign `payload` with a throwaway keypair and return
    /// `(public_key_file_b64, signature_file_text)` — the two strings `verify`
    /// consumes. `minisign` is a dev-dependency used only here.
    fn sign_fixture(payload: &[u8]) -> (String, String) {
        use base64::Engine as _;
        use std::io::Cursor;
        let minisign::KeyPair { pk, sk } =
            minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let sig_box = minisign::sign(None, &sk, Cursor::new(payload), None, None).unwrap();
        let pub_file = pk.to_box().unwrap().into_string();
        let pub_b64 = base64::engine::general_purpose::STANDARD.encode(pub_file.as_bytes());
        (pub_b64, sig_box.into_string())
    }

    #[test]
    fn verify_accepts_a_valid_signature() {
        // The positive path of guard (c): a real minisign signature verifies.
        let payload = b"release-binary-bytes";
        let (pub_b64, sig_text) = sign_fixture(payload);
        assert!(verify(&pub_b64, payload, &sig_text).is_ok());
    }

    #[test]
    fn verify_rejects_a_tampered_payload() {
        // Guard (c): the same valid signature must refuse a different payload.
        let (pub_b64, sig_text) = sign_fixture(b"release-binary-bytes");
        assert!(verify(&pub_b64, b"tampered-bytes", &sig_text).is_err());
    }

    #[test]
    fn verify_rejects_a_bad_signature() {
        // Guard (c): a signature that is not valid minisign encoding is refused.
        let err = verify(UPDATER_PUBKEY_B64, b"payload", "not-a-signature").unwrap_err();
        assert!(!err.is_empty());
    }
```

- [ ] **Step 4: Add `check` / `apply` with the "refuse without touching the binary" test**

Append to `core/updater.rs`:

```rust
/// Fetch the manifest and return an update only if it is newer than
/// `current_version` and has an entry for this platform.
pub async fn check(
    client: &reqwest::Client,
    current_version: &str,
) -> Result<Option<UpdateInfo>, String> {
    let resp = client.get(UPDATE_ENDPOINT).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("update check failed (HTTP {})", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let manifest: Manifest =
        serde_json::from_str(&body).map_err(|e| format!("invalid manifest: {e}"))?;
    if should_apply(current_version, &manifest.version).is_none() {
        return Ok(None);
    }
    match manifest.platforms.get(platform_key()) {
        Some(entry) => Ok(Some(UpdateInfo {
            version: manifest.version.clone(),
            url: entry.url.clone(),
            signature: entry.signature.clone(),
        })),
        None => Ok(None), // Review Focus #4: no artifact for this platform
    }
}

/// Download the artifact, verify it against `UPDATER_PUBKEY_B64`, and only then
/// replace the running binary. On any verification failure the binary is left
/// untouched and an `Err` is returned.
///
/// Both the download and the swap are injected so the ordering ("verify before
/// replace") is unit-testable without a real download or a real binary swap.
/// There is no `reqwest::Client` parameter: the download future owns whatever
/// transport it needs, and the production path (`apply`, below) is the only
/// caller that touches the network.
pub async fn apply_with<D, R>(
    info: &UpdateInfo,
    download: D,
    replace_binary: R,
) -> Result<(), String>
where
    D: std::future::Future<Output = Result<Vec<u8>, String>>,
    R: FnOnce(&[u8]) -> Result<(), String>,
{
    let bytes = download.await?;
    verify(UPDATER_PUBKEY_B64, &bytes, &info.signature)?; // refuse before replace
    replace_binary(&bytes)
}

/// Production `apply`: download the artifact, verify, then swap. Delegates to
/// `apply_with` so the verify-before-replace ordering is the same code path the
/// test exercises.
pub async fn apply(client: &reqwest::Client, info: &UpdateInfo) -> Result<(), String> {
    apply_with(info, download(client, &info.url), self_replace).await
}

/// Download an artifact to memory. Split out so `apply_with` stays transport-free.
async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    Ok(client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?
        .to_vec())
}

/// Replace the current executable. Uses a write-temp-then-rename swap.
fn self_replace(bytes: &[u8]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp, perms).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &exe).map_err(|e| e.to_string())
}
```

Add this test to the `tests` module:

```rust
    #[test]
    fn apply_refuses_a_bad_signature_without_touching_the_binary() {
        // Guard (c): the binary must not be replaced when the signature fails.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let info = UpdateInfo {
                version: "0.2.0".into(),
                url: "https://example.invalid/app".into(),
                signature: "not-a-signature".into(),
            };
            let replaced = std::cell::Cell::new(false);
            let res = apply_with(
                &info,
                async { Ok(b"new-binary".to_vec()) },
                |_bytes| {
                    replaced.set(true);
                    Ok(())
                },
            )
            .await;
            assert!(res.is_err(), "a bad signature must refuse");
            assert!(!replaced.get(), "the binary must not be touched on refusal");
        });
    }
```

- [ ] **Step 5: Declare the module, run the tests, and record the single dropped test**

Add `pub mod updater;` to `apps/desktop/src/core/mod.rs`. Run:

```bash
cargo test --locked core::updater
```

Expected: `test result: ok. 10 passed`, `0 failed`.

**The single dropped test from Tauri (declare in the PR1 body).** Exactly one
Tauri test is intentionally dropped, not ported:
- `apps/desktop/src-tauri/src/lib.rs:83` had **1** contract test
  (`ponter_agent_runtime_api_is_wired`), which asserted compile-time `AgentRuntime`
  and `RuntimeStatus` type compatibility. The egui desktop embeds the real
  `AgentRuntime` host directly in Task 10, superseding this compile-time stub test.
  File count **1 → 0**.

(Note: `apps/desktop/src-tauri/src/commands/updater.rs:87`'s test `refuses_an_older_version`
is a pure semver assertion, NOT Tauri wiring; it is ported and strengthened as
`should_apply_older_version_returns_none` in Step 1 above. It is not dropped.)

This reason is recorded in the PR1 description. (Per TEST-INTEGRITY this is a
declared drop, not a silent one.)

- [ ] **Step 6: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `113 passed` (103 + 10), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/core/mod.rs apps/desktop/src/core/updater.rs
git commit -m "feat(desktop): add minisign-verified self-updater (ADR-80)"
```

---

### Task 13: Rewrite the CI workflows (build-desktop.yml + ci-node.yml + no-GTK guard)

**Files:**
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `.github/workflows/ci-node.yml`
- Test: (CI is its own test — the guard step is the executable assertion)

**Interfaces:**
- Consumes: the crate from Tasks 1–12 (`apps/desktop`).
- Produces: a 2-leg matrix (`ubuntu-latest`, `windows-latest`) that builds the
  crate with `cargo build --release`, runs `cargo test`, produces the artifact
  set, and a guard step that fails if the dependency graph links a webview/GTK/Qt.

**TEST-INTEGRITY declaration (this file):** no Rust/Vue test changes. The guard
step *adds* a CI assertion (a new `cargo tree` grep); no existing assertion is
removed except the Tauri-specific ones named below.

- [ ] **Step 1: Rewrite `build-desktop.yml`**

Open `.github/workflows/build-desktop.yml` and make these changes:

1. **Remove** the steps: `Install pnpm`, `Setup Node.js`, `Install Node
   dependencies` (`pnpm install --frozen-lockfile`), `Build frontend`
   (`pnpm build`).
2. **Linux system deps** — remove the GTK/webview packages
   (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
   `librsvg2-dev`, `patchelf`). Keep the capture stack and X11/Wayland/GL
   headers, and add `libxkbcommon-dev`, `libx11-dev`, `libgl1-mesa-dev`,
   `libxcb-*`-dev headers required by `eframe`/`ksni`:

```yaml
      - name: Install Linux system dependencies
        if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            build-essential pkg-config libssl-dev libclang-dev \
            libxcb1-dev libxcb-randr0-dev libxcb-shm0-dev libxcb-xfixes0-dev \
            libxrandr-dev libxkbcommon-dev libx11-dev libgl1-mesa-dev \
            libwayland-dev libegl-dev libgbm-dev libdrm-dev \
            libpipewire-0.3-dev libspa-0.2-dev \
            appimagetool
```

3. **Rust toolchain** — use the pinned channel:

```yaml
      - uses: dtolnay/rust-toolchain@master
        with:
          toolchain: 1.98.1
          components: rustfmt, clippy
```

4. **Cache** — point at the new target dir: `apps/desktop/target`.
5. **Build + test**:

```yaml
      - name: Build
        working-directory: apps/desktop
        run: cargo build --release --locked

      - name: Test
        working-directory: apps/desktop
        run: cargo test --locked
```

6. **No-webview/GTK/Qt guard** (this is the executable assertion for the
   Global Constraint):

```yaml
      - name: Guard — no webview/GTK/Qt in the dependency graph
        working-directory: apps/desktop
        shell: bash
        run: |
          set -euo pipefail
          if cargo tree --locked | grep -Ei '\b(webkit|gtk|qt|wry|tao)\b'; then
            echo "::error::a webview/GTK/Qt crate is in the dependency graph"
            exit 1
          fi
          echo "no webview/GTK/Qt crate present"
```

7. **Artifacts** — build with the packaging tools and upload the artifact set:
   - Linux: `appimagetool` (AppImage), `cargo-deb` (`.deb`), `cargo-generate-rpm` (`.rpm`).
   - Windows: the release `.exe` (portable), `makensis` (NSIS `.exe`), `cargo-wix` (`.msi`).

```yaml
      - name: Package (Linux)
        if: matrix.os == 'ubuntu-latest'
        working-directory: apps/desktop
        run: |
          cargo install cargo-deb cargo-generate-rpm --locked
          cargo deb --no-build
          cargo generate-rpm
          ./scripts/make-appimage.sh

      - name: Package (Windows)
        if: matrix.os == 'windows-latest'
        working-directory: apps/desktop
        run: |
          cargo install cargo-wix --locked
          mkdir -p target/release/bundle/nsis target/release/bundle/msi
          makensis installer.nsi
          cargo wix --no-build --nocapture
```

Upload each format with `if-no-files-found: error` and `retention-days: 7`, as
today — but pointed at the new crate's output dirs (`apps/desktop/target/release`,
**not** `apps/desktop/src-tauri/target/...`), and using the same `${{ env.WORKSPACE }}`
prefix (the `path` input resolves from the workspace root):

```yaml
      - name: Upload Linux AppImage artifact
        if: ${{ runner.os == 'Linux' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-appimage
          path: ${{ env.WORKSPACE }}/target/release/bundle/appimage/*.AppImage
          if-no-files-found: error
          retention-days: 7

      - name: Upload Linux deb artifact
        if: ${{ runner.os == 'Linux' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-deb
          path: ${{ env.WORKSPACE }}/target/release/*.deb
          if-no-files-found: error
          retention-days: 7

      - name: Upload Linux rpm artifact
        if: ${{ runner.os == 'Linux' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-linux-rpm
          path: ${{ env.WORKSPACE }}/target/release/*.rpm
          if-no-files-found: error
          retention-days: 7

      - name: Upload Windows msi artifact
        if: ${{ runner.os == 'Windows' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-windows-msi
          path: ${{ env.WORKSPACE }}/target/release/bundle/msi/*.msi
          if-no-files-found: error
          retention-days: 7

      - name: Upload Windows NSIS artifact
        if: ${{ runner.os == 'Windows' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-windows-nsis
          path: ${{ env.WORKSPACE }}/target/release/bundle/nsis/*.exe
          if-no-files-found: error
          retention-days: 7

      - name: Upload Windows portable artifact
        if: ${{ runner.os == 'Windows' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-windows-portable
          path: ${{ env.WORKSPACE }}/target/release/ponter-desktop.exe
          if-no-files-found: error
          retention-days: 7
```

Keep the existing `PONTER_DEFAULT_SERVER_URL` env and the
`PONTER_KEYCHAIN_SKIP: 1` env on the test step.

8. **Assert installer artifacts** — update the Linux and Windows assertion steps
   to the new output paths: `apps/desktop/target/release/bundle` (not
   `src-tauri/target/release/bundle`) for the installers, and the portable
   binary is now `target/release/ponter-desktop.exe` (hyphen, the crate's
   `[[bin]]` name). Keep the ≥10 KB size assertions exactly.

9. **Release job** — keep the "Generate consolidated checksums manifest",
   "Assemble latest.json manifest", and `softprops/action-gh-release` steps
   **as they are** (the download step uses `merge-multiple: true`, so the
   artifact paths above flatten into `dist/` regardless), with **one** change:
   the `targetFor` mapping's portable-binary exclusion regex must match the new
   binary name — `/^ponter-desktop\.exe$/i` (was `ponter_desktop.exe`), so the
   raw portable `.exe` is never resolved as the `windows-x86_64-nsis` updater
   target. The extension-based `targetFor` cases themselves
   (`.AppImage`→`linux-x86_64-appimage`, `.deb`→`linux-x86_64-deb`,
   `.rpm`→`linux-x86_64-rpm`, `.msi`→`windows-x86_64-msi`,
   `*.exe`→`windows-x86_64-nsis`) are unchanged. Signing uses
   `MINISIGN_SECRET_KEY` / `MINISIGN_PASSWORD` (renamed from the Tauri
   `TAURI_SIGNING_PRIVATE_KEY*` variables) — see Step 3.

- [ ] **Step 2: Drop `apps/desktop/**` from `ci-node.yml`**

In `.github/workflows/ci-node.yml`, remove `'apps/desktop/**'` from **both**
`paths:` lists (the `push` filter and the `pull_request` filter). The Node
workspace no longer contains the desktop app; leaving the filter would make the
Node job run on desktop-only changes for no reason.

- [ ] **Step 3: Rename the signing secret env vars**

The updater signing is now performed by the release job with `minisign`. Rename
the workflow's env references:
`TAURI_SIGNING_PRIVATE_KEY` → `MINISIGN_SECRET_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` → `MINISIGN_PASSWORD`. The GitHub
repository secrets with the new names must be created by the owner before the
first release on this branch; note this in the PR description (it is an owner
action, not a code change).

- [ ] **Step 4: Create the packaging inputs the workflow calls**

The packaging steps in Step 1 invoke three files that do not exist yet in the
Rust crate. Create them so the workflow is runnable:

1. `apps/desktop/scripts/make-appimage.sh` — assemble an AppImage from the
   release binary. Keep it minimal and CI-only:

```bash
#!/usr/bin/env bash
# Build a Linux AppImage from the release binary (CI packaging step).
set -euo pipefail
appdir="$(mktemp -d)/PonterDesktop.AppDir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share/applications" \
         "$appdir/usr/share/icons/hicolor/256x256/apps"
install -Dm755 target/release/ponter-desktop "$appdir/usr/bin/ponter-desktop"
install -Dm644 icons/128x128@2x.png \
  "$appdir/usr/share/icons/hicolor/256x256/apps/ponter-desktop.png"
cat > "$appdir/ponter-desktop.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Ponter Desktop
Exec=ponter-desktop
Icon=ponter-desktop
Categories=Utility;Network;
DESKTOP
cp "$appdir/ponter-desktop.desktop" "$appdir/usr/share/applications/"
cat > "$appdir/AppRun" <<'APPRUN'
#!/usr/bin/env bash
exec "$(dirname "$0")/usr/bin/ponter-desktop" "$@"
APPRUN
chmod +x "$appdir/AppRun"
mkdir -p target/release/bundle/appimage
appimagetool "$appdir" target/release/bundle/appimage/PonterDesktop-x86_64.AppImage"
```

2. `apps/desktop/installer.nsi` — the NSIS script `makensis` compiles:

```nsis
!include "MUI2.nsh"
Name "Ponter Desktop"
OutFile "target\release\bundle\nsis\PonterDesktop-setup.exe"
InstallDir "$LOCALAPPDATA\Ponter Desktop"
RequestExecutionLevel user
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetOutPath "$INSTDIR"
  File "target\release\ponter-desktop.exe"
  CreateShortCut "$SMPROGRAMS\Ponter Desktop.lnk" "$INSTDIR\ponter-desktop.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\ponter-desktop.exe"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$SMPROGRAMS\Ponter Desktop.lnk"
  RMDir "$INSTDIR"
SectionEnd
```

3. `apps/desktop/wix/main.wxs` — the WiX source `cargo wix` consumes. Give the
   package a stable `UpgradeCode` (upgrades replace in place, never a second
   copy) and reference the release binary:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Ponter Desktop" Language="1033" Version="!(bind.FileVersion.ponter-desktop.exe)"
           Manufacturer="Ponter" UpgradeCode="b6b0f0b8-2f2f-4f3a-9d5a-6c8a2b0f7d10">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version is already installed."/>
    <MediaTemplate EmbedCab="yes"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="LocalAppDataFolder">
        <Directory Id="INSTALLFOLDER" Name="Ponter Desktop">
          <Component Id="MainExe" Guid="*">
            <File Id="ponter-desktop.exe" Source="target\release\ponter-desktop.exe" KeyPath="yes"/>
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Main" Title="Ponter Desktop" Level="1">
      <ComponentRef Id="MainExe"/>
    </Feature>
  </Product>
</Wix>
```

`cargo wix` reads `[package.metadata.wix]`; add the WiX source path there so the
`cargo wix` step finds `wix/main.wxs`:

```toml
[package.metadata.wix]
name = "Ponter Desktop"
```

(The exact WiX/NSIS schema details may be tuned at implementation time; the
requirement is that each packaging command in Step 1 has a committed input file
and produces the artifact the release job's `targetFor` mapping expects.)

- [ ] **Step 5: Validate YAML locally**

Run (from the repo root of the worktree):

```bash
python -c "import yaml,sys; [yaml.safe_load(open(p)) for p in ['.github/workflows/build-desktop.yml','.github/workflows/ci-node.yml']]; print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/build-desktop.yml .github/workflows/ci-node.yml \
        apps/desktop/Cargo.toml apps/desktop/scripts/make-appimage.sh \
        apps/desktop/installer.nsi apps/desktop/wix/main.wxs
git commit -m "ci(desktop): build the Rust shell, drop Node steps, guard no-GTK (ADR-79)"
```

---

## PR 2 — UI screens + tray + README + deletion of the Tauri/Vue tree

### Task 14: `theme` + the `ui` router skeleton

**Files:**
- Create: `apps/desktop/src/theme.rs`
- Create: `apps/desktop/src/ui/mod.rs`
- Create (stub): `apps/desktop/src/ui/{login,server_setup,wizard,devices,settings}.rs`
- Modify: `apps/desktop/src/main.rs`
- Modify: `apps/desktop/src/app.rs`
- Test: `apps/desktop/src/theme.rs`, `apps/desktop/src/ui/mod.rs` (in-file tests)

**Interfaces:**
- Consumes: `app::{App, Screen}`, `core::state::CoreState`.
- Produces:
  - `theme::apply(ctx: &egui::Context, theme: Option<&str>)`.
  - `theme::resolve(theme: Option<&str>) -> ThemeChoice` where
    `enum ThemeChoice { Light, Dark }`.
  - `ui::route(state: &CoreState, editing_server: bool) -> Screen`.
  - `ui::render(app: &mut App, ui: &mut egui::Ui)` — dispatches to the screen
    modules by `app.screen`.
  - Stub `render` fns for the five screens, replaced in Tasks 15 and 16. This
    task cannot declare `pub mod login;` … `pub mod settings;` and dispatch to
    them unless the files exist, so it creates a one-line stub for each; the
    stubs keep the crate compiling and the router test meaningful on its own.

**TEST-INTEGRITY declaration (this file):** adds **4** unit tests for egui
theme resolution (`theme::resolve`) covering the same behavioral cases as the
Vue `theme.test.ts` suite, plus **1** router test (`route_follows_gate_order`).
The 4 Vue tests are deleted with the app in Task 18. File test counts:
`theme.rs` **0 → 4**, `ui/mod.rs` **0 → 1**.

- [ ] **Step 1: Write `theme.rs` and its tests**

Create `apps/desktop/src/theme.rs`:

```rust
//! Light/dark theme selection, mirroring the Vue app's `useTheme` behaviour.

use eframe::egui;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Light,
    Dark,
}

/// Resolve a stored theme string. `None`/unknown -> Light (the Vue default
/// when the system preference is unavailable in this build).
pub fn resolve(theme: Option<&str>) -> ThemeChoice {
    match theme {
        Some("dark") => ThemeChoice::Dark,
        _ => ThemeChoice::Light,
    }
}

/// Apply the chosen theme to the egui context.
pub fn apply(ctx: &egui::Context, theme: Option<&str>) {
    match resolve(theme) {
        ThemeChoice::Dark => ctx.set_visuals(egui::Visuals::dark()),
        ThemeChoice::Light => ctx.set_visuals(egui::Visuals::light()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_defaults_to_system_or_light() {
        assert_eq!(resolve(None), ThemeChoice::Light);
    }

    #[test]
    fn resolve_explicit_dark() {
        assert_eq!(resolve(Some("dark")), ThemeChoice::Dark);
    }

    #[test]
    fn resolve_explicit_light() {
        assert_eq!(resolve(Some("light")), ThemeChoice::Light);
    }

    #[test]
    fn resolve_unknown_falls_back() {
        assert_eq!(resolve(Some("solarized")), ThemeChoice::Light);
    }
}
```

- [ ] **Step 2: Write `ui/mod.rs` with the router and its test**

Create `apps/desktop/src/ui/mod.rs`:

```rust
//! The screen router and the per-screen render dispatch. The gate order mirrors
//! the Vue `App.vue`: server setup -> login -> wizard -> devices, with the
//! Settings screen reachable as a manual override.

pub mod devices;
pub mod login;
pub mod server_setup;
pub mod settings;
pub mod wizard;

use crate::app::{App, Screen};
use crate::core::state::CoreState;

/// The screen the shell shows this frame. `editing_server` is the manual
/// override that returns to Server Setup from Settings.
pub fn route(state: &CoreState, editing_server: bool) -> Screen {
    if !state.has_server_url() || editing_server {
        Screen::ServerSetup
    } else if state.access_token.lock().unwrap().is_none() {
        Screen::Login
    } else if !state.wizard_completed() {
        Screen::Wizard
    } else {
        Screen::Devices
    }
}

/// Render the current screen.
pub fn render(app: &mut App, ui: &mut egui::Ui) {
    match app.screen {
        Screen::ServerSetup => server_setup::render(app, ui),
        Screen::Login => login::render(app, ui),
        Screen::Wizard => wizard::render(app, ui),
        Screen::Devices => devices::render(app, ui),
        Screen::Settings => settings::render(app, ui),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_follows_gate_order() {
        // Walk the gate order from the spec (§5.2): the router picks the first
        // screen whose condition is unmet.
        let state = CoreState::with_config(None);
        // 1. No server URL -> Server Setup (the manual override also wins).
        assert_eq!(route(&state, false), Screen::ServerSetup);
        assert_eq!(route(&state, true), Screen::ServerSetup);

        // 2. A server URL but no token -> Login.
        state.set_has_server_url(true);
        assert_eq!(route(&state, false), Screen::Login);

        // 3. Authenticated but the wizard has not completed -> Wizard.
        *state.access_token.lock().unwrap() = Some("tok".to_string());
        assert_eq!(route(&state, false), Screen::Wizard);

        // 4. Authenticated and the wizard done -> Devices.
        state.mark_wizard_completed();
        assert_eq!(route(&state, false), Screen::Devices);

        // The manual override still returns to Server Setup from any later screen.
        assert_eq!(route(&state, true), Screen::ServerSetup);
    }
}
```

(The `CoreState::wizard_completed()` accessor this router calls is defined in
Task 4, Step 1.)

- [ ] **Step 3: Write the five screen stubs, wire the modules, and run the tests**

Create one stub file per screen so `ui/mod.rs`'s `pub mod` declarations and its
`render` dispatch resolve (Tasks 15 and 16 replace each body):

```rust
// apps/desktop/src/ui/login.rs (stub — replaced in Task 15)
use crate::app::App;
pub fn render(_app: &mut App, _ui: &mut egui::Ui) {}
```

```rust
// apps/desktop/src/ui/server_setup.rs (stub — replaced in Task 15)
use crate::app::App;
pub fn render(_app: &mut App, _ui: &mut egui::Ui) {}
```

```rust
// apps/desktop/src/ui/wizard.rs (stub — replaced in Task 16)
use crate::app::App;
pub fn render(_app: &mut App, _ui: &mut egui::Ui) {}
```

```rust
// apps/desktop/src/ui/devices.rs (stub — replaced in Task 16)
use crate::app::App;
pub fn render(_app: &mut App, _ui: &mut egui::Ui) {}
```

```rust
// apps/desktop/src/ui/settings.rs (stub — replaced in Task 16)
use crate::app::App;
pub fn render(_app: &mut App, _ui: &mut egui::Ui) {}
```

Each stub needs `use eframe::egui;` for the `egui::Ui` type (add
`use eframe::egui;` above the `use crate::app::App;` line).

Then wire the router into `App::ui`, replacing Task 1's placeholder body. This
also adds `pub editing_server: bool` to `App` (the router's manual-override
flag), seeded `false` in `App::new`:

```rust
fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
    // The router picks the screen from CoreState each frame (Task 16 adds the
    // `showing_settings` override in front of this).
    self.screen = crate::ui::route(&self.state, self.editing_server);
    crate::theme::apply(ui.ctx(), self.state.theme.lock().unwrap().as_deref());
    crate::ui::render(self, ui);
}
```

Add `mod theme;` and `mod ui;` to `apps/desktop/src/main.rs`. Run:

```bash
cargo test --locked theme:: ui::mod
```

Expected: `test result: ok. 5 passed`, `0 failed`.

- [ ] **Step 4: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `118 passed` (113 + 5), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.rs apps/desktop/src/app.rs \
        apps/desktop/src/theme.rs apps/desktop/src/ui/mod.rs \
        apps/desktop/src/ui/login.rs apps/desktop/src/ui/server_setup.rs \
        apps/desktop/src/ui/wizard.rs apps/desktop/src/ui/devices.rs \
        apps/desktop/src/ui/settings.rs
git commit -m "feat(desktop): add theme + screen router for the egui shell"
```

---

### Task 15: `ui::server_setup` + `ui::login`

**Files:**
- Create: `apps/desktop/src/ui/server_setup.rs`
- Create: `apps/desktop/src/ui/login.rs`
- Test: `apps/desktop/src/ui/server_setup.rs`, `apps/desktop/src/ui/login.rs`

**Interfaces:**
- Consumes: `app::{App, Command, Msg}`, `core::wizard::{probe_server_impl, ProbeResult}`, `core::auth::{login_impl, UserProfile}`.
- Produces:
  - `server_setup::render(app: &mut App, ui: &mut egui::Ui)` and
    `server_setup::validate(url: &str) -> Result<(), String>`.
  - `login::render(app: &mut App, ui: &mut egui::Ui)` and
    `login::validate(username: &str, password: &str) -> Result<(), String>`.

**TEST-INTEGRITY declaration (this file):** adds **5** validation tests for
`server_setup::validate` and **4** for `login::validate`, establishing input
validation parity for the new egui screens (names:
`server_setup_rejects_empty`, `server_setup_rejects_no_scheme`,
`server_setup_accepts_http`, `server_setup_accepts_https`,
`server_setup_trims_whitespace`; `login_rejects_empty_username`,
`login_rejects_empty_password`, `login_accepts_any_non_empty`,
`login_trims_username`). The 5 `serverSetup.test.ts` and 4 `login.test.ts` Vue
view/store tests are deleted with the app in Task 18. File counts **0 → 5** and
**0 → 4**.

- [ ] **Step 1: Write `server_setup.rs` (validation + render)**

Create `apps/desktop/src/ui/server_setup.rs`:

```rust
//! Server Setup: enter the server URL, probe `/health`, then persist.

use crate::app::{App, Command, Msg};

/// Validate a server URL before probing.
pub fn validate(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Server URL is required".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Server URL must start with http:// or https://".into());
    }
    Ok(())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Connect to your server");
    let mut url = app.server_url_input.clone();
    if ui.text_edit_singleline(&mut url).changed() {
        app.server_url_input = url;
    }
    if ui.button("Test connection").clicked() {
        if validate(&app.server_url_input).is_ok() {
            app.send(Command::ProbeServer { url: app.server_url_input.clone() });
        }
    }
    if let Some(Msg::ServerProbed(res)) = app.last_probe.as_ref() {
        ui.colored_label(
            if res.ok { egui::Color32::GREEN } else { egui::Color32::RED },
            &res.message,
        );
    }
    if ui.button("Save and continue").clicked() && validate(&app.server_url_input).is_ok() {
        app.send(Command::SaveServer { url: app.server_url_input.clone() });
    }
    // The `SaveServer` arm reports through `Msg::ConfigSaved`; the fold stores a
    // failure in the shell's single inline-error slot (`login_error`).
    if let Some(err) = &app.login_error {
        ui.colored_label(egui::Color32::RED, err);
    }
}
```

Add to `App`: `pub server_url_input: String`, `pub last_probe: Option<Msg>`, and
`pub fn send(&self, cmd: Command)`. Because both `ui::server_setup` and
`ui::login` reference `App`, the compiler requires every field they read
(`server_url_input`, `last_probe`, `login_error`, `username_input`,
`password_input`) and the `send` method to exist before this task's tests run.
(`editing_server` was already added in Task 14 — this task does not touch it.)

`send` is a **stub** here — Task 16 replaces its body with the full dispatch
table. The stub must still consume every `Command` variant so the crate
compiles; it does nothing (the pure `validate` tests are what this task's step
runs):

```rust
/// Stub dispatch: Task 16 fills this in with the real `rt.spawn` table.
pub fn send(&self, cmd: Command) {
    let _ = cmd;
}
```

Add the five fields to `App::new` (`server_url_input: String::new()`,
`last_probe: None`, `login_error: None`, `username_input: String::new()`,
`password_input: String::new()`).

Add tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_setup_rejects_empty() {
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
    }

    #[test]
    fn server_setup_rejects_no_scheme() {
        assert!(validate("host:8787").is_err());
    }

    #[test]
    fn server_setup_accepts_http() {
        assert!(validate("http://localhost:8787").is_ok());
    }

    #[test]
    fn server_setup_accepts_https() {
        assert!(validate("https://example.com").is_ok());
    }

    #[test]
    fn server_setup_trims_whitespace() {
        assert!(validate("  https://example.com  ").is_ok());
    }
}
```

- [ ] **Step 2: Write `login.rs` (validation + render)**

Create `apps/desktop/src/ui/login.rs`:

```rust
//! Login: username + password, dispatched as `Command::Login`.

use crate::app::{App, Command};

pub fn validate(username: &str, password: &str) -> Result<(), String> {
    if username.trim().is_empty() {
        return Err("Username is required".into());
    }
    if password.is_empty() {
        return Err("Password is required".into());
    }
    Ok(())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Sign in");
    ui.text_edit_singleline(&mut app.username_input);
    ui.add(egui::TextEdit::singleline(&mut app.password_input).password(true));
    if ui.button("Sign in").clicked() {
        if validate(&app.username_input, &app.password_input).is_ok() {
            app.send(Command::Login {
                username: app.username_input.trim().to_string(),
                password: app.password_input.clone(),
            });
        }
    }
    if let Some(err) = &app.login_error {
        ui.colored_label(egui::Color32::RED, err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rejects_empty_username() {
        assert!(validate("", "pw").is_err());
        assert!(validate("  ", "pw").is_err());
    }

    #[test]
    fn login_rejects_empty_password() {
        assert!(validate("user", "").is_err());
    }

    #[test]
    fn login_accepts_any_non_empty() {
        assert!(validate("user", "pw").is_ok());
    }

    #[test]
    fn login_trims_username() {
        // The render path trims before sending; validate accepts surrounding
        // whitespace as long as the trimmed value is non-empty.
        assert!(validate("  user  ", "pw").is_ok());
    }
}
```

Add `pub username_input: String`, `pub password_input: String`,
`pub login_error: Option<String>` to `App`. (`login_error` is the shell's single
inline-error slot; later `Msg` folds reuse it for device/update failures.)

- [ ] **Step 3: Run the tests**

```bash
cargo test --locked ui::server_setup ui::login
```

Expected: `test result: ok. 9 passed`, `0 failed`.

- [ ] **Step 4: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `127 passed` (118 + 9), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ui/server_setup.rs apps/desktop/src/ui/login.rs \
        apps/desktop/src/app.rs
git commit -m "feat(desktop): add Server Setup and Login screens"
```

---

### Task 16: `ui::wizard` + `ui::devices` + `ui::settings` + the `Command` dispatch table

**Files:**
- Create: `apps/desktop/src/ui/wizard.rs`
- Create: `apps/desktop/src/ui/devices.rs`
- Create: `apps/desktop/src/ui/settings.rs`
- Modify: `apps/desktop/src/app.rs`
- Test: the three screen files (in-file tests)

**Interfaces:**
- Consumes: every `core::*` module (auth, session, devices, wizard, updater, fleet_ws, agent_host, config, state).
- Produces:
  - `wizard::render`, `wizard::step_count() -> usize`, `wizard::next_step(step: usize) -> usize`.
  - `wizard::step_label(step: usize) -> &'static str`, `wizard::can_advance(step: usize, capture_probe_ok: bool) -> bool`, `wizard::progress_label(step: usize) -> String`.
  - `devices::render`, `devices::status_label(status: &str) -> &'static str`.
  - `settings::render`, `settings::autostart_label(enabled: bool) -> &'static str`.
  - `App::send(&self, cmd: Command)` — the full dispatch table that maps each
    `Command` to a `self.rt.spawn(...)` task which sends `Msg`s back on `self.tx`.
  - `App::handle_msg(&mut self, msg: Msg)` — the full fold (replacing Task 1's
    placeholder).
  - `app::{Command, Msg, TrayRequest}` variants added here: `Command::{StartAgent,
    StopAgent, Quit}`, `Msg::{AgentStarted, AgentStopped, Tray}`, and the
    `TrayRequest` enum (consumed by the tray in Task 17).

**TEST-INTEGRITY declaration (this file):** the Vue `wizard.test.ts` suite has
**23** cases: **10** pure step/validation cases are ported to `ui/wizard.rs`
(names below); the remaining **13** cases (**8** that mounted DOM components
and **5** Pinia invoke-wrapper cases whose backend logic is covered by Tasks 8
and 9) are deleted with the Vue app in Task 18. Concretely: `wizard.rs` **0 →
10**, `devices.rs` **0 → 2** (`status_label` maps the four server statuses),
`settings.rs` **0 → 1** (`autostart_label`). Net Vue cases go to **0** because
the whole `__tests__` tree is deleted in Task 18. File total **0 → 13**.

- [ ] **Step 1: Write `wizard.rs` (step model + render)**

Create `apps/desktop/src/ui/wizard.rs`:

```rust
//! Setup wizard: three steps — capture, input gate, auto-start (spec §5.2).

use crate::app::{App, Command};

pub fn step_count() -> usize {
    3
}

pub fn next_step(step: usize) -> usize {
    (step + 1).min(step_count())
}

/// The stable slug for a step (0-based). Out-of-range steps read as `"done"`.
pub fn step_label(step: usize) -> &'static str {
    match step {
        0 => "capture",
        1 => "input gate",
        2 => "auto-start",
        _ => "done",
    }
}

/// R1: the store-level advance gate. Only the capture step is probe-gated; the
/// input-gate and auto-start steps advance unconditionally (gate B lives at
/// admission, ADR-42), and the terminal step never advances.
pub fn can_advance(step: usize, capture_probe_ok: bool) -> bool {
    match step {
        0 => capture_probe_ok,
        1 | 2 => true,
        _ => false,
    }
}

/// The one-based progress heading, e.g. `Setup — step 1 of 3`.
pub fn progress_label(step: usize) -> String {
    format!("Setup — step {} of {}", step + 1, step_count())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading(progress_label(app.wizard_step));
    match app.wizard_step {
        0 => {
            // Step 1: Capture. Advancing requires an `ok` capture probe.
            if ui.button("Verify Capture").clicked() {
                app.send(Command::ProbeCapture);
            }
        }
        1 => {
            // Step 2: Input gate. The checkbox is bound to `allow_input`
            // (default off); it is Gate A of the two-gate model (ADR-42).
            let mut allow = app.allow_input;
            if ui.checkbox(&mut allow, "Allow remote input").changed() {
                app.send(Command::ToggleAllowInput { enabled: allow });
            }
        }
        _ => {
            // Step 3: Auto-start. The checkbox reflects the real OS entry.
            let mut autostart = app.autostart_enabled;
            if ui.checkbox(&mut autostart, "Open at login").changed() {
                app.send(Command::SetAutostart { enabled: autostart });
            }
            if ui.button("Done").clicked() {
                app.send(Command::SaveServer { url: app.server_url_input.clone() });
                app.handle_msg(crate::app::Msg::WizardCompleted);
            }
        }
    }
    if ui
        .add_enabled(
            can_advance(app.wizard_step, app.capture_probe_ok),
            egui::Button::new("Next"),
        )
        .clicked()
    {
        // Advance through the fold, exactly as "Done" does with
        // `WizardCompleted`: the UI calls `handle_msg` directly for the
        // synchronous step transition, so `Msg::WizardAdvanced` has a producer
        // (spec §5 lists it among the Wizard's outputs).
        app.handle_msg(crate::app::Msg::WizardAdvanced);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from Vue `wizard.test.ts` (10 pure step/validation cases; the
    // remaining 13 cases — 8 that mounted DOM components and 5 Pinia invoke-wrapper
    // cases whose backend logic is covered by Tasks 8 and 9 — are deleted with
    // the Vue app). 10 cases.

    #[test]
    fn wizard_has_three_steps() {
        assert_eq!(step_count(), 3);
    }

    #[test]
    fn wizard_next_advances_and_clamps() {
        assert_eq!(next_step(0), 1);
        assert_eq!(next_step(1), 2);
        assert_eq!(next_step(2), 3);
        assert_eq!(next_step(3), 3);
    }

    #[test]
    fn step_labels_are_stable_and_terminal_is_done() {
        assert_eq!(step_label(0), "capture");
        assert_eq!(step_label(1), "input gate");
        assert_eq!(step_label(2), "auto-start");
        assert_eq!(step_label(3), "done");
    }

    #[test]
    fn progress_label_is_one_based() {
        assert_eq!(progress_label(0), "Setup — step 1 of 3");
        assert_eq!(progress_label(2), "Setup — step 3 of 3");
    }

    // R1: the capture step only advances once the probe succeeded.
    #[test]
    fn capture_step_advances_only_when_probe_ok() {
        assert!(!can_advance(0, false));
        assert!(can_advance(0, true));
    }

    // R1 negative: a failed probe leaves the capture step unadvanceable.
    #[test]
    fn capture_step_refuses_advance_on_failed_probe() {
        assert!(!can_advance(0, false));
    }

    // The input-gate and auto-start steps advance unconditionally (gate B is at
    // admission, ADR-42).
    #[test]
    fn input_gate_and_autostart_advance_unconditionally() {
        assert!(can_advance(1, false));
        assert!(can_advance(2, false));
    }

    // The terminal step never advances.
    #[test]
    fn terminal_step_never_advances() {
        assert!(!can_advance(3, true));
    }

    // The gate default is closed (guard (a)): with no probe, step 0 cannot
    // advance even though every later step can.
    #[test]
    fn default_state_cannot_advance_past_capture() {
        let probe_ok = false;
        assert!(!can_advance(0, probe_ok));
        assert!(can_advance(1, probe_ok));
    }

    // Advancing from the last step clamps instead of overflowing.
    #[test]
    fn advancing_past_the_end_is_idempotent() {
        assert_eq!(next_step(next_step(2)), 3);
        assert_eq!(next_step(3), 3);
    }
}
```

- [ ] **Step 2: Write `devices.rs` and `settings.rs`**

Create `apps/desktop/src/ui/devices.rs`:

```rust
//! Devices: list registered devices, register this one, delete.

use crate::app::{App, Command};

/// Map a server device status to a display label.
pub fn status_label(status: &str) -> &'static str {
    match status {
        "online" => "Online",
        "offline" => "Offline",
        "pending" => "Pending approval",
        _ => "Unknown",
    }
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Devices");
    ui.horizontal(|ui| {
        ui.label(format!("Signed in as {}", app.username));
        if ui.button("Log out").clicked() {
            app.send(Command::Logout);
        }
        // Live runtime-status indicator (spec §5.2): connected / disconnected /
        // stopped / unknown, read from the live handle (no shell-side atomic).
        let agent_status = {
            let guard = app.agent.lock().unwrap();
            match &*guard {
                Some(handle) => match handle.status() {
                    ponter_agent::RuntimeStatus::Connected => "connected",
                    ponter_agent::RuntimeStatus::Disconnected => "disconnected",
                    ponter_agent::RuntimeStatus::Stopped => "stopped",
                },
                None => "unknown",
            }
        };
        ui.label(format!("Agent: {agent_status}"));
        if ui.button("Settings").clicked() {
            app.showing_settings = true;
        }
    });

    ui.separator();
    ui.label("Capabilities for this device");
    for cap in ["terminal", "desktop", "files"] {
        let mut on = app.register_capabilities.iter().any(|c| c == cap);
        if ui.checkbox(&mut on, cap).changed() {
            if on {
                app.register_capabilities.push(cap.to_string());
            } else {
                app.register_capabilities.retain(|c| c != cap);
            }
        }
    }
    if ui.button("Register this device").clicked() {
        app.send(Command::RegisterDevice {
            capabilities: app.register_capabilities.clone(),
        });
    }

    ui.separator();
    for device in app.devices.clone() {
        ui.horizontal(|ui| {
            ui.label(&device.hostname);
            ui.label(format!("[{}]", device.platform));
            ui.label(status_label(if device.is_online { "online" } else { "offline" }));
            ui.label(format!("id: {}", device.id));
            ui.label(format!("created: {}", device.created_at));
            if ui.button("Delete").clicked() {
                app.pending_delete = Some(device.id.clone());
            }
        });
    }

    // Per-row delete confirmation (spec §5.2): the delete is dispatched only
    // after the operator confirms.
    if let Some(id) = app.pending_delete.clone() {
        ui.separator();
        ui.label(format!("Delete device {id}?"));
        if ui.button("Confirm delete").clicked() {
            app.pending_delete = None;
            app.send(Command::DeleteDevice { id });
        }
        if ui.button("Cancel").clicked() {
            app.pending_delete = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_label_maps_known_statuses() {
        assert_eq!(status_label("online"), "Online");
        assert_eq!(status_label("offline"), "Offline");
        assert_eq!(status_label("pending"), "Pending approval");
    }

    #[test]
    fn status_label_unknown_falls_back() {
        assert_eq!(status_label("weird"), "Unknown");
    }
}
```

Create `apps/desktop/src/ui/settings.rs`:

```rust
//! Settings: theme, autostart, allow-input, update, server edit.

use crate::app::{App, Command};

pub fn autostart_label(enabled: bool) -> &'static str {
    if enabled { "Enabled" } else { "Disabled" }
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Settings");
    if ui.button("Back").clicked() {
        app.showing_settings = false;
        app.editing_server = false;
    }

    // Server URL: edit + re-probe (spec §5.2).
    ui.horizontal(|ui| {
        let mut url = app.server_url_input.clone();
        if ui.text_edit_singleline(&mut url).changed() {
            app.server_url_input = url;
        }
        if ui.button("Re-probe").clicked() {
            app.send(Command::ProbeServer { url: app.server_url_input.clone() });
        }
        // "Edit server" returns to the full Server Setup screen (the router's
        // manual override), where the URL is edited and re-probed.
        if ui.button("Edit server").clicked() {
            app.showing_settings = false;
            app.editing_server = true;
        }
    });

    // Theme (light/dark) — a second control surface for the stored preference.
    ui.horizontal(|ui| {
        if ui.button("Light").clicked() {
            app.send(Command::SetTheme { theme: "light".to_string() });
        }
        if ui.button("Dark").clicked() {
            app.send(Command::SetTheme { theme: "dark".to_string() });
        }
    });

    let mut autostart = app.autostart_enabled;
    if ui.checkbox(&mut autostart, "Start on login").changed() {
        app.send(Command::SetAutostart { enabled: autostart });
    }
    // Allow-input toggle (owner decision, spec §5.2): the SAME `allow_input`
    // preference the wizard sets — a second control surface, not a second gate.
    let mut allow_input = app.allow_input;
    if ui.checkbox(&mut allow_input, "Allow remote input").changed() {
        app.send(Command::ToggleAllowInput { enabled: allow_input });
    }

    ui.label(format!("Version {}", env!("CARGO_PKG_VERSION")));
    if ui.button("Check for updates").clicked() {
        app.send(Command::CheckUpdate);
    }
    // Surfaced after `Msg::UpdateChecked(Ok(Some(..)))` folds in: the operator
    // must opt in before the binary is replaced (guard (b)/(c)).
    if let Some(info) = &app.available_update {
        ui.label(format!("Update available: {}", info.version));
        if ui.button("Install update").clicked() {
            app.send(Command::ApplyUpdate);
        }
    }
    if ui.button("Log out").clicked() {
        app.send(Command::Logout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_label_reflects_state() {
        assert_eq!(autostart_label(true), "Enabled");
        assert_eq!(autostart_label(false), "Disabled");
    }
}
```

Add `pub devices: Vec<crate::core::devices::DesktopDevice>`,
`pub wizard_step: usize`, `pub capture_probe_ok: bool`,
`pub autostart_enabled: bool`, `pub allow_input: bool`,
`pub show_window: bool`,
`pub showing_settings: bool`,
`pub username: String`, `pub register_capabilities: Vec<String>`,
`pub pending_delete: Option<String>`,
`pub available_update: Option<crate::core::updater::UpdateInfo>`,
`pub tray_active: bool`,
`pub fleet_started: std::sync::Arc<std::sync::atomic::AtomicBool>`, and
`pub agent: std::sync::Arc<std::sync::Mutex<Option<ponter_agent::RuntimeHandle>>>`
to `App`. (`server_url_input` and `last_probe` were added in Task 15;
`editing_server` in Task 14.)
`capture_probe_ok` is set in `handle_msg` when `Msg::CaptureProbed` folds in a
probe with `ok == true`; the wizard's Next button reads it via `can_advance`.
`show_window` is set by the tray's "Open window" action (it starts `false`; the
window is already visible on first launch, so the first frame must not re-focus
it); `showing_settings` is
the Devices → Settings override; `username` is set when
`Msg::LoggedIn` folds in; `register_capabilities` seeds the Devices selector
(default `terminal` + `desktop`); `pending_delete` holds the device id awaiting
confirmation; `available_update` holds the checked update (or `None`) so the
Settings screen can offer the install; `fleet_started` guards the one-time
`fleet_ws::run` spawn; `tray_active` is flipped by `main.rs` after the tray
starts (Task 17) so the close handler knows whether hiding strands the user;
`agent`
holds the live runtime handle (shared with the spawned tasks) so Start is
idempotent and Stop/Quit can reach it (§5.4).

The complete `App::new` — every field the earlier tasks added, in one place
(Task 1's `tx`/`rx`/`rt`/`screen`, Task 4's `state`, Task 15's input fields,
and this task's fields) — so the `Self { .. }` value is initialized exactly
once. `allow_input` is seeded from the persisted config, not hard-coded, so the
wizard's second step opens with the stored value:

```rust
pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("building the tokio runtime");
    let config_path = crate::core::state::config_dir().map(|d| d.join("config.json"));
    let state = std::sync::Arc::new(crate::core::state::CoreState::with_config(config_path));
    let screen = if !state.has_server_url() {
        Screen::ServerSetup
    } else {
        Screen::Login
    };
    // Seed the UI mirrors from the persisted config before `state` moves into
    // the struct (the wizard's input-gate step and the Settings toggle read
    // `app.allow_input`).
    let allow_input = *state.allow_input.lock().unwrap();
    let mut app = Self {
        tx,
        rx,
        rt,
        screen,
        state,
        ctx: cc.egui_ctx.clone(),
        username_input: String::new(),
        password_input: String::new(),
        login_error: None,
        server_url_input: String::new(),
        last_probe: None,
        devices: Vec::new(),
        wizard_step: 0,
        capture_probe_ok: false,
        autostart_enabled: crate::autostart::is_autostart_enabled(),
        allow_input,
        editing_server: false,
        show_window: false,
        showing_settings: false,
        username: String::new(),
        register_capabilities: vec!["terminal".to_string(), "desktop".to_string()],
        pending_delete: None,
        available_update: None,
        tray_active: false,
        fleet_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        agent: std::sync::Arc::new(std::sync::Mutex::new(None)),
    };
    // Start the fleet task exactly once for the app's lifetime (guard (g)).
    if !app.fleet_started.swap(true, std::sync::atomic::Ordering::Relaxed) {
        app.rt.spawn(crate::core::fleet_ws::run(app.state.clone(), app.tx.clone()));
    }
    app
}
```

- [ ] **Step 3: Write the `Command` dispatch table in `app.rs`**

Replace `App::send`'s placeholder with the full table. Every arm spawns a task
on `self.rt` that clones `self.tx` and `self.ctx`, calls the matching `core::*`
function, sends exactly one `Msg`, then calls `ctx.request_repaint()` so the
frame that folds the result in actually happens (the window may be hidden).
`self.state` is the `Arc<CoreState>` from Task 4:

```rust
pub fn send(&self, cmd: Command) {
    let tx = self.tx.clone();
    let ctx = self.ctx.clone();
    let state = self.state.clone(); // Arc<CoreState>
    match cmd {
        Command::Login { username, password } => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let url = state.server_url.lock().unwrap().clone();
                let slot = std::sync::Mutex::new(None);
                let res = crate::core::auth::login_impl(&client, &url, &username, &password, &slot)
                    .await;
                let msg = match res {
                    Ok(outcome) => {
                        *state.access_token.lock().unwrap() = Some(outcome.token.clone());
                        Msg::LoggedIn(outcome.user)
                    }
                    Err(e) => Msg::LoginFailed(e),
                };
                let _ = tx.send(msg).await;
                ctx.request_repaint();
            });
        }
        Command::Logout => {
            self.rt.spawn(async move {
                let _ = crate::core::auth::logout_impl(&state);
                *state.access_token.lock().unwrap() = None;
                let _ = tx.send(Msg::DevicesLoaded(Ok(Vec::new()))).await;
                ctx.request_repaint();
            });
        }
        Command::ProbeServer { url } => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let probe = crate::core::wizard::probe_server_impl(&client, &url)
                    .await
                    .unwrap_or_else(|e| crate::core::wizard::ProbeResult { ok: false, message: e });
                let _ = tx.send(Msg::ServerProbed(probe)).await;
                ctx.request_repaint();
            });
        }
        Command::SaveServer { url } => {
            self.rt.spawn(async move {
                *state.server_url.lock().unwrap() = url.clone();
                // `save_config_impl` takes the four real values (Task 8). After a
                // successful save the gate opens so the router leaves Server Setup
                // within this session.
                let res = crate::core::wizard::save_config_impl(
                    &state,
                    Some(url.as_str()),
                    *state.allow_input.lock().unwrap(),
                    state.theme.lock().unwrap().clone().as_deref(),
                );
                if res.is_ok() {
                    state.set_has_server_url(true);
                }
                let _ = tx.send(Msg::ConfigSaved(res)).await;
                ctx.request_repaint();
            });
        }
        Command::ProbeCapture => {
            self.rt.spawn(async move {
                let probe = crate::core::wizard::probe_capture()
                    .await
                    .unwrap_or_else(|e| crate::core::wizard::ProbeResult { ok: false, message: e });
                let _ = tx.send(Msg::CaptureProbed(probe)).await;
                ctx.request_repaint();
            });
        }
        Command::RegisterDevice { capabilities } => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let url = state.server_url.lock().unwrap().clone();
                let token = state.access_token.lock().unwrap().clone().unwrap_or_default();
                let res =
                    crate::core::devices::register_device_impl(&client, &url, &token, capabilities)
                        .await;
                let _ = tx.send(Msg::DeviceRegistered(res)).await;
                ctx.request_repaint();
            });
        }
        Command::DeleteDevice { id } => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let url = state.server_url.lock().unwrap().clone();
                let token = state.access_token.lock().unwrap().clone().unwrap_or_default();
                let res = crate::core::devices::delete_device_impl(&client, &url, &token, &id).await;
                let _ = tx.send(Msg::DeviceDeleted(res)).await;
                ctx.request_repaint();
            });
        }
        Command::RefreshDevices => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let url = state.server_url.lock().unwrap().clone();
                let token = state.access_token.lock().unwrap().clone().unwrap_or_default();
                let res = crate::core::devices::list_devices_impl(&client, &url, &token).await;
                let _ = tx.send(Msg::DevicesLoaded(res)).await;
                ctx.request_repaint();
            });
        }
        Command::CheckUpdate => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                let res = crate::core::updater::check(&client, env!("CARGO_PKG_VERSION")).await;
                let _ = tx.send(Msg::UpdateChecked(res)).await;
                ctx.request_repaint();
            });
        }
        Command::ApplyUpdate => {
            self.rt.spawn(async move {
                let client = state.http.clone();
                // The update info came from a prior CheckUpdate; re-check to
                // obtain the artifact URL + signature, then apply (which
                // verifies before replacing the binary — guard (c)).
                let res = match crate::core::updater::check(&client, env!("CARGO_PKG_VERSION")).await
                {
                    Ok(Some(info)) => crate::core::updater::apply(&client, &info).await,
                    Ok(None) => Ok(()),
                    Err(e) => Err(e),
                };
                let _ = tx.send(Msg::UpdateApplied(res)).await;
                ctx.request_repaint();
            });
        }
        Command::SetAutostart { enabled } => {
            self.rt.spawn(async move {
                // Ported single-entry API: `set_autostart(bool)` (Task 9).
                let res = crate::autostart::set_autostart(enabled);
                let _ = tx.send(Msg::AutostartToggled(res.is_ok())).await;
                ctx.request_repaint();
            });
        }
        Command::ToggleAllowInput { enabled } => {
            self.rt.spawn(async move {
                *state.allow_input.lock().unwrap() = enabled;
                // Preserve the server URL + theme (Task 8's four-value API): a
                // later toggle must not silently drop the other settings.
                let url = state.server_url.lock().unwrap().clone();
                let theme = state.theme.lock().unwrap().clone();
                let res = crate::core::wizard::save_config_impl(
                    &state,
                    url.as_deref(),
                    enabled,
                    theme.as_deref(),
                );
                if res.is_ok() && url.is_some() {
                    state.set_has_server_url(true);
                }
                let _ = tx.send(Msg::ConfigSaved(res)).await;
                ctx.request_repaint();
            });
        }
        Command::SetTheme { theme } => {
            self.rt.spawn(async move {
                *state.theme.lock().unwrap() = Some(theme.clone());
                // Preserve the server URL + allow-input (Task 8's four-value API).
                let url = state.server_url.lock().unwrap().clone();
                let allow_input = *state.allow_input.lock().unwrap();
                let res = crate::core::wizard::save_config_impl(
                    &state,
                    url.as_deref(),
                    allow_input,
                    Some(theme.as_str()),
                );
                if res.is_ok() && url.is_some() {
                    state.set_has_server_url(true);
                }
                let _ = tx.send(Msg::ConfigSaved(res)).await;
                ctx.request_repaint();
            });
        }
        Command::StartAgent => {
            // Idempotent: a second Start while a handle is already held is a
            // no-op (§5.4). The `agent` slot is checked before spawning.
            if self.agent.lock().unwrap().is_some() {
                return;
            }
            let agent = self.agent.clone();
            self.rt.spawn(async move {
                // `agent_host::start` is async (Task 10): it awaits
                // `AgentRuntime::start(config)`.
                match crate::core::agent_host::start(&state).await {
                    Ok(handle) => {
                        *agent.lock().unwrap() = Some(handle);
                        let _ = tx.send(Msg::AgentStarted(Ok(()))).await;
                    }
                    Err(e) => {
                        let _ = tx.send(Msg::AgentStarted(Err(e))).await;
                    }
                }
                ctx.request_repaint();
            });
        }
        Command::StopAgent => {
            let agent = self.agent.clone();
            self.rt.spawn(async move {
                // `agent_host::stop` is async (Task 10).
                let res = match agent.lock().unwrap().take() {
                    Some(handle) => crate::core::agent_host::stop(&handle).await,
                    None => Ok(()), // no-op when nothing runs (§5.4)
                };
                let _ = tx.send(Msg::AgentStopped(res)).await;
                ctx.request_repaint();
            });
        }
        Command::Quit => {
            let agent = self.agent.clone();
            self.rt.spawn(async move {
                if let Some(handle) = agent.lock().unwrap().take() {
                    let _ = crate::core::agent_host::stop(&handle).await;
                }
                std::process::exit(0);
            });
        }
    }
}
```

Two notes on the agent arms:

- The live `RuntimeHandle` is shared between the UI thread and the spawned
  tasks, so `App.agent` is
  `pub agent: std::sync::Arc<std::sync::Mutex<Option<ponter_agent::RuntimeHandle>>>`
  (not a plain `Option`). `App::new` initializes it to `Arc::new(Mutex::new(None))`.
  `StopAgent`/`Quit` `take()` the handle (so a later Start works) and stop it;
  `StartAgent` stores the handle on success.
- `Command::StartAgent` is idempotent at the call site: `App::send` returns early
  when the slot already holds a handle, so a second "Start agent" (from Settings
  or the tray) does not start a second runtime.

Every arm spawns on `self.rt`, sends exactly one `Msg` on `tx`, and calls
`ctx.request_repaint()` after the send. No arm retries (guard (e)); a failed
refresh or a failed probe is reported once and left for the user to retry.

`CoreState` must be `Clone`-by-handle: wrap it in `Arc<CoreState>` on `App`
(`pub state: std::sync::Arc<CoreState>`), and have each task hold a clone of the
`Arc`. `App::new` builds `Arc::new(CoreState::with_config(...))`. Store a clone
of `egui::Context` on `App` (`pub ctx: egui::Context`, from `CreationContext`) so
tasks can call `ctx.request_repaint()`.

Then update `App::handle_msg` to fold each `Msg` into state (it currently
ignores its argument — Task 1's placeholder). Replace its body with the full
fold:

```rust
pub(crate) fn handle_msg(&mut self, msg: Msg) {
    match msg {
        Msg::ServerProbed(res) => self.last_probe = Some(Msg::ServerProbed(res)),
        Msg::CaptureProbed(res) => {
            self.capture_probe_ok = res.ok;
            self.last_probe = Some(Msg::CaptureProbed(res));
        }
        Msg::ConfigSaved(Ok(())) => {
            self.login_error = None;
            // A successful save leaves Server Setup even when it was reached via
            // the Settings "Edit server" override.
            self.editing_server = false;
        }
        Msg::ConfigSaved(Err(err)) => self.login_error = Some(err),
        Msg::LoggedIn(user) => {
            self.login_error = None;
            self.username = user.username; // shown by the Devices screen
            self.send(Command::RefreshDevices);
        }
        Msg::LoginFailed(err) => self.login_error = Some(err),
        Msg::WizardAdvanced => self.wizard_step = crate::ui::wizard::next_step(self.wizard_step),
        Msg::WizardCompleted => self.state.mark_wizard_completed(),
        Msg::AutostartToggled(ok) => self.autostart_enabled = ok,
        Msg::DevicesLoaded(Ok(devices)) => self.devices = devices,
        Msg::DevicesLoaded(Err(err)) => self.login_error = Some(err),
        Msg::DeviceRegistered(Ok(_)) | Msg::DeviceDeleted(Ok(_)) => {
            self.send(Command::RefreshDevices)
        }
        Msg::DeviceRegistered(Err(err)) | Msg::DeviceDeleted(Err(err)) => {
            self.login_error = Some(err)
        }
        Msg::FleetChanged => self.send(Command::RefreshDevices),
        Msg::UpdateChecked(Ok(Some(info))) => self.available_update = Some(info),
        Msg::UpdateChecked(Ok(None)) => self.available_update = None,
        Msg::UpdateChecked(Err(err)) | Msg::UpdateApplied(Err(err)) => {
            self.login_error = Some(err)
        }
        Msg::UpdateApplied(Ok(())) => { /* the new binary takes over on restart */ }
        Msg::AgentStarted(Ok(())) => { /* the runtime is up; the tray reads status */ }
        Msg::AgentStarted(Err(err)) | Msg::AgentStopped(Err(err)) => {
            self.login_error = Some(err)
        }
        Msg::AgentStopped(Ok(())) => { /* the runtime is down */ }
        Msg::Tray(req) => match req {
            TrayRequest::StartAgent => self.send(Command::StartAgent),
            TrayRequest::StopAgent => self.send(Command::StopAgent),
            TrayRequest::OpenWindow => self.show_window = true,
            TrayRequest::ToggleAutostart => {
                let next = !self.autostart_enabled;
                self.send(Command::SetAutostart { enabled: next });
            }
            TrayRequest::Quit => self.send(Command::Quit),
        },
    }
}
```

The `show_window` flag (added with `App.agent`) is read in `App::ui` to restore
the window when the tray's "Open window" is chosen:

```rust
if self.show_window {
    self.show_window = false;
    ui.ctx().send_viewport_cmd(egui::ViewportCommand::Visible(true));
    ui.ctx().send_viewport_cmd(egui::ViewportCommand::Focus);
}
```

`App::ui` becomes (the Settings screen is a manual override, reached from
Devices, exactly as Server Setup is re-entered from Settings):

```rust
fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
    // Manual overrides win over the gate router: `editing_server` returns to
    // Server Setup, `showing_settings` opens Settings from Devices.
    self.screen = if self.showing_settings {
        Screen::Settings
    } else {
        crate::ui::route(&self.state, self.editing_server)
    };
    crate::theme::apply(ui.ctx(), self.state.theme.lock().unwrap().as_deref());
    crate::ui::render(self, ui);
}
```

Finally, start the fleet WS task once (Task 11's `fleet_ws::run` is the **only**
producer of `Msg::FleetChanged`; without this the push path is dead). This is
already wired in Step 2's complete `App::new` — the `fleet_started` guard makes
the spawn idempotent, so a re-login never starts a second one:

```rust
// In App::new, after the `Self { .. }` value is built and bound to a mutable
// `app`, start the fleet task exactly once before returning it:
if !app.fleet_started.swap(true, std::sync::atomic::Ordering::Relaxed) {
    app.rt.spawn(crate::core::fleet_ws::run(app.state.clone(), app.tx.clone()));
}
app
```

`fleet_ws::run` loops until the channel closes, so it is spawned exactly once
for the app's lifetime.

- [ ] **Step 4: Run the tests**

```bash
cargo test --locked ui::wizard ui::devices ui::settings
```

Expected: `test result: ok. 13 passed` (10 + 2 + 1), `0 failed`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `140 passed` (127 + 13), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/ui/wizard.rs apps/desktop/src/ui/devices.rs \
        apps/desktop/src/ui/settings.rs apps/desktop/src/app.rs
git commit -m "feat(desktop): add Wizard, Devices, Settings screens and command dispatch"
```

---

### Task 17: `src/tray.rs` — tray on its own thread (ADR-81)

**Files:**
- Create: `apps/desktop/src/tray.rs`
- Modify: `apps/desktop/src/main.rs`
- Modify: `apps/desktop/src/app.rs`
- Test: `apps/desktop/src/tray.rs` (in-file tests)

**Interfaces:**
- Consumes: `app::{Command, Msg}`, `ponter_agent::RuntimeStatus`, `core::agent_host`.
- Produces:
  - The **pure** functions, carried verbatim from the Tauri `tray.rs`:
    `tray_label(status: &RuntimeStatus) -> &'static str`,
    `status_text(status: &RuntimeStatus) -> String`,
    `status_key(status: &RuntimeStatus) -> &'static str`,
    `action_for_menu_id(id: &str) -> Option<TrayAction>`,
    `derive_ws_url(server_url: &str) -> Result<String, String>`,
    `should_hide_on_close(tray_active: bool) -> bool`.
  - `TrayAction { Start, Stop, OpenWindow, ToggleAutostart, Quit }`.
  - Menu ids `ID_STATUS`, `ID_START`, `ID_STOP`, `ID_OPEN`, `ID_AUTOSTART`, `ID_QUIT`
    (values `"status"`, `"start"`, `"stop"`, `"open"`, `"autostart"`, `"quit"`).
  - `tray::spawn(tx: Sender<Msg>, runtime: Arc<Mutex<Option<RuntimeHandle>>>)` —
    starts the tray on its own thread; Linux uses `ksni` (StatusNotifierItem, no
    GTK), Windows uses `tray-icon`. It reads the live status from the shared
    `runtime` slot each time it (re)builds its menu (`status_text(&handle.status())`),
    so there is **no** shell-side status atomic (Task 10 / spec §4.3).

**TEST-INTEGRITY declaration (this file):** ports the **12** menu/logic tests
from the Tauri `tray.rs` (the other 6 went to Task 10):
`maps_runtime_status_to_tray_label`, `status_key_maps_all_variants`,
`status_text_formats_exactly`, `action_for_menu_id_dispatches_all_ids`,
`action_for_menu_id_unknown_is_none`, `derive_ws_url_converts_http`,
`derive_ws_url_converts_https_and_trims_slash`, `derive_ws_url_passes_through_ws`,
`derive_ws_url_rejects_unsupported_scheme`, `derive_ws_url_rejects_missing_scheme`,
`should_hide_on_close_true_when_tray_active`,
`should_hide_on_close_false_when_no_tray` (names preserved). File test count
**0 → 12**. Review Focus #5 is pinned by the two `should_hide_on_close_*` tests.

- [ ] **Step 1: Port the pure functions + tests**

Copy the 12 tests and their supporting pure functions listed above from
`apps/desktop/src-tauri/src/tray.rs` into `apps/desktop/src/tray.rs`. Keep the
function bodies and the tests byte-identical apart from imports
(`RuntimeStatus` now from `ponter_agent`, `TrayAction` defined here).

- [ ] **Step 2: Add the platform tray threads**

Add the `spawn` entry point and its two platform implementations:

```rust
use std::sync::{Arc, Mutex};

use ponter_agent::{RuntimeHandle, RuntimeStatus};
use tokio::sync::mpsc::Sender;
use crate::app::{Msg, TrayRequest};

/// The shared runtime slot `App.agent` owns; the tray reads the live status
/// from it and never keeps a second status atomic (Task 10 / spec §4.3).
pub type RuntimeSlot = Arc<Mutex<Option<RuntimeHandle>>>;

/// The status row's text, read from the live handle (or "Stopped" when no
/// runtime is running). Rebuilt each time the menu is shown, so it stays live.
fn current_status_text(runtime: &Mutex<Option<RuntimeHandle>>) -> String {
    let guard = match runtime.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    match &*guard {
        Some(handle) => status_text(&handle.status()),
        None => status_text(&RuntimeStatus::Stopped),
    }
}

/// Start the tray on its own OS thread. It never touches the GUI thread; it
/// injects `Msg::Tray(..)` actions into the app channel.
pub fn spawn(tx: Sender<Msg>, runtime: RuntimeSlot) {
    #[cfg(target_os = "linux")]
    spawn_linux(tx, runtime);
    #[cfg(target_os = "windows")]
    spawn_windows(tx, runtime);
}

/// The tray icon, embedded from `apps/desktop/icons/` (spec §4.1). One PNG is
/// used on both platforms: the Linux SNI falls back to it when the themed name
/// is not installed, and Windows decodes it to RGBA for `tray-icon`. Decoding
/// reuses `eframe`'s helper (already a dependency — no `image` crate needed).
#[cfg(any(target_os = "linux", target_os = "windows"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// Map a menu id to the `Msg` the app should receive, using the ported
/// `action_for_menu_id` (single source of the id→action mapping).
fn msg_for_menu_id(id: &str) -> Option<Msg> {
    match action_for_menu_id(id)? {
        TrayAction::Start => Some(Msg::Tray(TrayRequest::StartAgent)),
        TrayAction::Stop => Some(Msg::Tray(TrayRequest::StopAgent)),
        TrayAction::OpenWindow => Some(Msg::Tray(TrayRequest::OpenWindow)),
        TrayAction::ToggleAutostart => Some(Msg::Tray(TrayRequest::ToggleAutostart)),
        TrayAction::Quit => Some(Msg::Tray(TrayRequest::Quit)),
    }
}

#[cfg(target_os = "linux")]
fn spawn_linux(tx: Sender<Msg>, runtime: RuntimeSlot) {
    use ksni::blocking::TrayMethods;
    struct PonterTray { tx: Sender<Msg>, runtime: RuntimeSlot }
    impl ksni::Tray for PonterTray {
        fn id(&self) -> String { "ponter-desktop".into() }
        fn title(&self) -> String { "Ponter Desktop".into() }
        fn icon_name(&self) -> String { "ponter-desktop".into() }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            // The embedded PNG (spec §4.1) so the icon shows even when the
            // themed name above is not installed in the icon theme.
            eframe::icon_data::from_png_bytes(TRAY_ICON_PNG)
                .map(|img| {
                    vec![ksni::Icon {
                        width: img.width as i32,
                        height: img.height as i32,
                        data: img.rgba,
                    }]
                })
                .unwrap_or_default()
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::StandardItem;
            let send = |id: &'static str| {
                let tx = self.tx.clone();
                move |_t: &mut PonterTray| {
                    if let Some(msg) = msg_for_menu_id(id) {
                        let _ = tx.try_send(msg);
                    }
                }
            };
            vec![
                StandardItem { label: current_status_text(&self.runtime).into(), enabled: false, ..Default::default() }.into(),
                StandardItem { label: "Start agent".into(), activate: Box::new(send(ID_START)), ..Default::default() }.into(),
                StandardItem { label: "Stop agent".into(), activate: Box::new(send(ID_STOP)), ..Default::default() }.into(),
                StandardItem { label: "Open window".into(), activate: Box::new(send(ID_OPEN)), ..Default::default() }.into(),
                StandardItem { label: "Quit".into(), activate: Box::new(send(ID_QUIT)), ..Default::default() }.into(),
            ]
        }
    }
    let tray = PonterTray { tx, runtime };
    std::thread::spawn(move || {
        let _ = tray.spawn();
    });
}

#[cfg(target_os = "windows")]
fn spawn_windows(tx: Sender<Msg>, runtime: RuntimeSlot) {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tray_icon::TrayIconBuilder;

    // Build the menu from the same ids (`ID_START` …) the Linux arm uses.
    let menu = Menu::new();
    let status = MenuItem::new(current_status_text(&runtime), false, None);
    let start = MenuItem::with_id(ID_START, "Start agent", true, None);
    let stop = MenuItem::with_id(ID_STOP, "Stop agent", true, None);
    let open = MenuItem::with_id(ID_OPEN, "Open window", true, None);
    let quit = MenuItem::with_id(ID_QUIT, "Quit", true, None);
    menu.append_items(&[
        &status,
        &start,
        &stop,
        &open,
        &PredefinedMenuItem::separator(),
        &quit,
    ])
    .expect("building the tray menu");

    // Decode the embedded PNG to RGBA for the notification-area icon (spec
    // §4.1), reusing eframe's helper — no extra image crate.
    let icon = eframe::icon_data::from_png_bytes(TRAY_ICON_PNG)
        .map(|img| tray_icon::Icon::from_rgba(img.rgba, img.width, img.height))
        .expect("decoding the embedded tray icon")
        .expect("building the tray icon");

    std::thread::spawn(move || {
        // `build` starts the Win32 message pump on its own thread; the handle
        // must stay alive for the process lifetime, so it is bound (not `_`).
        let _tray = TrayIconBuilder::new()
            .with_tooltip("Ponter Desktop")
            .with_icon(icon)
            .with_menu(Box::new(menu))
            .build()
            .expect("building the tray icon");
        // Menu clicks arrive on the global receiver; forward each to the app
        // through the same `msg_for_menu_id` mapping as the Linux arm.
        let rx = tray_icon::menu::MenuEvent::receiver();
        loop {
            match rx.recv() {
                Ok(event) => {
                    if let Some(msg) = msg_for_menu_id(event.id.as_ref()) {
                        let _ = tx.try_send(msg);
                    }
                }
                Err(_) => break, // the sender side is gone; stop the loop.
            }
        }
    });
}
```

(The ksni `StandardItem` field set and the `tray-icon` menu-builder methods
may differ slightly by version — build against the fields/methods `ksni` 0.3.6
and `tray-icon` 0.26.1 expose, keeping the labels, the menu ids, and
`enabled: false` on the status row. The id→action mapping lives only in
`msg_for_menu_id`, so both platforms share it. On Windows the status row is
built once at tray creation; the Linux SNI menu is rebuilt on each open, so it
reflects the live handle. The pure `status_text`/`tray_label` functions — the
part the tests pin — are shared by both.)

- [ ] **Step 3: Wire the close handler (Review Focus #5) and start the tray**

In `App`, add `pub tray_active: bool` (set true when the tray spawns) and handle
the viewport close request in `App::ui`: The window must start visible, so
initialize `tray_active: false` in Task 16's `App::new` and let `main.rs` flip
it after `tray::spawn` succeeds. Read the close flag and the request as:

```rust
// In App::ui, before rendering:
let close_requested = ui
    .ctx()
    .input(|i| i.viewport().close_requested());
if close_requested {
    if should_hide_on_close(self.tray_active) {
        ui.ctx().send_viewport_cmd(egui::ViewportCommand::CancelClose);
        ui.ctx().send_viewport_cmd(egui::ViewportCommand::Visible(false));
    }
    // else: let the window close and the app exit.
}
```

In `main.rs`, after `App::new`, call `tray::spawn(app.tx.clone(), app.agent.clone())`
on the app's channel + the shared runtime slot (`App.agent`, added in Task 16), and
set `app.tray_active = true`. The tray reads the live status from that slot, so no
separate status atomic exists (Task 10 / spec §4.3). On Windows, hold the tray in a
variable that outlives the event loop.

- [ ] **Step 4: Run the tests**

```bash
cargo test --locked tray
```

Expected: `test result: ok. 12 passed`, `0 failed`.

- [ ] **Step 5: Run the whole suite, format, and lint**

```bash
cargo test --locked
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
```

Expected: `152 passed` (140 + 12), `0 failed`; fmt and clippy exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main.rs apps/desktop/src/tray.rs apps/desktop/src/app.rs
git commit -m "feat(desktop): add tray on its own thread (ksni/tray-icon, ADR-81)"
```

---

### Task 18: Rewrite the README and delete the Tauri/Vue tree

**Files:**
- Modify: `apps/desktop/README.md`
- Delete: `apps/desktop/src/**`, `apps/desktop/src-tauri/**`
- Delete: `apps/desktop/package.json`, `apps/desktop/vite.config.ts`,
  `apps/desktop/vitest.config.ts`, `apps/desktop/tsconfig.json`,
  `apps/desktop/tsconfig.node.json`, `apps/desktop/index.html`,
  `apps/desktop/components.json`, `apps/desktop/public/`
- Delete: `apps/desktop/scripts/build-self.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a repository where `apps/desktop/` contains only the Rust crate
  (`Cargo.toml`, `Cargo.lock`, `README.md`, `icons/`, `src/`) plus the packaging
  inputs added in Task 13 (`scripts/make-appimage.sh`, `installer.nsi`,
  `wix/main.wxs`).

**TEST-INTEGRITY declaration (this file):** deletes the **84** Vue
`it()`/`test()` declarations (89 executed cases) across
`apps/desktop/src/__tests__/**`. **Declared deletion with reason: the subject
(Vue components, stores, views) is deleted.** Net Vue **84 → 0**. No Rust test
changes.

- [ ] **Step 1: Rewrite `README.md`**

Replace `apps/desktop/README.md` in full with a Rust-shell README: what the app
is, the toolchain (`1.98.1`), `cargo run`, `cargo test`, how to build the
artifacts per platform, where the config/keychain live (the continuity
invariants), and the two ADRs it implements (79, 80, 81, 82). English only.

- [ ] **Step 2: Delete the Vue + Tauri tree**

```bash
git rm -r apps/desktop/src apps/desktop/src-tauri \
         apps/desktop/package.json apps/desktop/vite.config.ts \
         apps/desktop/vitest.config.ts apps/desktop/tsconfig.json \
         apps/desktop/tsconfig.node.json apps/desktop/index.html \
         apps/desktop/components.json apps/desktop/public \
         apps/desktop/scripts/build-self.sh
```

Keep `apps/desktop/icons/` (the tray + bundle icons). The new crate has its own
`Cargo.lock`; the old `apps/desktop/src-tauri/Cargo.lock` goes with the tree.

- [ ] **Step 3: Confirm the crate still builds and tests after the deletion**

```bash
cd apps/desktop && cargo test --locked
```

Expected: `test result: ok. 152 passed`, `0 failed` (the deletion removed only
the Vue tree; the Rust crate is untouched).

- [ ] **Step 4: Confirm no Vue/Node file remains under `apps/desktop`**

```bash
find apps/desktop -name '*.vue' -o -name '*.ts' -o -name 'package.json' -o -name 'vite.config.ts'
```

Expected: no output (empty).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/README.md
git commit -m "chore(desktop): delete Tauri/Vue tree, rewrite README for the Rust shell"
```

---

### Task 19: Docs — ADRs 79–82 and the §8 trail (docs-only, English)

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/README.md` (only if it links the desktop app's build steps)

**Interfaces:**
- Consumes: the shipped PRs (their numbers + squash SHAs).
- Produces: four ADRs recorded inline in `docs/ARCHITECTURE.md` §8, in the same
  prose-blockquote style as ADR-78, plus one §8 trail entry.

**TEST-INTEGRITY declaration (this file):** docs-only; no test changes. Only
SonarCloud QG applies (no `paths:` filter matches `docs/**`). QA binding not
required (precedent #108/#111/#113/#114).

- [ ] **Step 1: Append the ADRs after the ADR-78 blockquote in §8**

Open `docs/ARCHITECTURE.md`, find the ADR-78 blockquote
(`> **Phase 9: Platform consolidation — macOS dropped (2026-10-13).** **ADR-78 — …**`)
and its trail line, then append, in the same `> **…** **ADR-N — Title.** …`
blockquote style (NOT `### ADR-N` headings):

- **ADR-79 — Native desktop shell on egui/eframe.** One Rust crate replaces the
  Tauri + Vue app; no webview, no GTK, no Qt, no Node build; the same five
  screens and the same security posture.
- **ADR-80 — Rust self-updater with minisign verification.** The updater fetches
  the release manifest, downloads the artifact, verifies a minisign signature
  against the compiled-in public key **before** replacing the binary; the public
  key is unchanged (continuity).
- **ADR-81 — Tray on its own thread.** The tray runs off the GUI thread; Linux
  uses StatusNotifierItem via `ksni` (no GTK); Windows uses `tray-icon`. It
  injects commands into the app's channel.
- **ADR-82 — Fleet push-first with polling fallback.** Fleet changes arrive over
  the existing `/api/ws/browser` WebSocket; when the WS is unusable (drop, or
  the Origin gate's 403) the shell polls `GET /api/agents`. The two layers are
  never active together.

- [ ] **Step 2: Append the §8 trail entry**

Add a trail line after the ADRs naming the PR(s) that made them true, following
the existing format, e.g.:

```
> **§8 trail (ADR-79–82):** code+CI PR #<PR1-NUMBER> `<PR1-SHA>` (Rust core,
> updater, fleet WS, CI); UI+tray+deletion PR #<PR2-NUMBER> `<PR2-SHA>`. Spec
> authored in `0b2edf9`, folded owner decisions in `9cef33d`.
```

Fill the placeholders with the real PR numbers and squash SHAs once the PRs
merge. (Per the convention in #109 → #112, the squash SHA of the last PR may be
recorded by a follow-up docs cycle if it is not yet known.)

- [ ] **Step 3: Verify English-only and no Vietnamese characters**

```bash
grep -nP '[\x{1EA0}-\x{1EFF}]' docs/ARCHITECTURE.md docs/README.md || echo "no Vietnamese characters"
```

Expected: `no Vietnamese characters`.

- [ ] **Step 4: Run prettier on the changed docs**

```bash
pnpm prettier --check docs/ARCHITECTURE.md
```

Expected: passes (or run `pnpm prettier --write` on the file).

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/README.md
git commit -m "docs(architecture): record ADRs 79-82 for the native desktop shell"
```

---

## Post-Plan: Delivery (2 PRs)

**PR 1 — Rust core + updater + fleet WS + CI (non-GUI-first).** Tasks 1–13.
The crate builds, every `core::*` module is ported and tested, `fleet_ws` and
`updater` are new and tested, and CI builds the crate with the no-GTK guard. The
old Tauri/Vue app still exists in the tree (untouched) — PR1 adds the new crate
beside it. Branch `feat/native-desktop-shell-core`. **QA binding required.**

**PR 2 — UI screens + tray + README + deletion.** Tasks 14–19. The `ui::*`
screens, the tray, the rewritten README, the deletion of the Tauri/Vue tree, and
the ADRs. Branch `feat/native-desktop-shell-ui`. **QA binding required.**

The docs task (19) may instead land as a docs-only follow-up if the ADR trail
needs the merged PR numbers/SHAs.

## §8 Verification Checklist (final, for QA / PM cross-check)

1. `cargo test --locked` in `apps/desktop` reports **152 passed, 0 failed**; the
   per-task deltas in this plan sum to that number (99 ported + 53 new across
   both PRs, minus 1 declared drop from the 100 baseline).
2. `cargo fmt --check` and `cargo clippy --all-targets --locked -- -D warnings`
   both exit 0.
3. The CI guard step fails if `cargo tree` contains any of `webkit`, `gtk`,
   `qt`, `wry`, `tao` — and passes on the shipped crate.
4. `build-desktop.yml` has no Node/pnpm steps and no Tauri system deps; it builds
   the crate on `ubuntu-latest` + `windows-latest` and uploads the artifact set
   (AppImage, `.deb`, `.rpm`; portable `.exe`, NSIS, `.msi`).
5. `ci-node.yml` no longer lists `apps/desktop/**` in either `paths:` filter.
6. `find apps/desktop -name '*.vue' -o -name '*.ts' -o -name 'package.json'`
   prints nothing.
7. Guards (a)–(g) each have a test: (b) `should_apply_*` (Task 12), (c)
   `apply_refuses_a_bad_signature_without_touching_the_binary` (Task 12), (d)
   `is_auth_fatal_status_classifies_401_fatal_and_403_not` (Task 6), (e)
   `retry_once_on_401_*` (Task 6), (f)
   `device_payload_has_no_credential_and_account_is_unchanged` (Task 7), (g)
   `ws_unusable_switches_to_fallback_and_arms_poll` +
   `successful_reconnect_disarms_poll_before_push_active` (Task 11). Guard (a)
   (input-gate default open→closed) is pinned by the ported
   `build_runtime_config_*` + `config` default tests.
8. Continuity invariants (§9.3) each have a test: config identifier (Task 4),
   keychain service/accounts (Tasks 5, 7), updater pubkey (Task 12 const),
   agent identity path (Task 10).
9. The `fleet_ws` layer state-machine invariant test
   (`layers_are_never_both_active_across_a_full_cycle`) passes.
10. `docs/ARCHITECTURE.md` §8 carries ADRs 79–82 in blockquote style plus a §8
    trail entry; `docs/**` has 0 Vietnamese characters; prettier passes.
11. No commit in either PR carries a `Co-authored-by` trailer; every commit
    message and all repo docs are English.
12. TEST-INTEGRITY: the only deletions are the 84 Vue declarations (subject
    deleted) and the 1 declared Rust drop (`lib.rs:83` `ponter_agent_runtime_api_is_wired`,
    superseded by Task 10 agent host integration), with its reason recorded in
    Task 12 and the PR1 description.
