//! Persisted desktop configuration (ADR-64/65/68).
//!
//! `PersistedConfig` is the on-disk JSON shape written to the Tauri app-config
//! directory. It holds ONLY non-secret preferences — the access token stays in
//! memory and the refresh token in the OS keychain (ADR-52).

use std::path::Path;

/// The on-disk config shape. Every field defaults so an older or partial file
/// still loads (ADR-65).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedConfig {
    pub server_url: Option<String>,
    pub allow_input: bool,
    pub theme: Option<String>,
}

/// Load the config from `path`. A missing, unreadable, or invalid file yields
/// the default config — never an error (a corrupt config must not brick
/// startup, ADR-65).
pub fn load_config(path: &Path) -> PersistedConfig {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => PersistedConfig::default(),
    }
}

/// Write `cfg` to `path` as pretty JSON, creating the parent directory if it
/// does not exist.
pub fn save_config(path: &Path, cfg: &PersistedConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create config dir {parent:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("could not serialize config: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("could not write config {path:?}: {e}"))
}

/// Resolve the effective server URL from the four-level precedence chain
/// (ADR-64): runtime env → persisted → build-time default → localhost.
/// A whitespace-only value at any level is treated as unset; the result has
/// trailing slashes trimmed.
pub fn resolve_server_url(
    runtime_env: Option<&str>,
    persisted: Option<&str>,
    build_default: Option<&str>,
) -> String {
    for value in [runtime_env, persisted, build_default]
        .into_iter()
        .flatten()
    {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }
    "http://localhost:8787".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_runtime_env() {
        assert_eq!(
            resolve_server_url(
                Some("http://env:1"),
                Some("http://file:2"),
                Some("http://build:3")
            ),
            "http://env:1"
        );
    }

    #[test]
    fn resolve_falls_to_persisted_when_env_absent() {
        assert_eq!(
            resolve_server_url(None, Some("http://file:2"), Some("http://build:3")),
            "http://file:2"
        );
    }

    #[test]
    fn resolve_falls_to_build_default() {
        assert_eq!(
            resolve_server_url(None, None, Some("http://build:3")),
            "http://build:3"
        );
    }

    #[test]
    fn resolve_falls_to_localhost_when_all_unset() {
        assert_eq!(
            resolve_server_url(None, None, None),
            "http://localhost:8787"
        );
    }

    #[test]
    fn resolve_treats_whitespace_only_as_unset() {
        assert_eq!(
            resolve_server_url(Some("   "), Some("http://file:2"), None),
            "http://file:2"
        );
        // An empty build default must NOT be returned as "".
        assert_eq!(
            resolve_server_url(None, None, Some("")),
            "http://localhost:8787"
        );
    }

    #[test]
    fn resolve_trims_trailing_slashes() {
        assert_eq!(
            resolve_server_url(Some("http://host:8787///"), None, None),
            "http://host:8787"
        );
    }

    #[test]
    fn load_missing_file_is_default() {
        let path = std::env::temp_dir().join("ponter-cfg-missing-does-not-exist.json");
        let _ = std::fs::remove_file(&path);
        let cfg = load_config(&path);
        assert_eq!(cfg, PersistedConfig::default());
    }

    #[test]
    fn load_corrupt_json_is_default() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        assert_eq!(load_config(&path), PersistedConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_partial_json_defaults_absent_fields() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        // An older build that had no `theme` field.
        std::fs::write(&path, r#"{"serverUrl":"http://s:1","allowInput":true}"#).unwrap();
        let cfg = load_config(&path);
        assert_eq!(cfg.server_url.as_deref(), Some("http://s:1"));
        assert!(cfg.allow_input);
        assert_eq!(cfg.theme, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips_and_creates_parent_dir() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Parent does not exist yet — save must create it.
        let path = dir.join("nested").join("config.json");
        let cfg = PersistedConfig {
            server_url: Some("http://s:1".to_string()),
            allow_input: true,
            theme: Some("dark".to_string()),
        };
        save_config(&path, &cfg).expect("save should create parent dir and write");
        assert_eq!(load_config(&path), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
