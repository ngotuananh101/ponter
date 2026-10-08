//! Setup wizard commands (ADR-53).
//!
//! Each wizard step verifies real capability, not just collects a string:
//! `probe_server` probes `GET /health`; `probe_capture` probes a real capture
//! frame through the agent's desktop code path; `save_config` writes
//! the verified values into `AppState` and persists them to `config.json`
//! (ADR-64/65).

use crate::config::save_config as write_config;
use crate::state::AppState;
use anyhow::Result;
use serde::Deserialize;

/// The result returned to the frontend for every probe (camelCase on the wire).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub message: String,
}

/// Wire shape of the server's `/health` response.
#[derive(Debug, Deserialize)]
struct HealthResponse {
    status: String,
}

/// Pure mapping of a health-check HTTP response into a `ProbeResult`
/// (R2). Unit-tested independently of any network.
///
/// Success is a 2xx status AND a body that parses as `{"status":"ok"}`.
pub fn map_health_response(status: u16, body: &str) -> ProbeResult {
    if !(200..300).contains(&status) {
        return ProbeResult {
            ok: false,
            message: format!("server returned HTTP {status}"),
        };
    }

    match serde_json::from_str::<HealthResponse>(body) {
        Ok(resp) if resp.status == "ok" => ProbeResult {
            ok: true,
            message: "Server reachable".to_string(),
        },
        Ok(resp) => ProbeResult {
            ok: false,
            message: format!("unexpected health status: {}", resp.status),
        },
        Err(_) => ProbeResult {
            ok: false,
            message: "server response was not valid JSON".to_string(),
        },
    }
}

/// Map an agent capture error into an honest, actionable message (R4).
///
/// Wayland/portal errors and macOS permission errors get platform-specific
/// guidance; everything else is passed through verbatim — no invention.
pub fn map_capture_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("portal") || lower.contains("wayland") {
        format!(
            "{err}; Wayland capture is portal-dependent (recorded limitation ADR-27/45). \
             Try X11/XWayland or grant the screen-capture portal access."
        )
    } else if lower.contains("screen recording")
        || lower.contains("permission")
        || lower.contains("denied")
    {
        format!("{err}; on macOS, grant Screen Recording in System Settings, then re-probe.")
    } else {
        err.to_string()
    }
}

/// `GET {url}/health` with a 5s per-request timeout (R2). Returns a
/// `ProbeResult` — success only when the body parses as `{"status":"ok"}`.
#[tauri::command]
pub async fn probe_server(
    url: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProbeResult, String> {
    probe_server_impl(&state.http, &url).await
}

/// Testable impl: takes a client and a URL, performs the health probe.
pub async fn probe_server_impl(http: &reqwest::Client, url: &str) -> Result<ProbeResult, String> {
    let trimmed = url.trim_end_matches('/');
    let target = format!("{trimmed}/health");

    let resp = match http
        .get(&target)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(ProbeResult {
                ok: false,
                message: format!("Could not reach {url}: {e}"),
            })
        }
    };

    let status = resp.status().as_u16();
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(ProbeResult {
                ok: false,
                message: format!("response read error: {e}"),
            })
        }
    };

    Ok(map_health_response(status, &body))
}

/// Trigger a real capture frame through the agent's desktop code path, proving
/// the wizard's screen-permission step is honest (R3). Only compiled on non-musl.
#[tauri::command]
#[cfg(not(target_env = "musl"))]
pub async fn probe_capture(state: tauri::State<'_, AppState>) -> Result<ProbeResult, String> {
    // Touch `state` so the signature stays uniform across cfg variants.
    let _ = &state;
    match ponter_agent::probe_capture().await {
        Ok(probe) => Ok(ProbeResult {
            ok: true,
            message: format!(
                "Captured {}×{} from {}:{}",
                probe.width, probe.height, probe.kind, probe.source_id
            ),
        }),
        Err(e) => Ok(ProbeResult {
            ok: false,
            message: map_capture_error(&e),
        }),
    }
}

/// The config payload returned to the frontend (camelCase on the wire).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPayload {
    pub server_url: Option<String>,
    pub allow_input: bool,
    pub theme: Option<String>,
    pub has_server_url: bool,
}

/// Build the frontend config payload. `server_url` is the EFFECTIVE URL
/// (ADR-64 chain, always non-empty — the localhost fallback guarantees it),
/// so a deployment that supplies the URL via runtime env or a build-time
/// default displays it instead of "not set". `has_server_url` keeps its
/// "a real source supplied the URL" semantics.
pub fn config_payload(state: &AppState) -> Result<ConfigPayload, String> {
    let persisted = state
        .persisted
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?
        .clone();
    let effective = state
        .server_url
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?
        .clone();
    Ok(ConfigPayload {
        server_url: Some(effective),
        allow_input: persisted.allow_input,
        theme: persisted.theme,
        has_server_url: state.has_server_url || persisted.server_url.is_some(),
    })
}

/// Read the effective config for the frontend (ADR-64/65).
///
/// `has_server_url` is recomputed against the CURRENT persisted value, not only
/// the startup snapshot: `save_config_impl` updates `persisted.server_url`
/// without touching the `has_server_url` field (it is a plain bool, set once at
/// construction), so an in-session save would otherwise leave `get_config`
/// reporting `false` — two sources of truth drifting apart. `save_config_impl`
/// never clears the URL (blank is ignored, `None` means unchanged), so the `||`
/// is monotonic and correct.
#[tauri::command]
pub async fn get_config(state: tauri::State<'_, AppState>) -> Result<ConfigPayload, String> {
    config_payload(&state)
}

/// Persist the user's choices to `config.json` and update the runtime mirrors.
#[tauri::command]
pub async fn save_config(
    server_url: Option<String>,
    allow_input: bool,
    theme: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    save_config_impl(&state, server_url.as_deref(), allow_input, theme.as_deref())
}

/// Testable impl: normalize + persist + mirror into `AppState`. A blank
/// `server_url` is ignored (never clobbers the resolved URL); `None` means
/// "leave the server URL unchanged" (e.g. a theme-only save).
pub fn save_config_impl(
    state: &AppState,
    server_url: Option<&str>,
    allow_input: bool,
    theme: Option<&str>,
) -> Result<(), String> {
    let normalized_url = server_url
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty());

    {
        let mut cfg = state
            .persisted
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if let Some(url) = &normalized_url {
            cfg.server_url = Some(url.clone());
        }
        cfg.allow_input = allow_input;
        if let Some(t) = theme {
            cfg.theme = Some(t.to_string());
        }
        if let Some(path) = &state.config_path {
            write_config(path, &cfg)?;
        }
    }

    if let Some(url) = normalized_url {
        *state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))? = url;
    }
    *state
        .allow_input
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = allow_input;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{ensure_provider, spawn_stub, spawn_stub_capturing};

    // ---- R2: map_health_response unit tests ----

    #[test]
    fn health_2xx_ok_body() {
        let r = map_health_response(200, r#"{"status":"ok"}"#);
        assert!(r.ok);
        assert_eq!(r.message, "Server reachable");
    }

    #[test]
    fn health_2xx_wrong_body() {
        let r = map_health_response(200, r#"{"status":"degraded"}"#);
        assert!(!r.ok);
        assert_eq!(r.message, "unexpected health status: degraded");
    }

    #[test]
    fn health_200_garbage_body() {
        let r = map_health_response(200, "not json");
        assert!(!r.ok);
        assert_eq!(r.message, "server response was not valid JSON");
    }

    #[test]
    fn health_non_2xx() {
        let r = map_health_response(503, r#"{"status":"ok"}"#);
        assert!(!r.ok);
        assert_eq!(r.message, "server returned HTTP 503");
    }

    #[test]
    fn health_trims_trailing_slash_in_message() {
        // Verify that probe_server_impl trims a trailing slash from the URL
        // before appending /health, so the request path is exactly "/health"
        // and not "//health".
        ensure_provider();
        let (base_url, rx) = spawn_stub_capturing(200, r#"{"status":"ok"}"#.to_string());
        let url_with_slash = format!("{base_url}/");
        let state = crate::state::AppState::new();

        let result =
            tauri::async_runtime::block_on(probe_server_impl(&state.http, &url_with_slash))
                .expect("should return Ok(ProbeResult)");

        assert!(result.ok);
        // The stub captured the request line; verify the path is /health.
        let request_line = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("stub should have received the request");
        assert!(
            request_line.contains("GET /health HTTP/"),
            "request path should be /health, got: {request_line}"
        );
        // And NOT a double-slash.
        assert!(
            !request_line.contains("//health"),
            "trailing slash should be trimmed, got: {request_line}"
        );
    }

    // ---- R4: map_capture_error unit tests ----

    #[test]
    fn capture_error_wayland_portal_note() {
        let m = map_capture_error("failed to start capture: portal request denied");
        assert!(m.contains("portal-dependent"));
        assert!(m.contains("Wayland capture is portal-dependent"));
    }

    #[test]
    fn capture_error_wayland_only() {
        let m = map_capture_error("Wayland: no session");
        assert!(m.contains("portal-dependent"));
    }

    #[test]
    fn capture_error_macos_guidance() {
        let m = map_capture_error("Screen Recording permission denied");
        assert!(m.contains("Screen Recording in System Settings"));
    }

    #[test]
    fn capture_error_permission_guidance() {
        let m = map_capture_error("permission denied");
        assert!(m.contains("Screen Recording in System Settings"));
    }

    #[test]
    fn capture_error_unknown_passthrough() {
        let m = map_capture_error("some unknown error");
        assert_eq!(m, "some unknown error");
    }

    // ---- R2: probe_server against spawn_stub ----

    #[test]
    fn probe_server_success() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"status":"ok"}"#.to_string());
        let state = crate::state::AppState::new();
        let result = tauri::async_runtime::block_on(probe_server_impl(&state.http, &url))
            .expect("should succeed");
        assert!(result.ok);
        assert_eq!(result.message, "Server reachable");
    }

    #[test]
    fn probe_server_wrong_body() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"status":"bad"}"#.to_string());
        let state = crate::state::AppState::new();
        let result = tauri::async_runtime::block_on(probe_server_impl(&state.http, &url))
            .expect("should return a result");
        assert!(!result.ok);
        assert!(result.message.contains("unexpected health status"));
    }

    #[test]
    fn probe_server_non_2xx() {
        ensure_provider();
        let url = spawn_stub(503, r#"{"status":"ok"}"#.to_string());
        let state = crate::state::AppState::new();
        let result = tauri::async_runtime::block_on(probe_server_impl(&state.http, &url))
            .expect("should return a result");
        assert!(!result.ok);
        assert!(result.message.contains("HTTP 503"));
    }

    #[test]
    fn probe_server_network_error() {
        ensure_provider();
        // A port we know is closed → connection refused.
        let url = "http://127.0.0.1:1".to_string();
        let state = crate::state::AppState::new();
        let result = tauri::async_runtime::block_on(probe_server_impl(&state.http, &url))
            .expect("should return Ok(ProbeResult), not Err");
        assert!(!result.ok);
        assert!(result.message.starts_with("Could not reach"));
    }

    // ---- R9: AppState defaults ----

    #[test]
    fn app_state_allow_input_defaults_false() {
        let state = crate::state::AppState::new();
        let allow = state
            .allow_input
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert!(!*allow, "allow_input must default to false");
    }

    #[test]
    fn app_state_server_url_defaults_from_env() {
        // With no override, the default is http://localhost:8787.
        let state = crate::state::AppState::new();
        let url = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert_eq!(*url, "http://localhost:8787");
    }

    #[test]
    fn save_config_impl_persists_and_updates_state() {
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = crate::state::AppState::with_config(Some(path.clone()));

        save_config_impl(&state, Some("http://new:1/"), true, Some("dark"))
            .expect("save should succeed");

        // Runtime mirrors updated.
        assert_eq!(*state.server_url.lock().unwrap(), "http://new:1");
        assert!(*state.allow_input.lock().unwrap());
        // File persisted.
        let reloaded = crate::config::load_config(&path);
        assert_eq!(reloaded.server_url.as_deref(), Some("http://new:1"));
        assert!(reloaded.allow_input);
        assert_eq!(reloaded.theme.as_deref(), Some("dark"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_config_impl_ignores_blank_server_url() {
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-blank-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = crate::state::AppState::with_config(Some(path.clone()));

        // Blank server URL must not clobber the resolved URL.
        save_config_impl(&state, Some("   "), false, None).expect("save should succeed");
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(crate::config::load_config(&path).server_url.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_config_impl_sets_has_server_url_for_same_session_get_config() {
        // Regression (plan defect): saving a URL in-session must make a
        // subsequent get_config report hasServerUrl=true — otherwise the
        // frontend is sent back to ServerSetupView on reload within a session.
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-has-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = crate::state::AppState::with_config(Some(path));
        assert!(!state.has_server_url);

        save_config_impl(&state, Some("http://new:1"), false, None).expect("save should succeed");

        let persisted = state.persisted.lock().unwrap().clone();
        assert!(
            state.has_server_url || persisted.server_url.is_some(),
            "get_config must report hasServerUrl=true after an in-session save"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- F3: get_config must return the EFFECTIVE server URL ----

    #[test]
    fn config_payload_returns_effective_url_from_persisted() {
        let dir = std::env::temp_dir().join(format!("ponter-cfgpayload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        crate::config::save_config(
            &path,
            &crate::config::PersistedConfig {
                server_url: Some("http://file:9".to_string()),
                allow_input: false,
                theme: None,
            },
        )
        .unwrap();
        let state = crate::state::AppState::with_config(Some(path));
        let payload = config_payload(&state).expect("payload");
        assert_eq!(payload.server_url.as_deref(), Some("http://file:9"));
        assert!(payload.has_server_url);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_payload_reports_effective_fallback_url_not_none() {
        // F3 regression: with NO persisted URL (env/build-default deployment) the
        // payload must carry the EFFECTIVE url (localhost fallback), never None —
        // otherwise LoginView shows "Server: not set".
        let state = crate::state::AppState::with_config(None);
        let payload = config_payload(&state).expect("payload");
        assert_eq!(payload.server_url.as_deref(), Some("http://localhost:8787"));
        assert!(!payload.has_server_url);
    }
}
