# Sub-project G — Unified API-access standard: BE technical input

Status: DRAFT technical input from BE to BA (owner of the spec/ADR).
Scope requested by owner: standardize how APIs (and similar parts) are called
across the whole project, including Rust.
Not a PR. No implementation starts until the owner approves the spec.

## Finding 0 — reality check that reframes Deliverable 1

`apps/agent` has **no `reqwest`** dependency (`apps/agent/Cargo.toml`). Its only
outbound call to the server is the WebSocket connect via `tokio-tungstenite`:

- `apps/agent/src/signal.rs:360` — `tokio_tungstenite::connect_async(request)`.
- Auth travels in the `Authorization: Bearer {credential}` header
  (`apps/agent/src/signal.rs:354-360`), **not** in the query string (ADR-13).
- The agent never mints a WS ticket; `POST /api/ws/ticket`
  (`apps/server/src/routes/ws.ts:543`, `{ ticket, expiresIn: 15 }`) exists for
  the **browser** WebSocket API, which cannot set headers.

The only Rust HTTP client in the tree today is the **hand-rolled `reqwest`
code in `apps/desktop/src/core/{devices,session}.rs`** (`reqwest = 0.13.5`,
`apps/desktop/Cargo.toml:23`). That whole app is being replaced by Electron in
sub-projects B–F.

Consequence: **there is currently no live Rust HTTP consumer to unify.** A shared
`ponter-api-client` crate would have zero callers on day one. The parts that are
genuinely worth sharing are small and already duplicated in spirit:

1. the server error envelope + mapping that mirrors the TS `ApiError`;
2. the WS connect helper (base-URL build, credential header, close-code
   classification).

## G3 plan review (BE, 2026-10-14) — plan written by BA

Plan: `docs/superpowers/plans/2026-10-14-subproject-g3-rust-api-module.md` (5 tasks).
BE froze the interface; BA adopted it verbatim. BE reviewed the plan's Rust and
gate content. Tasks 1-4 are sound (verified against the tree). One blocking
defect in Task 5's gate:

### G3-F4 (BLOCKING in the plan): Task 5 URL rule is RED on the plan's own code

Task 5 Step 1 (`:608`) and Step 2 (`:624`) run:

```
grep -rn --include='*.rs' -E '"https?://|"wss?://' src | grep -v '^src/main.rs'
```

The allow-list is `src/main.rs` only. But Task 1 creates `api.rs` whose
`#[cfg(test)] mod tests` holds literal URLs, and Task 4 Step 3 adds another.
Running Step 2's block verbatim against the plan's own `api.rs` → 9 matching
lines (all in `src/api.rs`), so the gate exits non-zero and the implementer is
stuck at Task 5 Step 2 (whose "Expected: API-access guard PASSED" can never
hold). The parenthetical at `:627` ("the URL check finds only `main.rs:29`") is
wrong for the same reason.

**Fix (2 lines + 1 sentence):** add `api.rs` to the URL allow-list in both
places — `grep -vE '^src/(main|api)\.rs'` — and correct the `:627` note.
Verified: with that allow-list the Step 2 block passes clean.

**Spec follow-on (§6.2 rule (b)):** the spec's allow-list is "`src/main.rs:29`
(the single clap `default_value`)" — it must also name `src/api.rs`, since the
shared module necessarily contains literal URLs in its unit tests (URL-3 is a
scheme rewrite; its tests need literal in/out). Same family as G3-F1: an
allow-list that doesn't cover every legitimate site.

### G3-F5 (spec, still open): §6.2 rule (a) in the merged spec is still the red rule

BA fixed §6.2 rule (b)'s allow-list in both the plan (4 sites) and the spec
(`:234`, docs-only +2/−2) — both verified correct. But the spec's rule **(a)**
at `:234` still reads verbatim "forbid (a) ad-hoc `struct …Error` outside
`src/api.rs`" — the rule BE proved RED on `main` (G3-F1, `files.rs:214
FilesError`). The corrected `details`-token rule exists **only in the plan**
(Self-Review "Known spec deviations" #1); grepping the spec for
`details`-token/`FilesError`/`files.rs` returns nothing. So the merged, binding
spec and the plan state two different rule (a)s, and the spec's own "passes
clean on `main`" sentence is false for rule (a). Fix: bring `:234` rule (a) in
line with the plan (`details`-token, or `struct …Error` + `src/files.rs` in the
allow-list). Same family as G3-F4 — the spec was only half-corrected.

**RESOLVED (2026-10-15):** BA corrected spec §6.2 (`:234-235`, docs-only
+2/−2) to carry all three rules — (a) `details`-token, (b) the RS-1 dependency
rule, (c) two-file URL allow-list — and rewrote the "Verified today" line.
BE re-verified against `main`: all three gate components PASS (only literal URL
is `main.rs:29`), and BE independently re-ran the seed-fail proof in a temp
tree — baseline pass, each seed (envelope field / literal URL / `reqwest::`)
turns its component RED, cleanup pass. Plan cross-refs (`:34,583,585,684`) synced
to "spec == plan"; VI-clean confirmed on both files. Chain closed.

### Verified sound (no change needed)

- Task 1 `to_ws_url`: trim → strip_prefix https/http → pass-through ws/wss →
  `else bail!`; the 6 tests match the impl.
- Task 2 `ApiError`: type/derives/consts match; `is_auth_fatal` =
  `status == Some(401) || code == "UNAUTHORIZED"`; `from_response` maps a
  non-JSON body to `API_ERROR` (commented, matches §5.3 "NETWORK_ERROR = no HTTP
  response"); the #107 tests match the impl.
- Task 4 wiring: insertion point is real — `lib.rs:628-631`
  (`let mut delay = signal::BACKOFF_INITIAL;` + `let mut supervisor …` +
  `loop {`); `run_with_reconnect` (`lib.rs:592`) returns `Result<()>`;
  `Context` imported at `lib.rs:209`; `config` is a fn param, usable in the
  `tokio::select!` closure. `HeaderValue` has exactly one use in `signal.rs`
  (`:15` import, `:356`) → removing the import is correct.

## G3 interface decision (BE → BA, 2026-10-14) — post-approval

Spec merged `main` @ `d6054a4`. BA asked BE to pin the G3 interface before the
plan is written. Verified against the tree; three gaps found (G3-F1 is
load-bearing — the gate as specified is RED on `main`).

### G3-F1 (BLOCKING): §6.2 rule (a) fails on clean `main`

§6.2 rule (a) forbids "ad-hoc `struct …Error` outside `src/api.rs`". Run today:

```
$ grep -rn --include='*.rs' -E 'struct [A-Za-z_0-9]*Error\b' apps/agent/src | grep -v 'src/api.rs'
apps/agent/src/files.rs:214:pub struct FilesError {
```

`FilesError` (`apps/agent/src/files.rs:214`) is a **legitimate file-transfer
error type** (`{code: FilesErrorCode, message, request_id, transfer_id}` — no
`error`/`code`/`details` envelope triple). The naive rule flags it, so the gate
would fail on `main` — directly contradicting §6.2's own "the gate passes clean
on `main` — as designed".

**Fix (recommended):** make rule (a) precise. The envelope's distinguishing
field is `details`, which is **unused** in `apps/agent/src` today (0 hits —
proven: `grep -rn '\bdetails\b' apps/agent/src` → empty), so a `details`-token
check passes clean on `main` AND still catches a duplicated envelope anywhere
outside the module:

```
if grep -rn --include='*.rs' '\bdetails\b' src | grep -v '^src/api.rs'; then fail
```

**Alternative fix:** keep the `struct …Error` shape but add `src/files.rs` to
the allow-list (also verified clean:
`grep -rnE 'struct [A-Za-z_0-9]*Error\b' apps/agent/src | grep -vE 'src/(api|files)\.rs'` → empty).
The `details`-token rule is preferable: it keys on the envelope's actual
identity, so it needs no allow-list upkeep and cannot silently drift when
`files.rs` grows a second error type.

Rule (b) is fine as written — verified: exactly one literal URL in agent src,
`main.rs:29`, 0 elsewhere. Also add the dependency rule (`reqwest::`,
`hyper::Client`, `ureq::`) the spec omits though RS-1/RS-3's intent needs it.

### G3-F2: `is_auth_fatal` semantics are undefined in the spec

RS-1 names `is_auth_fatal` but never defines it. Two divergent desktop impls
exist:
- `apps/desktop/src/core/devices.rs:106` — `status == 401 || code == "UNAUTHORIZED"`
  (403 NOT fatal; the only 403 there is `AGENT_LIMIT_REACHED`). **This is the
  issue-#107 ruling** (PR #110).
- `apps/desktop/src/core/session.rs:54` — `matches!(status, 401 | 403)`
  (refresh-endpoint-specific: a 403 there means the refresh credential is dead).

These are **different contexts**, not a bug. The shared module's `is_auth_fatal`
MUST pin the **general API rule** (401 OR `code=="UNAUTHORIZED"`; 403 NOT fatal),
matching #107 and the TS client's 401-only refresh trigger
(`packages/api-client/src/client.ts:90`).

### G3-F3: URL-3 in the agent is a scheme rewrite, and normalizing is a real fix

Agent's `--server` default is `ws://localhost:8787/api/ws/agent`
(`main.rs:29`) — a complete WS URL, not an HTTP base. So the shared helper for
the agent MUST be a **pure scheme rewrite** (`http→ws`, `https→wss`, `ws`/`wss`
pass through, trailing `/` trimmed, else `Err`) with **no path append** — the
agent's own server string already carries `/api/ws/agent`, so appending would
double it.

**This is a real fix, not cosmetics:** today `SignalClient::connect` passes
`config.server` straight to `into_client_request` (`signal.rs:353`) and then
`connect_async`, whose `connect` rejects any non-`ws`/`wss` scheme with
`UrlError::UnsupportedUrlScheme` (tokio-tungstenite `connect.rs:88`,
`tungstenite client.rs:144`). So an operator running `--server http://host:8787`
(or `AGENT_SERVER=http://…`) **fails the handshake today**; routing it through
`api::to_ws_url` makes the documented `http(s)→ws(s)` behaviour actually work.

Note the desktop's three copies each append a *different* path on top of the
common scheme rewrite — `tray.rs:55` and `agent_host.rs:20` append
`/api/ws/agent`, `fleet_ws.rs:147` appends `/api/ws/browser?ticket=…`. Only the
scheme rewrite is the shareable unit; the per-caller path stays with the caller.

### Pinned interface (for the plan)

```rust
// apps/agent/src/api.rs  —  `pub mod api;` in lib.rs (alongside `pub mod identity`)

/// Server failure envelope: `{ error, code, details }`. Mirrors TS `ApiError`.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: Option<u16>,            // None = transport/config failure, no HTTP response
    pub code: String,
    pub message: String,                // the `error` field
    pub details: Option<serde_json::Value>,
}
impl std::fmt::Display for ApiError { /* … */ }
impl std::error::Error for ApiError {}

impl ApiError {
    /// Parse a non-2xx body. Fallback code `API_ERROR` when the body has no `code`.
    pub fn from_response(status: u16, body: &str) -> Self;
    /// No HTTP response (transport/parse). code `NETWORK_ERROR`, status `None`.
    pub fn network(message: impl Into<String>) -> Self;
    /// `status == Some(401) || code == "UNAUTHORIZED"` — issue-#107 rule; 403 NOT fatal.
    pub fn is_auth_fatal(&self) -> bool;
}

/// Scheme rewrite: http→ws, https→wss, ws/wss pass through; trailing '/' trimmed; else Err.
pub fn to_ws_url(base: &str) -> anyhow::Result<String>;

/// Insert `Authorization: Bearer {credential}` on a WS client request.
pub fn with_bearer(
    request: &mut tokio_tungstenite::tungstenite::http::Request<()>,
    credential: &str,
) -> anyhow::Result<()>;
```

Error-style choice: helpers return `anyhow::Result` (crate-idiomatic; `signal.rs`
already uses `anyhow` + `.context(..)`), `ApiError` is the **server-envelope**
type only (implements `std::error::Error` so it flows into `anyhow` when an HTTP
call lands). Alternative — one error type everywhere — would force inventing
config-error codes; not recommended.

### G3 scope (minimal but live)

1. `apps/agent/src/api.rs` + `pub mod api;` in `lib.rs`.
2. Wire the **live** half into `signal.rs`:
   - `signal.rs:354-360` — replace the inline `format!("Bearer {credential}")`
     + `HeaderValue::from_str` insert with `api::with_bearer(&mut request, credential)?`
     (satisfies AUTH-3's "no inline `format!("Bearer …")`").
   - `lib.rs:643` — normalize before connect:
     `let url = api::to_ws_url(&config.server)?;` then `SignalClient::connect(&url, …)`.
     This is a real fix: a `--server http://host:...` today is handed straight to
     `into_client_request` unnormalized.
3. **Forward-looking** (spec RS-3), unit-tested, not yet wired: `from_response`,
   `network`, `is_auth_fatal` (no HTTP consumer exists). `pub mod` means no
   dead-code warnings.
4. CI gate (corrected per G3-F1) after `Check formatting`, before `Lint`.

**Not** in scope: refactoring `signal.rs`'s error handling to `ApiError` —
signal.rs errors are WS/transport, not server envelopes. Converting them would
be wrong.

### Tests for `api.rs` (pin behavior, incl. the #107 anchor)

- `from_response` maps `{error,code,details}`; `details: null` → `None`; object
  `{"retryAfter":30}` → `Some(object)` (the D6 case).
- `from_response` fallback → code `API_ERROR` when body lacks `code`.
- `network(..)` → `status == None`, `code == "NETWORK_ERROR"`.
- `is_auth_fatal`: true `(401, any)` and `(403, "UNAUTHORIZED")`; **false**
  `(403, "AGENT_LIMIT_REACHED")`, `(500,..)`, `(429,..)`, `(400,..)` — port of
  `devices.rs:427-445`.
- `to_ws_url`: `http→ws`, `https→wss`, `ws`/`wss` passthrough, trailing `/`
  trimmed, bad scheme → `Err`.
- `with_bearer`: sets the header; a credential with a control char → `Err`.

Gate seed-fail obligation (§6.2): with the **corrected** rule, seed a
`struct Foo { details: Option<String> }` in `signal.rs` → gate FAILS; remove →
gate PASSES on clean `main`.

## Deliverable 1 — Rust shared client

### Recommendation: scope to `apps/agent`, do not create a crate yet

There is **no Rust workspace** today: no root `Cargo.toml`, no `crates/` dir.
`apps/agent` and `apps/desktop` are two independent crates. Creating
`crates/ponter-api-client` forces a new workspace root and touches the build for
both apps — structural cost with no second consumer to justify it (YAGNI).

Recommended shape for now: a module inside the agent crate,
`ponter_agent::api` (`apps/agent/src/api.rs`), promoted to a real
`crates/ponter-api-client` **only when a second Rust consumer appears** (e.g. if
the Electron main process ever needs a Rust sidecar, or a future Rust CLI).

If the owner/spec prefers a crate now, the fallback is:
`crates/ponter-api-client` + a workspace root `Cargo.toml` listing
`apps/agent` (and not `apps/desktop`, which is being deleted).

### Proposed API surface (mirrors TS `packages/api-client/src/errors.ts`)

```rust
/// Server failure envelope: `{ error, code, details }`.
/// Mirrors TS `ApiError { status, code, details }`.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,                 // HTTP status, 0 for transport failure
    pub code: String,                // stable server code, or a sentinel
    pub message: String,             // `error` field, human-readable
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    /// Parse a non-2xx body into the envelope.
    /// Fallback code `"API_ERROR"` when the body carries no `code`
    /// (mirrors TS `data.code || 'API_ERROR'`).
    pub fn from_response(status: u16, body: &str) -> Self;

    /// Transport/parse failure with no HTTP response.
    /// code `"NETWORK_ERROR"` (mirrors TS `fromResponse` catch arm).
    pub fn network(message: impl Into<String>) -> Self;

    /// `status == 401 || code == "UNAUTHORIZED"` — the existing desktop rule
    /// (`apps/desktop/src/core/devices.rs:106`), reused verbatim.
    pub fn is_auth_fatal(&self) -> bool;
}
```

Helpers (base-URL build + credential header) stay thin, because the agent's
only call is the WS handshake:

```rust
/// Build the WS URL from a configured base (scheme+host+port) and path.
pub fn build_ws_url(base: &str, path: &str) -> anyhow::Result<String>;

/// Insert `Authorization: Bearer {credential}` on a WS client request.
pub fn with_bearer(request: &mut http::Request<()>, credential: &str) -> anyhow::Result<()>;
```

**WS ticket minting: not needed for the agent.** The agent authenticates with a
credential header, not a browser-style ticket. Only add a ticket helper if a
Rust consumer must mimic the browser flow — none exists today.

### Consumers

- `apps/agent` — the only consumer for now (error mapping + WS helpers).
- `apps/desktop` — **excluded**; deleted with the Electron migration.
- No JS/TS impact — `packages/api-client` already covers the web/Electron side.

## Deliverable 2 — Server contract (single source of truth)

### Envelope

`apps/server/src/middleware/error.ts` is the single source of truth. Every error
response is:

```json
{ "error": "<human message>", "code": "<STABLE_CODE>", "details": <object|null> }
```

- `AppError(message, statusCode = 400, code = 'BAD_REQUEST', details = null)`.
- `errorHandler` emits `{ error: err.message, code: err.code, details: err.details }`.
- `SyntaxError` → `400` / `MALFORMED_JSON` / `"Malformed JSON payload"`.
- Unknown error → `500` / `INTERNAL_SERVER_ERROR` / `"Internal server error"`.

### Status-code conventions (observed distribution)

| status | meaning                       |
|--------|-------------------------------|
| 400    | validation / bad request      |
| 401    | unauthorized                  |
| 403    | forbidden                     |
| 404    | not found                     |
| 409    | conflict (duplicate/limit)    |
| 429    | rate limited                  |
| 500    | internal / database           |

### Stable `code` values clients may branch on

Canonical union found across `apps/server/src/**/*.ts` (18 distinct):

- **Generic**: `BAD_REQUEST`, `VALIDATION_ERROR`, `MALFORMED_JSON`,
  `UNAUTHORIZED`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`, `DATABASE_ERROR`,
  `TOO_MANY_REQUESTS`
- **Auth/token**: `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`,
  `INVALID_TOKEN_TYPE`, `TOKEN_REVOKED`, `ACCOUNT_INACTIVE`
- **Identity conflict**: `EMAIL_EXISTS`, `USERNAME_EXISTS`
- **Agent**: `AGENT_EXISTS`, `AGENT_LIMIT_REACHED`
- **Session**: `SESSION_NOT_ACTIVE`, `SESSION_TERMINATED`

### Client-side sentinel codes (must be mirrored)

- TS `ApiError.fromResponse` uses `code = 'API_ERROR'` when the body has no
  `code`, and `code = 'NETWORK_ERROR'` when the body is not JSON.
- Rust `ApiError` must produce the same two sentinels so branch logic is portable.

### WS-level codes

`apps/server/src/routes/ws.ts` reuses the same vocabulary on close/error frames
(`INTERNAL_SERVER_ERROR`, `MALFORMED_JSON`, `NOT_FOUND`, `SESSION_NOT_ACTIVE`,
`SESSION_TERMINATED`, `VALIDATION_ERROR`). The agent classifies terminal closes
in `apps/agent/src/signal.rs` (`classify_close`; `4409`/`4401` terminal).

### CORRECTION (2026-10-14, after BA review): the code vocabulary is 28, not 18

My first extraction counted only **18** codes. That was **wrong**: the grep window
was too narrow, so multi-line `new AppError(\n  '...',\n  <status>,\n  'CODE',\n)`
calls were invisible. BA independently counted **28** and is correct. Verified by
re-extracting with a multi-line-aware window plus all three emit paths
(`AppError(..)`, `code: '..'`, `sendError('..')`): union = 27 explicitly thrown +
`BAD_REQUEST` (the `AppError` default) = **28**.

Codes my 18-list omitted: `DEVICE_EXISTS`, `FORBIDDEN`, `LAST_ADMIN_PROTECTED`,
`SELF_DEACTIVATION_BLOCKED`, `SIGNING_KEY_ALREADY_SET`, `USER_PENDING_APPROVAL`,
`USER_REJECTED`, `REGISTRATION_DISABLED`, `INVALID_TOKEN_TYPE`, `TOKEN_REVOKED`,
`REFRESH_TOKEN_REUSED`. Treat BA's §5.3 table as authoritative.

### ADDITIONAL FINDING: `BrowserErrorCode` over-declares **two** members, not one

BA found `TICKET_EXPIRED` (never emitted, never read). There is a **second**
phantom member of the same class: **`UNAUTHORIZED`**.

- `BrowserErrorCode` (`packages/shared/src/types/signaling.ts:86-93`) declares:
  `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`,
  `TICKET_EXPIRED`, `SESSION_TERMINATED`, `INTERNAL_SERVER_ERROR`.
- The browser socket actually emits only:
  `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `SESSION_TERMINATED`,
  `INTERNAL_SERVER_ERROR` (`ws.ts:413` `sendError` set, `:900`, `sessions.ts:148`).
- `UNAUTHORIZED` appears **0 times** in `apps/server/src/routes/ws.ts`; it is an
  HTTP 401 only (`middleware/auth.ts:12,17,53`). A rejected WS upgrade is an HTTP
  401 (`ws.ts:650-663`), never a frame.
- `packages/webrtc-core/src/transport.ts` reads the frame code (`:641`) but never
  synthesizes `UNAUTHORIZED`.

So **`BrowserErrorCode` over-states the wire contract by two members**
(`UNAUTHORIZED`, `TICKET_EXPIRED`). By contrast `AgentErrorCode`
(`signaling.ts:61-66`) is **exact**: its 5 members equal the agent socket's emit
set (`ws.ts:1000-1100`).

Also note the two unions are **not** in a superset relation, contrary to the
spec's "the above plus …" prose: `AgentErrorCode` contains `SESSION_NOT_ACTIVE`,
which `BrowserErrorCode` does **not** (the browser union has `SESSION_TERMINATED`
instead). The spec should list them as two independent sets.

**RESOLVED (2026-10-14):** BA folded both findings into the spec at commit
`d495b94` (branch `docs/api-access-standard-spec`). BE independently re-verified
the fix: the corrected §5.3 now states the two unions are independent sets, and
all 17 emit-set citations (`ws.ts:413,425,433,439,468,488,493,499,536` +
`sessions.ts:148-150` for browser; `ws.ts:1013,1023,1030,1054,1062,1076,1083,1091`
for agent) resolve exactly as claimed. Diff is 1 file, +10/−3, docs-only.

### Divergence: WS error frame has a THIRD shape (spec must reconcile)

The HTTP envelope is `{error, code, details}` — **three fields, no `type`**. The
WS error frame is `{type: 'error', code}` — **two fields, no `error`/`details`**.
Produced at `apps/server/src/routes/ws.ts:413` (`sendError`), `:900`, `:1013`,
`:1023`, `:1030`, `:1054`, `:1062`, `:1076`, `:1083`, `:1091`, and
`apps/server/src/routes/sessions.ts:148`. The agent already models this as a
distinct variant: `InboundFrame::Error { code: String }`
(`apps/agent/src/signal.rs:98`, handled at `:139`).

Consequence for the spec: the "unified API-access standard" must name **two**
wire shapes, not one — HTTP `{error, code, details}` and WS `{type:'error', code}` —
or explicitly rule that they stay distinct. A single Rust `ApiError` type can
still back both, but its `message`/`details` fields are empty on the WS path.
This is the single most important contract point the spec must not blur.

## Deliverable 3 — Enforcement (Rust side)

The stated rule — "catch new raw `reqwest` calls outside the shared crate" — is
**vacuous today**: the agent has no `reqwest`. The enforceable rules that match
reality are:

- **R-G1**: all server-error-envelope parsing and auth-fatal classification go
  through the shared module — no ad-hoc `struct XError { error, code, details }`
  duplicates (the desktop crate has exactly this duplicate today).
- **R-G2**: all outbound server URLs are built through the shared base-URL
  helper — no literal `ws://` / `http://` outside the config default
  (`apps/agent/src/main.rs:29` `default_value = "ws://localhost:8787/api/ws/agent"`).

Mechanisms, ranked:

1. **CI grep gate (works today, no toolchain risk).** Add a step to
   `.github/workflows/build-agent.yml` (already path-filtered to `apps/agent/**`)
   that fails if `apps/agent/src` contains forbidden patterns:
   `reqwest::`, `hyper::Client`, or a literal `http://` / `ws://` outside an
   allowlist. Cheap, explicit, reviewable in the diff.
2. **`clippy.toml` `disallowed-types`** for `reqwest::Client` (and, once a real
   crate exists, `disallowed-methods` for `reqwest::Client::new`). Native, but
   only flags the exact paths you enumerate.
3. **`#[deny(...)]` attributes** — weakest; only catches lints clippy provides.

Recommendation: **(1) grep gate in `build-agent.yml`** as the primary gate,
with **(2) `clippy.toml` `disallowed-types`** as belt-and-suspenders. Revisit
when/if `ponter-api-client` becomes a real crate.

### Concrete CI gate model (ready to paste into the spec)

Insertion point: `.github/workflows/build-agent.yml`, `verify` job, right after
the `Check formatting` step (line 88) and before `Lint` (line 90) — so a
structural violation fails fast, before the slow clippy/test steps. The job
already runs `working-directory: apps/agent` and is path-filtered to
`apps/agent/**` (lines 23-31), so no new trigger is needed.

Proposed step:

```yaml
      - name: Guard — API access goes through the shared module
        run: |
          set -euo pipefail
          # R-G1: no ad-hoc error-envelope structs outside the shared api module.
          if grep -rn --include='*.rs' -E 'struct [A-Za-z]*Error\b' src \
               | grep -v '^src/api.rs'; then
            echo "::error::ad-hoc error struct outside src/api.rs (use ponter_agent::api::ApiError)"
            exit 1
          fi
          # R-G2: no literal server URLs outside the config default in main.rs.
          if grep -rn --include='*.rs' -E '"https?://|"wss?://' src \
               | grep -v '^src/main.rs'; then
            echo "::error::literal server URL outside src/main.rs (use the base-URL helper)"
            exit 1
          fi
          echo "API-access guard PASSED"
```

Allowlist rationale: `src/main.rs:29` legitimately holds the clap `default_value`
`ws://localhost:8787/api/ws/agent` (the single config default), and `src/api.rs`
is the shared module itself. Everything else must go through the helper.

Proof obligation (for the spec's acceptance criteria): the gate must be shown to
**fail** on a seeded violation (add a `struct FooError` or a literal
`"http://x"` to `src/signal.rs`, run the step, confirm exit 1) and **pass** on
clean `main`. A gate never observed failing is not a gate.

### Contract-drift evidence (why the spec is worth writing)

| Field | TS `ApiError` | Rust `DevicesError` (`apps/desktop/src/core/devices.rs:99`) | Server (`error.ts`) |
|-------|---------------|-------------------------------------------------------------|---------------------|
| error | `error: string` | `error: String` | `error: string` |
| code  | `code: string`  | `code: String`  | `code: string` |
| details | `details: unknown` | `details: Option<String>` (**drift**) | `details: unknown` (object/null) |

The Rust struct types `details` as `Option<String>`, but the server sends an
object or `null` (and always `null` today). A non-null object payload would fail
Rust deserialization. The shared `ApiError` must type `details` as
`Option<serde_json::Value>`, matching TS `unknown`.

### Per-code source map (for the spec's canonical reference table)

| code | status | produced at (representative) |
|------|--------|------------------------------|
| BAD_REQUEST | 400 | `middleware/error.ts:8` (AppError default) |
| VALIDATION_ERROR | 400 | `routes/auth.ts:65,86`; `routes/sessions.ts:59` |
| MALFORMED_JSON | 400 | `middleware/error.ts:35`; `routes/ws.ts:425,433` |
| UNAUTHORIZED | 401 | `middleware/auth.ts:12,17,37` |
| INVALID_CREDENTIALS | 401 | `routes/auth.ts:251,263,404` |
| INVALID_REFRESH_TOKEN | 401 | `routes/auth.ts:455,479` |
| INVALID_TOKEN_TYPE | 401 | `routes/auth.ts:459` |
| TOKEN_REVOKED | 401 | `routes/auth.ts:463` |
| ACCOUNT_INACTIVE | 401 | `routes/auth.ts:282,467` |
| AGENT_LIMIT_REACHED | 403 | `routes/agents.ts:81` |
| NOT_FOUND | 404 | `routes/sessions.ts:39,43,111` |
| EMAIL_EXISTS | 409 | `routes/auth.ts:125` |
| USERNAME_EXISTS | 409 | `routes/auth.ts:123` |
| AGENT_EXISTS | 409 | `routes/agents.ts:69` |
| SESSION_NOT_ACTIVE | 409 | `routes/signal.ts:32`; `routes/ws.ts:1083` |
| SESSION_TERMINATED | 409 | `routes/sessions.ts:149`; `routes/ws.ts:493,901` |
| TOO_MANY_REQUESTS | 429 | `middleware/login-rate-limit.ts:86,111` |
| DATABASE_ERROR | 500 | `routes/auth.ts:177` |
| INTERNAL_SERVER_ERROR | 500 | `middleware/error.ts:57`; `routes/agents.ts:110`; `utils/env.ts:19` |

Note: `BAD_REQUEST` is only the AppError *default* (`middleware/error.ts:8`) and
is not thrown explicitly anywhere — a client seeing `BAD_REQUEST` means an
`AppError` was constructed without a code. Worth a spec sentence.

## Open questions for the spec (BA)

1. **Crate vs module**: does the spec want a real Rust workspace +
   `crates/ponter-api-client`, or accept an `apps/agent`-scoped module for now?
   (BE recommends the module; YAGNI until a 2nd Rust consumer exists.)
2. **Code list**: freeze the 18 `code` values as a shared enum across TS+Rust,
   or keep the vocabulary open-ended with sentinels only?
3. **Electron migration**: will the Electron main process (Node) reuse
   `packages/api-client`, or need a new path? If Node, **no Rust HTTP client is
   needed at all** and Deliverable 1 shrinks to the WS helper + error type.
