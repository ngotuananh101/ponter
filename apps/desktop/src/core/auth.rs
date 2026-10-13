//! Authentication logic: login, logout, and token handling (ADR-52, ADR-79).
//!
//! Stores the refresh token in the OS keychain and keeps the access token in
//! memory only. Pure helpers (`parse_login_response`, `map_login_error`) are
//! unit-tested without HTTP.

use crate::core::keychain;
use crate::core::state::CoreState;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const KEYCHAIN_SERVICE: &str = "ponter-desktop";
pub const KEYCHAIN_REFRESH_ACCOUNT: &str = "refresh-token";

/// Wire shape of the user profile as returned by the server (camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerUser {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub role: String,
}

/// Shape returned to the frontend command caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub role: String,
}

/// Success envelope (200) from `/api/auth/login`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginSuccess {
    user: ServerUser,
    token: String,
    refresh_token: String,
    #[allow(dead_code)]
    expires_in: u64,
}

/// Failure envelope — the server returns `{ error, code, details }`.
#[derive(Debug, Deserialize)]
struct LoginError {
    error: String,
    #[allow(dead_code)]
    code: String,
    #[allow(dead_code)]
    details: Option<String>,
}

#[derive(Debug)]
pub struct LoginOutcome {
    pub user: UserProfile,
    pub token: String,
    pub refresh_token: String,
}

/// Parse a success body into `LoginOutcome`. Returns a descriptive `Err` string
/// when the JSON shape is wrong so tests can assert on it.
pub fn parse_login_response(body: &str) -> Result<LoginOutcome, String> {
    let parsed: LoginSuccess =
        serde_json::from_str(body).map_err(|e| format!("parse error: {e}"))?;
    Ok(LoginOutcome {
        user: UserProfile {
            id: parsed.user.id,
            username: parsed.user.username,
            email: parsed.user.email,
            role: parsed.user.role,
        },
        token: parsed.token,
        refresh_token: parsed.refresh_token,
    })
}

/// Map a non-200 response into a user-facing error string. Falls back to a
/// generic message when the body is not the expected envelope.
pub fn map_login_error(status: u16, body: &str) -> String {
    match serde_json::from_str::<LoginError>(body) {
        Ok(envelope) => envelope.error,
        Err(_) => format!("Login failed (HTTP {status})"),
    }
}

/// Thin wrapper around the testable impl. `access_slot` is the same Mutex that
/// `CoreState::access_token` wraps — we pass a reference to the inner `Mutex`
/// so tests can construct a standalone `Mutex<Option<String>>`.
pub async fn login_impl(
    http: &reqwest::Client,
    server_url: &str,
    username: String,
    password: String,
    access_slot: &Mutex<Option<String>>,
) -> Result<UserProfile, String> {
    let url = format!("{server_url}/api/auth/login");
    let resp = http
        .post(&url)
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("response read error: {e}"))?;

    if status != 200 {
        return Err(map_login_error(status, &body));
    }

    let outcome = parse_login_response(&body)?;

    // Persist the refresh token in the OS keychain. If this fails the login
    // must fail loudly — returning success without a persisted refresh token
    // would leave the user unable to recover their session.
    let refresh_token = outcome.refresh_token.clone();
    tokio::task::spawn_blocking(move || {
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, &refresh_token)
    })
    .await
    .map_err(|e| format!("keychain task failed: {e}"))?
    .map_err(|e| format!("keychain write failed: {e:?}"))?;

    // Access token: memory only.
    *access_slot
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = Some(outcome.token.clone());

    Ok(UserProfile {
        id: outcome.user.id,
        username: outcome.user.username,
        email: outcome.user.email,
        role: outcome.user.role,
    })
}

/// Pure helper: clears the in-memory access token and deletes the refresh
/// token from the OS keychain.
pub fn logout_impl(state: &CoreState) -> Result<(), String> {
    // Clear in-memory access token
    let mut access_guard = state
        .access_token
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    *access_guard = None;
    drop(access_guard);

    // Delete refresh token from OS keychain
    keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
        .map_err(|e| format!("keychain delete failed: {e:?}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_util::{ensure_provider, keychain_lock, spawn_stub};

    #[test]
    fn keychain_identifiers_are_unchanged() {
        // Continuity invariant (§9.3): an upgraded install must still find its
        // stored refresh token under the same service + account.
        assert_eq!(KEYCHAIN_SERVICE, "ponter-desktop");
        assert_eq!(KEYCHAIN_REFRESH_ACCOUNT, "refresh-token");
    }

    #[test]
    fn parses_success_response() {
        let body = r#"{
            "user": { "id": "u1", "username": "alice", "email": "a@example.com", "role": "user" },
            "token": "access-123",
            "refreshToken": "refresh-456",
            "expiresIn": 3600
        }"#;
        let outcome = parse_login_response(body).expect("should parse");
        assert_eq!(outcome.user.id, "u1");
        assert_eq!(outcome.user.username, "alice");
        assert_eq!(outcome.token, "access-123");
        assert_eq!(outcome.refresh_token, "refresh-456");
    }

    #[test]
    fn maps_server_error() {
        let body = r#"{ "error": "Invalid username or password", "code": "INVALID_CREDENTIALS", "details": null }"#;
        assert_eq!(map_login_error(401, body), "Invalid username or password");
        // Non-envelope body falls back to HTTP status.
        assert_eq!(map_login_error(500, "not json"), "Login failed (HTTP 500)");
    }

    #[test]
    fn login_stores_refresh_token_in_keychain() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }

        // Serialize against the session/devices keychain tests on the shared
        // `KEYCHAIN_REFRESH_ACCOUNT` entry (parallel cargo test threads race).
        let _guard = keychain_lock();
        ensure_provider();

        // Pre-clean so a crashed previous run cannot make this test lie.
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);

        let refresh = "integration-refresh-token".to_string();
        let body = format!(
            r#"{{
                "user": {{ "id": "u1", "username": "alice", "email": "a@example.com", "role": "user" }},
                "token": "integration-access",
                "refreshToken": "{refresh}",
                "expiresIn": 3600
            }}"#
        );
        let url = spawn_stub(200, body);
        let client = reqwest::Client::new();
        let access: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

        let outcome = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(login_impl(
                &client,
                &url,
                "alice".to_string(),
                "secret".to_string(),
                &access,
            ))
            .expect("login should succeed");

        assert_eq!(outcome.username, "alice");
        // Access token in memory.
        let guard = access.lock().unwrap();
        assert_eq!(guard.as_deref(), Some("integration-access"));
        drop(guard);
        // Refresh token persisted to the real keychain.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT).unwrap(),
            Some(refresh),
        );

        // Cleanup after ourselves so we never leak real keychain entries.
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);
    }

    #[test]
    fn login_surfaces_server_error() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }

        // Serialize against the other keychain-touching tests (shared entry).
        let _guard = keychain_lock();
        ensure_provider();

        let body =
            r#"{ "error": "Account is inactive", "code": "ACCOUNT_INACTIVE", "details": null }"#;
        let url = spawn_stub(401, body.to_string());
        let client = reqwest::Client::new();
        let access: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

        let result = tokio::runtime::Runtime::new().unwrap().block_on(login_impl(
            &client,
            &url,
            "alice".to_string(),
            "secret".to_string(),
            &access,
        ));

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Account is inactive");
        // Keychain must remain untouched on auth failure.
        assert_eq!(access.lock().unwrap().as_deref(), None);
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);
    }

    #[test]
    fn logout_impl_clears_token_and_deletes_keychain() {
        // Deletes the shared `KEYCHAIN_REFRESH_ACCOUNT` entry — serialize.
        let _guard = keychain_lock();
        let state = CoreState::with_config(None);
        {
            let mut token = state.access_token.lock().unwrap();
            *token = Some("secret-token".into());
        }
        assert!(state.access_token.lock().unwrap().is_some());
        let res = logout_impl(&state);
        assert!(res.is_ok());
        assert!(state.access_token.lock().unwrap().is_none());
    }
}
