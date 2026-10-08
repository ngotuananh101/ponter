use crate::config::{load_config, resolve_server_url, PersistedConfig};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub http: reqwest::Client,
    /// Effective server URL (ADR-64). `Mutex` so `save_config` can write it and
    /// `login` can read it.
    pub server_url: Mutex<String>,
    /// Whether a real source (env / persisted / build default) supplied the
    /// URL — NOT whether the resolved URL is non-empty (the localhost fallback
    /// always makes it non-empty). Drives `ServerSetupView` visibility.
    pub has_server_url: bool,
    /// Access token: memory only, never persisted.
    pub access_token: Mutex<Option<String>>,
    /// Input-gate preference (ADR-42 Gate A), loaded from config.
    pub allow_input: Mutex<bool>,
    /// Path to `config.json`; `None` in tests / when `app_config_dir()` is
    /// unavailable (persistence is then a no-op).
    pub config_path: Option<PathBuf>,
    /// The last-loaded/known persisted config (kept in sync on save).
    pub persisted: Mutex<PersistedConfig>,
}

impl AppState {
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

        Self {
            http: reqwest::Client::new(),
            server_url: Mutex::new(server_url),
            has_server_url,
            access_token: Mutex::new(None),
            allow_input: Mutex::new(allow_input),
            config_path,
            persisted: Mutex::new(persisted),
        }
    }

    /// Convenience constructor with no persistence (tests, and any path where
    /// the config dir cannot be resolved).
    pub fn new() -> Self {
        Self::with_config(None)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{save_config, PersistedConfig};

    #[test]
    fn with_config_none_defaults_to_localhost() {
        // No config path, no env (assumes PONTER_SERVER_URL unset in the test env).
        let state = AppState::with_config(None);
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(!state.has_server_url);
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

        let state = AppState::with_config(Some(path));
        assert_eq!(*state.server_url.lock().unwrap(), "http://file:9");
        assert!(*state.allow_input.lock().unwrap());
        assert!(state.has_server_url);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
