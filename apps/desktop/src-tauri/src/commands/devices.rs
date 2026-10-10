//! Device registration + management commands (ADR-54).
//!
//! The desktop counterpart of the web dashboard's agent dialogs: register this
//! device against the existing server API, store the one-time credential in the
//! OS keychain IMMEDIATELY, list devices, delete with confirm. No server
//! changes. Registration does NOT start the runtime (Task 7).
//!
//! Pure helpers (`generate_device_id`, `map_devices_error`, `is_auth_error`)
//! are unit-tested without HTTP. The `register_device_impl`/`list_devices_impl`/
//! `delete_device_impl` functions are exercised by integration tests that spin
//! up a real TCP listener serving a canned response (via the shared
//! `test_util::spawn_stub`). The retry-once-on-401 path lives in
//! `commands::session::retry_once_on_401`, which is unit-tested there.

use crate::commands::login::KEYCHAIN_SERVICE;
use crate::keychain;
use crate::state::AppState;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Account name for the one-time device credential, under the shared
/// `KEYCHAIN_SERVICE` (`"ponter-desktop"` from `commands/login.rs`). Import the
/// service const rather than re-declaring it (R3).
pub const KEYCHAIN_AGENT_ACCOUNT: &str = "agent-credential";

/// Wire shape of a public agent, mirroring `packages/shared/src/types/user.ts`'s
/// `Agent` and the server's `toPublicAgent` projection. NOTE: `credential` is
/// deliberately absent — the credential is never returned to the frontend
/// (R3).
#[derive(Debug, Clone, Serialize)]
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

/// Wire shape of the server's `toPublicAgent` projection (camelCase). Used only
/// to deserialize the response; the returned struct to the frontend is
/// `DesktopDevice` (which has no `credential` field).
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
/// We deserialize the whole envelope, but ONLY return the `agent` projection
/// to the frontend — the `credential` is written to the keychain and then
/// dropped (never crosses to the frontend, R3).
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
    #[allow(dead_code)]
    code: String,
    #[allow(dead_code)]
    details: Option<String>,
}

/// Map a non-2xx response into a user-facing error string. Falls back to a
/// generic message when the body is not the expected envelope (mirrors
/// `map_login_error`).
pub fn map_devices_error(status: u16, body: &str) -> String {
    match serde_json::from_str::<DevicesError>(body) {
        Ok(envelope) => envelope.error,
        Err(_) => format!("Request failed (HTTP {status})"),
    }
}

/// Resolve the local hostname for device registration (R2/R5).
///
/// Priority: `HOSTNAME` env var → `/etc/hostname` (Linux) → `COMPUTERNAME`
/// (Windows) → fallback `"device"`.
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
    // `/etc/hostname` is the Linux fallback.
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

/// Sanitize a hostname for use in a device id: lowercase, replace runs of
/// non-`[a-z0-9-]` with `-`, collapse repeats, trim trailing/leading `-`.
/// Empty after sanitize → `"device"`.
fn sanitize_hostname(hostname: &str) -> String {
    let lower = hostname.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
        } else {
            // Replace any non-safe char with a single dash, collapsing repeats.
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "device".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Generate a device id: `{hostname}-{8 lowercase hex}`.
///
/// Pure: takes the random suffix as an argument so tests can pin the format
/// without real entropy (R2).
pub fn generate_device_id(hostname: &str, random: [u8; 4]) -> String {
    let sanitized = sanitize_hostname(hostname);
    let suffix = format!(
        "{:02x}{:02x}{:02x}{:02x}",
        random[0], random[1], random[2], random[3],
    );
    format!("{sanitized}-{suffix}")
}

/// Sanitize + resolve the hostname for a register payload. Returns the
/// *unsanitized* hostname string for the payload (R5 says sanitize only for
/// the id) — actually the spec says hostname in the payload is the resolver
/// output (unsanitized for display, sanitized for the id).
fn device_hostname() -> String {
    resolve_hostname()
}

/// Build the platform string exactly as the server/web dialog accepts (R1):
/// `"linux" | "macos" | "windows"`.
fn device_platform() -> String {
    match std::env::consts::OS {
        "linux" => "linux".to_string(),
        "macos" => "macos".to_string(),
        "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

/// The access token is read out of the mutex *before* the `.await` (R4, the
/// Task 4 Send-bound lesson — the access token is passed as an `Option<String>`
/// (already cloned out of the mutex) so no `.await` happens while a MutexGuard
/// is held.
pub async fn register_device_impl(
    http: &reqwest::Client,
    server_url: &str,
    access_token: Option<String>,
    capabilities: Vec<String>,
) -> Result<DesktopDevice, String> {
    let token = access_token.ok_or_else(|| "not logged in".to_string())?;
    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/agents");

    // Generate the device id using ring entropy. `ring` is a direct dep.
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
        // `publicKey` omitted: do NOT fabricate (R1).
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

    // Persist the credential to the OS keychain IMMEDIATELY (R3). Failure fails
    // the registration loudly — same posture as login's refresh-token write.
    // On re-registration the value is REPLACED (R3 swap behavior): a device is
    // re-registered after a manual delete, the latest credential must win.
    keychain::set_secret(
        KEYCHAIN_SERVICE,
        KEYCHAIN_AGENT_ACCOUNT,
        &envelope.credential,
    )
    .map_err(|e| format!("keychain write failed: {e:?}"))?;

    // The projection returned to the frontend carries no `credential` field
    // (R3). The access token slot is left untouched — registration does not
    // touch the access token.

    Ok(DesktopDevice::from(envelope.agent))
}

/// `GET {server_url}/api/agents` — returns the public agent list (R1).
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

/// `DELETE {server_url}/api/agents/:id` → `{ success: true }` (R1).
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

// ---- Tauri command wrappers ----

/// The exact server message surfaced on a 401 by the access-token middleware
/// (`apps/server/src/middleware/auth.ts`). The retry-on-401 path triggers only
/// for this string — never for network or 5xx errors, which must NOT force a
/// logout.
pub(crate) const AUTH_401_MESSAGE: &str = "Invalid or expired token";

/// Classify whether an error string is the server's 401 auth failure that
/// should trigger the refresh+retry path. Only the exact middleware message
/// matches — a failed refresh surfaces as `REFRESH_FAILED_PREFIX` (see
/// `commands::session`), which is intentionally NOT treated as a fresh 401.
pub(crate) fn is_auth_error(err: &str) -> bool {
    err == AUTH_401_MESSAGE
}

#[tauri::command]
pub async fn register_device(
    state: tauri::State<'_, AppState>,
    capabilities: Vec<String>,
) -> Result<DesktopDevice, String> {
    // Clone values OUT of mutexes before any `.await` (R4).
    let server_url = {
        let guard = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.clone()
    };
    let http = &state.http;
    let access_slot = &state.access_token;
    let caps = capabilities;

    // Retry the original request once on a 401-shaped auth failure: refresh the
    // session and re-issue with the rotated access token. A non-auth failure
    // (network, 5xx) is returned verbatim — no logout, no retry.
    crate::commands::session::retry_once_on_401(
        http,
        &server_url,
        access_slot,
        |token| {
            let token = token.to_string();
            let caps = caps.clone();
            let url = server_url.clone();
            async move { register_device_impl(http, &url, Some(token), caps).await }
        },
        is_auth_error,
    )
    .await
}

#[tauri::command]
pub async fn list_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DesktopDevice>, String> {
    let server_url = {
        let guard = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.clone()
    };
    let http = &state.http;
    let access_slot = &state.access_token;

    crate::commands::session::retry_once_on_401(
        http,
        &server_url,
        access_slot,
        |token| {
            let token = token.to_string();
            let url = server_url.clone();
            async move { list_devices_impl(http, &url, Some(token)).await }
        },
        is_auth_error,
    )
    .await
}

#[tauri::command]
pub async fn delete_device(
    agent_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let server_url = {
        let guard = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.clone()
    };
    let http = &state.http;
    let access_slot = &state.access_token;

    crate::commands::session::retry_once_on_401(
        http,
        &server_url,
        access_slot,
        |token| {
            let token = token.to_string();
            let agent_id = agent_id.clone();
            let url = server_url.clone();
            async move { delete_device_impl(http, &url, Some(token), &agent_id).await }
        },
        is_auth_error,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{
        ensure_provider, keychain_lock, spawn_stub, spawn_stub_capturing, spawn_stub_capturing_body,
    };

    /// Pre-clean + post-clean the credential account so a crashed previous run
    /// cannot make the swap test lie.
    fn clear_credential() {
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT);
    }

    // ---- pure fn unit tests ----

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
        // Non-envelope fallback.
        assert_eq!(
            map_devices_error(500, "garbage"),
            "Request failed (HTTP 500)"
        );
    }

    #[test]
    fn is_auth_error_only_matches_the_401_message() {
        // The exact server middleware message triggers retry.
        assert!(is_auth_error("Invalid or expired token"));
        // Everything else — network, 5xx, a failed refresh — must NOT trigger.
        assert!(!is_auth_error("network error: ..."));
        assert!(!is_auth_error("Request failed (HTTP 500)"));
        assert!(!is_auth_error("Agent not found"));
        // A failed refresh carries the session-expired prefix, not the raw 401.
        assert!(!is_auth_error(
            "session expired after refresh attempt: Refresh token reuse detected"
        ));
    }

    // ---- integration tests against spawn_stub ----

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

        let device = tauri::async_runtime::block_on(register_device_impl(
            &client,
            &url,
            Some("access-token".to_string()),
            vec![],
        ))
        .expect("register should succeed");

        assert_eq!(device.id, "dev-1");
        assert_eq!(device.hostname, "mybox");
        // Credential persisted to the real keychain.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT).unwrap(),
            Some("ag_deadbeefcafebabe".to_string()),
        );
        // And never returned to the caller — the struct has no `credential` field.
        // (Compile-time guarantee; we assert the wire fields here.)
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
        let result =
            tauri::async_runtime::block_on(register_device_impl(&client, &url, None, vec![]));
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

        let result = tauri::async_runtime::block_on(register_device_impl(
            &client,
            &url,
            Some("access-token".to_string()),
            vec![],
        ));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Agent already exists");
        // Keychain untouched on failure.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_AGENT_ACCOUNT).unwrap(),
            None,
        );
    }

    #[test]
    fn register_device_swap_replaces_keychain_value() {
        // Review Focus #1 (spec §4.2): re-registration replaces the keychain
        // value so the latest credential wins (not "write only if absent").
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

        // First registration: credential A.
        let url_a = spawn_stub(201, make_body("ag_aaa"));
        let client = reqwest::Client::new();
        let _ = tauri::async_runtime::block_on(register_device_impl(
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

        // Second registration (different id): credential B replaces A.
        let url_b = spawn_stub(201, make_body("ag_bbb"));
        let _ = tauri::async_runtime::block_on(register_device_impl(
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
        let result = tauri::async_runtime::block_on(list_devices_impl(
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
        let result = tauri::async_runtime::block_on(list_devices_impl(
            &client,
            &url,
            Some("access-token".to_string()),
        ));
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Unauthorized");
    }

    #[test]
    fn delete_device_succeeds() {
        ensure_provider();
        let url = spawn_stub(200, r#"{"success":true}"#.to_string());
        let client = reqwest::Client::new();
        let result = tauri::async_runtime::block_on(delete_device_impl(
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
        let result = tauri::async_runtime::block_on(delete_device_impl(
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
        // Inspect the request line + Authorization header via a capturing stub.
        ensure_provider();

        let body = r#"{
            "agent": {"id":"dev-1","userId":"u1","hostname":"mybox","platform":"linux","osVersion":"unknown","agentVersion":"0.1.0","publicKey":"","signingPublicKey":null,"isOnline":false,"lastHeartbeat":null,"capabilities":[],"createdAt":"2026-10-08T00:00:00Z"},
            "credential":"ag_deadbeefcafebabe"
        }"#;
        let (url, rx) = spawn_stub_capturing(201, body.to_string());
        let client = reqwest::Client::new();
        let _ = tauri::async_runtime::block_on(register_device_impl(
            &client,
            &url,
            Some("access-token".to_string()),
            vec![],
        ));

        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("request sent");
        // reqwest may send headers in lowercase; compare case-insensitively.
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
        let _ = tauri::async_runtime::block_on(register_device_impl(
            &client,
            &url,
            Some("access-token".to_string()),
            vec!["desktop".to_string(), "terminal".to_string()],
        ));
        let raw = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("request sent");
        // serde_json::json! serializes compactly: no spaces after ':' or ','.
        assert!(
            raw.contains(r#""capabilities":["desktop","terminal"]"#),
            "payload must carry capabilities verbatim, got: {raw}",
        );

        clear_credential();
    }
}
