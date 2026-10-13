//! In-process `AgentRuntime` host (ADR-55, ADR-79).
//!
//! Owns the lifecycle, identity, and configuration for running the agent
//! runtime in-process.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::core::state::CoreState;
use ponter_agent::identity::AgentIdentity;
use ponter_agent::{AgentRuntime, DesktopSource, RuntimeConfig, RuntimeHandle, StreamProfile};

/// Derive the signaling WS URL from the server URL (pure fn).
///
/// - Trims trailing `/`
/// - `http://` -> `ws://`, `https://` -> `wss://`, `ws://`/`wss://` pass through
/// - Appends `/api/ws/agent`
/// - Any other scheme or no scheme -> `Err`
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

/// Identity path, mirroring the CLI — `apps/agent/src/main.rs` `resolve_identity_path`.
///
/// XDG_CONFIG_HOME (non-blank), else HOME/.config, else "." -> join("ponter/agent-identity.pkcs8").
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

/// Default shell for the embedded runtime: `$SHELL` on unix, `cmd.exe` on Windows.
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
    #[cfg(windows)]
    {
        "cmd.exe".to_string()
    }
}

/// Assemble the embedded runtime's config from stored settings.
///
/// `Err` when the credential is absent or blank after trim.
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

/// Load or generate `AgentIdentity` at the specified directory / path.
pub fn load_identity(config_dir: &Path) -> anyhow::Result<Arc<AgentIdentity>> {
    let path = if config_dir.as_os_str().is_empty() {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let home = std::env::var("HOME").ok();
        resolve_identity_path(xdg.as_deref(), home.as_deref())
    } else if config_dir.ends_with("agent-identity.pkcs8") {
        config_dir.to_path_buf()
    } else {
        config_dir.join("agent-identity.pkcs8")
    };
    let identity = AgentIdentity::load_or_generate(&path)?;
    Ok(Arc::new(identity))
}

/// Start the agent runtime in-process.
///
/// Reads the agent credential from the keychain in `spawn_blocking` (Linux D-Bus safe),
/// resolves the agent identity, builds `RuntimeConfig`, and launches `AgentRuntime`.
pub async fn start(state: &CoreState) -> Result<RuntimeHandle, String> {
    let server_url = state
        .server_url
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?
        .clone();
    let allow_input = *state
        .allow_input
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;

    let credential = tokio::task::spawn_blocking(|| {
        crate::core::keychain::get_secret(
            crate::core::auth::KEYCHAIN_SERVICE,
            crate::core::devices::AGENT_CREDENTIAL_ACCOUNT,
        )
    })
    .await
    .map_err(|e| format!("keychain task panicked: {e}"))?
    .map_err(|e| format!("could not read agent credential from keychain: {e:?}"))?;

    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    let identity_path = resolve_identity_path(xdg.as_deref(), home.as_deref());
    let identity = load_identity(&identity_path)
        .map_err(|e| format!("could not load/generate agent identity: {e:?}"))?;

    let config = build_runtime_config(&server_url, credential.as_deref(), allow_input, identity)?;

    let handle = AgentRuntime::start(config)
        .await
        .map_err(|e| format!("agent runtime failed to start: {e:?}"))?;

    Ok(handle)
}

/// Stop the agent runtime.
pub async fn stop(handle: &RuntimeHandle) -> Result<(), String> {
    handle
        .stop()
        .await
        .map_err(|e| format!("agent runtime stop failed: {e:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    fn make_test_identity() -> Arc<AgentIdentity> {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ponter-agent-host-test-{}-{}.pkcs8",
            std::process::id(),
            n
        ));
        let identity =
            AgentIdentity::load_or_generate(&path).expect("should load or generate identity");
        let _ = std::fs::remove_file(&path);
        Arc::new(identity)
    }

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
}
