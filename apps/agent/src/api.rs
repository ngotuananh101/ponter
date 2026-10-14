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

use anyhow::Result;

/// Rewrite a configured base URL to a WebSocket URL (URL-3).
///
/// `http://`->`ws://`, `https://`->`wss://`, `ws://`/`wss://` pass through;
/// trailing slashes are trimmed (URL-4). Any other scheme is an error.
///
/// **No path is appended**: the agent's `--server` is already a complete WS URL
/// (`apps/agent/src/main.rs:29`), so appending would double the path.
pub fn to_ws_url(base: &str) -> Result<String> {
    let trimmed = base.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{rest}"))
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{rest}"))
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        Ok(trimmed.to_string())
    } else {
        anyhow::bail!("unsupported URL scheme in {base:?}: expected http(s):// or ws(s)://")
    }
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

    #[test]
    fn rejects_an_unknown_scheme() {
        assert!(to_ws_url("ftp://h/p").is_err());
        assert!(to_ws_url("").is_err());
    }
}
