//! Setup wizard commands (ADR-53).
//!
//! Each wizard step verifies real capability, not just collects a string:
//! `probe_server` probes `GET /health`; `probe_capture` probes a real capture
//! frame through the agent's desktop code path; `save_wizard_settings` writes
//! the verified values into `AppState` (runtime only — no disk persistence in
//! Task 5, per R7).

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

/// Write the wizard's verified settings into `AppState` (R7 — runtime only,
/// no disk persistence in Task 5).
#[tauri::command]
pub async fn save_wizard_settings(
    server_url: String,
    allow_input: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    save_wizard_settings_impl(
        &state.server_url,
        &state.allow_input,
        &server_url,
        allow_input,
    )
}

/// Testable impl: writes verified settings into the given mutexes. Trims
/// trailing slashes from the URL for normalization.
pub fn save_wizard_settings_impl(
    server_url_slot: &std::sync::Mutex<String>,
    allow_input_slot: &std::sync::Mutex<bool>,
    server_url: &str,
    allow_input: bool,
) -> Result<(), String> {
    let trimmed = server_url.trim_end_matches('/');
    *server_url_slot
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = trimmed.to_string();
    *allow_input_slot
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = allow_input;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::thread;

    /// Spin up a tiny HTTP/1.1 stub server on an ephemeral port that returns
    /// `canned_status`/`canned_body` for a single request. Returns the bound
    /// `http://127.0.0.1:port` URL. Reused from `login.rs`'s `spawn_stub`
    /// pattern (R11).
    fn spawn_stub(canned_status: u16, canned_body: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let body = canned_body.clone();
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                    status = canned_status,
                    len = body.len(),
                    body = body,
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        format!("http://{addr}")
    }

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

    /// Spawn a stub that captures the request line and returns it via a channel.
    /// Returns `(base_url, receiver)` so the test can inspect what path the
    /// client requested.
    fn spawn_stub_capturing(
        canned_status: u16,
        canned_body: String,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();

        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }

                // Extract the request line (first line up to \r\n).
                if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                    let line = buf[..nl].to_vec();
                    let _ = tx.send(String::from_utf8_lossy(&line).to_string());
                }

                let body = canned_body.clone();
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
                    status = canned_status,
                    len = body.len(),
                    body = body,
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });

        (format!("http://{addr}"), rx)
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

    fn ensure_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

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
    fn save_wizard_settings_updates_state() {
        let state = crate::state::AppState::new();
        save_wizard_settings_impl(
            &state.server_url,
            &state.allow_input,
            "http://my-server:8787",
            true,
        )
        .expect("should succeed");

        let url = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert_eq!(*url, "http://my-server:8787");

        let allow = state
            .allow_input
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert!(*allow);
    }

    #[test]
    fn save_wizard_settings_trims_trailing_slash() {
        let state = crate::state::AppState::new();
        save_wizard_settings_impl(
            &state.server_url,
            &state.allow_input,
            "http://my-server:8787/",
            false,
        )
        .expect("should succeed");

        let url = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))
            .expect("lock");
        assert_eq!(*url, "http://my-server:8787");
    }
}
