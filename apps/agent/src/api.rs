//! Shared backend-access module: the one place the agent builds a signaling
//! URL, attaches its credential, and maps a server error envelope.
//!
//! Mirrors the TypeScript `@ponter/api-client` contract
//! (`packages/api-client/src/errors.ts`): `ApiError { status, code, details }`
//! plus the two client-side sentinels `API_ERROR` / `NETWORK_ERROR`.
//!
//! The agent has no HTTP client today (RS-3): its only egress is the signaling
//! WebSocket. The HTTP half (`ApiError::from_response`, `ApiError::network`)
//! is written now so any future agent HTTP call has exactly one place to map a
//! server response; the WS half (`to_ws_url`, `with_bearer`) is live.

use anyhow::{Context, Result};
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};

/// Rewrite a configured base URL to a WebSocket URL (URL-3).
///
/// `http://`->`ws://`, `https://`->`wss://`, `ws://`/`wss://` pass through;
/// trailing slashes are trimmed (URL-4). Any other scheme is an error.
///
/// **No path is appended**: the agent's `--server` is already a complete WS URL
/// (`apps/agent/src/main.rs:29`), so appending would double the path.
pub fn to_ws_url(base: &str) -> Result<String> {
    // Split off any query/fragment suffix *before* trimming path-ending slashes
    // (URL-3/4 + G3-W1: a query value such as `?next=/` must survive byte-for-byte).
    // Split at the first `?` or `#`, whichever comes first, and reattach the
    // suffix unchanged after scheme rewriting and path trimming.
    let (head, suffix) = match base.find(['?', '#']) {
        Some(idx) => (&base[..idx], &base[idx..]),
        None => (base, ""),
    };
    let trimmed = head.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{rest}{suffix}"))
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{rest}{suffix}"))
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        Ok(format!("{trimmed}{suffix}"))
    } else {
        anyhow::bail!("unsupported URL scheme in {base:?}: expected http(s):// or ws(s)://")
    }
}

/// Fallback code when a server response carries no `code`
/// (mirrors TS `data.code || 'API_ERROR'`, `errors.ts:31`).
pub const API_ERROR: &str = "API_ERROR";
/// Code for a transport/parse failure with no usable HTTP response
/// (mirrors TS `NETWORK_ERROR`, `errors.ts:38`).
pub const NETWORK_ERROR: &str = "NETWORK_ERROR";

/// The server failure envelope `{ error, code, details }`, mirroring the TS
/// `ApiError` (`packages/api-client/src/errors.ts:7-10`).
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    /// HTTP status, or `None` when the failure had no HTTP response.
    pub status: Option<u16>,
    /// Stable server code, or one of the two client sentinels.
    pub code: String,
    /// Human-readable message (the envelope's `error` field).
    pub message: String,
    /// The envelope's `details`. `Option<serde_json::Value>` -- NOT
    /// `Option<String>` -- so a server-sent object deserializes (RS-2, D6).
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    /// Parse a non-2xx response body into the envelope.
    ///
    /// Falls back to `API_ERROR` when the body has no `code`, and to
    /// `"Unknown API Error"` when it has no `error`. A body that is not JSON
    /// still has an HTTP status, so it maps to `API_ERROR`, not
    /// `NETWORK_ERROR` -- the spec defines `NETWORK_ERROR` as *no HTTP
    /// response* (§5.3).
    pub fn from_response(status: u16, body: &str) -> Self {
        #[derive(serde::Deserialize)]
        struct Payload {
            error: Option<String>,
            code: Option<String>,
            details: Option<serde_json::Value>,
        }
        let (code, message, details) = match serde_json::from_str::<Payload>(body) {
            Ok(p) => (
                p.code.filter(|c| !c.is_empty()),
                p.error.filter(|e| !e.is_empty()),
                p.details,
            ),
            Err(_) => (None, None, None),
        };
        Self {
            status: Some(status),
            code: code.unwrap_or_else(|| API_ERROR.to_string()),
            message: message.unwrap_or_else(|| "Unknown API Error".to_string()),
            details,
        }
    }

    /// A failure with no usable HTTP response (transport error). `status` is
    /// `None`, code `NETWORK_ERROR`.
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            status: None,
            code: NETWORK_ERROR.to_string(),
            message: message.into(),
            details: None,
        }
    }

    /// Whether the failure means the credential is dead and retrying cannot
    /// help: HTTP 401, or a server `UNAUTHORIZED` code (issue-#107 rule,
    /// PR #110). A 403 is deliberately NOT fatal -- the only 403 the agent
    /// path sees is `AGENT_LIMIT_REACHED`, which re-auth cannot fix.
    pub fn is_auth_fatal(&self) -> bool {
        self.status == Some(401) || self.code == "UNAUTHORIZED"
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "{} (HTTP {}): {}", self.code, s, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ApiError {}

/// Insert `Authorization: Bearer {credential}` on a WebSocket client request.
///
/// The single place the agent builds a `Bearer` header (AUTH-3); the credential
/// travels in the header, never the query string (ADR-13).
pub fn with_bearer(request: &mut Request<()>, credential: &str) -> Result<()> {
    let value = HeaderValue::from_str(&format!("Bearer {credential}"))
        .context("credential is not a valid header value")?;
    request.headers_mut().insert("Authorization", value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_http_to_ws() {
        assert_eq!(
            to_ws_url("http://localhost:8787/api/ws/agent").unwrap(),
            "ws://localhost:8787/api/ws/agent"
        );
    }

    #[test]
    fn rewrites_https_to_wss() {
        assert_eq!(
            to_ws_url("https://signal.example.com/x").unwrap(),
            "wss://signal.example.com/x"
        );
    }

    #[test]
    fn passes_ws_schemes_through() {
        assert_eq!(to_ws_url("ws://h/p").unwrap(), "ws://h/p");
        assert_eq!(to_ws_url("wss://h/p").unwrap(), "wss://h/p");
    }

    #[test]
    fn trims_trailing_slashes() {
        assert_eq!(to_ws_url("http://h/p/").unwrap(), "ws://h/p");
        assert_eq!(to_ws_url("ws://h/").unwrap(), "ws://h");
    }

    #[test]
    fn does_not_append_a_path() {
        // G3-F3: --server is already a full WS URL; the rewrite must not
        // double `/api/ws/agent`.
        let out = to_ws_url("http://h:8787/api/ws/agent").unwrap();
        assert_eq!(out.matches("/api/ws/agent").count(), 1);
    }

    // --- G3-W1: query/fragment values must survive scheme rewrite + trim ---

    #[test]
    fn preserves_a_ws_query_value_ending_in_slash() {
        // wss://... is already a complete signing URL; its query value `next=/`
        // must be byte-for-byte preserved (the previous trim_end_matches ran over
        // the whole URL and dropped the trailing slash in the value).
        assert_eq!(
            to_ws_url("wss://signal.example/api/ws/agent?next=/").unwrap(),
            "wss://signal.example/api/ws/agent?next=/"
        );
    }

    #[test]
    fn rewrites_https_with_a_query_value_ending_in_slash() {
        // The slash-trim must apply to the path only, so a query value ending
        // in `/` (e.g. `?scope=/`) is preserved through the https->wss rewrite.
        assert_eq!(
            to_ws_url("https://signal.example/api/ws/agent?scope=/").unwrap(),
            "wss://signal.example/api/ws/agent?scope=/"
        );
    }

    #[test]
    fn trims_a_path_slash_before_the_query_without_altering_it() {
        // Path normalization (URL-4) still trims a trailing path slash, but
        // only the pre-suffix portion; the query `?q=1/` is untouched.
        assert_eq!(to_ws_url("http://h/p/?q=1/").unwrap(), "ws://h/p?q=1/");
    }

    #[test]
    fn preserves_a_fragment_suffix_unchanged() {
        // Any `#`-fragment is preserved byte-for-byte; only the leading path
        // trailing slash (if any) is trimmed.
        assert_eq!(to_ws_url("http://h/p/#frag").unwrap(), "ws://h/p#frag");
    }

    #[test]
    fn rejects_an_unknown_scheme() {
        assert!(to_ws_url("ftp://h/p").is_err());
        assert!(to_ws_url("").is_err());
    }

    // --- ApiError::from_response (D6) ---

    #[test]
    fn parses_the_error_envelope() {
        let e = ApiError::from_response(
            404,
            r#"{"error":"Agent not found","code":"NOT_FOUND","details":null}"#,
        );
        assert_eq!(e.status, Some(404));
        assert_eq!(e.code, "NOT_FOUND");
        assert_eq!(e.message, "Agent not found");
        assert_eq!(e.details, None);
    }

    #[test]
    fn parses_an_object_details_field() {
        // D6: the server sends `details` as an object; it must survive.
        let e = ApiError::from_response(
            429,
            r#"{"error":"slow down","code":"TOO_MANY_REQUESTS","details":{"retryAfter":30}}"#,
        );
        assert_eq!(e.details, Some(serde_json::json!({ "retryAfter": 30 })));
    }

    #[test]
    fn falls_back_to_api_error_when_code_is_absent() {
        let e = ApiError::from_response(400, r#"{"error":"nope"}"#);
        assert_eq!(e.code, "API_ERROR");
        assert_eq!(e.message, "nope");
    }

    #[test]
    fn non_json_body_with_a_status_is_api_error_not_network_error() {
        // Spec §5.3: NETWORK_ERROR means *no HTTP response*. A 500 with an
        // HTML body still has a response, so it maps to API_ERROR.
        let e = ApiError::from_response(500, "<html>oops</html>");
        assert_eq!(e.status, Some(500));
        assert_eq!(e.code, "API_ERROR");
    }

    // --- ApiError::network ---

    #[test]
    fn network_has_no_status_and_the_network_sentinel() {
        let e = ApiError::network("connection reset");
        assert_eq!(e.status, None);
        assert_eq!(e.code, "NETWORK_ERROR");
        assert_eq!(e.message, "connection reset");
        assert_eq!(e.details, None);
    }

    // --- is_auth_fatal (issue #107, PR #110) ---

    #[test]
    fn auth_fatal_on_401_or_unauthorized_code() {
        assert!(ApiError::from_response(401, "{}").is_auth_fatal());
        assert!(ApiError::from_response(403, r#"{"code":"UNAUTHORIZED"}"#).is_auth_fatal());
    }

    #[test]
    fn not_auth_fatal_on_other_failures() {
        assert!(!ApiError::from_response(403, r#"{"code":"AGENT_LIMIT_REACHED"}"#).is_auth_fatal());
        assert!(!ApiError::from_response(500, "{}").is_auth_fatal());
        assert!(!ApiError::from_response(429, "{}").is_auth_fatal());
        assert!(!ApiError::from_response(400, "{}").is_auth_fatal());
        assert!(!ApiError::network("down").is_auth_fatal());
    }

    // --- with_bearer (AUTH-3, ADR-13) ---

    #[test]
    fn sets_the_authorization_header() {
        let mut request = Request::builder()
            .uri("ws://localhost:8787/api/ws/agent")
            .body(())
            .unwrap();
        with_bearer(&mut request, "ag_secret").unwrap();
        assert_eq!(
            request.headers().get("Authorization").unwrap(),
            "Bearer ag_secret"
        );
    }

    #[test]
    fn rejects_a_credential_with_a_control_character() {
        let mut request = Request::builder()
            .uri("ws://localhost:8787/api/ws/agent")
            .body(())
            .unwrap();
        assert!(with_bearer(&mut request, "bad\nvalue").is_err());
    }

    #[test]
    fn the_cli_default_normalizes_to_itself() {
        // apps/agent/src/main.rs:29 default_value = "ws://localhost:8787/api/ws/agent"
        assert_eq!(
            to_ws_url("ws://localhost:8787/api/ws/agent").unwrap(),
            "ws://localhost:8787/api/ws/agent"
        );
    }
}
