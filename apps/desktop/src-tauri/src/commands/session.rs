//! Session refresh command (issue #102).
//!
//! Reads the OS-keychain refresh token, POSTs `{ refreshToken }` to
//! `/api/auth/refresh`, stores the new access token in memory and rotates the
//! refresh token in the keychain. Used both as an explicit backend command and
//! as the recovery step inside the device commands' retry-on-401 path.
//!
//! Pure helpers (`parse_refresh_response`, `map_refresh_error`) are unit-tested
//! without HTTP. `refresh_session_impl` is exercised by integration tests that
//! spin up a real TCP listener serving a canned response (via the shared
//! `test_util::spawn_stub`). The `retry_once_on_401` helper is exercised by a
//! dedicated test that drives a 401-then-200 closure.

use crate::commands::login::{KEYCHAIN_REFRESH_ACCOUNT, KEYCHAIN_SERVICE};
use crate::keychain;
use crate::state::AppState;
use anyhow::Result;
use serde::Deserialize;
use std::sync::Mutex;

/// Success envelope from `POST /api/auth/refresh` (camelCase). Mirrors the
/// server's `auth.ts` `/refresh` success return shape exactly.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshSuccess {
    token: String,
    refresh_token: String,
    #[allow(dead_code)]
    expires_in: u64,
}

/// Failure envelope — the server returns `{ error, code, details }`.
#[derive(Debug, Deserialize)]
struct RefreshError {
    error: String,
    #[allow(dead_code)]
    code: String,
    #[allow(dead_code)]
    details: Option<String>,
}

/// Stable, distinguishable error string prefix emitted when a refresh attempt
/// itself fails (missing keychain token, non-200, parse error, or keychain
/// write failure). The frontend matches on this prefix to force a logout — any
/// other error string is treated as a non-auth failure and must NOT log the
/// user out.
pub const REFRESH_FAILED_PREFIX: &str = "session expired after refresh attempt";

/// Parse a success body into `(token, refresh_token)`. Returns a descriptive
/// `Err` string when the JSON shape is wrong.
pub fn parse_refresh_response(body: &str) -> Result<(String, String), String> {
    let parsed: RefreshSuccess =
        serde_json::from_str(body).map_err(|e| format!("parse error: {e}"))?;
    Ok((parsed.token, parsed.refresh_token))
}

/// True for HTTP statuses that mean the refresh credential itself is dead — the
/// session is unrecoverable and the FE must log out. Transient statuses (5xx,
/// 429, and client errors such as 400) are deliberately NOT auth-fatal: a flaky
/// or overloaded server must not log the user out (brief C: "Do NOT force-logout
/// on unrelated errors (network down, server 500)").
pub fn is_auth_fatal_status(status: u16) -> bool {
    matches!(status, 401 | 403)
}

/// Map a non-200 refresh response into a user-facing error string. Falls back to
/// a generic message when the body is not the expected envelope.
///
/// Auth-fatal statuses (401/403) carry `REFRESH_FAILED_PREFIX` so the FE forces a
/// logout; every other status (5xx/429/400) returns an UNPREFIXED error so the FE
/// surfaces it WITHOUT logging out.
pub fn map_refresh_error(status: u16, body: &str) -> String {
    let inner = match serde_json::from_str::<RefreshError>(body) {
        Ok(envelope) => envelope.error,
        Err(_) => format!("Refresh failed (HTTP {status})"),
    };
    if is_auth_fatal_status(status) {
        format!("{REFRESH_FAILED_PREFIX}: {inner}")
    } else {
        format!("session refresh failed (HTTP {status}): {inner}")
    }
}

/// Read the refresh token from the OS keychain, POST it to `/refresh`, store the
/// new access token in `access_slot`, and rotate the refresh token in the
/// keychain. `access_slot` is the `Mutex<Option<String>>` that
/// `AppState::access_token` wraps — passed by reference so tests can construct a
/// standalone instance.
///
/// Returns the new access token on success. On any failure (missing keychain
/// token, network error, non-200, parse error, keychain write failure) returns
/// an `Err(String)` — fail closed, the caller decides what to surface.
pub async fn refresh_session_impl(
    http: &reqwest::Client,
    server_url: &str,
    access_slot: &Mutex<Option<String>>,
) -> Result<String, String> {
    let refresh_token = keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
        .map_err(|e| format!("{REFRESH_FAILED_PREFIX}: keychain read failed: {e:?}"))?
        .ok_or_else(|| format!("{REFRESH_FAILED_PREFIX}: no refresh token in keychain"))?;

    let base = server_url.trim_end_matches('/');
    let url = format!("{base}/api/auth/refresh");

    let resp = http
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("response read error: {e}"))?;

    if status != 200 {
        return Err(map_refresh_error(status, &body));
    }

    let (token, new_refresh) = parse_refresh_response(&body)?;

    // Rotate the refresh token in the keychain BEFORE swapping the in-memory
    // access token: if the key write fails we return hard rather than leaving a
    // stale access token paired with a refresh token we could not persist.
    keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, &new_refresh)
        .map_err(|e| format!("{REFRESH_FAILED_PREFIX}: keychain rotate failed: {e:?}"))?;

    {
        let mut guard = access_slot
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        *guard = Some(token.clone());
    }

    Ok(token)
}

/// Thin wrapper around the testable impl. Clones values OUT of the mutex before
/// the `.await` (R4 Send-bound rule — see `commands/devices.rs`).
#[tauri::command]
pub async fn refresh_session(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let server_url = {
        let guard = state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.clone()
    };

    refresh_session_impl(&state.http, &server_url, &state.access_token).await
}

/// Attempt `op` with the current access token; on a 401-shaped auth failure,
/// run one `refresh_session_impl` and retry `op` ONCE with the refreshed token.
/// Centralised so the device commands share one retry path (Sonar new-code
/// dedup gate).
///
/// `op` receives an **owned** `String` token so the returned future need not
/// borrow the caller's `Mutex` guard across an `.await` (which would trip the
/// R4 Send-bound rule). `client`/`server_url` are borrowed; the closure captures
/// its own `Clone`s (`reqwest::Client` is `Arc`-backed, so this is cheap) so it
/// stays `Send` and callable twice.
pub async fn retry_once_on_401<F, Fut, T>(
    client: &reqwest::Client,
    server_url: &str,
    access_slot: &Mutex<Option<String>>,
    op: F,
    is_auth_err: impl Fn(&str) -> bool,
) -> Result<T, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let first = op(access_token(access_slot)?).await;
    match first {
        Ok(v) => Ok(v),
        Err(e) => {
            if !is_auth_err(&e) {
                return Err(e);
            }
            // Refresh the session; on success retry once with the new token.
            match refresh_session_impl(client, server_url, access_slot).await {
                Ok(_) => op(access_token(access_slot)?).await,
                Err(refresh_err) => Err(refresh_err),
            }
        }
    }
}

/// Clone the access token out of the mutex so it can be passed into the retry
/// closure by value without holding the guard across an `.await`.
pub fn access_token(access_slot: &Mutex<Option<String>>) -> Result<String, String> {
    let guard = access_slot
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    guard.clone().ok_or_else(|| "not logged in".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{ensure_provider, keychain_lock, spawn_stub};

    fn clear_refresh() {
        let _ = keychain::delete_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);
    }

    // ---- pure fn unit tests ----

    #[test]
    fn parses_success_response() {
        let body = r#"{
            "token": "new-access-789",
            "refreshToken": "new-refresh-012",
            "expiresIn": 900
        }"#;
        let (token, refresh) = parse_refresh_response(body).expect("should parse");
        assert_eq!(token, "new-access-789");
        assert_eq!(refresh, "new-refresh-012");
    }

    #[test]
    fn maps_auth_status_is_prefixed() {
        let body = r#"{ "error": "Refresh token reuse detected", "code": "REFRESH_TOKEN_REUSED", "details": null }"#;
        let err = map_refresh_error(401, body);
        assert!(err.starts_with(REFRESH_FAILED_PREFIX));
        assert!(err.contains("Refresh token reuse detected"));
        // 403 is also auth-fatal.
        assert!(map_refresh_error(403, "forbidden").starts_with(REFRESH_FAILED_PREFIX));
    }

    #[test]
    fn maps_transient_status_is_not_auth_prefixed() {
        // A 5xx (or 429) from the refresh endpoint is a transient server
        // problem, NOT an auth death — the FE must surface it without logging
        // the user out (brief C). Non-envelope body still gets a message.
        let err = map_refresh_error(500, "broken");
        assert!(!err.starts_with(REFRESH_FAILED_PREFIX));
        assert!(err.contains("HTTP 500"));
        let err2 = map_refresh_error(429, "slow down");
        assert!(!err2.starts_with(REFRESH_FAILED_PREFIX));
        assert!(err2.contains("HTTP 429"));
    }

    #[test]
    fn classifies_only_401_403_as_auth_fatal() {
        assert!(is_auth_fatal_status(401));
        assert!(is_auth_fatal_status(403));
        assert!(!is_auth_fatal_status(400));
        assert!(!is_auth_fatal_status(429));
        assert!(!is_auth_fatal_status(500));
        assert!(!is_auth_fatal_status(503));
    }

    // ---- integration tests against spawn_stub ----

    #[test]
    fn refresh_stores_access_token_and_rotates_keychain() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();

        let old_refresh = "old-refresh-token".to_string();
        // Seed the keychain exactly as `login` would leave it.
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, &old_refresh)
            .expect("seed keychain");

        let body = r#"{
            "token": "rotated-access",
            "refreshToken": "rotated-refresh",
            "expiresIn": 900
        }"#;
        let url = spawn_stub(200, body.to_string());
        let client = reqwest::Client::new();
        let access: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

        let token = tauri::async_runtime::block_on(refresh_session_impl(&client, &url, &access))
            .expect("refresh should succeed");

        assert_eq!(token, "rotated-access");
        // Access token stored in memory.
        assert_eq!(access.lock().unwrap().as_deref(), Some("rotated-access"));
        // Refresh token rotated in the keychain.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("rotated-refresh"),
            "refresh token must be rotated in the keychain",
        );

        clear_refresh();
    }

    #[test]
    fn refresh_surfaces_401_as_prefixed_error() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, "any")
            .expect("seed keychain");

        let body = r#"{ "error": "Invalid or expired refresh token", "code": "INVALID_REFRESH_TOKEN", "details": null }"#;
        let url = spawn_stub(401, body.to_string());
        let client = reqwest::Client::new();
        let access: std::sync::Mutex<Option<String>> =
            std::sync::Mutex::new(Some("old-access".into()));

        let result = tauri::async_runtime::block_on(refresh_session_impl(&client, &url, &access));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.starts_with(REFRESH_FAILED_PREFIX),
            "auth failure must be distinguishable: {err}"
        );
        // Access token must NOT have been swapped on failure (fail-closed).
        assert_eq!(access.lock().unwrap().as_deref(), Some("old-access"));
        // Refresh token must NOT have been rotated.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("any"),
        );

        clear_refresh();
    }

    #[test]
    fn refresh_fails_closed_without_keychain_refresh() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();

        let url = spawn_stub(200, "{}".to_string());
        let client = reqwest::Client::new();
        let access: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

        let result = tauri::async_runtime::block_on(refresh_session_impl(&client, &url, &access));
        assert!(result.is_err());
        assert!(result.unwrap_err().starts_with(REFRESH_FAILED_PREFIX));
        // No token written, no request actually needed to fire past the gate.
        clear_refresh();
    }

    /// Retry-on-401: `op` returns a 401 auth error on its first call, then the
    /// retry helper refreshes the session (rotating the keychain + swapping the
    /// in-memory access token) and retries `op` once — which succeeds on the
    /// second invocation and returns the refreshed token.
    #[test]
    fn retry_once_on_401_refreshes_then_retries_to_success() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();

        // Seed a refresh token so the refresh step succeeds against the 200 stub.
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, "rt-seeded")
            .expect("seed refresh token");

        let refresh_url = spawn_stub(
            200,
            r#"{"token":"new-access","refreshToken":"new-rt","expiresIn":900}"#.to_string(),
        );
        let client = reqwest::Client::new();

        // `op` returns the 401 auth message on call 1, then echoes the token it
        // was given on call 2 — proving the retry used the rotated access token.
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for_op = calls.clone();
        let access: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(Some("stale".into()));

        let op = move |token: String| {
            let calls = calls_for_op.clone();
            async move {
                let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 0 {
                    // First attempt: mimic a 401 from the device endpoint. The
                    // stable auth marker (issue #107) is what `is_auth_error`
                    // now matches.
                    Err(format!(
                        "{}: Invalid or expired token",
                        crate::commands::devices::AUTH_FAILED_PREFIX
                    ))
                } else {
                    // Retry: succeeds with whatever token the helper passed.
                    Ok(token)
                }
            }
        };

        let result = tauri::async_runtime::block_on(retry_once_on_401(
            &client,
            &refresh_url,
            &access,
            op,
            crate::commands::devices::is_auth_error,
        ));

        // Exactly one retry happened (2 total op calls).
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(result.unwrap(), "new-access");
        // The retry used the rotated in-memory access token.
        assert_eq!(
            access.lock().unwrap().as_deref(),
            Some("new-access"),
            "retry must use the rotated access token",
        );
        // And the refresh token was rotated in the keychain.
        assert_eq!(
            keychain::get_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)
                .unwrap()
                .as_deref(),
            Some("new-rt"),
            "refresh token must have been rotated",
        );

        clear_refresh();
    }

    /// Retry-on-401: when the refresh itself fails, the original 401 is NOT
    /// retried and the session-expired error propagates (fail closed).
    #[test]
    fn retry_once_on_401_propagates_refresh_failure() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain integration test");
            return;
        }
        let _guard = keychain_lock();
        ensure_provider();
        clear_refresh();

        let refresh_url = spawn_stub(
            401,
            r#"{"error":"Invalid or expired refresh token","code":"X","details":null}"#.to_string(),
        );
        let client = reqwest::Client::new();

        // Seed a stale refresh token so the refresh POST fires (not the
        // no-token fast path) and returns 401.
        keychain::set_secret(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, "stale-rt")
            .expect("seed refresh token");

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let access: std::sync::Mutex<Option<String>> =
            std::sync::Mutex::new(Some("old-access".into()));

        let op = |_token: String| {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Always returns the stable auth marker on the first attempt.
                Err(format!(
                    "{}: Invalid or expired token",
                    crate::commands::devices::AUTH_FAILED_PREFIX
                ))
            }
        };

        let result: Result<String, String> = tauri::async_runtime::block_on(retry_once_on_401(
            &client,
            &refresh_url,
            &access,
            op,
            crate::commands::devices::is_auth_error,
        ));

        // op must have been called only ONCE (no retry after a failed refresh).
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        // The error is the session-expired prefix (the refresh failure), not the
        // raw 401 — so the FE treats it as an auth-death and logs out.
        let err = result.unwrap_err();
        assert!(
            err.starts_with(REFRESH_FAILED_PREFIX),
            "must surface the refresh failure, got: {err}"
        );
        // Access token untouched on failure.
        assert_eq!(access.lock().unwrap().as_deref(), Some("old-access"));

        clear_refresh();
    }
}
