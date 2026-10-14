//! The central application state (ADR-79).
//!
//! `CoreState` is the single source of truth for runtime configuration,
//! authentication credentials, and feature gates. It is display-agnostic and
//! unit-testable without a window or display server.

use crate::core::config::{load_config, resolve_server_url, PersistedConfig};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub struct CoreState {
    pub http: reqwest::Client,
    /// Effective server URL (ADR-64). `Mutex` so `save_config` can write it and
    /// `login` can read it.
    pub server_url: Mutex<String>,
    /// Whether a real source (env / persisted / build default) supplied the
    /// URL — NOT whether the resolved URL is non-empty (the localhost fallback
    /// always makes it non-empty). Drives `ServerSetupView` visibility.
    has_server_url: AtomicBool,
    /// Access token: memory only, never persisted.
    pub access_token: Mutex<Option<String>>,
    /// Input-gate preference (ADR-42 Gate A), loaded from config.
    pub allow_input: Mutex<bool>,
    /// Path to `config.json`; `None` in tests / when config dir is unavailable
    /// (persistence is then a no-op).
    pub config_path: Option<PathBuf>,
    /// The last-loaded/known persisted config (kept in sync on save).
    pub persisted: Mutex<PersistedConfig>,
    /// UI theme preference, initialized from `persisted.theme`.
    pub theme: Mutex<Option<String>>,
    /// Wizard completion status for the current session.
    wizard_completed: Mutex<bool>,
}

impl CoreState {
    /// Build state with an explicit config path. Loads the persisted config and
    /// resolves the server URL via the ADR-64 chain.
    pub fn with_config(config_path: Option<PathBuf>) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let persisted = config_path.as_deref().map(load_config).unwrap_or_default();

        let runtime_env = std::env::var("PONTER_SERVER_URL").ok();
        let build_default = option_env!("PONTER_DEFAULT_SERVER_URL");

        let has_server_url = [
            runtime_env.as_deref(),
            persisted.server_url.as_deref(),
            build_default,
        ]
        .iter()
        .any(|v| v.map(|s| !s.trim().is_empty()).unwrap_or(false));

        let server_url = resolve_server_url(
            runtime_env.as_deref(),
            persisted.server_url.as_deref(),
            build_default,
        );
        let allow_input = persisted.allow_input;
        let theme = persisted.theme.clone();

        Self {
            http: reqwest::Client::new(),
            server_url: Mutex::new(server_url),
            has_server_url: AtomicBool::new(has_server_url),
            access_token: Mutex::new(None),
            allow_input: Mutex::new(allow_input),
            config_path,
            persisted: Mutex::new(persisted),
            theme: Mutex::new(theme),
            wizard_completed: Mutex::new(false),
        }
    }

    /// Convenience constructor with no persistence (tests, and any path where
    /// the config dir cannot be resolved).
    pub fn new() -> Self {
        Self::with_config(None)
    }

    /// Whether a real source supplied the URL. Read by the router (Task 14).
    pub fn has_server_url(&self) -> bool {
        self.has_server_url.load(Ordering::Relaxed)
    }

    /// Mark that a real server URL is now set (called after a successful save, so
    /// the router leaves Server Setup within the same session — the Tauri
    /// `save_config` regression).
    pub fn set_has_server_url(&self, value: bool) {
        self.has_server_url.store(value, Ordering::Relaxed);
    }

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

    /// The per-platform config directory for this app's identifier, matching the
    /// Tauri app's `app_config_dir()` so an upgraded install finds `config.json`
    /// in place (continuity invariant §9.3).
    ///
    /// Linux:   `$XDG_CONFIG_HOME/com.ponter.desktop` (usually `~/.config/...`)
    /// Windows: `%APPDATA%\com.ponter.desktop`
    pub fn config_dir() -> Option<PathBuf> {
        config_dir()
    }
}

/// The per-platform config directory for this app's identifier, matching the
/// Tauri app's `app_config_dir()` so an upgraded install finds `config.json`
/// in place (continuity invariant §9.3).
///
/// Linux:   `$XDG_CONFIG_HOME/com.ponter.desktop` (usually `~/.config/...`)
/// Windows: `%APPDATA%\com.ponter.desktop`
pub fn config_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.config_dir().join("com.ponter.desktop"))
}

impl Default for CoreState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::{save_config, PersistedConfig};

    #[test]
    fn with_config_none_defaults_to_localhost() {
        // No config path, no env (assumes PONTER_SERVER_URL unset in the test env).
        let state = CoreState::with_config(None);
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(!state.has_server_url());
    }

    #[test]
    fn with_config_loads_persisted_server_url_and_sets_has_server_url() {
        let dir = std::env::temp_dir().join(format!("ponter-state-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        save_config(
            &path,
            &PersistedConfig {
                server_url: Some("http://file:9".to_string()),
                allow_input: true,
                theme: Some("dark".to_string()),
            },
        )
        .unwrap();

        let state = CoreState::with_config(Some(path));
        assert_eq!(*state.server_url.lock().unwrap(), "http://file:9");
        assert!(*state.allow_input.lock().unwrap());
        assert_eq!(*state.theme.lock().unwrap(), Some("dark".to_string()));
        assert!(state.has_server_url());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_dir_uses_com_ponter_desktop_identifier() {
        // Continuity invariant (§9.3): the identifier must not change, or an
        // upgraded install loses its config.json.
        let dir = CoreState::config_dir().expect("a home dir exists in the test environment");
        assert!(
            dir.ends_with("com.ponter.desktop"),
            "config dir must end with the app identifier, got {dir:?}"
        );
    }
}
