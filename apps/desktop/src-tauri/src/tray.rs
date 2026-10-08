//! Tray icon + agent lifecycle (ADR-55, Task 7).
//!
//! Pure functions (R3) are unit-tested in `#[cfg(test)]`; the lifecycle hooks
//! (`init`, `start_agent`, `stop_agent`, `quit_app`, the menu handler, the status
//! poll, and the close-to-tray handler) are NOT unit-tested — they require a real
//! tray / window / keychain / network and are exercised by the L3 smoke test
//! (spec §6.4).
//!
//! No credential value is ever logged (R6/R7).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ponter_agent::identity::AgentIdentity;
use ponter_agent::{
    AgentRuntime, DesktopSource, RuntimeConfig, RuntimeHandle, RuntimeStatus, StreamProfile,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::autostart;
// Imported — never re-declared (R3):
use crate::commands::devices::KEYCHAIN_AGENT_ACCOUNT;
use crate::commands::login::KEYCHAIN_SERVICE;
use crate::keychain;
use crate::state::AppState;

/// The tray menu item ids (keep these EXACT strings — they are the dispatch contract).
const ID_STATUS: &str = "status";
const ID_START: &str = "start";
const ID_STOP: &str = "stop";
const ID_OPEN: &str = "open";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";

/// Lightweight logging shim: `tracing` is not a direct dependency of this crate
/// (R2 forbids new deps), so lifecycle logs go to `eprintln!` — consistent with
/// `keychain.rs` and visible in the terminal regardless of subscriber state.
macro_rules! tray_log {
    ($($arg:tt)*) => {
        eprintln!($($arg)*)
    };
}

/// What a tray menu id means (R3 pure-fn).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Start,
    Stop,
    OpenWindow,
    ToggleAutostart,
    Quit,
}

/// Map a runtime status to its display label (R3 pure-fn, R7 honest — 3 states only).
pub fn tray_label(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Connected => "Connected",
        RuntimeStatus::Disconnected => "Disconnected",
        RuntimeStatus::Stopped => "Stopped",
    }
}

/// The status menu item's text (R3 pure-fn).
pub fn status_text(status: &RuntimeStatus) -> String {
    format!("Status: {}", tray_label(status))
}

/// What a menu id means (R3 pure-fn).
/// "start" -> Start, "stop" -> Stop, "open" -> OpenWindow, "autostart" ->
/// ToggleAutostart, "quit" -> Quit, anything else -> None.
pub fn action_for_menu_id(id: &str) -> Option<TrayAction> {
    match id {
        ID_START => Some(TrayAction::Start),
        ID_STOP => Some(TrayAction::Stop),
        ID_OPEN => Some(TrayAction::OpenWindow),
        ID_AUTOSTART => Some(TrayAction::ToggleAutostart),
        ID_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// Derive the signaling WS URL from the wizard's server URL (R3 pure-fn).
/// - trims trailing '/'
/// - "http://" -> "ws://", "https://" -> "wss://", "ws://"/"wss://" pass through
/// - then appends "/api/ws/agent"
/// - any other scheme, or no scheme at all -> Err
pub fn derive_ws_url(server_url: &str) -> Result<String, String> {
    let trimmed = server_url.trim_end_matches('/');
    let ws = if trimmed.starts_with("http://") {
        trimmed.replacen("http://", "ws://", 1)
    } else if trimmed.starts_with("https://") {
        trimmed.replacen("https://", "wss://", 1)
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        trimmed.to_string()
    } else {
        return Err(format!(
            "server URL must use http://, https://, ws://, or wss:// (got: {})",
            trimmed
        ));
    };
    Ok(format!("{ws}/api/ws/agent"))
}

/// Close-request behavior (R3 pure-fn): hide only when a tray exists to
/// restore the window from.
pub fn should_hide_on_close(tray_active: bool) -> bool {
    tray_active
}

/// Identity path, mirroring the CLI — `apps/agent/src/main.rs` `resolve_identity_path`
/// (R3 pure-fn, R5 parity source).
///
/// XDG_CONFIG_HOME (non-blank), else HOME/.config, else "." -> join("ponter/agent-identity.pkcs8").
/// Takes `Option<&str>` for each env var so the resolution logic is testable
/// without touching the process environment.
pub fn resolve_identity_path(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf {
    let base = if let Some(x) = xdg_config_home {
        if !x.trim().is_empty() {
            PathBuf::from(x)
        } else {
            home.map_or(PathBuf::from("."), |h| {
                let mut p = PathBuf::from(h);
                p.push(".config");
                p
            })
        }
    } else if let Some(h) = home {
        if !h.trim().is_empty() {
            let mut p = PathBuf::from(h);
            p.push(".config");
            p
        } else {
            PathBuf::from(".")
        }
    } else {
        PathBuf::from(".")
    };
    base.join("ponter").join("agent-identity.pkcs8")
}

/// Default shell for the embedded runtime (R5 parity with CLI, with the documented
/// parity gap noted in the report): `$SHELL` on unix, `cmd.exe` on Windows.
/// The CLI's richer Windows pwsh detection is NOT reused here — acceptable carry-forward.
fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
    #[cfg(windows)]
    {
        "cmd.exe".to_string()
    }
}

/// Assemble the embedded runtime's config from stored settings (R3 + R5 parity).
///
/// `Err` when the credential is absent or blank after trim (mirror the CLI's rule:
/// "never a default" — a default credential authenticates nothing). The error
/// message names registration so the user knows where to get a credential.
pub fn build_runtime_config(
    server_url: &str,
    credential: Option<&str>,
    allow_input: bool,
    identity: Arc<AgentIdentity>,
) -> Result<RuntimeConfig, String> {
    let cred = match credential {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return Err(
                "no agent credential stored — register this device in the Devices view first"
                    .to_string(),
            )
        }
    };

    let server = derive_ws_url(server_url)?;

    Ok(RuntimeConfig {
        server,
        credential: cred,
        shell: default_shell(),
        stun: "stun:stun.l.google.com:19302".to_string(),
        cols: 80,
        rows: 24,
        desktop_source: DesktopSource::Screen,
        desktop_profile: StreamProfile::DEFAULT_1080P30,
        desktop_default_source: "primary".to_string(),
        desktop_select_timeout: Duration::from_millis(5000),
        allow_input,
        files_root: None,
        identity,
    })
}

/// Managed state owned by this module (R1 — `state.rs` is off-limits).
/// The runtime slot + tray bookkeeping live here.
pub struct TrayState {
    /// True only after the tray was built successfully (set in `init`).
    tray_active: AtomicBool,
    /// The running runtime handle, if any.
    runtime: std::sync::Mutex<Option<RuntimeHandle>>,
    /// Serializes concurrent starts (double menu-click guard).
    start_guard: tauri::async_runtime::Mutex<()>,
    /// The status menu item, stored for the poll loop.
    status_item: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
    /// The "Open at login" check menu item (R8 — stored for the toggle handler).
    autostart_item: std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    /// Keeps the tray icon alive explicitly (builder result is stored, not dropped).
    _tray: std::sync::Mutex<Option<tauri::tray::TrayIcon>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            tray_active: AtomicBool::new(false),
            runtime: std::sync::Mutex::new(None),
            start_guard: tauri::async_runtime::Mutex::new(()),
            status_item: std::sync::Mutex::new(None),
            autostart_item: std::sync::Mutex::new(None),
            _tray: std::sync::Mutex::new(None),
        }
    }

    /// Whether the tray was successfully built. The close-to-tray handler reads
    /// this to decide whether `window.hide()` is reversible.
    pub fn tray_active(&self) -> bool {
        self.tray_active.load(Ordering::Relaxed)
    }

    /// Set the runtime handle after a successful start.
    fn set_runtime(&self, handle: RuntimeHandle) {
        match self.runtime.lock() {
            Ok(mut guard) => *guard = Some(handle),
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = Some(handle);
            }
        }
    }

    /// Take the runtime handle (leaves None in its place). Used by stop/quit.
    fn take_runtime(&self) -> Option<RuntimeHandle> {
        match self.runtime.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }

    /// Snapshot the current status for the poll loop to read.
    fn current_status(&self) -> RuntimeStatus {
        let guard = match self.runtime.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match &*guard {
            Some(handle) => handle.status(),
            None => RuntimeStatus::Stopped,
        }
    }
}

impl Default for TrayState {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the tray menu: Status (disabled) / separator / Start / Stop / separator
/// / Open / "Open at login" checkbox / separator / Quit. IDs are the dispatch
/// contract (R4/R8). Returns the menu + the status item + the autostart checkbox
/// so `init` can store both.
fn build_menu(
    app: &AppHandle,
) -> tauri::Result<(
    Menu<tauri::Wry>,
    MenuItem<tauri::Wry>,
    CheckMenuItem<tauri::Wry>,
)> {
    let status_item = MenuItem::with_id(app, ID_STATUS, "Status: Stopped", false, None::<&str>)?;
    let start_item = MenuItem::with_id(app, ID_START, "Start agent", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, ID_STOP, "Stop agent", true, None::<&str>)?;
    let open_item = MenuItem::with_id(app, ID_OPEN, "Open window", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        ID_AUTOSTART,
        "Open at login",
        true,
        autostart::is_autostart_enabled(),
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_id_and_items(
        app,
        "ponter-tray-menu",
        &[
            &status_item,
            &sep1,
            &start_item,
            &stop_item,
            &sep2,
            &open_item,
            &autostart_item,
            &sep3,
            &quit_item,
            &sep4,
        ],
    )?;

    Ok((menu, status_item, autostart_item))
}

/// Build the tray icon. The icon is set only when `default_window_icon` is Some
/// (never unwrap — R10). On failure, log and continue: an app without a tray
/// must still open a window.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let (menu, status_item, autostart_item) = build_menu(app)?;

    let builder = TrayIconBuilder::with_id("ponter-tray")
        .menu(&menu)
        .on_menu_event(|app, event| {
            // Sync handler — spawn async work, never block (R4/R10).
            let id = event.id().0.clone();
            match action_for_menu_id(&id) {
                Some(action) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_menu_action(&app, action).await;
                    });
                }
                None => {
                    tray_log!("unknown tray menu id — ignoring: {id}");
                }
            }
        })
        .show_menu_on_left_click(false);

    // Set icon only when one exists (never unwrap — R10).
    let builder = if let Some(icon) = app.default_window_icon().cloned() {
        builder.icon(icon)
    } else {
        builder
    };

    let tray = builder.build(app)?;

    let state = app.state::<TrayState>();
    // Store the status item + autostart item + tray, mark active.
    // Same poison-handling pattern on every mutex (R8).
    match state.status_item.lock() {
        Ok(mut guard) => *guard = Some(status_item),
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            *guard = Some(status_item);
        }
    }
    match state.autostart_item.lock() {
        Ok(mut guard) => *guard = Some(autostart_item),
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            *guard = Some(autostart_item);
        }
    }
    match state._tray.lock() {
        Ok(mut guard) => *guard = Some(tray),
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            *guard = Some(tray);
        }
    }
    state.tray_active.store(true, Ordering::Relaxed);

    // Spawn the status poll loop.
    spawn_status_poll(app.clone());

    Ok(())
}

/// The menu handler dispatch — spawns the async lifecycle action (R4).
async fn handle_menu_action(app: &AppHandle, action: TrayAction) {
    match action {
        TrayAction::Start => {
            if let Err(e) = start_agent(app).await {
                tray_log!("failed to start the agent runtime: {e}");
            }
        }
        TrayAction::Stop => {
            if let Err(e) = stop_agent(app).await {
                tray_log!("failed to stop the agent runtime: {e}");
            }
        }
        TrayAction::OpenWindow => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        TrayAction::ToggleAutostart => {
            toggle_autostart(app).await;
        }
        TrayAction::Quit => {
            if let Err(e) = quit_app(app).await {
                tray_log!("error during quit: {e}");
            }
            app.exit(0);
        }
    }
}

/// Handle the "Open at login" toggle (R8). tauri flips the checkbox on click,
/// so the item's `is_checked()` is the user's desired state. On failure,
/// revert the check so the item never lies.
async fn toggle_autostart(app: &AppHandle) {
    let state = app.state::<TrayState>();

    // Read the desired state from the checkbox (tauri toggled it on click).
    // `is_checked()` returns Result — surface a read failure rather than unwrap.
    let (desired, item) = {
        let guard = match state.autostart_item.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match &*guard {
            Some(item) => {
                let checked = match item.is_checked() {
                    Ok(c) => c,
                    Err(e) => {
                        tray_log!("could not read autostart checkbox state: {e}");
                        return;
                    }
                };
                (checked, item.clone())
            }
            None => return,
        }
    };

    // Apply to the platform entry (R3 — entry IS the source of truth).
    match autostart::set_autostart(desired) {
        Ok(()) => {
            tray_log!(
                "auto-start {} (takes effect at next login)",
                if desired { "enabled" } else { "disabled" }
            );
        }
        Err(e) => {
            tray_log!("failed to toggle auto-start: {e}");
            // Revert the checkbox so it never lies about the real state.
            if let Err(revert_err) = item.set_checked(!desired) {
                tray_log!("could not revert autostart checkbox: {revert_err}");
            }
        }
    }
}

/// Start the agent runtime (R4). Idempotent against double-clicks via `start_guard`.
async fn start_agent(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let _guard = state.start_guard.lock().await;

    // Already running? No-op.
    {
        let cur = {
            let guard = match state.runtime.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.as_ref().map(|h| h.status())
        };
        if let Some(status) = cur {
            if status != RuntimeStatus::Stopped {
                tray_log!(
                    "agent runtime already started (status: {})",
                    tray_label(&status)
                );
                return Ok(());
            }
        }
    }

    // Clone values OUT of mutexes before any `.await` (R4 — Task 4 Send-bound lesson).
    let (server_url, allow_input) = {
        let app_state = app.state::<AppState>();
        let su = {
            let guard = app_state
                .server_url
                .lock()
                .map_err(|e| format!("state lock poisoned: {e}"))?;
            guard.clone()
        };
        let ai = {
            let guard = app_state
                .allow_input
                .lock()
                .map_err(|e| format!("state lock poisoned: {e}"))?;
            *guard
        };
        (su, ai)
    };

    // Read the credential from the keychain (imported consts — never re-declared).
    let credential = keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT)
        .map_err(|e| format!("could not read agent credential from keychain: {e:?}"))?;

    // Load identity, mirroring the CLI's path resolution.
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    let identity_path = resolve_identity_path(xdg.as_deref(), home.as_deref());
    let identity = AgentIdentity::load_or_generate(&identity_path)
        .map_err(|e| format!("could not load/generate agent identity: {e:?}"))?;

    let config = build_runtime_config(
        &server_url,
        credential.as_deref(),
        allow_input,
        Arc::new(identity),
    )?;

    // Take any stale handle, stop it, then start fresh.
    let stale = state.take_runtime();
    if let Some(handle) = stale {
        let _ = handle.stop().await;
    }

    let handle = AgentRuntime::start(config)
        .await
        .map_err(|e| format!("agent runtime failed to start: {e:?}"))?;
    state.set_runtime(handle);

    tray_log!("agent runtime started");
    Ok(())
}

/// Stop the agent runtime (R4). Idempotent — no handle is a no-op.
async fn stop_agent(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    if let Some(handle) = state.take_runtime() {
        handle
            .stop()
            .await
            .map_err(|e| format!("agent runtime stop failed: {e:?}"))?;
        tray_log!("agent runtime stopped");
    } else {
        tray_log!("stop requested but no runtime is running");
    }
    Ok(())
}

/// Quit: stop the runtime (if any), then exit (R4).
async fn quit_app(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<TrayState>();
    if let Some(handle) = state.take_runtime() {
        handle
            .stop()
            .await
            .map_err(|e| format!("agent runtime stop during quit failed: {e:?}"))?;
    }
    Ok(())
}

/// Spawn the status poll loop: `std::thread::spawn` + 1s sleep (R4).
/// Reads `TrayState.runtime` status, computes `status_text`, and if it differs
/// from the last value written, calls `MenuItem::set_text` (tauri dispatches
/// this to the main thread — safe from any thread).
fn spawn_status_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));

            let status = {
                let state = app.state::<TrayState>();
                state.current_status()
            };

            let text = status_text(&status);
            if last.as_deref() != Some(text.as_str()) {
                // Update the status item text.
                let item = {
                    let state = app.state::<TrayState>();
                    let guard = match state.status_item.lock() {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    guard.clone()
                };
                if let Some(item) = item {
                    if let Err(e) = item.set_text(&text) {
                        tray_log!("could not update tray status text (will retry next tick): {e}");
                    }
                }
                last = Some(text);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // R3/RL test 1: status-to-label mapping (verbatim from the plan).
    #[test]
    fn maps_runtime_status_to_tray_label() {
        assert_eq!(tray_label(&RuntimeStatus::Connected), "Connected");
        assert_eq!(tray_label(&RuntimeStatus::Disconnected), "Disconnected");
        assert_eq!(tray_label(&RuntimeStatus::Stopped), "Stopped");
    }

    // R3/RL test 2: status_text exact strings.
    #[test]
    fn status_text_formats_exactly() {
        assert_eq!(status_text(&RuntimeStatus::Connected), "Status: Connected");
        assert_eq!(
            status_text(&RuntimeStatus::Disconnected),
            "Status: Disconnected"
        );
        assert_eq!(status_text(&RuntimeStatus::Stopped), "Status: Stopped");
    }

    // R3/RL test 3: action_for_menu_id dispatch.
    #[test]
    fn action_for_menu_id_dispatches_all_ids() {
        assert_eq!(action_for_menu_id("start"), Some(TrayAction::Start));
        assert_eq!(action_for_menu_id("stop"), Some(TrayAction::Stop));
        assert_eq!(action_for_menu_id("open"), Some(TrayAction::OpenWindow));
        assert_eq!(
            action_for_menu_id("autostart"),
            Some(TrayAction::ToggleAutostart)
        );
        assert_eq!(action_for_menu_id("quit"), Some(TrayAction::Quit));
    }

    #[test]
    fn action_for_menu_id_unknown_is_none() {
        assert_eq!(action_for_menu_id("nope"), None);
        assert_eq!(action_for_menu_id(""), None);
    }

    // R3/RL test 4: derive_ws_url — the five spec cases + trailing slash trim.
    #[test]
    fn derive_ws_url_converts_http() {
        assert_eq!(
            derive_ws_url("http://localhost:8787").unwrap(),
            "ws://localhost:8787/api/ws/agent"
        );
    }

    #[test]
    fn derive_ws_url_converts_https_and_trims_slash() {
        assert_eq!(
            derive_ws_url("https://h:8443/").unwrap(),
            "wss://h:8443/api/ws/agent"
        );
    }

    #[test]
    fn derive_ws_url_passes_through_ws() {
        assert_eq!(derive_ws_url("ws://h").unwrap(), "ws://h/api/ws/agent");
    }

    #[test]
    fn derive_ws_url_rejects_unsupported_scheme() {
        assert!(derive_ws_url("ftp://h").is_err());
    }

    #[test]
    fn derive_ws_url_rejects_missing_scheme() {
        assert!(derive_ws_url("localhost:8787").is_err());
    }

    // R3/RL test 5: should_hide_on_close.
    #[test]
    fn should_hide_on_close_true_when_tray_active() {
        assert!(should_hide_on_close(true));
    }

    #[test]
    fn should_hide_on_close_false_when_no_tray() {
        assert!(!should_hide_on_close(false));
    }

    // R3/RL test 6: resolve_identity_path — three cases.
    #[test]
    fn resolve_identity_path_xdg_wins() {
        let p = resolve_identity_path(Some("/custom/xdg"), Some("/home/user"));
        assert_eq!(
            p,
            PathBuf::from("/custom/xdg")
                .join("ponter")
                .join("agent-identity.pkcs8")
        );
    }

    #[test]
    fn resolve_identity_path_home_fallback() {
        let p = resolve_identity_path(None, Some("/home/user"));
        assert_eq!(
            p,
            PathBuf::from("/home/user/.config")
                .join("ponter")
                .join("agent-identity.pkcs8")
        );
    }

    #[test]
    fn resolve_identity_path_neither() {
        let p = resolve_identity_path(None, None);
        assert_eq!(
            p,
            PathBuf::from(".")
                .join("ponter")
                .join("agent-identity.pkcs8")
        );
    }

    // R3/RL test 7: build_runtime_config.
    #[test]
    fn build_runtime_config_missing_credential_errs() {
        let identity = make_test_identity();
        let result = build_runtime_config("http://localhost:8787", None, false, identity);
        match result {
            Err(e) => assert!(
                e.contains("register"),
                "error must mention registration: {e}"
            ),
            Ok(_) => panic!("expected Err for missing credential"),
        }
    }

    #[test]
    fn build_runtime_config_blank_credential_errs() {
        let identity = make_test_identity();
        let result = build_runtime_config("http://localhost:8787", Some("  "), false, identity);
        match result {
            Err(e) => assert!(
                e.contains("register"),
                "blank credential must error with register hint: {e}"
            ),
            Ok(_) => panic!("expected Err for blank credential"),
        }
    }

    #[test]
    fn build_runtime_config_ok_has_parity_values() {
        let identity = make_test_identity();
        let result = build_runtime_config("http://localhost:8787", Some("ag_test"), true, identity);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result.err());
        let config = result.unwrap();
        assert_eq!(config.server, "ws://localhost:8787/api/ws/agent");
        assert_eq!(config.credential, "ag_test");
        assert!(config.allow_input);
        assert_eq!(config.cols, 80);
        assert_eq!(config.rows, 24);
        assert_eq!(config.desktop_profile, StreamProfile::DEFAULT_1080P30);
        assert_eq!(config.desktop_source, DesktopSource::Screen);
        assert_eq!(config.desktop_default_source, "primary");
        assert_eq!(config.desktop_select_timeout, Duration::from_millis(5000));
        assert_eq!(config.stun, "stun:stun.l.google.com:19302");
        assert_eq!(config.files_root, None);
    }

    /// Helper: create a throwaway identity in a temp dir unique to this call.
    /// Uses a thread-id + counter so parallel tests don't collide on the same file.
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    fn make_test_identity() -> Arc<AgentIdentity> {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ponter-tray-test-{}-{}.pkcs8",
            std::process::id(),
            n
        ));
        let identity =
            AgentIdentity::load_or_generate(&path).expect("should load or generate identity");
        let _ = std::fs::remove_file(&path);
        Arc::new(identity)
    }
}
