# Sub-project G3 — Rust Shared API Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/agent` one shared module — `ponter_agent::api` — that owns the signaling-URL rewrite, the `Bearer` header, and the server-error-envelope type, so no module re-implements them; and land a CI gate that keeps it that way.

**Architecture:** A new `apps/agent/src/api.rs` (`pub mod api;`) exposing `to_ws_url`, `with_bearer`, and `ApiError { status, code, message, details }` mirroring the TS `@ponter/api-client` `ApiError`. The two live helpers are wired into `signal.rs` (bearer) and `lib.rs` (URL normalization); the HTTP half is written forward-looking per RS-3. A `build-agent.yml` grep gate enforces the boundary.

**Tech Stack:** Rust 2021 (toolchain 1.98.1, MSRV 1.85), `tokio-tungstenite` 0.30 (`tungstenite::http`), `serde`/`serde_json`, `anyhow`.

**Spec:** `docs/superpowers/specs/2026-10-14-unified-api-access-standard-design.md` (ADR-89, §3.2 RS-1..4, §3.3 URL-3/4, §3.4 AUTH-3, §5, §6.2, §8).

**BE technical input (untracked, cites for the reviewer):** `docs/notes/2026-10-14-subproject-g-api-standard-be-input.md`.

## Global Constraints

- Module, **not** a crate: `ponter_agent::api` inside `apps/agent` (ADR-89). No new Cargo dependency; `serde_json`, `serde`, `anyhow`, `tokio-tungstenite` are already present.
- `ApiError.details` **MUST** be `Option<serde_json::Value>`, never `Option<String>` (RS-2, fixes D6).
- `apps/agent` has **no HTTP client** today; the WS/URL/auth half is live, the HTTP half is forward-looking and unit-tested but not wired (RS-3).
- `apps/desktop` is out of scope — it is deleted by the Electron migration (RS-4).
- Helpers return `anyhow::Result` (crate-idiomatic; `signal.rs` already uses `anyhow` + `.context`). `ApiError` is the **server-envelope** type only.
- `signal.rs` error handling stays `anyhow::Result` — its errors are WS/transport, not server envelopes; do **not** convert them to `ApiError`.
- The gate step runs in `build-agent.yml` job `verify` (working-directory `apps/agent`), **after** `Check formatting` and **before** `Lint`.
- Gate seed-fail obligation (§6.2): the gate MUST be shown to fail on a seeded violation and pass on clean `main`.
- Rust formatting: `cargo fmt --check` must pass; `cargo clippy --all-targets --locked -- -D warnings` must pass (an unused import is a build failure).

## Review Focus

Failure modes the spec implies that a naive implementation gets wrong (each has a pinning test below):

- **`to_ws_url` must not append a path.** The agent's `--server` is already a complete WS URL (`main.rs:29`); a "base URL + path" helper would double `/api/ws/agent`. Test: `does_not_append_a_path`.
- **A non-JSON body with an HTTP status maps to `API_ERROR`, not `NETWORK_ERROR`.** Spec §5.3 defines `NETWORK_ERROR` as *no HTTP response*; a 500 with an HTML body still has a response. (This deliberately diverges from the TS `fromResponse` catch-arm, which uses `NETWORK_ERROR` for an unparseable body — the spec's cause-based definition wins.) Test: `non_json_body_with_a_status_is_api_error_not_network_error`.
- **403 is not auth-fatal.** Issue-#107 ruling (PR #110): only 401 or code `UNAUTHORIZED`. `session.rs`'s `401 | 403` is refresh-path-specific and must NOT be copied into the shared module. Test: `not_auth_fatal_on_other_failures`.
- **Gate rule (a) keys on the envelope field `details`, not a `struct …Error` name.** The name shape was red on clean `main` (BE G3-F1: `apps/agent/src/files.rs:214 pub struct FilesError` is a legitimate file-transfer type). This plan uses the `details`-token rule, and the spec's §6.2 has been corrected to match (see Task 5) — spec == plan; a reviewer must not "restore" the old name-based rule.
- **`details` as an object must survive deserialization** (D6: the server sends `{"retryAfter":30}`). Test: `parses_an_object_details_field`.

---

### Task 1: Create `api.rs` with `to_ws_url` (URL-3, URL-4)

**Files:**
- Create: `apps/agent/src/api.rs`
- Modify: `apps/agent/src/lib.rs` (add `pub mod api;` beside `pub mod identity;` / `pub mod logging;`)
- Test: inline `#[cfg(test)] mod tests` in `apps/agent/src/api.rs`

**Interfaces:**
- Produces: `pub fn to_ws_url(base: &str) -> anyhow::Result<String>`.

- [x] **Step 1: Write the failing test**

Create `apps/agent/src/api.rs` with the module doc, the import, the function stub, and the tests:

```rust
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
/// trailing path slashes are trimmed (URL-4). Query parameters and fragments
/// are preserved byte-for-byte (G3-W1). Any other scheme is an error.
///
/// **No path is appended**: the agent's `--server` is already a complete WS URL
/// (`apps/agent/src/main.rs:29`), so appending would double the path.
pub fn to_ws_url(base: &str) -> Result<String> {
    todo!("implement the scheme rewrite")
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
    fn preserves_a_ws_query_value_ending_in_slash() {
        assert_eq!(
            to_ws_url("wss://signal.example/api/ws/agent?next=/").unwrap(),
            "wss://signal.example/api/ws/agent?next=/"
        );
    }

    #[test]
    fn rewrites_https_with_a_query_value_ending_in_slash() {
        assert_eq!(
            to_ws_url("https://signal.example/api/ws/agent?scope=/").unwrap(),
            "wss://signal.example/api/ws/agent?scope=/"
        );
    }

    #[test]
    fn trims_a_path_slash_before_the_query_without_altering_it() {
        assert_eq!(
            to_ws_url("http://h/p/?q=1/").unwrap(),
            "ws://h/p?q=1/"
        );
    }

    #[test]
    fn preserves_a_fragment_suffix_unchanged() {
        assert_eq!(to_ws_url("http://h/p/#frag").unwrap(), "ws://h/p#frag");
    }

    #[test]
    fn rejects_an_unknown_scheme() {
        assert!(to_ws_url("ftp://h/p").is_err());
        assert!(to_ws_url("").is_err());
    }
}
```

Then declare the module in `apps/agent/src/lib.rs`. The module list currently reads (around lines 23-31):

```rust
pub mod identity;
mod input;
pub mod logging;
```

Add `pub mod api;` immediately before `pub mod identity;` (keeping the `pub mod` group together):

```rust
pub mod api;
pub mod identity;
mod input;
pub mod logging;
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: FAIL — the tests panic with `not yet implemented` (the `todo!()`).

- [x] **Step 3: Write the minimal implementation**

Replace the `todo!()` body of `to_ws_url` with the scheme rewrite splitting query/fragment before path trimming:

```rust
pub fn to_ws_url(base: &str) -> Result<String> {
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: PASS — tests pass.

- [x] **Step 5: Commit**

```bash
git add apps/agent/src/api.rs apps/agent/src/lib.rs
git commit -m "feat(agent): add ponter_agent::api with the WS-URL rewrite (URL-3/4)"
```

---

### Task 2: Add `ApiError` (envelope type, `from_response`, `network`, `is_auth_fatal`)

**Files:**
- Modify: `apps/agent/src/api.rs`
- Test: inline `#[cfg(test)] mod tests` in `apps/agent/src/api.rs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `pub const API_ERROR: &str`, `pub const NETWORK_ERROR: &str`
  - `pub struct ApiError { pub status: Option<u16>, pub code: String, pub message: String, pub details: Option<serde_json::Value> }` (derives `Debug, Clone, PartialEq`; impls `Display` + `std::error::Error`)
  - `ApiError::from_response(status: u16, body: &str) -> ApiError`
  - `ApiError::network(message: impl Into<String>) -> ApiError`
  - `ApiError::is_auth_fatal(&self) -> bool`

- [x] **Step 1: Write the failing test**

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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: FAIL to compile — `ApiError` / `API_ERROR` / `NETWORK_ERROR` are not defined.

- [x] **Step 3: Write the minimal implementation**

Insert below the `to_ws_url` function in `apps/agent/src/api.rs`:

```rust
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: PASS — 13 tests pass (6 from Task 1 + 7 new).

- [x] **Step 5: Commit**

```bash
git add apps/agent/src/api.rs
git commit -m "feat(agent): add ApiError envelope type mirroring TS ApiError (RS-2)"
```

---

### Task 3: Add `with_bearer` (AUTH-3, ADR-13)

**Files:**
- Modify: `apps/agent/src/api.rs`
- Test: inline `#[cfg(test)] mod tests` in `apps/agent/src/api.rs`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `pub fn with_bearer(request: &mut tokio_tungstenite::tungstenite::http::Request<()>, credential: &str) -> anyhow::Result<()>`.

- [x] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block in `apps/agent/src/api.rs`:

```rust
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: FAIL to compile — `with_bearer` and `Request` are not defined.

- [x] **Step 3: Write the minimal implementation**

Extend the import line at the top of `apps/agent/src/api.rs` from

```rust
use anyhow::Result;
```

to

```rust
use anyhow::{Context, Result};
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};
```

Then append below the `impl std::error::Error for ApiError {}` block:

```rust
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent && cargo test --locked api::tests`
Expected: PASS — 15 tests pass.

- [x] **Step 5: Commit**

```bash
git add apps/agent/src/api.rs
git commit -m "feat(agent): add api::with_bearer so no module writes a Bearer header inline (AUTH-3)"
```

---

### Task 4: Wire the live half into `signal.rs` and `lib.rs`

**Files:**
- Modify: `apps/agent/src/signal.rs` (use `api::with_bearer`; drop the now-unused `HeaderValue` import)
- Modify: `apps/agent/src/lib.rs` (normalize the URL via `api::to_ws_url` before connecting)
- Test: existing suites (`cargo test --locked`) plus the two new behaviors below

**Interfaces:**
- Consumes: `api::with_bearer` (Task 3), `api::to_ws_url` (Task 1).
- Produces: no new public surface — this is the integration.

- [x] **Step 1: Replace the inline Bearer construction in `signal.rs`**

In `apps/agent/src/signal.rs`, `SignalClient::connect` currently reads (around lines 353-358):

```rust
        let mut request = url.into_client_request().context("invalid signaling URL")?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {credential}"))
                .context("credential is not a valid header value")?,
        );
```

Replace the header insert with the shared helper:

```rust
        let mut request = url.into_client_request().context("invalid signaling URL")?;
        crate::api::with_bearer(&mut request, credential)?;
```

Then remove the now-unused import at line 15:

```rust
use tokio_tungstenite::tungstenite::http::HeaderValue;
```

(`HeaderValue` has no other use in `signal.rs`; leaving it would fail `clippy -D warnings`.)

- [x] **Step 2: Normalize the signaling URL in `lib.rs`**

In `apps/agent/src/lib.rs`, the reconnect supervisor builds `SignalClient::connect(&config.server, ...)` inside a `loop`. Immediately **before** the loop, where the code reads:

```rust
    let mut delay = signal::BACKOFF_INITIAL;
    let mut supervisor: Option<tokio::task::JoinHandle<Result<()>>> = None;

    loop {
```

insert the normalization (the enclosing function returns `anyhow::Result<()>`, so `?` is valid):

```rust
    let signaling_url = api::to_ws_url(&config.server)
        .context("invalid signaling server URL")?;
    let mut delay = signal::BACKOFF_INITIAL;
    let mut supervisor: Option<tokio::task::JoinHandle<Result<()>>> = None;

    loop {
```

Then change the connect call (around line 643) from `&config.server` to the normalized URL:

```rust
        let connect = SignalClient::connect(
            &signaling_url,
            &config.credential,
            inbound_tx.clone(),
            ice_tx.clone(),
            cfg.identity.clone(),
        );
```

- [x] **Step 3: Add a behavior test for the URL fix**

The normalization is a real fix: today `--server http://host:8787` fails the handshake with `UnsupportedUrlScheme` (`tokio-tungstenite` 0.30 `connect.rs:88`). `to_ws_url` is already unit-tested in Task 1; add one integration-style assertion in `apps/agent/src/api.rs`'s test module that pins the exact default the CLI ships, so a regression in the default is caught:

```rust
    #[test]
    fn the_cli_default_normalizes_to_itself() {
        // apps/agent/src/main.rs:29 default_value = "ws://localhost:8787/api/ws/agent"
        assert_eq!(
            to_ws_url("ws://localhost:8787/api/ws/agent").unwrap(),
            "ws://localhost:8787/api/ws/agent"
        );
    }
```

- [x] **Step 4: Run the full agent suite + clippy + fmt**

Run:
```bash
cd apps/agent && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```
Expected: all PASS — the existing `signal.rs` tests (`classify_close_*`, `backoff_sequence`, parsers) and the new `api::tests` are green; no unused-import warning.

- [x] **Step 5: Commit**

```bash
git add apps/agent/src/signal.rs apps/agent/src/lib.rs apps/agent/src/api.rs
git commit -m "refactor(agent): route the signaling URL + Bearer header through ponter_agent::api"
```

---

### Task 5: Land the CI gate in `build-agent.yml` (with seed-fail proof)

**Files:**
- Modify: `.github/workflows/build-agent.yml` (add a step to the `verify` job, after `Check formatting`, before `Lint`)

**Interfaces:**
- Consumes: nothing.
- Produces: a CI gate that fails the `verify` job on a structural violation.

**Gate rule — corrected (BE G3-F1).** The spec's original §6.2 rule (a) — "forbid ad-hoc `struct …Error` outside `src/api.rs`" — was **red on clean `main`** because `apps/agent/src/files.rs:214` has a legitimate `FilesError` (a file-transfer type with `{code, message, request_id, transfer_id}`, no `error`/`code`/`details` envelope). This plan keys the rule on the envelope's distinguishing field, `details`, which has **0 occurrences** in `apps/agent/src` today (verified). The spec's §6.2 has been corrected to this same `details`-token form — spec == plan. Do **not** substitute the old name-based rule.

**URL rule allow-list — corrected (BE G3-F4).** Rule (b) forbids string-literal server URLs, but its allow-list must cover **two** files, not one: `src/main.rs` (the clap config default) **and** `src/api.rs` (the shared module, whose own unit tests carry literal URLs to pin the scheme rewrite — URL-3 *is* a rewrite, so inputs and outputs are literals). A naive `grep -v '^src/main.rs'` is **red** once `api.rs` exists: this plan's Tasks 1-4 put 13 literal-URL lines in `api.rs`'s tests, all of which the one-file allow-list would flag (verified: the old rule exits non-zero on `api.rs`'s tests; `grep -vE '^src/(main|api)\.rs'` exits zero). The spec's own §6.2 **Allow-list sentence already named `src/api.rs`** — its rule-(b) sentence merely omitted it; the spec has since been corrected to the two-file allow-list, so spec == plan.

- [x] **Step 1: Add the gate step**

In `.github/workflows/build-agent.yml`, in the `verify` job, insert this step immediately after the `Check formatting` step (`run: cargo fmt --check`) and before `Lint`:

```yaml
      - name: Guard — API access goes through the shared module
        shell: bash
        run: |
          set -euo pipefail
          # R-G1: no ad-hoc server-error envelope outside the shared api module.
          # The envelope's distinguishing field is `details`, which has zero
          # occurrences in src/ today (a `struct ...Error` name alone would
          # false-positive on files.rs's legitimate FilesError).
          if grep -rn --include='*.rs' '\bdetails\b' src | grep -vE '^src/api\.rs:'; then
            echo "::error::ad-hoc error envelope outside src/api.rs (use ponter_agent::api::ApiError)"
            exit 1
          fi
          # R-G1b: no hand-rolled HTTP client dependency in agent source.
          if grep -rn --include='*.rs' -E 'reqwest::|hyper::Client|ureq::' src; then
            echo "::error::hand-rolled HTTP client in agent source (use ponter_agent::api)"
            exit 1
          fi
          # R-G2: no literal server URL outside the two sanctioned files — the
          # clap config default (main.rs) and the shared module itself (api.rs),
          # whose own unit tests must carry literal URLs to pin the scheme
          # rewrite (URL-3 is a rewrite, so inputs/outputs are literals).
          if grep -rn --include='*.rs' -E '"https?://|"wss?://' src | grep -vE '^src/(main|api)\.rs:'; then
            echo "::error::literal server URL outside src/main.rs or src/api.rs (use ponter_agent::api::to_ws_url)"
            exit 1
          fi
          echo "API-access guard PASSED"
```

The job's `defaults.run.working-directory` is `apps/agent`, so `src` and `^src/api\.rs:` are correct as written.

- [x] **Step 2: Verify the gate PASSES on the current tree**

Run (from `apps/agent`):
```bash
set -euo pipefail
if grep -rn --include='*.rs' '\bdetails\b' src | grep -vE '^src/api\.rs:'; then echo FAIL; exit 1; fi
if grep -rn --include='*.rs' -E 'reqwest::|hyper::Client|ureq::' src; then echo FAIL; exit 1; fi
if grep -rn --include='*.rs' -E '"https?://|"wss?://' src | grep -vE '^src/(main|api)\.rs:'; then echo FAIL; exit 1; fi
echo "API-access guard PASSED"
```
Expected: `API-access guard PASSED`. (The first check finds `details` in `src/api.rs` only — excluded by `grep -vE '^src/api\.rs:'`; the URL check finds only `main.rs:29` and the literal URLs inside `src/api.rs`'s own tests — both excluded by `grep -vE '^src/(main|api)\.rs:'. **G3-W2: exact regexes with escaped dot `\.` and grep's colon separator `:` prevent false-negative exemptions of similar filenames like `src/api_rs.rs` or `src/api.rs.backup.rs`.)

- [x] **Step 3: Prove the gate FAILS on a seeded violation (seed-fail obligation)**

Temporarily add a violation to `apps/agent/src/signal.rs` — a duplicated envelope field:

```rust
#[allow(dead_code)]
struct SeededEnvelope {
    details: Option<String>,
}
```

Run the Step 2 block again.
Expected: the first check prints `src/signal.rs:NNN:    details: Option<String>,` and exits non-zero.

- [x] **Step 4: Remove the seed and re-verify**

Delete the `SeededEnvelope` struct (do not commit it), then run:
```bash
cd apps/agent && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```
and the Step 2 block.
Expected: `git status` shows only `.github/workflows/build-agent.yml` modified; clippy/test green; guard prints `API-access guard PASSED`.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/build-agent.yml
git commit -m "ci(agent): gate API access through the shared module (R-G1/R-G2)"
```

---

## Self-Review

**Spec coverage:**
- RS-1 (one shared module, base-URL/`Bearer`/error mapping) → Tasks 1-3 (module) + Task 4 (wired). ✓
- RS-2 (`details: Option<serde_json::Value>`) → Task 2 (`ApiError.details`, test `parses_an_object_details_field`). ✓
- RS-3 (no HTTP today; WS half live, HTTP half forward-looking) → Task 2 (forward-looking, unit-tested), Task 4 (WS half wired), Global Constraints. ✓
- RS-4 (`apps/desktop` out of scope) → Global Constraints; no task touches it. ✓
- URL-3 (`http→ws`, `https→wss`, pass-through, else error; one shared rewrite; no path append) → Task 1. ✓
- URL-4 (trailing-slash trim) → Task 1. ✓
- AUTH-3 (`with_bearer`, no inline `format!("Bearer …")`) → Task 3 + Task 4 Step 1. ✓
- §6.2 Rust gate (placement + seed-fail) → Task 5. ✓
- §8 G3 scope → Tasks 1-5. ✓

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N"; every code step carries full code. ✓

**Type consistency:** `to_ws_url(&str) -> Result<String>`, `with_bearer(&mut Request<()>, &str) -> Result<()>`, `ApiError { status: Option<u16>, code, message, details }`, `from_response(u16, &str)`, `network(impl Into<String>)`, `is_auth_fatal(&self)` — used identically in Tasks 1-5. ✓

**Known spec deviations, recorded for the reviewer:**
1. Gate rule (a) keys on the envelope field `details`, not a `struct …Error` name (BE G3-F1: the name rule is red on `main` — `src/files.rs:214 pub struct FilesError` is legitimate). Gate rule (b)'s allow-list is `src/main.rs` **and** `src/api.rs` (BE G3-F4). Both were spec defects; the spec's §6.2 has been corrected to match this plan (rule (a) keyed on `details`, rule (b) two-file allow-list, plus the RS-1 dependency rule), so spec == plan.
2. A non-JSON body with a status maps to `API_ERROR` (spec §5.3's cause-based definition), not the TS `fromResponse` catch-arm's `NETWORK_ERROR`.
3. `is_auth_fatal` pins the general-API rule (`401` or `UNAUTHORIZED`; 403 not fatal), matching issue #107 / PR #110 — not `session.rs`'s refresh-path `401 | 403`.
4. `main.rs:29`'s `--server` default stays the only literal URL in **non-test** source; `api.rs` carries literal URLs in its own unit tests (allow-listed). The CLI keeps resolving `flag > env > default` (`main.rs:25-31`) — G3 adds no HTTP base-URL resolver for the agent (there is no HTTP consumer).

---

## Execution & Merge Record

- **Tasks 1–5 Completed:** All 5 tasks implemented via subagent-driven development (TDD RED→GREEN per task).
- **Whole-Branch Review (Opus):** Two Important findings identified on candidate `8e3430f`:
  - **G3-W1:** `to_ws_url` trimmed entire URL rather than path-only, corrupting query values ending in `/` (`?next=/`). Fixed by pre-splitting query/fragment at first `?` or `#` and adding 4 new unit tests.
  - **G3-W2:** Gate allow-list regexes `^src/api.rs` and `^src/(main|api)\.rs` were overbroad (regex wildcard dot, missing filename terminator), allowing false negatives (`src/api_rs.rs`, `src/api.rs.backup.rs`). Fixed by tightening regexes to `^src/api\.rs:` and `^src/(main|api)\.rs:` with seed proof.
- **Fix Commit:** `1e617aa` (`fix(agent): preserve signaling URL query suffix and tighten gate allow-list (G3-W1/W2)`).
- **Scoped Re-Review:** Approved (`final-fix-review-report.md`).
- **TEST-INTEGRITY:** 20 unit tests and 36 assertions in `api::tests` (lib suite 283 passed / 4 ignored, bin suite 6 passed; total 289 passed, net +20 tests vs baseline 269; 0 modified, 0 deleted, 0 skipped).
- **QA Binding Verdict:** PASS (`RECOMMEND MERGE`).
- **BA Audit Verdict:** PASS (`RECOMMEND MERGE`).
- **Merged to `main`:** Squash-merged by PM @ `9de96c2e16801fd53f78e413541e30a8db65203c` ([PR #129](https://github.com/ngotuananh101/ponter/pull/129)).

