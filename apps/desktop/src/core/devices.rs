//! Device registration + management commands (ADR-54, ADR-79).
//!
//! The desktop counterpart of the web dashboard's agent dialogs: register this
//! device against the existing server API, store the one-time credential in the
//! OS keychain IMMEDIATELY, list devices, delete with confirm. No server
//! changes. Registration does NOT start the runtime.
//!
//! Pure helpers (`generate_device_id`, `map_devices_error`, `is_auth_error`)
//! are unit-tested without HTTP. The `register_device_impl`/`list_devices_impl`/
//! `delete_device_impl` functions are exercised by integration tests that spin
//! up a real TCP listener serving a canned response (via the shared
//! `test_util::spawn_stub`).
//!
//! Auth-fatal classification (issue #107) is driven by a stable signal — the
//! HTTP status / the server's `code` field — never by the human-readable message.

use crate::core::auth::KEYCHAIN_SERVICE;
pub use crate::core::error::AUTH_FAILED_PREFIX;
use crate::core::keychain;
use serde::{Deserialize, Serialize};

/// Check if an error message represents an auth-fatal error (guarding against loop).
pub fn is_auth_error(err: &str) -> bool {
    crate::core::error::is_auth_error(err)
}

/// Account name for the one-time device credential, under the shared
/// `KEYCHAIN_SERVICE` (`"ponter-desktop"`).
pub const AGENT_CREDENTIAL_ACCOUNT: &str = "agent-credential";
pub const KEYCHAIN_AGENT_ACCOUNT: &str = AGENT_CREDENTIAL_ACCOUNT;

/// Wire shape of a public agent, mirroring `packages/shared/src/types/user.ts`'s
/// `Agent` and the server's `toPublicAgent` projection. NOTE: `credential` is
/// deliberately absent — the credential is never returned to the frontend (guard f).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDevice {
    pub id: String,
    pub user_id: String,
    pub hostname: String,
    pub platform: String,
    pub os_version: String,
    pub agent_version: String,
    pub public_key: String,
    pub signing_public_key: Option<String>,
    pub is_online: bool,
    pub last_heartbeat: Option<String>,
    pub capabilities: Vec<String>,
    pub created_at: String,
}

impl From<PublicAgent> for DesktopDevice {
    fn from(a: PublicAgent) -> Self {
        Self {
            id: a.id,
            user_id: a.user_id,
            hostname: a.hostname.unwrap_or_default(),
            platform: a.platform.unwrap_or_default(),
            os_version: a.os_version.unwrap_or_else(|| "unknown".to_string()),
            agent_version: a.agent_version.unwrap_or_default(),
            public_key: a.public_key,
            signing_public_key: a.signing_public_key,
            is_online: a.is_online,
            last_heartbeat: a.last_heartbeat,
            capabilities: a.capabilities,
            created_at: a.created_at,
        }
    }
}

/// Wire shape of the server's `toPublicAgent` projection (camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicAgent {
    id: String,
    user_id: String,
    hostname: Option<String>,
    platform: Option<String>,
    os_version: Option<String>,
    agent_version: Option<String>,
    public_key: String,
    signing_public_key: Option<String>,
    is_online: bool,
    last_heartbeat: Option<String>,
    capabilities: Vec<String>,
    created_at: String,
}

/// Shape of the register response body: `{ agent: PublicAgent, credential }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    agent: PublicAgent,
    credential: String,
}

/// Failure envelope — the server returns `{ error, code, details }`.
#[derive(Debug, Deserialize)]
struct DevicesError {
    error: String,
    code: String,
    #[allow(dead_code)]
    details: Option<String>,
}

fn is_auth_fatal_response(status: u16, code: Option<&str>) -> bool {
    status == 401 || code == Some("UNAUTHORIZED")
}

/// Map a non-2xx response into a user-facing error string. Falls back to a
/// generic message when the body is not the expected envelope.
pub fn map_devices_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<DevicesError>(body).ok();
    let inner = match &parsed {
        Some(envelope) => envelope.error.clone(),
        None => format!("Request failed (HTTP {status})"),
    };
    let code = parsed.as_ref().map(|envelope| envelope.code.as_str());
    if is_auth_fatal_response(status, code) {
        format!("{AUTH_FAILED_PREFIX}: {inner}")
    } else {
        inner
    }
}

fn resolve_hostname() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    if std::env::consts::OS == "windows" {
        if let Ok(h) = std::env::var("COMPUTERNAME") {
            if !h.is_empty() {
                return h;
            }
        }
    }
    let fallback = std::fs::read_to_string("/etc/hostname").ok().and_then(|s| {
        let s = s.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    });
    if let Some(h) = fallback {
        return h;
    }
    "device".to_string()
}

fn sanitize_hostname(hostname: &str) -> String {
    let lower = hostname.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "device".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn generate_device_id(hostname: &str, random: [u8; 4]) -> String {
    let sanitized = sanitize_hostname(hostname);
    let suffix = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        random[0], random[1], random[2], random[3],
    );
    format!("{sanitized}-{suffix}")
}

fn device_hostname() -> String {
    resolve_hostname()
}

fn device_platform() -> String {
    match std::env::consts::OS {
        "linux" => "linux".to_string(),
        "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

pub async fn register_device_impl(
    http: &reqwest::Client,
    server_url: &str,
    access_token: Option<String>,
    capabilities: Vec<String>,
) -> Result<DesktopDevice, String> {
    let token = access_token.ok_or_else(|| "not logged in".to_string())?;
    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/agents");

    let hostname = device_hostname();
    let platform = device_platform();
    let os_version = "unknown".to_string();
    let agent_version = env!("CARGO_PKG_VERSION").to_string();

    let rng = ring::rand::SystemRandom::new();
    let suffix: [u8; 4] = ring::rand::generate::<[u8; 4]>(&rng)
        .map(ring::rand::Random::expose)
        .map_err(|e| format!("entropy error: {e:?}"))?;
    let device_id = generate_device_id(&hostname, suffix);

    let payload = serde_json::json!({
        "id": device_id,
        "hostname": hostname,
        "platform": platform,
        "osVersion": os_version,
        "agentVersion": agent_version,
        "capabilities": capabilities,
    });

    let resp = http
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("response read error: {e}"))?;

    if status != 201 {
        return Err(map_devices_error(status, &body));
    }

    let envelope: RegisterResponse =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;

    // Persist the credential to the OS keychain IMMEDIATELY (guard f).
    // Wrapped in spawn_blocking for Linux D-Bus zbus / SecretService safety.
    let credential = envelope.credential.clone();
    tokio::task::spawn_blocking(move || {
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT, &credential)
    })
    .await
    .map_err(|e| format!("keychain task failed: {e}"))?
    .map_err(|e| format!("keychain write failed: {e:?}"))?;

    Ok(DesktopDevice::from(envelope.agent))
}

pub async fn list_devices_impl(
    http: &reqwest::Client,
    server_url: &str,
    access_token: Option<String>,
) -> Result<Vec<DesktopDevice>, String> {
    let token = access_token.ok_or_else(|| "not logged in".to_string())?;
    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/agents");

    let resp = http
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("response read error: {e}"))?;

    if status != 200 {
        return Err(map_devices_error(status, &body));
    }

    let agents: Vec<PublicAgent> =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;

    Ok(agents.into_iter().map(DesktopDevice::from).collect())
}

pub async fn delete_device_impl(
    http: &reqwest::Client,
    server_url: &str,
    access_token: Option<String>,
    agent_id: &str,
) -> Result<bool, String> {
    let token = access_token.ok_or_else(|| "not logged in".to_string())?;
    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/agents/{agent_id}");

    let resp = http
        .delete(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("response read error: {e}"))?;

    if status != 200 {
        return Err(map_devices_error(status, &body));
    }

    let success: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(success
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::auth::KEYCHAIN_REFRESH_ACCOUNT;
    use crate::core::test_util::{
        ensure_provider, keychain_lock, spawn_stub, spawn_stub_capturing,
        spawn_stub_capturing_body, spawn_stub_routing,
    };

    fn clear_credential() {
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT);
    }

    fn clear_refresh() {
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);
    }

    #[test]
    fn device_payload_has_no_credential_and_account_is_unchanged() {
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
        assert_eq!(AGENT_CREDENTIAL_ACCOUNT, "agent-credential");
    }

    #[test]
    fn device_id_format_pure() {
        let id = generate_device_id("MyBox", [0xa1, 0xb2, 0xc3, 0xd4]);
        assert_eq!(id, "mybox-a1b2c3d4");
    }

    #[test]
    fn device_id_sanitizes_hostname() {
        let id = generate_device_id("My Box 123!", [0x00, 0x11, 0x22, 0x33]);
        assert_eq!(id, "my-box-123-00112233");
    }

    #[test]
    fn device_id_empty_hostname_falls_back() {
        let id = generate_device_id("!!!", [0xff, 0xff, 0xff, 0xff]);
        assert_eq!(id, "device-ffffffff");
    }

    #[test]
    fn map_devices_error_extracts_message() {
        let body = r#"{"error":"Agent already exists","code":"AGENT_EXISTS","details":null}"#;
        assert_eq!(map_devices_error(409, body), "Agent already exists");
        assert_eq!(
            map_devices_error(500, "garbage"),
            "Request failed (HTTP 500)"
        );
    }

    #[test]
    fn is_auth_error_only_matches_the_auth_marker() {
        assert!(is_auth_error(&format!(
            "{AUTH_FAILED_PREFIX}: Invalid or expired token"
        )));
        assert!(!is_auth_error("Invalid or expired token"));
        assert!(!is_auth_error("network error: ..."));
        assert!(!is_auth_error("Request failed (HTTP 500)"));
        assert!(!is_auth_error("Agent not found"));
        assert!(!is_auth_error(
            "session expired after refresh attempt: Refresh token reuse detected"
        ));
    }

    #[test]
    fn map_devices_error_marks_every_401_variant_as_auth_signal() {
        let variants = [
            "Invalid or expired token",
            "Invalid token type",
            "Token has been revoked",
            "User is inactive or not found",
            "WS ticket rejected by REST",
            "Missing or invalid Authorization header",
        ];
        for msg in variants {
            let body = format!(r#"{{"error":"{msg}","code":"UNAUTHORIZED","details":null}}"#);
            let err = map_devices_error(401, &body);
            assert!(
                is_auth_error(&err),
                "401 variant {msg:?} must classify as auth-fatal, got: {err}"
            );
        }
    }

    #[test]
    fn map_devices_error_treats_unauthorized_code_as_auth_signal() {
        let body = r#"{"error":"anything","code":"UNAUTHORIZED","details":null}"#;
        assert!(is_auth_error(&map_devices_error(401, body)));
        assert!(is_auth_error(&map_devices_error(403, body)));
    }

    #[test]
    fn map_devices_error_does_not_mark_non_auth_failures() {
        let limit =
            r#"{"error":"Agent limit reached","code":"AGENT_LIMIT_REACHED","details":null}"#;
        assert!(!is_auth_error(&map_devices_error(403, limit)));

        let server =
            r#"{"error":"Internal server error","code":"INTERNAL_SERVER_ERROR","details":null}"#;
        assert!(!is_auth_error(&map_devices_error(500, server)));
        assert!(!is_auth_error(&map_devices_error(429, "slow down")));
        assert!(!is_auth_error(&map_devices_error(400, "bad request")));

        let not_found = r#"{"error":"Agent not found","code":"NOT_FOUND","details":null}"#;
        assert!(!is_auth_error(&map_devices_error(404, not_found)));
    }

    #[test]
    fn register_device_stores_credential_in_keychain() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();

        ensure_provider();
        clear_credential();

        let body = r#"{
            "agent": {
                "id": "dev-1",
                "userId": "u1",
                "hostname": "mybox",
                "platform": "linux",
                "osVersion": "unknown",
                "agentVersion": "0.1.0",
                "publicKey": "",
                "signingPublicKey": null,
                "isOnline": false,
                "lastHeartbeat": null,
                "capabilities": [],
                "createdAt": "2026-10-08T00:00:00Z"
            },
            "credential": "ag_deadbeefcafebabe"
        }"#;

        let url = spawn_stub(201, body.to_string());
        let client = reqwest::Client::new();

        let device = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                vec![],
            ))
            .expect("register should succeed");

        assert_eq!(device.id, "dev-1");
        assert_eq!(device.hostname, "mybox");
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT).unwrap(),
            Some("ag_deadbeefcafebabe".to_string()),
        );
        let serialized = serde_json::to_string(&device).unwrap();
        assert!(
            !serialized.contains("ag_"),
            "credential must not leak into the projection"
        );

        clear_credential();
    }

    #[test]
    fn register_device_fails_without_token() {
        ensure_provider();
        let url = spawn_stub(201, "{}".to_string());
        let client = reqwest::Client::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(&client, &url, None, vec![]));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "not logged in");
    }

    #[test]
    fn register_device_surfaces_server_error() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_credential();

        let body = r#"{"error":"Agent already exists","code":"AGENT_EXISTS","details":null}"#;
        let url = spawn_stub(409, body.to_string());
        let client = reqwest::Client::new();

        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                vec![],
            ));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Agent already exists");
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT).unwrap(),
            None,
        );
    }

    #[test]
    fn register_device_swap_replaces_keychain_value() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_credential();

        let make_body = |cred: &str| {
            format!(
                r#"{{
                    "agent": {{
                        "id": "dev-{}",
                        "userId": "u1",
                        "hostname": "mybox",
                        "platform": "linux",
                        "osVersion": "unknown",
                        "agentVersion": "0.1.0",
                        "publicKey": "",
                        "signingPublicKey": null,
                        "isOnline": false,
                        "lastHeartbeat": null,
                        "capabilities": [],
                        "createdAt": "2026-10-08T00:00:00Z"
                    }},
                    "credential": "{}"
                }}"#,
                cred, cred,
            )
        };

        let url_a = spawn_stub(201, make_body("ag_aaa"));
        let client = reqwest::Client::new();
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url_a,
                Some("access-token".to_string()),
                vec![],
            ))
            .expect("register A should succeed");
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("ag_aaa"),
        );

        let url_b = spawn_stub(201, make_body("ag_bbb"));
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url_b,
                Some("access-token".to_string()),
                vec![],
            ))
            .expect("register B should succeed");
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("ag_bbb"),
            "re-registration must replace the keychain credential (R3 swap)",
        );

        clear_credential();
    }

    #[test]
    fn list_devices_parses_empty_list() {
        ensure_provider();
        let url = spawn_stub(200, r#"[]"#.to_string());
        let client = reqwest::Client::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(list_devices_impl(
                &client,
                &url,
                Some("access-token".to_string()),
            ))
            .expect("list should succeed");
        assert!(result.is_empty());
    }

    #[test]
    fn list_devices_surfaces_error() {
        ensure_provider();
        let url = spawn_stub(
            401,
            r#"{"error":"Unauthorized","code":"UNAUTH","details":null}"#.to_string(),
        );
        let client = reqwest::Client::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(list_devices_impl(
                &client,
                &url,
                Some("access-token".to_string()),
            ));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.starts_with(AUTH_FAILED_PREFIX), "got: {err}");
        assert!(err.contains("Unauthorized"), "got: {err}");
    }

    #[test]
    fn delete_device_succeeds() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"success":true}"#.to_string());
        let client = reqwest::Client::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(delete_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                "dev-1",
            ))
            .expect("delete should succeed");
        assert!(result);
    }

    #[test]
    fn delete_device_surfaces_404() {
        ensure_provider();
        let url = spawn_stub(
            404,
            r#"{"error":"Agent not found","code":"NOT_FOUND","details":null}"#.to_string(),
        );
        let client = reqwest::Client::new();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(delete_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                "dev-missing",
            ));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Agent not found");
    }

    #[test]
    fn register_device_sends_auth_header_and_body() {
        ensure_provider();

        let body = r#"{
            "agent": {"id":"dev-1","userId":"u1","hostname":"mybox","platform":"linux","osVersion":"unknown","agentVersion":"0.1.0","publicKey":"","signingPublicKey":null,"isOnline":false,"lastHeartbeat":null,"capabilities":[],"createdAt":"2026-10-08T00:00:00Z"},
            "credential":"ag_deadbeefcafebabe"
        }"#;
        let (url, rx) = spawn_stub_capturing(201, body.to_string());
        let client = reqwest::Client::new();
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                vec![],
            ));

        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("request sent");
        let lower = raw.to_lowercase();
        assert!(
            lower.contains("post /api/agents http/"),
            "requested POST /api/agents, got: {raw}"
        );
        assert!(
            lower.contains("authorization: bearer access-token"),
            "must send bearer token, got: {raw}",
        );

        clear_credential();
    }

    #[test]
    fn register_device_sends_capabilities_in_payload() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        clear_credential();

        let body = r#"{"agent":{"id":"dev-1","userId":"u1","hostname":"mybox",
         "platform":"linux","osVersion":"unknown","agentVersion":"0.1.0",
         "publicKey":"","signingPublicKey":null,"isOnline":false,
         "lastHeartbeat":null,"capabilities":[],"createdAt":"2026-10-08T00:00:00Z"},
         "credential":"ag_deadbeefcafebabe"}"#;
        let (url, rx) = spawn_stub_capturing_body(201, body.to_string());
        let client = reqwest::Client::new();
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(register_device_impl(
                &client,
                &url,
                Some("access-token".to_string()),
                vec!["desktop".to_string(), "terminal".to_string()],
            ));
        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("request sent");
        assert!(
            raw.contains(r#""capabilities":["desktop","terminal"]"#),
            "payload must carry capabilities verbatim, got: {raw}",
        );

        clear_credential();
    }

    #[test]
    fn list_devices_retries_once_after_refresh_on_401() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, "rt-seeded")
            .expect("seed refresh token");

        let agents_401 =
            r#"{"error":"Token has been revoked","code":"UNAUTHORIZED","details":null}"#;
        let refresh_ok =
            r#"{"token":"rotated-access","refreshToken":"rotated-refresh","expiresIn":900}"#;
        let agents_ok = r#"[{"id":"dev-1","userId":"u1","hostname":"mybox","platform":"linux","osVersion":"unknown","agentVersion":"0.1.0","publicKey":"","signingPublicKey":null,"isOnline":false,"lastHeartbeat":null,"capabilities":[],"createdAt":"2026-10-08T00:00:00Z"}]"#;
        let agents_hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let agents_hits_for_stub = agents_hits.clone();
        let url = spawn_stub_routing(move |raw| {
            if raw.contains("/api/auth/refresh") {
                (200, refresh_ok.to_string())
            } else if raw.contains("/api/agents") {
                let n = agents_hits_for_stub.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    (401, agents_401.to_string())
                } else {
                    (200, agents_ok.to_string())
                }
            } else {
                (
                    404,
                    r#"{"error":"not found","code":"NOT_FOUND","details":null}"#.to_string(),
                )
            }
        });

        let client = reqwest::Client::new();
        let http = &client;
        let access: std::sync::Mutex<Option<String>> =
            std::sync::Mutex::new(Some("stale-access".into()));

        let devices = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(crate::core::session::retry_once_on_401(
                http,
                &url,
                &access,
                |token| {
                    let url = url.clone();
                    async move { list_devices_impl(http, &url, Some(token)).await }
                },
                is_auth_error,
            ))
            .expect("list should succeed after one refresh+retry");

        assert_eq!(agents_hits.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "dev-1");
        assert_eq!(access.lock().unwrap().as_deref(), Some("rotated-access"));
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("rotated-refresh"),
        );

        clear_refresh();
    }

    #[test]
    fn list_devices_does_not_loop_when_refresh_fails() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, "stale-rt")
            .expect("seed refresh token");

        let agents_401 =
            r#"{"error":"Token has been revoked","code":"UNAUTHORIZED","details":null}"#;
        let refresh_401 = r#"{"error":"Invalid or expired refresh token","code":"INVALID_REFRESH_TOKEN","details":null}"#;
        let agents_hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let agents_hits_for_stub = agents_hits.clone();
        let url = spawn_stub_routing(move |raw| {
            if raw.contains("/api/auth/refresh") {
                (401, refresh_401.to_string())
            } else if raw.contains("/api/agents") {
                agents_hits_for_stub.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                (401, agents_401.to_string())
            } else {
                (404, "{}".to_string())
            }
        });

        let client = reqwest::Client::new();
        let http = &client;
        let access: std::sync::Mutex<Option<String>> =
            std::sync::Mutex::new(Some("stale-access".into()));

        let result = tokio::runtime::Runtime::new().unwrap().block_on(
            crate::core::session::retry_once_on_401(
                http,
                &url,
                &access,
                |token| {
                    let url = url.clone();
                    async move { list_devices_impl(http, &url, Some(token)).await }
                },
                is_auth_error,
            ),
        );

        assert_eq!(agents_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        let err = result.unwrap_err();
        assert!(
            err.starts_with(crate::core::session::REFRESH_FAILED_PREFIX),
            "failed refresh must surface the session-expired prefix, got: {err}"
        );

        clear_refresh();
    }
}
