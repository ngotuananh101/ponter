//! Setup wizard commands (ADR-53, ADR-79).
//!
//! Each wizard step verifies real capability, not just collects a string:
//! `probe_server` probes `GET /health`; `probe_capture` probes a real capture
//! frame through the agent's desktop code path; `save_config` writes
//! the verified values into `CoreState` and persists them to `config.json`
//! (ADR-64/65).

use crate::core::config::save_config as write_config;
use crate::core::state::CoreState;
use serde::{Deserialize, Serialize};

/// The result returned to the frontend for every probe (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
/// Wayland/portal errors get platform-specific
/// guidance; everything else is passed through verbatim — no invention.
pub fn map_capture_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("portal") || lower.contains("wayland") {
        format!(
            "{err}; Wayland capture is portal-dependent (recorded limitation ADR-27/45). \
             Try X11/XWayland or grant the screen-capture portal access."
        )
    } else {
        err.to_string()
    }
}

/// Testable impl: takes a client and a URL, performs the health probe.
///
/// `GET {url}/health` with a 5s per-request timeout (R2). Returns a
/// `ProbeResult` — success only when the body parses as `{"status":"ok"}`.
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
            });
        }
    };

    let status = resp.status().as_u16();
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            return Ok(ProbeResult {
                ok: false,
                message: format!("response read error: {e}"),
            });
        }
    };

    Ok(map_health_response(status, &body))
}

/// Trigger a real capture frame through the agent's desktop code path, proving
/// the wizard's screen-permission step is honest (R3). Only compiled on non-musl.
#[cfg(not(target_env = "musl"))]
pub async fn probe_capture() -> Result<ProbeResult, String> {
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

#[cfg(target_env = "musl")]
pub async fn probe_capture() -> Result<ProbeResult, String> {
    Ok(ProbeResult {
        ok: false,
        message: "Screen capture probe is not supported on musl builds".to_string(),
    })
}

/// The config payload returned to the frontend (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub fn config_payload(state: &CoreState) -> Result<ConfigPayload, String> {
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
        has_server_url: state.has_server_url() || persisted.server_url.is_some(),
    })
}

/// Testable impl: normalize + persist + mirror into `CoreState`. A blank
/// `server_url` is ignored (never clobbers the resolved URL); `None` means
/// "leave the server URL unchanged" (e.g. a theme-only save).
pub fn save_config_impl(
    state: &CoreState,
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
        state.set_has_server_url(true);
    }
    *state
        .allow_input
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = allow_input;
    if let Some(t) = theme {
        *state
            .theme
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))? = Some(t.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_util::{ensure_provider, spawn_stub, spawn_stub_capturing};

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
        ensure_provider();
        let (base_url, rx) = spawn_stub_capturing(200, r#"{"status":"ok"}"#.to_string());
        let url_with_slash = format!("{base_url}/");
        let state = CoreState::new();

        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe_server_impl(&state.http, &url_with_slash))
            .expect("should return Ok(ProbeResult)");

        assert!(result.ok);
        let request_line = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("stub should have received the request");
        assert!(
            request_line.contains("GET /health HTTP/"),
            "request path should be /health, got: {request_line}"
        );
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
    fn capture_error_unknown_passthrough() {
        let m = map_capture_error("some unknown error");
        assert_eq!(m, "some unknown error");
    }

    // ---- R2: probe_server against spawn_stub ----

    #[test]
    fn probe_server_success() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"status":"ok"}"#.to_string());
        let state = CoreState::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe_server_impl(&state.http, &url))
            .expect("should succeed");
        assert!(result.ok);
        assert_eq!(result.message, "Server reachable");
    }

    #[test]
    fn probe_server_wrong_body() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"status":"bad"}"#.to_string());
        let state = CoreState::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe_server_impl(&state.http, &url))
            .expect("should return a result");
        assert!(!result.ok);
        assert!(result.message.contains("unexpected health status"));
    }

    #[test]
    fn probe_server_non_2xx() {
        ensure_provider();
        let url = spawn_stub(503, r#"{"status":"ok"}"#.to_string());
        let state = CoreState::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe_server_impl(&state.http, &url))
            .expect("should return a result");
        assert!(!result.ok);
        assert!(result.message.contains("HTTP 503"));
    }

    #[test]
    fn probe_server_network_error() {
        ensure_provider();
        let url = "http://127.0.0.1:1".to_string();
        let state = CoreState::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe_server_impl(&state.http, &url))
            .expect("should return Ok(ProbeResult), not Err");
        assert!(!result.ok);
        assert!(result.message.starts_with("Could not reach"));
    }

    // ---- R9: AppState / CoreState defaults ----

    #[test]
    fn app_state_allow_input_defaults_false() {
        let state = CoreState::new();
        let allow = state
            .allow_input
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert!(!*allow, "allow_input must default to false");
    }

    #[test]
    fn app_state_server_url_defaults_from_env() {
        let state = CoreState::new();
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
        let state = CoreState::with_config(Some(path.clone()));

        save_config_impl(&state, Some("http://new:1/"), true, Some("dark"))
            .expect("save should succeed");

        assert_eq!(*state.server_url.lock().unwrap(), "http://new:1");
        assert!(*state.allow_input.lock().unwrap());
        let reloaded = crate::core::config::load_config(&path);
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
        let state = CoreState::with_config(Some(path.clone()));

        save_config_impl(&state, Some("   "), false, None).expect("save should succeed");
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(crate::core::config::load_config(&path).server_url.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_config_impl_sets_has_server_url_for_same_session_get_config() {
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-has-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = CoreState::with_config(Some(path));
        assert!(!state.has_server_url());

        save_config_impl(&state, Some("http://new:1"), false, None).expect("save should succeed");

        let persisted = state.persisted.lock().unwrap().clone();
        assert!(
            state.has_server_url() || persisted.server_url.is_some(),
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
        crate::core::config::save_config(
            &path,
            &crate::core::config::PersistedConfig {
                server_url: Some("http://file:9".to_string()),
                allow_input: false,
                theme: None,
            },
        )
        .unwrap();
        let state = CoreState::with_config(Some(path));
        let payload = config_payload(&state).expect("payload");
        assert_eq!(payload.server_url.as_deref(), Some("http://file:9"));
        assert!(payload.has_server_url);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_payload_reports_effective_fallback_url_not_none() {
        let state = CoreState::with_config(None);
        let payload = config_payload(&state).expect("payload");
        assert_eq!(payload.server_url.as_deref(), Some("http://localhost:8787"));
        assert!(!payload.has_server_url);
    }
}
