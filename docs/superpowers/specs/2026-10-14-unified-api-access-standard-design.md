# Unified API Access Standard — Design Spec

- **Status:** Approved (owner, 2026-10-14) — ready for implementation planning.
- **Phase:** Cross-cutting standardization (Sub-project G)
- **Date:** 2026-10-14
- **Owner directive:** "Standardize how APIs (and similar parts) are called across the whole project" (2026-10-14); scope = the whole project, **including Rust**.
- **ADR:** ADR-89 (Unified API Access Standard) — number and the four open questions confirmed by the owner on 2026-10-14 (§9).
- **Related ADRs:** ADR-13 (agent credential via header, never query string), ADR-52 (OS keychain), ADR-64/65 (desktop config precedence), ADR-67 (build-time default server URL), ADR-85..88 (Electron migration).
- **Related Files:** `packages/api-client/**`, `packages/webrtc-core/**`, `packages/shared/src/types/signaling.ts`, `apps/web/src/{config.ts,services/**}`, `apps/agent/**`, `apps/desktop/**` (being removed), `apps/server/src/{middleware,routes}/**`, `.github/workflows/{ci-node,build-agent,build-desktop}.yml`, `docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md`.

---

## 1. Context & Motivation

Every client surface today reaches the backend through a **different** mechanism. The backend contract is stable and single-sourced, but no client-side standard binds them, so each surface re-implements URL building, auth-header injection, error mapping, and reconnect logic. That duplication is already producing real drift (a Rust struct that cannot deserialize a payload the server actually sends — §5.4).

**Evidence (surveyed 2026-10-14, read-only):**

| # | Divergence | Where |
|---|---|---|
| D1 | **Rust side has no shared client.** URL building, `Bearer` injection, and status→string error mapping are hand-rolled per module. | `apps/desktop/src/core/{auth,session,devices,fleet_ws,wizard,updater}.rs` (being deleted by the Electron migration) |
| D2 | **Base-URL resolution is per-app**, with three different shapes and precedence chains. | `apps/web/src/config.ts`, `apps/desktop/src/core/config.rs:41-64`, `apps/agent/src/main.rs:25-31` |
| D3 | **Token/credential storage is per-app.** The `TokenStorageAdapter` *interface* is shared; the *implementations* are not. | `apps/web/src/services/token-storage.ts` (localStorage), desktop keychain, agent env/argv |
| D4 | **WS clients duplicate logic.** `FleetSocket` mirrors `WebSocketSignalTransport`'s backoff constants (200/2000), its `randomUnit()`, and its delay formula. | `apps/web/src/services/fleet-socket.ts:10-28,195-208` vs `packages/webrtc-core/src/transport.ts:329-340,672-690` |
| D5 | **Spec drift.** The Electron migration spec says the main process calls the backend "via `@ponter/desktop-core` HTTP". `desktop-core` is **WebRTC-only** (`DesktopClient`); the HTTP client is `@ponter/api-client`. | `docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md:78,104,105,153,154` |
| D6 | **Contract drift on `details`.** The server sends `details` as an **object or null**; the TS client types it `unknown` (correct); the Rust `DevicesError` types it `Option<String>` (wrong — an object payload fails to deserialize). | `apps/server/src/middleware/error.ts:4-14`, `packages/api-client/src/errors.ts:10`, `apps/desktop/src/core/devices.rs:99-104` |

**The goal:** one contract per language, enforced by CI, with the drift fixed.

**What is already good (the standard builds on this, it does not replace it):**
- `@ponter/api-client` — `HttpClient` + `ApiClient` + 7 typed resource classes (auth/admin/users/devices/agents/sessions/webrtc), base-URL normalization, `Bearer` injection, single-flight `401`→refresh→retry (`refreshPromise`, `client.ts:106,130`), typed `ApiError` (`errors.ts:7-10`), `NETWORK_ERROR` on transport failure.
- The server's single `errorHandler` and `AppError` (`apps/server/src/middleware/error.ts`).
- `packages/webrtc-core` `mintWsTicket` / `buildBrowserWsUrl` (`src/ws-ticket.ts:1,16`) — already shared by web and the signaling transport.

---

## 2. Locked Owner Decisions

1. **Scope = the whole project, including Rust.** Not limited to one app.
2. **Timing = now**, in parallel with sub-projects A–F (docs-only in this phase; no code conflict).
3. **One HTTP client per language.** TypeScript/JavaScript → `@ponter/api-client`; Rust → a single shared module (see ADR-89).
4. **Enforcement is part of the standard** — a CI gate per language, not a convention.
5. **Fix the Electron-spec drift** (§7) so the next migration step targets the right client.
6. **ADR-89** is the number for this standard (Electron migration keeps ADR-85..88).
7. **The TS enforcement gate is a vitest source-scan guard test** (modelled on `apps/web/src/__tests__/e2ee-claims.test.ts`), not a shell `grep` step.
8. **The `createApiClient` factory ships in G2** — not deferred to when the Electron main process needs it.
9. **The `FleetSocket` backoff divergence is kept**, expressed as configuration of the shared base (§3.5 WS-2) — not removed.

---

## 3. The Standard (normative rules)

Rules use RFC-2119 keywords. "App code" = first-party source under `apps/*/src` and `packages/*/src`.

### 3.1 HTTP — TypeScript/JavaScript (web, Electron main + renderer, packages)

- **TS-1** All backend HTTP calls from app code **MUST** go through `@ponter/api-client` (`ApiClient` + its typed resource classes).
- **TS-2** App code **MUST NOT** call `fetch`/`axios` directly against a backend endpoint. Permitted exceptions, exhaustively:
  - `apps/server/**` (it *is* the backend);
  - `packages/webrtc-core/src/ws-ticket.ts` (the sanctioned ticket-mint helper — it takes an **injected** `fetch` and is the one place a raw call is allowed);
  - `packages/webrtc-core/src/transport.ts` (REST polling transport — see §3.5; it also uses an injected `fetch`).
- **TS-3** There is **no factory today**. Construction is `new ApiClient({ baseUrl, storage, onAuthError?, fetch? })` (`packages/api-client/src/client.ts:202,212`). **A `createApiClient({ baseUrl, storage })` factory is a deliverable of G2** (owner decision, §2.8) — it **MUST** be introduced without changing `ApiClient`'s behavior, and every app **SHOULD** construct its client through it once available. (This corrects PM item 1, which assumed the factory already exists.)
- **TS-4** Every client **MUST** configure a `TokenStorageAdapter` (§3.4) and **MUST NOT** hold tokens anywhere else.

### 3.2 HTTP — Rust (`apps/agent`; any retained Rust)

- **RS-1** Rust app code that talks to the backend **MUST** go through **one shared module**, `ponter_agent::api` (see ADR-89), providing: base-URL construction, `Bearer` injection, and error mapping.
- **RS-2** The shared error type **MUST** mirror the TS `ApiError` shape: `{ status: Option<u16>, code: String, message: String, details: Option<serde_json::Value> }`. `details` **MUST** be `Option<serde_json::Value>` — **not** `Option<String>` — so a server-sent object (e.g. `{"retryAfter": 30}`) deserializes (fixes D6).
- **RS-3** **`apps/agent` today performs no HTTP at all.** Its only egress is the signaling WebSocket (`tokio-tungstenite`, no `reqwest`/`hyper`/`ureq` in `apps/agent/Cargo.toml`). Therefore RS-1's HTTP half is **forward-looking**: it is written now so that any future agent HTTP call (or any retained Rust) has exactly one place to go. The **WS half is live** and is what G3 implements (§3.5, §8).
- **RS-4** `apps/desktop`'s hand-rolled `reqwest` client is **out of scope** — the Electron migration deletes that crate. The standard must not be read as an endorsement to preserve it.

### 3.3 Base URL — one contract, per-app source of truth

- **URL-1** Each app **MUST** expose exactly one resolver returning an absolute base URL, and every call **MUST** be built from it. No module may `format!`/concatenate a server URL from scratch (this is what D1/D2 violate).
- **URL-2** The per-app precedence chains are fixed as follows:

| App | Precedence (highest first) | Source |
|---|---|---|
| web | runtime `window.__PONTER_CONFIG__.apiUrl` → `import.meta.env.VITE_API_URL` → `window.location.origin` (if not `"null"`) → `http://localhost:8787` | `apps/web/src/config.ts:16-38` |
| Electron (future) | config store → build-time default → localhost (folds into sub-project B) | — |
| agent | `--server` flag → `AGENT_SERVER` env → `ws://localhost:8787/api/ws/agent` (clap resolves flag > env > default) | `apps/agent/src/main.rs:25-31` |
| desktop (removed) | runtime env → persisted config → build-time default (`option_env!`, ADR-67) → localhost | `apps/desktop/src/core/config.rs:41-64` |

- **URL-3** WebSocket URLs **MUST** be derived from the resolved HTTP base URL by one shared rewrite: `http://`→`ws://`, `https://`→`wss://`, `ws://`/`wss://` pass through, anything else is an error. Today this rule is duplicated three times in Rust (`apps/desktop/src/tray.rs:55`, `apps/desktop/src/core/agent_host.rs:20`, `apps/desktop/src/core/fleet_ws.rs:147`) and lives implicitly in the TS helpers. The Rust shared module **MUST** own it once.
- **URL-4** Trailing slashes **MUST** be trimmed before joining a path (`trim_end_matches('/')`), matching `apps/desktop/src/core/config.rs` and `packages/api-client/src/client.ts`.

### 3.4 Auth & token storage — one interface, pluggable implementations

- **AUTH-1** The `TokenStorageAdapter` interface (`packages/api-client/src/types.ts:8-14`: `getAccessToken`/`getRefreshToken`/`setTokens`/`clearTokens`) is the single storage contract for TS clients.
- **AUTH-2** Implementations are per-environment and **MUST** be the only token holders:
  - web → `LocalStorageTokenAdapter` (`apps/web/src/services/token-storage.ts`);
  - Electron → a `safeStorage`/IPC adapter (sub-project B);
  - agent → **no token storage**; the credential is supplied by `AGENT_CREDENTIAL` env or `--credential` argv (`apps/agent/src/main.rs:39-42`), per ADR-13, and the identity is a persisted Ed25519 PKCS#8 file (`apps/agent/src/identity.rs`).
- **AUTH-3** The Rust shared module **MUST** expose the equivalent seam: a way to supply the credential and a single `with_bearer` helper, so no module writes `format!("Bearer {token}")` inline.
- **AUTH-4** Access tokens **MUST** be memory-only where a persistent store exists (desktop precedent: `apps/desktop/src/core/state.rs:21-22`); refresh tokens/credentials go to the platform store.

### 3.5 WebSocket — one transport, one ticket path

- **WS-1** All WebSocket **ticket minting** and **browser URL building** **MUST** go through `packages/webrtc-core` (`mintWsTicket`, `buildBrowserWsUrl`). Web already does (`apps/web/src/services/fleet-socket.ts:15,155,166`).
- **WS-2** Reconnect/backoff **MUST** live in **one shared base**, not be mirrored. The duplicated constants `WS_INITIAL_BACKOFF_MS = 200`, `WS_MAX_BACKOFF_MS = 2000`, the `randomUnit()` helper, and the delay formula `min(initial * 2**retries, max) + round(randomUnit()*100 - 50)` exist in **both** `apps/web/src/services/fleet-socket.ts:18-19,28,207-208` **and** `packages/webrtc-core/src/transport.ts:330-331,340,689-690`. G2 **MUST** collapse them into one shared implementation. The documented divergence (transport has a retry cap + fallback + pending queue; fleet reconnects forever with a 60s REST poll) **MUST** be preserved as configuration of that shared base, not as a second copy (owner decision, §2.9).
- **WS-3** The agent's own signaling client (`apps/agent/src/signal.rs`) is a **separate, Rust-side** concern: it uses `Bearer` on the upgrade (ADR-13, never query string), a ×1.5 backoff (`BACKOFF_INITIAL=200ms`, `BACKOFF_MAX=2000ms`, no jitter), and classifies close codes `4401`/`4409` as terminal (`signal.rs:298-303`). The standard records this as the Rust transport contract; it is **not** unified with the TS backoff (different language, different protocol role).
- **WS-4** Error frames and close codes are part of the server contract (§5).

### 3.6 Server contract — the single source of truth

The server contract is normative for all clients. It is fully specified in **§5**. Clients **MUST** map against the codes and shapes there, and **MUST NOT** invent client-side codes except the two sentinels (§5.3).

---

## 4. Architecture Decisions

### ADR-89: Unified API Access Standard

- **Decision:** Bind every client surface to one contract per language. TypeScript clients go through `@ponter/api-client` (existing) with a proposed `createApiClient` factory; Rust clients go through a single shared module `ponter_agent::api` exposing base-URL build, `Bearer` injection, a `{status, code, message, details}` error type mirroring TS `ApiError`, and the WS-URL rewrite. Both languages' rules are enforced by CI gates. The server's `{error, code, details}` HTTP envelope and `{type:'error', code}` WS frame are the canonical wire shapes.
- **Rationale:** The duplication in §1 is already causing drift (D6: a Rust type that cannot parse a payload the server sends). A single shared module per language removes the per-file re-implementation and gives CI one thing to guard. It reuses the good existing pieces (`@ponter/api-client`, `webrtc-core`, `AppError`) rather than inventing a parallel stack.
- **Alternatives Rejected:**
  - *A new shared Rust **crate** (`ponter-api-client`).* Rejected **for now** — there is no Rust workspace root (`apps/agent` and `apps/desktop` are independent Cargo projects with separate `Cargo.lock`s), and after the Electron migration `apps/agent` is the **only** Rust consumer, with **no HTTP at all**. A module inside the agent crate is the right size; promoting it to a crate is a follow-up if a second Rust consumer appears. (This refines PM item 2.)
  - *Unify TS and Rust into one generated client.* Rejected as YAGNI — the wire shapes are small and stable; codegen adds a build dependency with no near-term payoff.
  - *Leave it as convention, no CI gate.* Rejected — conventions decay; D1–D6 are the evidence.
  - *Fold everything into the Electron migration.* Rejected — the standard also governs web and the agent, which are not part of that migration.

---

## 5. Canonical Server Contract Reference

This section is the reference every client maps against. It is derived from the server source, with `file:line` citations.

### 5.1 HTTP error envelope — `{ error, code, details }`

`apps/server/src/middleware/error.ts` is the single emitter:

- `AppError(message, statusCode = 400, code = 'BAD_REQUEST', details = null)` (`error.ts:4-14`).
- The handler returns `{ error: err.message, code: err.code, details: err.details }` at `err.statusCode` (`error.ts:16-24`).
- A `SyntaxError` (bad JSON body) → `400` `{ error: 'Malformed JSON payload', code: 'MALFORMED_JSON', details: null }` (`error.ts:35`).
- A Hono `HTTPException` is passed through via `getResponse()` (`error.ts:39-44`).
- Anything else → `500` `{ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR', details: null }` (`error.ts:57`).

**Three fields. There is no `type` field on the HTTP envelope.**

### 5.2 WebSocket error frame — `{ type: 'error', code }`

The WS frame is a **different, smaller shape** — two fields, **no `error`, no `details`**:

- `connection.send(JSON.stringify({ type: 'error', code }))` — `apps/server/src/routes/ws.ts:412-413` (`sendError`), used at `ws.ts:425,433,493` and the `pushToBrowser` sites `ws.ts:901` and `sessions.ts:148-150`.
- A direct `socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_ACTIVE' }))` at `ws.ts:1083`.

The agent already models this correctly as its own variant: `InboundFrame::Error { code: String }` (`apps/agent/src/signal.rs:98`), handled at `signal.rs:139` (logged and dropped, never fatal).

**These two shapes MUST NOT be conflated into one.** A single Rust `ApiError` may back both, but `message`/`details` are empty on the WS path.

### 5.3 Error-code vocabulary

Two **client-side sentinels** are not server codes and exist only in the TS client:

| Sentinel | Meaning | Source |
|---|---|---|
| `API_ERROR` | Fallback when a response has no `code` | `packages/api-client/src/errors.ts:31` |
| `NETWORK_ERROR` | Transport failure (no HTTP response) | `packages/api-client/src/errors.ts:38`, `client.ts:68` |

**Server codes (HTTP envelope), with status and citation:**

| Code | HTTP | Source (`file:line`) |
|---|---|---|
| `BAD_REQUEST` | 400 | `middleware/error.ts:8` — the `AppError` **default only**; never thrown explicitly. A client seeing it means an `AppError` was constructed without a code. |
| `VALIDATION_ERROR` | 400 | `routes/auth.ts:62,83,91,233,329,347,393,420,441`; `routes/sessions.ts:59`; `routes/devices.ts:36,44`; `routes/agents.ts:54,192,200,220,231,243,258`; `routes/admin.ts:222,228,239,246,252` |
| `MALFORMED_JSON` | 400 | `middleware/error.ts:35`; `routes/ws.ts:425,433` |
| `LAST_ADMIN_PROTECTED` | 400 | `routes/admin.ts:276` |
| `SELF_DEACTIVATION_BLOCKED` | 400 | `routes/admin.ts:324` |
| `UNAUTHORIZED` | 401 | `middleware/auth.ts:12,17,53` |
| `INVALID_CREDENTIALS` | 401 | `routes/auth.ts:248,260,404,408` |
| `INVALID_REFRESH_TOKEN` | 401 | `routes/auth.ts:476` |
| `INVALID_TOKEN_TYPE` | 401 | `routes/auth.ts:459` |
| `TOKEN_REVOKED` | 401 | `routes/auth.ts:463` |
| `ACCOUNT_INACTIVE` | 401 | `routes/auth.ts:282,467` |
| `REFRESH_TOKEN_REUSED` | 401 | `routes/auth.ts:508,581` |
| `FORBIDDEN` | 403 | `middleware/admin.ts:18` |
| `REGISTRATION_DISABLED` | 403 | `routes/auth.ts:103` |
| `USER_PENDING_APPROVAL` | 403 | `routes/auth.ts:268` |
| `USER_REJECTED` | 403 | `routes/auth.ts:275` |
| `AGENT_LIMIT_REACHED` | 403 | `routes/agents.ts:81` |
| `NOT_FOUND` | 404 | `routes/sessions.ts:39,43,111,129`; `routes/auth.ts:369,432`; `routes/devices.ts:97`; `routes/agents.ts:135,282,293,317` |
| `USERNAME_EXISTS` | 409 | `routes/auth.ts:123` |
| `EMAIL_EXISTS` | 409 | `routes/auth.ts:125` |
| `AGENT_EXISTS` | 409 | `routes/agents.ts:69` |
| `DEVICE_EXISTS` | 409 | `routes/devices.ts:62` |
| `SIGNING_KEY_ALREADY_SET` | 409 | `routes/auth.ts:353` |
| `SESSION_NOT_ACTIVE` | 409 | `routes/signal.ts:32` (HTTP); `routes/ws.ts:1083` (WS frame) |
| `SESSION_TERMINATED` | 409 | `routes/sessions.ts:149` (WS frame); `routes/ws.ts:493,901` (WS frame) |
| `TOO_MANY_REQUESTS` | 429 | `middleware/login-rate-limit.ts:86,111` — **the only site where `details` is a non-null object** (`{ retryAfter }`), which is exactly the D6 drift. |
| `DATABASE_ERROR` | 500 | `routes/auth.ts:177` |
| `INTERNAL_SERVER_ERROR` | 500 | `middleware/error.ts:57`; `routes/agents.ts:107`; `utils/env.ts:16,28` |

**28 distinct server codes.** The shared WS unions in `packages/shared/src/types/signaling.ts` are the typed contract for the two sockets. **They are two independent sets — neither is a superset of the other:**

- `AgentErrorCode` (`signaling.ts:61-66`): `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`, `SESSION_NOT_ACTIVE`.
- `BrowserErrorCode` (`signaling.ts:86-93`): `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `TICKET_EXPIRED`, `SESSION_TERMINATED`, `INTERNAL_SERVER_ERROR`.

The asymmetry is intentional and correct in one direction: `SESSION_NOT_ACTIVE` is **agent-only** (the agent socket is told its session is not active; a browser is told `SESSION_TERMINATED` instead — the doc comment at `signaling.ts:82-85` says exactly this).

**Over-declared union members (finding) — `BrowserErrorCode` over-states the wire contract by 2 members:**

- **`UNAUTHORIZED`** — appears **0 times** in `apps/server/src/routes/ws.ts`. A rejected/expired/consumed WS ticket is an **HTTP 401 at the upgrade** (`routes/ws.ts:650-663`), never a frame. `UNAUTHORIZED` is an HTTP-only code (`middleware/auth.ts:12,17,53`).
- **`TICKET_EXPIRED`** — never emitted by the server (same 401-at-upgrade path) and never read by any client.

The browser socket's **actual** emit-set is exactly `{MALFORMED_JSON, VALIDATION_ERROR, NOT_FOUND, SESSION_TERMINATED, INTERNAL_SERVER_ERROR}` (`routes/ws.ts:413,425,433,439,468,488,493,499,536` via `sendError`/`send`, plus `routes/sessions.ts:148-150`), i.e. **5 of the 7 declared members**. The agent socket's emit-set (`routes/ws.ts:1013,1023,1030,1054,1062,1076,1083,1091` in `handleInboundMessage`) is exactly its 5 declared members — `AgentErrorCode` is accurate, no over-declaration. G2 **SHOULD** remove the two over-declared browser members or mark them reserved; leaving them silently in the union is the kind of drift this standard exists to stop.

### 5.4 Drift to fix (D6)

- TS `ApiError.details` is `unknown` (`errors.ts:10`) — correct, accepts anything.
- Server `details` is an object or `null` (`error.ts`; `login-rate-limit.ts` sends `{ retryAfter }`).
- Rust `DevicesError.details` is `Option<String>` (`apps/desktop/src/core/devices.rs:99-104`) — **wrong**: an object payload fails to deserialize.
- **Rule:** any Rust mirror **MUST** use `Option<serde_json::Value>` (RS-2). The Electron migration deletes the offending struct, but the rule stands for the shared module.

### 5.5 WS close codes (signaling)

Server closes on: `4401` bad identity (`ws.ts:931,946,953,976,989`), `4409` replaced by a newer connection (`ws.ts:815`), `4408` pong timeout (`ws.ts:747`). The agent's terminal/transient verdict keys on `4401`/`4409` (`signal.rs:298-303`).

---

## 6. Enforcement (CI gates)

A gate that has never been seen to fail is not a gate. Each gate below carries a **seed-fail obligation**: the plan **MUST** prove the gate exits non-zero on a seeded violation and zero on clean `main`.

### 6.1 TypeScript gate — no raw `fetch` in app code

- **Form (owner decision, §2.7):** a **vitest source-scan guard test**, not a shell `grep` step.
- **Placement:** the test lives in the app/package tree and runs in the existing gating test step of `ci-node.yml`.
- **Rule:** the test reads app source files and fails (naming the offending `file:line`) if any direct `fetch(`/`axios` call against a backend endpoint is found. Allow-list: `apps/server/**`, `packages/webrtc-core/src/ws-ticket.ts`, `packages/webrtc-core/src/transport.ts` (both use an **injected** `fetch`).
- **Model to imitate:** the existing source-scanning guard tests read files and regex-assert — e.g. `apps/web/src/__tests__/e2ee-claims.test.ts:1-25`, `apps/web/src/__tests__/sonner-styles.test.ts:12-17`.

### 6.2 Rust gate — API access goes through the shared module

- **Placement:** `.github/workflows/build-agent.yml`, job `verify`, **immediately after** `Check formatting` and **before** `Lint`, so it fails fast. The job already runs in `apps/agent` and is path-filtered to `apps/agent/**` — no new trigger needed.
- **Rule:** in `apps/agent/src`, forbid (a) an ad-hoc server-error envelope outside `src/api.rs`, keyed on the envelope's distinguishing field `details` (the field has **zero** occurrences in agent source today, so it is the envelope's identity — a `struct …Error` *name* is not, because `src/files.rs:214 pub struct FilesError` is a legitimate file-transfer type carrying no `error`/`code`/`details` triple); (b) any hand-rolled HTTP-client dependency (`reqwest::`, `hyper::Client`, `ureq::`) anywhere in agent source (RS-1); and (c) string-literal server URLs (`"http(s)://…"`, `"ws(s)://…"`) outside `src/main.rs` and `src/api.rs`. Allow-list: `src/api.rs` (the shared module itself — including its unit tests, which must carry literal URLs to pin the scheme rewrite, since URL-3 *is* a rewrite) and `src/main.rs:29` (the single clap `default_value`).
- **Verified today:** `apps/agent/src` has **exactly one** literal URL (`main.rs:29`), **zero** occurrences of the envelope field `details`, and **no** `reqwest`/`hyper`/`ureq`, so the gate passes clean on `main` — as designed. (The verbatim `struct …Error` shape would **not** pass clean: `src/files.rs:214` is legitimate — hence rule (a) keys on the `details` field instead. After G3 lands, `src/api.rs` adds literal URLs in its own tests; the two-file allow-list above covers them.)
- **Model to imitate:** the deny-list dependency guard `cargo tree --locked | grep -Ei …` in `build-desktop.yml:126-135`.

---

## 7. Drift Fix (D5) — Electron migration spec

`docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md` states the Electron main process calls the backend "via `@ponter/desktop-core` HTTP" (lines 78, 104, 105, 153, 154). **This is wrong.** `@ponter/desktop-core` (`packages/desktop-core/src/index.ts`, deps `@ponter/shared` + `@ponter/webrtc-core`) is a **WebRTC-only** client (`DesktopClient`). The HTTP client is **`@ponter/api-client`**.

**Action:** correct those five references to `@ponter/api-client`. This is a one-line-per-site docs edit owned by the Electron-migration docs cycle (sub-project F / B), not by this spec. This spec records the correction so it is not lost.

---

## 8. Sequencing vs Sub-projects A–F

| Slice | Scope | Can start | Blocked by |
|---|---|---|---|
| **G1** | This spec (ADR-89) + owner approval | done | — |
| **G2** | TS consolidation: ship the `createApiClient({ baseUrl, storage })` factory (§2.8, TS-3); collapse `FleetSocket` ↔ `WebSocketSignalTransport` into one backoff base (keeping the divergence as config, §2.9); a shared base-URL resolver where feasible; the vitest TS gate (§6.1) | after G1 **and** after sub-project A merges | A touches `apps/web` |
| **G3** | Rust shared module `ponter_agent::api` (base-URL/WS-URL rewrite, `with_bearer`, `ApiError` mirror, `is_auth_fatal`) + the Rust gate | now (after G1) | — |
| **G4** | Electron main wiring to `@ponter/api-client` (safeStorage/IPC token adapter + config-store base URL) | — | folds into sub-project B |
| **G5** | Enforcement gates (part of G2/G3, listed separately for tracking) | with G2/G3 | — |
| **G6** | Docs: ARCHITECTURE ADR-89 entry + §8 trail | after the code lands | G2/G3 |

**G3 note:** the agent has no HTTP today, so G3 delivers the module's **WS/URL/auth** half plus the error type, and lands the gate. The HTTP half is written for future use (RS-3).

---

## 9. Resolved Decisions (owner, 2026-10-14)

All four questions raised in the draft were decided by the owner on 2026-10-14:

1. **ADR number → ADR-89.** The Electron migration keeps ADR-85..88; this standard is ADR-89. No provisional numbering remains.
2. **TS gate form → vitest source-scan guard test** (modelled on `apps/web/src/__tests__/e2ee-claims.test.ts`), not a shell `grep` step. See §6.1.
3. **`createApiClient` factory → ships in G2**, not deferred until the Electron main process needs it. See §2.8, TS-3, §8.
4. **`FleetSocket` backoff divergence → kept**, expressed as configuration of the shared base (§3.5 WS-2), not removed. See §2.9.

With these resolved, the spec is approved and ready for implementation planning (§8).

---

## 10. Out of Scope

- The server's own implementation (it is the contract's source; this standard consumes it).
- The `apps/desktop` Rust `reqwest` client (deleted by the Electron migration).
- `apps/mobile` — an empty stub (`package.json` only, no source).
- The Electron migration itself (sub-project B) and the shared design layer (sub-project A) beyond the sequencing above.
- Changing any wire protocol (signaling, WebRTC, E2EE, file transfer).
- Code generation of clients from the server contract.

---

## 11. Risks & Trade-offs

- **A shared Rust module with no HTTP consumer yet** could look speculative. Mitigated: the WS/URL/auth half is live (the agent's URL derivation and error classification exist today), and the gate is what makes the boundary real.
- **The TS gate may flag legitimate injected-`fetch` helpers.** Mitigated by an explicit, small allow-list in §3.1 / §6.1.
- **Collapsing the two WS backoffs (WS-2) risks changing fleet behavior.** Mitigated by preserving the divergence as configuration, not by deleting it.
- **ADR-number collision** if the Electron spec and this spec merge out of order. **Resolved:** the owner fixed ADR-89 (§9.1), so the number is settled regardless of merge order.
