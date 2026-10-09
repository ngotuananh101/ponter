# Detailed Implementation Plan — FE WebSocket Signaling (repo /mnt/Data/Ponta/remote-platform)

> Verified code context: pnpm + Turborepo monorepo (Node.js 24). Self-hosted Docker backend (`apps/server`, Hono + `ws` + SQLite), Vue 3 SPA frontend on Cloudflare Workers Static Assets (deployed via `wrangler deploy`). Rust agent (`apps/agent`) unmodified. Current state of `RESTPollingTransport` + `POST /api/signal/{offer,answer,ice-candidate}` + `GET /api/signal/poll/:sessionId`: `rowid` is used for internal ordering, wire cursor is the UUID `id` of the last signal (server maps `id`→`rowid` — matching REST polling semantics). References: `apps/server/src/routes/ws.ts:22` (`agentConnections` Map), `index.ts:109-118` (only matches `/api/ws/agent`, destroys remaining requests), `jwt.ts:38-45` (`TokenPayload` without `scope`), `auth.ts:52-103` (`verifyTokenForUser` only checks `type`), `app.ts:16-27` (inline `CORS_ORIGIN` parsing), `signal.ts:231-247` (`replay rowid > afterId` pattern), `terminal.ts:41-116` (hardcoded `RESTPollingTransport`, no flag).

## Table of Contents

1. [Summary](#1-summary)
2. [Context & Objectives](#2-context--objectives)
3. [Design Decisions](#3-design-decisions)
4. [Protocol Specification (Bidirectional JSON Envelope)](#4-protocol-specification-bidirectional-json-envelope)
5. [Implementation Phases](#5-implementation-phases)
   - [P1 — Server: ticket endpoint + browser WS + subscribe/replay + pushToBrowser + notify SESSION_TERMINATED + keepalive + tests](#p1--server)
   - [P2 — Shared: BrowserSocketMessage types + export](#p2--shared)
   - [P3 — FE: WebSocketSignalTransport + reconnect + fallback + flag + unit tests](#p3--fe)
   - [P4 — E2E WS variant + docs + infra](#p4--e2e-ws-variant--docs--infra-proxydocker)
   - [P5 — Rollout (server first, flag OFF → global flip → measurement → decision)](#p5--rollout)
6. [Integrated Red-Team Fixes](#6-integrated-red-team-fixes-re-verified-by-plan-critic)
7. [Risks](#7-risks)
8. [Rollback](#8-rollback)
9. [Open Questions](#9-open-questions)
10. [Appendix: Merge Checklist / Production Flag Activation Checklist](#10-appendix-merge-checklist--production-flag-activation-checklist)

## 1. Summary

Replace `RESTPollingTransport` (polling 200ms–2000ms) with `WebSocketSignalTransport` for browser↔server WebRTC signaling behind the `VITE_BROWSER_WS_SIGNALING` feature flag (default OFF), retaining REST as fallback. The server adds `POST /api/ws/ticket` (single-use ticket with 15s TTL) + `/api/ws/browser` endpoint (subscribe/replay/push/keepalive). The Rust agent and `PeerConnection` remain unchanged. 5 phases: P1 server → P2 shared types → P3 FE transport → P4 E2E + infra → P5 rollout. The plan has undergone verification across 5 code regions + red-teaming across 3 lenses + plan-critic cross-referencing against real code.

## 2. Context & Objectives

### Why Eliminate Polling
Polling (`RESTPollingTransport` polling 200ms–2000ms) creates signal delivery latency ≥ 200ms, and server load scales linearly with the number of active sessions. WebSocket provides near-instantaneous delivery (sub-millisecond push using a pattern similar to `pushToAgent`) and decreases request volume.

### Scope
- **In Scope:** Server WS browser path, ticket endpoint, FE transport, shared types, tests, rollout.
- **Out of Scope:** Rust agent (`apps/agent`), `PeerConnection/connection.ts` (preserves existing `SignalTransport` interface), REST endpoints (retained as formal fallback).

### Design Constraints
- 1 WS connection per signaling session (per `PeerConnection` — i.e. per `agentId` per page load). Multiple tabs → each tab maintains its own WS for its respective session; server fans out via `browserConnections: Map<userId, Set<BrowserConnection>>`.
- Wire cursor = UUID `id` of the last signal (identical to REST polling). `rowid` is used exclusively in internal SQL ordering: `ORDER BY rowid ASC` + `rowid > COALESCE((SELECT rowid FROM signals WHERE id=afterId AND session_id=sessionId), 0)` — replicated from `signal.ts:231-247`.
- REST polling remains fully functional and is only engaged when falling back from WS.

## 3. Design Decisions

### D1. 1 WS per Signaling Session (Per PeerConnection), No Multiplexing Across Sessions on One Socket
- **Rationale:** `terminal.ts:41` creates 1 `PeerConnection` (→ 1 transport) for each `agentId` per page load; the transport maintains 1 `sessionId`. Each tab represents an isolated page load → each tab maintains its own WS for its session. Server-side fan-out across tabs is handled via `Map<userId, Set<BrowserConnection>>`.
- **Rejected Alternative:** Multiplexing multiple `sessionId`s on 1 WS per tab (with `BroadcastChannel` for tab sharing) — significantly higher complexity, unnecessary at current scale; preserving "1 socket ↔ 1 session" maps directly to the `SignalTransport` interface.

### D2. Single-Use Ticket with 15s TTL (Reduced from Original 30s Design)
- **Rationale:** The browser WebSocket API cannot set an `Authorization` header → token must pass via query string. A short TTL reduces exposure risk in proxy access logs. Single-use enforcement (in-memory `jti` registry) narrows the replay window.
- **Actual Endpoint:** `POST /api/ws/ticket` — mount a dedicated lightweight Hono router exported from `routes/ws.ts` (`wsTicketRouter`) into `app.ts` at `/api/ws`. Note: DO NOT place inside `routes/auth.ts` because that router is mounted at `/api/auth` (which would result in `/api/auth/ws/ticket`); preserving the designed path requires a dedicated router.
- **Single-Use Registry:** New module `apps/server/src/utils/ws-ticket.ts` — `registerWsTicket(jti, exp)` called at mint time; `consumeWsTicket(jti): boolean` called at upgrade time (true if valid and marked consumed; false if already used, expired, or non-existent). Lazy cleanup of expired entries on each register/consume call. In-memory storage is acceptable because the architecture is single-replica (see D1/Risks).
- **Rejected Alternative:** Cookie-based auth for WS — impractical because the server is self-hosted, and cookies require complex `Secure; SameSite` configurations; `?ticket=` in query string conforms to standard W3C WebSocket API practice. Subprotocol header (`Sec-WebSocket-Protocol`) avoids access logs but introduces `handleProtocols` complexity — left as an open question.

### D3. Internal Ordering via SQLite `rowid`; Wire Cursor = UUID `id`
- **Rationale:** `signals.id` is `crypto.randomUUID()` (TEXT PK, `signals.ts:92`), non-monotonic and unsuitable for `ORDER BY`. `rowid` is a 64-bit auto-increment, strictly monotonic 1:1 per row — used for `ORDER BY rowid ASC` and `rowid > COALESCE((SELECT rowid FROM signals WHERE id = ? AND session_id = ?), 0)` (mirroring the exact REST poll pattern from `signal.ts:231-247`). The wire cursor remains the UUID `id` of the last signal (identical to REST poll); the server maps it to `rowid` internally. `rowid` is NEVER sent on the wire.
- **Rejected Alternative:** Sending `rowid` over the wire as cursor — forces the frontend to read cursors differently than REST without benefit; `id` preserves consistency with REST polling.

### D4. Replay LIMIT 200 + `hasMore` Flag
- **Rationale:** Prevents WS queue saturation when a browser is offline for an extended duration. Matches REST maximum limit of 200 (`signal.ts:210`).
- **Rejected Alternative:** No limit — risk of memory exhaustion and event loop blocking.

### D5. Atomic Subscribe: `replaying → live` State Machine + Buffer + Dedup by Signal ID
- **Rationale:** Guarantees delivery ordering between replay and live stream. During replay (async DB execution), live pushes for the session are **buffered** rather than dispatched immediately; after replay, the buffer is flushed, **discarding frames whose `id` already exists in the replay batch** (dedup by UUID `id`, eliminating the need for `rowid` in the live path).
- **Implication:** NO requirement for `lastDeliveredRowid` on live push, thus NO need to query the `rowid` of newly inserted signals (`recordSignal().returning()` does not include `rowid` — `SignalSelect` does not contain it). `rowid` appears exclusively in internal replay SQL queries.
- **Rejected Alternative:** (a) Omitting this step — race between replay and live causes out-of-order delivery (WebRTC state machine is order-sensitive). (b) Deduplicating by `rowid` for each live push — requires querying `SELECT rowid` on every signal, which is unnecessary because ID set deduplication across the replay window is sufficient.

### D6. Outbound Queue Contains ONLY Unsent Signals; Flushed After Re-subscribe
- **Rationale:** `send()` while WS is not yet open (CONNECTING or reconnecting) → pushed to queue. Signals already dispatched via `ws.send()` while OPEN are fire-and-forget (identical to current REST POST) — NOT queued, preventing duplicate re-transmission → **cannot generate duplicates server-side**. The queue persists across closures (containing only unsent signals) and is flushed immediately after re-sending `subscribe` on the subsequent reconnect.
- **Rejected Alternative:** (a) Clearing queue on close — drops client signals generated during disconnection (server replay cannot recover them because they never reached the DB). (b) Re-sending all previously sent signals — duplicates signals server-side (server lacks inbound deduplication; client would rely on agent-side guards like `duplicate-signals.test.ts`).

### D7. Origin Check (CSWSH Protection)
- **Rationale:** `?ticket=` resides in query string without native CORS protection on WebSockets. A malicious external site could open a WS to `/api/ws/browser?ticket=<stolen>`. Origin check compares against `CORS_ORIGIN` (parsed identically to `app.ts:16-27`).
- **Rejected Alternative:** Omitting Origin check — red-team flagged as CSWSH vulnerability.

### D8. Liveness via Protocol-Level `ws.ping()` (30s) + Pong Watchdog (90s)
- **Rationale:** Browsers **automatically respond with pong at the protocol level** (RFC 6455) — independent of JavaScript execution, avoiding background tab throttling (unlike application-level `{type:'ping'}` which requires JS execution). Server issues `ws.ping()` every 30s, tracking the `'pong'` event; exceeding 90s without pong triggers `close(4408)`.
- **Application-level frames** `{type:'ping'}` from client are still accepted (server replies `{type:'pong'}`) — preserving compatibility with the agent pattern; however, this is not required for connection liveness.
- **Why application-level ping is not primary:** Client would need its own `setInterval` + response logic, and browser tab background throttling causes false disconnects. `ws` does not have a built-in `pingInterval` on server, so a server `setInterval` is used — server timers are never throttled.
- **Injectable intervals/timeouts** (via factory options) enable rapid testing without waiting 90s.

### D9. Graceful Shutdown (SIGTERM Handler)
- **Rationale:** `index.ts:166` currently lacks signal handlers. Docker stop issues SIGTERM → abrupt process termination → loss of in-process Maps. Graceful shutdown: reject new upgrade requests, close existing WebSockets with code 1001, flush DB, and exit.
- **Rejected Alternative:** Non-graceful shutdown — triggers severe reconnect storms and loses `SESSION_TERMINATED` push notifications.

### D10. Fallback Mechanism
- **Rationale:** If WS fails to connect → fall back to `RESTPollingTransport` (existing code). `WebSocketSignalTransport` exposes a `fallback?: SignalTransport` option.
- **Rejected Alternative:** Infinite WS retry — poor UX, lacks DB-backed fallback.

### D11. Feature Flag Default OFF
- **Rationale:** Safe rollout. `terminal.ts` selects transport based on `VITE_BROWSER_WS_SIGNALING`.
- **Rejected Alternative:** Default ON — risk of regression for all users.

### D12. Scope Separation: Ticket Uses JWT_SECRET with Guard Preventing REST Acceptance
- **Rationale:** `TokenPayload` currently lacks `scope` (`jwt.ts:38-45`). Ticket carries `type='access'` + `scope='ws-ticket'`. `authMiddleware` rejects tokens with `scope='ws-ticket'` (after `verifyTokenForUser`). The `verifyWsTicket` helper checks scope independently.
- **Mandatory Bidirectional Guard:** Missing guard in `authMiddleware` allows ws-tickets to function as access tokens (privilege escalation); missing check in `verifyWsTicket` allows standard 15-minute access tokens to serve as tickets. This is a mandatory implementation step, not optional.
- **Rejected Alternative:** Dedicated secret for tickets (`WS_TICKET_SECRET`) — red-team determined option (a) is sufficiently secure while avoiding a new environment secret.

### D13. Stale Cursor (Signal Pruned by Cleanup) → Time-Bound Replay, NOT Replay from Scratch
- **Rationale:** Cleanup prunes signals past their 5-minute TTL every 15 minutes (`cleanup.ts:43-46`). If using `COALESCE(...,0)` like REST poll, a cursor pointing to a deleted row would replay ALL remaining signals for the session from the beginning. In REST polling this is benign (client discards old signals); in WS replay, this wastes resources and may inject stale signals into the state machine.
- **Resolution:** The WS replay query adds `created_at > datetime('now', '-5 minutes')` (matching `SIGNAL_TTL`) — replaying at most the last 5 minutes; if the cursor cannot resolve to a rowid, replay remains time-bounded. Log warning when cursor is stale. Client treats `subscribed.hasMore=false` + absence of older signals as normal.
- **Rejected Alternative:** Rejecting subscribe on stale cursor — breaks reconnection when most needed; if session is dead, `SESSION_TERMINATED` arrives via live push.

## 4. Protocol Specification (Bidirectional JSON Envelope)

### Frame Size Limit
- 256KB (`MAX_INBOUND_FRAME_BYTES = 256*1024` in `ws.ts:13`). Applied to browser WS inbound messages (enforced pre-parsing).

### Client → Server (BrowserSocketMessage C->S)

| Type | Data | Description |
|------|------|-------------|
| `subscribe` | `{sessionId: string, after?: string\|null}` | Register subscription. `after` = UUID of last received signal id (null = initial subscribe). |
| `signal` | `SignalMessage` | Forward signal to agent via `pushToAgent`. |
| `ping` | — | Client→server heartbeat. |

```json
{"type":"subscribe","data":{"sessionId":"sess_123","after":"sig_abc"}}
{"type":"signal","data":{"type":"offer","data":{"sessionId":"sess_123","sdp":"...","capabilities":["terminal"]}}}
{"type":"ping"}
```

### Server → Client (BrowserSocketMessage S->C)

| Type | Data | Description |
|------|------|-------------|
| `pong` | — | Reply to client ping (application-level, optional). |
| `signal` | `{data: SignalMessage, id: string}` | Replayed from DB or live push. `id` = UUID signal id — client stores as cursor (`lastCursor = id`). |
| `subscribed` | `{sessionId: string, after: string\|null, hasMore: boolean}` | Ack following replay. `hasMore=true` → client sends subsequent `subscribe` with `after` set to last received id. |
| `error` | `{code: BrowserErrorCode}` | Error indication (auth, not found, terminated, etc.). |

```json
{"type":"pong"}
{"type":"signal","data":{"type":"offer","data":{"sessionId":"sess_123","sdp":"...","capabilities":["terminal"]}},"id":"sig_abc"}
{"type":"subscribed","data":{"sessionId":"sess_123","after":"sig_abc","hasMore":false}}
{"type":"error","code":"SESSION_TERMINATED"}
```

**Envelope Notes:** Follows the established `AgentSocketMessage` pattern — `pong`/`error`/`subscribed` place `code`/`data` at the top level (not wrapped in `data`). `signal` retains `{type, data, id}` as in the original design. `rowid` NEVER appears on the wire (used only in internal server SQL).

### BrowserErrorCode
- `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `TICKET_EXPIRED`, `SESSION_TERMINATED`, `INTERNAL_SERVER_ERROR`
- Current `AgentErrorCode` lacks `SESSION_TERMINATED` — added specifically for browser.

### Close Codes
- `4401` — Unauthorized (ticket invalid/expired/wrong scope, Origin mismatch).
- `4408` — Timeout (server ping received no pong within 90s).
- `4409` — Replaced (not used for browser, agent only).

### Subscribe → Replay → Live Flow (Sequence)
```
1. Browser sends subscribe{sessionId, after}
2. Server: validate session.userId == ticket.sub
3. Server: register subscription + set session state = 'replaying'
   (live pushes for this session are BUFFERED, not sent immediately)
4. Server: replay SQL:
     SELECT id, session_id, type, payload, created_at FROM signals
     WHERE session_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND created_at > datetime('now', '-5 minutes')      -- time-bound, prevents stale cursor loop
       AND rowid > COALESCE((SELECT rowid FROM signals WHERE id = ? AND session_id = ?), 0)
     ORDER BY rowid ASC LIMIT 200
5. Server: send each signal S->C {type:signal, data, id}
6. Server: flush buffer — send buffered frames whose id is NOT YET in replay batch (dedup by id)
7. Server: set session state = 'live'
8. Server: send {type:subscribed, data:{sessionId, after:lastId, hasMore}}
9. Live push from here on: pushToBrowser sends directly
```
If `hasMore=true` (replay hit LIMIT 200): client sends another `subscribe` with `after` set to the last received id; server repeats steps 3-8 for the next page.

### Reconnect Flow
```
1. WS closes (network drop / server restart)
2. Transport: retains outbound queue (contains only unsent signals)
3. Transport: fetch fresh ticket (401 → refresh once → retry ticket once)
4. Transport: open WS ?ticket=
5. Transport: send subscribe{after: lastCursor} (lastCursor = UUID of last received signal id)
6. Server: replay missed signals (rowid > map(after), time-bound 5 min) → subscribed ack
7. Transport: flush outbound queue (signals created during disconnection)
8. Transport: resume live push
Backoff: 200ms → 2000ms exponential + jitter ±50ms. Max 5 retries → fallback to REST.
```

## 5. Implementation Phases

### P1 — Server: ticket endpoint + browser WS + subscribe/replay + pushToBrowser + notify SESSION_TERMINATED + keepalive + tests

**Goal:** Server ready to accept browser WebSockets, issue tickets, push signals to browser, and notify on session termination.

**Files:**
- `apps/server/src/utils/jwt.ts` — add `scope?: string` to `TokenPayload`, add `signWsTicket()`.
- `apps/server/src/utils/auth.ts` — add `verifyWsTicket()`.
- `apps/server/src/utils/ws-ticket.ts` (NEW) — in-memory single-use registry `registerWsTicket()` / `consumeWsTicket()`.
- `apps/server/src/utils/env.ts` (NEW) — extract `getJwtSecret()` / `getRefreshSecret()` (previously private in `routes/auth.ts:23-40`).
- `apps/server/src/middleware/auth.ts` — add guard rejecting `scope === 'ws-ticket'`.
- `apps/server/src/utils/cors.ts` (NEW) — extract `getAllowedOrigins()`.
- `apps/server/src/routes/ws.ts` — `browserConnections` Map, `BrowserConnection` interface, `wsTicketRouter` (mint endpoint), `handleBrowserUpgrade`, `pushToBrowser`, browser message handler, keepalive.
- `apps/server/src/app.ts` — mount `wsTicketRouter` at `/api/ws` (effective path: `POST /api/ws/ticket`).
- `apps/server/src/routes/auth.ts` — import `getJwtSecret` from `utils/env.ts` (replacing private implementation).
- `apps/server/src/index.ts` — add upgrade handler for `/api/ws/browser`, graceful shutdown.
- `apps/server/test/ws-browser.test.ts` (NEW) — browser WS tests.

**Steps:**
1. `jwt.ts:38-45`: add `scope?: string` to `TokenPayload`. Create `signWsTicket(userId, username, secret, expiresInSeconds=15)` — mirrors shape of `signAccessToken` (returns `{ticket, jti, exp}` so caller can register in single-use registry):
   ```typescript
   export async function signWsTicket(
     userId: string, username: string, secret: string, expiresInSeconds = 15,
   ): Promise<{ ticket: string; jti: string; exp: number }> {
     const jti = crypto.randomUUID();
     const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
     const payload: TokenPayload = {
       sub: userId, username, type: 'access', scope: 'ws-ticket', jti, exp,
     };
     return { ticket: await sign(payload, secret), jti, exp };
   }
   ```
2. `utils/env.ts` (NEW): move `getJwtSecret()` + `getRefreshSecret()` from `routes/auth.ts` here, export; `routes/auth.ts` re-imports (behavior unchanged).
3. `utils/ws-ticket.ts` (NEW): in-memory single-use registry:
   ```typescript
   const tickets = new Map<string, number>(); // jti -> expiresAtMs
   export function registerWsTicket(jti: string, ttlMs = 15_000): void {
     const now = Date.now();
     for (const [k, exp] of tickets) if (exp <= now) tickets.delete(k); // lazy cleanup
     tickets.set(jti, now + ttlMs);
   }
   export function consumeWsTicket(jti: string): boolean {
     const exp = tickets.get(jti);
     if (exp === undefined || exp <= Date.now()) return false;
     tickets.delete(jti); // one-time
     return true;
   }
   ```
4. `utils/auth.ts`: add `verifyWsTicket(rawToken, secret)`:
   ```typescript
   export async function verifyWsTicket(rawToken: string, secret: string): Promise<TokenPayload> {
     const payload = await verifyToken(rawToken, secret);
     if (payload.type !== 'access' || payload.scope !== 'ws-ticket') {
       throw new Error('Invalid ws-ticket');
     }
     return payload;
   }
   ```
5. `middleware/auth.ts:22-51`: after `verifyTokenForUser()` returns `{payload, user}`, add guard (MANDATORY — without this, ws-tickets can act as access tokens):
   ```typescript
   if (payload.scope === 'ws-ticket') {
     throw new AppError('WS ticket rejected by REST', 401, 'UNAUTHORIZED');
   }
   ```
6. `utils/cors.ts` (NEW): extract logic from `app.ts:16-27`:
   ```typescript
   export function getAllowedOrigins(): string[] | '*' {
     const corsOrigin = process.env.CORS_ORIGIN?.trim();
     if (!corsOrigin || corsOrigin === '*') return '*';
     return corsOrigin.split(',').map((o) => o.trim());
   }
   ```
7. `app.ts`: import `getAllowedOrigins` from `utils/cors.ts`, use in CORS middleware. Mount ticket router: `app.route('/api/ws', wsTicketRouter)`.
8. `routes/ws.ts`: `wsTicketRouter` (lightweight Hono instance, `new Hono<AppContext>()`):
   ```typescript
   wsTicketRouter.post('/ticket', authMiddleware, async (c) => {
     const user = c.get('user');
     const { ticket, jti } = await signWsTicket(user.id, user.username, getJwtSecret(), 15);
     registerWsTicket(jti);
     return c.json({ ticket, expiresIn: 15 });
   });
   ```
9. `routes/ws.ts`: add `browserConnections` Map + `BrowserConnection` + `handleBrowserUpgrade` + `pushToBrowser`:
   - `BrowserConnection`: `{ userId, socket, send(data: string), subscriptions: Map<string, Subscription>, lastPongAt: number }` with `Subscription = { state: 'replaying' | 'live', replayedIds: Set<string>, buffer: BrowserSocketMessage[] }`.
   - `browserConnections = new Map<string, Set<BrowserConnection>>()`.
   - `handleBrowserUpgrade(request, socket, head, wss)`: parse `?ticket=` from `request.url` (using `new URL(url, 'http://localhost')`) → `verifyWsTicket(ticket, getJwtSecret())` → `consumeWsTicket(payload.jti)` (false → 401) → Origin check via `getAllowedOrigins()` (allowlist `'*'` → allow; otherwise require `Origin` ∈ allowlist, missing/mismatched → 403) → `wss.handleUpgrade` → register in `browserConnections`. All error branches: write raw HTTP response + `socket.destroy()` (matching `handleAgentUpgrade` pattern, `ws.ts:52-95`).
   - `pushToBrowser(userId, sessionId, msg: BrowserSocketMessage): boolean`: iterate `browserConnections.get(userId)`; for each connection with subscription for sessionId: if `state === 'replaying'` → `buffer.push(msg)`; if `'live'` → `conn.send(JSON.stringify(msg))`. Best-effort, does not throw.
10. `routes/ws.ts` browser message handler (on browser socket): size check pre-parse (`MAX_INBOUND_FRAME_BYTES`), JSON.parse, validate envelope:
    - `subscribe{sessionId, after}`: validate session belongs to `connection.userId` (SELECT id, userId FROM sessions) → create/reset subscription `state='replaying'` → run replay SQL (time-bound 5 min + `LIMIT 201`, trimmed to 200) → send each frame `{type:'signal', data, id}` + record `replayedIds` → flush buffer (skip signal frames with `id` ∈ replayedIds; other `error` frames pass directly) → set `state='live'` (**synchronous, no `await` between flush and state change** — single-threaded, establishing an atomic transition point) → send `{type:'subscribed', data:{sessionId, after:lastId, hasMore}}`.
    - `signal{data}`: parse using existing `parseSignalMessage` → validate session belongs to user + `agentId` matches (identical to `handleInboundMessage` in `ws.ts:245-290`) → `recordSignal` → `pushToAgent` + `pushToBrowser` (skipping echo to sending connection).
    - `ping`: reply with `{type:'pong'}`.
    - Error frame → `{type:'error', code:'VALIDATION_ERROR'|'MALFORMED_JSON'|'NOT_FOUND'}`.
11. `routes/ws.ts:161-183` (agent close handler): update session termination to `.returning({ id: sessions.id, userId: sessions.userId })`, then loop `pushToBrowser(row.userId, row.id, {type:'error', code:'SESSION_TERMINATED'})`.
12. `routes/sessions.ts:116-143` (DELETE): after termination, call `pushToBrowser(user.id, sessionId, {type:'error', code:'SESSION_TERMINATED'})` — imported from `./ws.js`.
13. `routes/ws.ts` keepalive (browser socket only): factory accepts `{ pingIntervalMs = 30_000, pongTimeoutMs = 90_000 }` (injectable for testing). `setInterval` → `socket.ping()`; event `'pong'` updates `lastPongAt`; watchdog verifies `Date.now() - lastPongAt > pongTimeoutMs` → `close(4408)`. Clear interval in close handler + remove from `browserConnections`.
14. `index.ts:109-118`: add branch for `/api/ws/browser` (with/without query) → `handleBrowserUpgrade(...)`; remaining branch executes `socket.destroy()` as before.
15. `index.ts:166-190` (`startServer`): add `process.on('SIGTERM'|'SIGINT')` — `cleanup.stop()`, close all browser+agent sockets with `close(1001, 'Server shutting down')`, `server.close(callback → process.exit(0))`, fallback forced exit after 10s.
16. `routes/ws.ts` after `recordSignal` (around line ~291): `pushToBrowser(session.userId, message.data.sessionId, {type:'signal', data: message, id: inserted.id})` — NO requirement for `rowid` (deduplicated by `id`, see D5).

**Tests:**
- `apps/server/test/ws-browser.test.ts` (matching `startOnEphemeral()` pattern from `signaling.test.ts:61`):
  - Ticket: 401 when Bearer missing; mint succeeds returning `{ticket, expiresIn:15}`.
  - Bidirectional scope separation: REST endpoint rejects ws-ticket (401); `handleBrowserUpgrade` rejects standard access token (401).
  - Single-use: consuming ticket second time → 401. Expired ticket (injected short TTL) → 401.
  - Origin: `CORS_ORIGIN` allowlist + invalid Origin → 403; matching Origin → upgrade succeeds.
  - Subscribe: ownership check (different user → NOT_FOUND); replay in correct rowid order; `hasMore` when > 200; stale cursor (deleted signal) → avoids replay from scratch (time-bound).
  - Agent→browser push: agent dispatches signal via agent WS → browser receives `{type:'signal', id}` immediately (no polling).
  - Buffer/dedup: signal arriving during replay is not delivered twice.
  - SESSION_TERMINATED on agent WS closure + on DELETE session.
  - Keepalive: with short injected `pingIntervalMs`/`pongTimeoutMs` — client failing to pong triggers close with code 4408.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/server test
pnpm --filter @ponter/server typecheck
pnpm lint
```

**Done when:** All browser WS tests pass, typecheck passes, existing agent WS functionality remains intact.

**Commit:** `feat(server): browser WebSocket signaling with ticket auth + replay + push`

### P2 — Shared: BrowserSocketMessage types + export

**Goal:** Provide types for browser WS messages in shared package, imported across server and client.

**Files:**
- `packages/shared/src/types/signaling.ts` — add `BrowserSocketMessage`, `BrowserErrorCode`, `parseBrowserMessage`.
- `packages/shared/src/types/index.ts` — add to existing export block from `./signaling.js` (file uses `export type {...}` — add new types to this block; `parseBrowserMessage` is a function so it is exported via `packages/shared/src/index.ts` which has `export * from './types/index.js'`; do not use `export type` for functions).

**Steps:**
1. `signaling.ts`: add (following file convention — pure types + validators, no runtime imports):
   ```typescript
   export type BrowserErrorCode =
     | 'MALFORMED_JSON' | 'VALIDATION_ERROR' | 'NOT_FOUND'
     | 'UNAUTHORIZED' | 'TICKET_EXPIRED' | 'SESSION_TERMINATED' | 'INTERNAL_SERVER_ERROR';

   /** Client -> Server */
   export type BrowserMessageInit =
     | { type: 'subscribe'; data: { sessionId: string; after?: string | null } }
     | { type: 'signal'; data: SignalMessage }
     | { type: 'ping' };

   /** Server -> Client. Envelope matches AgentSocketMessage pattern. */
   export type BrowserSocketMessage =
     | { type: 'pong' }
     | { type: 'signal'; data: SignalMessage; id: string }
     | { type: 'subscribed'; data: { sessionId: string; after: string | null; hasMore: boolean } }
     | { type: 'error'; code: BrowserErrorCode };

   export function parseBrowserMessage(raw: string): BrowserMessageInit | null { /* JSON.parse + validate type + data shape, mirroring existing parseSignalMessage */ }
   ```
2. `types/index.ts`: add `BrowserSocketMessage`, `BrowserErrorCode`, `BrowserMessageInit` to `export type {...} from './signaling.js'`.
3. `packages/shared/src/index.ts` unchanged (`export * from './types/index.js'` — star export re-exports both functions and types).

**Verification:** `pnpm --filter @ponter/shared typecheck`

**Commit:** `feat(shared): add BrowserSocketMessage + BrowserErrorCode types`

### P3 — FE: WebSocketSignalTransport + reconnect + fallback + flag + unit tests

**Goal:** Implement `SignalTransport` via `WebSocketSignalTransport`, reconnect with exponential backoff + jitter, fall back to REST upon failure, select transport based on feature flag.

**Files:**
- `packages/webrtc-core/src/transport.ts` — add `WebSocketSignalTransport`.
- `packages/webrtc-core/src/index.ts` — export (line 5 automatic).
- `apps/web/src/stores/terminal.ts` — select transport based on feature flag.
- `apps/web/env.d.ts` — add `VITE_BROWSER_WS_SIGNALING`.
- `apps/web/.env.example`, `.env.production.example` — add flag.
- `packages/webrtc-core/test/ws-transport.test.ts` (NEW) — unit tests.

**Steps:**
1. `transport.ts`: add class (following file convention — do not import `import.meta.env`; inject configuration via options):
   ```typescript
   export interface WebSocketSignalTransportOptions {
     baseUrl: string;
     sessionId: string;
     /** Retrieve current access token (to mint ticket). Returns null if unavailable. */
     getToken: () => Promise<string | null>;
     /** Invoked on 401 when minting ticket — refreshes access token, returns null on failure. */
     onUnauthorized?: () => Promise<string | null>;
     /** Enable reconnection (default true). false → test or fallback-only mode. */
     reconnect?: boolean;
     /** Permanently switch to this transport after WS fails N times. */
     fallback?: SignalTransport;
     fetch?: typeof fetch;
     maxRetries?: number; // default 5
   }
   export class WebSocketSignalTransport implements SignalTransport {
     private ws: WebSocket | null = null;
     private pending: SignalMessage[] = [];   // ONLY unsent signals
     private retries = 0;
     private lastCursor: string | null = null; // UUID of last received signal id
     private subscribers: Array<(msg: SignalMessage) => void> = [];
     private activeTransport: SignalTransport | null = null; // set upon fallback
     // ...
   }
   ```
   - `wsUrl()`: `this.opts.baseUrl.replace(/^http/, 'ws')` + `/api/ws/browser?ticket=${encodeURIComponent(ticket)}` — http→ws, https→wss (single expression, no separate option required).
   - `subscribe(handler)`: fetch ticket (`POST ${baseUrl}/api/ws/ticket` with `Authorization: Bearer ${await getToken()}`; 401 → `onUnauthorized()` → retry exactly once, following `withTokenRefresh` pattern from `RESTPollingTransport`, `transport.ts:85-97`) → open WS → on open send `subscribe{sessionId, after: lastCursor}` → on message: `signal` → `lastCursor = id`, fan-out to handlers; `subscribed` → flush `pending`; `error SESSION_TERMINATED` → close + reconnect (or fallback if retries exhausted).
   - `send(msg)`: WS OPEN → `ws.send(JSON.stringify({type:'signal', data:msg}))` (fire-and-forget, not queued); otherwise `pending.push(msg)`.
   - Queue: persists across closures; **flushed after re-sending `subscribe`** on next reconnect; NOT cleared (see D6).
   - Reconnect: `delay = Math.min(200 * 2^retries, 2000) + (Math.random() * 100 - 50)` (jitter ±50ms), `retries++`; `retries > maxRetries` → switch to `fallback` (if provided) via `activeTransport = fallback; fallback.subscribe(handler); flush pending via fallback` — permanently delegating all subsequent `send`/`subscribe` calls to fallback for this session.
   - `close()`: `ws?.close(1000, 'normal')`, clear timers, `activeTransport?.close()`, does not throw.
2. `terminal.ts:53`: select transport:
   ```typescript
   const useWs = import.meta.env.VITE_BROWSER_WS_SIGNALING === 'true';
   const restTransport = () =>
     new RESTPollingTransport({
       baseUrl: apiClient.http.baseUrl,
       sessionId: sessionResp.id,
       token: token ?? '',
       onUnauthorized: async () => apiClient.http.refreshAccessToken(),
     });
   const transport = useWs
     ? new WebSocketSignalTransport({
         baseUrl: apiClient.http.baseUrl,
         sessionId: sessionResp.id,
         getToken: () => tokenStorage.getAccessToken(),
         onUnauthorized: async () => apiClient.http.refreshAccessToken(),
         reconnect: true,
         fallback: restTransport(),
       })
     : restTransport();
   ```
3. `env.d.ts`: `readonly VITE_BROWSER_WS_SIGNALING?: string;` (add to `ImportMetaEnv`, keeping `VITE_API_URL?` intact).
4. `apps/web/.env.example` + `.env.production.example`: add `VITE_BROWSER_WS_SIGNALING=false`.

**Tests:**
- `packages/webrtc-core/test/ws-transport.test.ts` (mock global `WebSocket` + mock fetch; use `vi.useFakeTimers` similar to `transport.test.ts`):
  - Backoff formula: 200→400→800→1600→2000 (cap), jitter within ±50ms.
  - Ticket flow: mint succeeds; 401 → onUnauthorized → retry once; refresh failure → fallback (no infinite loop).
  - Queue: send before open → retained without loss; flush after `subscribed`; signals sent while OPEN never re-transmitted (no duplicates).
  - `lastCursor` updates from `id` in `signal` frame; subsequent subscribe sends matching `after`.
  - Fallback after `maxRetries`: handler delegates to fallback transport, `send` delegates.
  - `close()` is idempotent, does not throw when WS is not yet open.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/webrtc-core run test
pnpm --filter @ponter/web typecheck
pnpm --filter @ponter/web build
```

**Commit:** `feat(webrtc-core): WebSocketSignalTransport with reconnect + fallback`

### P4 — E2E WS variant + docs + infra (proxy/docker)

**Goal:** E2E test running real server + browser WS; proxy and Docker configuration for connection stability; update documentation.

**Files:**
- `packages/webrtc-core/test/e2e/terminal-ws.e2e.test.ts` (NEW) — E2E variant utilizing WS transport.
- `apps/server/src/index.ts` — request log filter `ticket=` → `[REDACTED]` (if logging exists; if no request logging exists, add minimal error logging in `handleBrowserUpgrade` error branches omitting full query string).
- `docker/Caddyfile` — add WS timeout and keepalive configuration.
- `docker/docker-compose.prod.yml`, `docker-compose.tunnel.yml`, `docker-compose.local.yml` — add `stop_grace_period: 15s` for `server` service (Docker defaults to 10s then SIGKILL — insufficient for graceful shutdown D9).
- `docker/docker-compose.tunnel.yml` — cloudflared: mount `config.yml` with `originRequest.maxIdleDuration: 300s` (cannot be configured via env; `tunnel run --token` ignores per-service env settings).
- `docs/guides/deployment.md` — new section: browser WS path, flag, stop_grace_period, tunnel config.

**Steps:**
1. `terminal-ws.e2e.test.ts` — duplicate `terminal.e2e.test.ts` (`test/e2e/terminal.e2e.test.ts:349` instantiates `RESTPollingTransport`), substitute with `WebSocketSignalTransport` (no flag required — E2E specifies directly). Verify: signaling across WS, reconnect after server restart, `SESSION_TERMINATED` received.
2. `Caddyfile` — Caddy 2 automatically handles Upgrade for all paths, but requires explicit timeout. Update site block:
   ```
   {$DOMAIN:localhost} {
       @ws path /api/ws/*
       reverse_proxy @ws server:8787 {
           transport http {
               read_buffer 65536
               keepalive 300s
           }
       }
       reverse_proxy server:8787
   }
   ```
   (Note: `header_regexp ConnectionUpgrade Upgrade` in previous drafts had incorrect syntax — use `path /api/ws/*` matcher.)
3. Request log redaction: if `index.ts`/`app.ts` does not implement request logging, ensure `handleBrowserUpgrade` error logs omit `?ticket=` (log `req.url.split('?')[0]`). If a logger is present, apply filter `ticket=[^&]*` → `ticket=[REDACTED]`.
4. Docker compose: add `stop_grace_period: 15s` under `server` service across all 3 compose files.
5. Cloudflare Tunnel: create `docker/cloudflared/config.yml`:
   ```yaml
   originRequest:
     maxIdleDuration: 300s
   ```
   and in compose change `command: tunnel run` → `command: tunnel --config /etc/cloudflared/config.yml run`, mount `./cloudflared:/etc/cloudflared:ro`. (`TUNNEL_TOKEN` remains sourced from env.)
6. `docs/guides/deployment.md`: add section covering `/api/ws/browser`, `VITE_BROWSER_WS_SIGNALING`, `stop_grace_period`, tunnel `maxIdleDuration`.
7. Manual verification of graceful shutdown: `docker stop` → verify logs show close 1001 and process exit code 0 (no SIGKILL).

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/webrtc-core run test:e2e
pnpm --filter @ponter/server typecheck
# verify compose files syntax
docker compose -f docker/docker-compose.prod.yml config >/dev/null && echo OK
```

**Commit:** `test(e2e): add WebSocket signaling E2E variant + proxy/docker WS config`

### P5 — Rollout (server first, flag OFF → global flip → measurement → decision)

**Goal:** Safe zero-downtime rollout with rollback capability.

**Files:**
- `.github/workflows/deploy.yml` — add `VITE_BROWSER_WS_SIGNALING` env to Build step (around lines ~45-47).
- `apps/web/env.d.ts` + `.env.example` + `.env.production.example` — added in P3.
- `docker/docker-compose.tunnel.yml` — verify single-replica deployment (from P4).

**Steps:**
1. Deploy server P1 (flag OFF) — REST operates as before; browser WS endpoint exists without incoming traffic.
2. **Global flip (decided — no canary percentage):** `VITE_BROWSER_WS_SIGNALING` is build-time → a single bundle applies to all users; percentage canary would require runtime config or Cloudflare gradual deployments (2 versions + version affinity + `run_worker_first`) — disproportionate overhead. Instead: smoke test first (E2E P4 + server P1 deployed with zero traffic) → set `VITE_BROWSER_WS_SIGNALING=true` in Build step of `.github/workflows/deploy.yml` → CI rebuild + `wrangler deploy` → monitor metrics (step 3).
3. Following flip, keep flag ON if: reconnect rate < 1%, SESSION_TERMINATED is not dropped, WS fallback rate < 0.1%. If not met → rollback: reset to `false` + rebuild + redeploy.
4. Measurements: signal delivery latency (target < 10ms WS vs 200-2000ms polling), error rate 4408/4401, reconnect count per session.
5. Decision: retain flag ON if metrics are sound, or revert to OFF and iterate if issues arise.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm lint
grep VITE_BROWSER_WS_SIGNALING .github/workflows/deploy.yml
```

**Commit:** `ci(deploy): add VITE_BROWSER_WS_SIGNALING to deploy workflow`

## 6. Integrated Red-Team Fixes (Re-verified by Plan Critic)

The table below lists each fix and where it is applied in the plan. The "Source" column indicates whether the finding originated from the red-team workflow or from plan-critic / self-inspection.

| Fix | Severity | Code change | Location | Source |
|------|--------|-------------|---------------|-------|
| Token scope separation: `TokenPayload` adds `scope`, `signWsTicket()`, `authMiddleware` rejects `scope='ws-ticket'`, `verifyWsTicket()` | CRITICAL | `jwt.ts`, `utils/auth.ts`, `middleware/auth.ts` | D12 + P1 steps 1,4,5 | red-team + critic |
| **Ticket endpoint mounted at correct path**: dedicated router mounted at `/api/ws` → `POST /api/ws/ticket` (NOT placed in `routes/auth.ts` because mounting at `/api/auth` would yield `/api/auth/ws/ticket`) | CRITICAL | `routes/ws.ts` (`wsTicketRouter`) + `app.ts` | D2 + P1 steps 8,9 | self-check (critic missed) |
| **No `rowid` required for live push**: deduplicated by signal `id` + buffer during replay → `recordSignal().returning()` is sufficient (`SignalSelect` lacks rowid) | CRITICAL | `pushToBrowser` + subscription state machine | D5 + P1 steps 9,10,16 | critic |
| **Consistent cursor semantics**: wire = UUID `id`; `rowid` used exclusively in internal SQL (mapping `id`→`rowid` identically to REST poll) | CRITICAL | protocol spec + replay SQL | D3 + protocol spec | red-team + self-check |
| Origin check on browser WS upgrade (CSWSH) | HIGH | `handleBrowserUpgrade` (allowlist from `getAllowedOrigins()`) | D7 + P1 step 9 | red-team |
| Ticket TTL 15s + single-use (in-memory `jti` registry) + log redaction | HIGH | `utils/ws-ticket.ts`, `handleBrowserUpgrade`, log filter | D2 + P1 steps 3,9 + P4 step 3 | red-team |
| Stale cursor (signal pruned by cleanup) → time-bound replay (5 minutes), avoiding replay from scratch | HIGH | replay SQL (`created_at > datetime('now','-5 minutes')`) | D13 + P1 step 10 | red-team + critic |
| Server-initiated liveness: protocol-level `ws.ping()` (30s) + pong watchdog (90s) (browser replies automatically, avoiding tab throttling) | HIGH | keepalive with injectable intervals | D8 + P1 step 13 | red-team + critic |
| Atomic subscribe: `replaying → live` state machine + buffer + dedup by `id` | HIGH | subscription state machine | D5 + P1 step 10 | red-team |
| Outbound queue contains ONLY unsent signals; flushed after re-subscribe (never cleared, never re-sent) | HIGH | transport queue logic | D6 + P3 step 1 | red-team + critic |
| Graceful SIGTERM handler (`cleanup.stop()`, close 1001, `server.close`, forced exit 10s) | HIGH | `index.ts` signal handler | D9 + P1 step 15 | red-team |
| Docker `stop_grace_period: 15s` (default 10s causes SIGKILL mid-shutdown) | HIGH | 3 compose files | P4 step 4 | critic |
| Caddy WS timeout (`path /api/ws/*` matcher + `transport http { read_buffer 65536; keepalive 300s }`) | HIGH | `docker/Caddyfile` | P4 step 2 | red-team + critic |
| CF Tunnel `originRequest.maxIdleDuration: 300s` via config.yml (cannot be set via env) | HIGH | `docker/cloudflared/config.yml` + compose | P4 step 5 | critic |
| `getToken()` callback instead of static token (access token expires during active session) | MEDIUM | `WebSocketSignalTransportOptions` + `terminal.ts` | P3 steps 1,2 | critic |
| Replay LIMIT 200 + `hasMore` → client requests subsequent page (pagination) | HIGH | replay SQL + `subscribed` frame | D4 + P1 step 10 | red-team |
| SESSION_TERMINATED: `.returning()` on agent close + push on DELETE session | MEDIUM | agent close handler + `routes/sessions.ts` | P1 steps 11,12 | red-team |
| Session ownership verification upon subscribe (`session.userId === payload.sub`) | MEDIUM | browser message handler | P1 step 10 | red-team |
| Feature flag plumbing: `env.d.ts` + `.env.example` + `.env.production.example` + `deploy.yml` | MEDIUM | 4 files | P3 step 3,4 + P5 | critic |
| Multi-tab isolation: each tab maintains dedicated WS, server fans out via `Map<userId, Set<BrowserConnection>>` | MEDIUM | `browserConnections` | D1 + P1 step 9 | red-team |
| `agents.ts:26` shadowing `agentConnections` Map (latent bug, out of scope) | LOW | — | Open question | critic |

## 7. Risks

- **Multi-replica push breakdown:** `browserConnections` Map is in-process. If deployed across multiple replicas, browser A connected via WebSocket to replica-1 while a signal arrives at replica-2 will fail to push. Mitigation: single replica for P1; REST fallback remains multi-replica safe. Current docker-compose deployment is single replica.
- **Reconnect storm:** Server restart → hundreds of browsers reconnecting simultaneously. Mitigation: jitter ±50ms + 2000ms backoff ceiling + max 5 retries + graceful shutdown 1001 (client backs off immediately rather than hammering).
- **Ticket leak via query string:** `?ticket=` appears in proxy access logs. Mitigation: 15s TTL + single-use registry + log filter redaction. (Subprotocol negotiation serves as an alternative if stricter security is needed — open question.)
- **CSWSH:** Malicious page opening WS to `/api/ws/browser?ticket=<stolen>`. Mitigation: Origin allowlist + 15s single-use ticket.
- **Replay/live race condition:** Out-of-order delivery causes WebRTC handshake failure. Mitigation: subscription state machine `replaying → live`, buffer + dedup by ID (D5).
- **Stale cursor following cleanup:** Cursor pointing to pruned signal (5-minute TTL) → time-bound replay, avoiding replay from scratch (D13).
- **Background tab throttling:** JS throttled → avoid application-level ping for liveness; rely on protocol-level `ws.ping()`/pong handled by the browser engine (D8).
- **Memory leak:** `browserConnections` not removed when browser disconnects. Mitigation: close handler cleanup + keepalive watchdog 4408.
- **Unbounded queue growth:** Signals generated during prolonged disconnection → memory bloat. Mitigation: capped backoff + max 5 retries → fallback to REST (queue flushed via REST, preventing unbounded accumulation).
- **In-memory ticket registry accumulation:** Expired entries removed only on subsequent register/consume calls (lazy). Mitigation: lazy cleanup on each register; acceptable at current scale (few tickets/second maximum).

## 8. Rollback

1. **Disable flag:** Set `VITE_BROWSER_WS_SIGNALING=false` (or remove) in `deploy.yml` → CI rebuild + `wrangler deploy` → browser uses `RESTPollingTransport` (existing code path, unmodified). Because the flag is build-time, rollback is all-or-nothing (single deploy for all users).
2. **Server side:** Browser WS endpoint (`/api/ws/browser`) remains active but receives no traffic. No impact on agent WS or REST traffic.
3. **Database:** No schema migrations — only added endpoint and helpers. Rollback = revert commit P1 (no data remediation required).
4. **Deployment ordering:** Server P1 (flag OFF) deployed first → client flag deployed second. Rollback client first (disable flag), server second (safe because endpoint is inert without callers).
5. **Quick revert:** In the event of critical issues post-flip → disable flag (takes effect after subsequent build + deploy, few minutes) + revert commit P1 if server-side defect.

## 9. Open Questions

- **Future multi-replica scaling:** Will Redis Pub/Sub or sticky sessions be required for `browserConnections`? (Currently single-instance, documented.)
- **Percentage canary rollout — decided:** Skip percentage canary (Vite build-time env → percentage canary requires runtime config or Cloudflare gradual deployments; disproportionate overhead). Use global flip via rebuild — see P5 step 2.
- **Ticket passing via subprotocol:** `Sec-WebSocket-Protocol` completely avoids access logs — worth switching if tighter security is demanded?
- **CSP `_headers` on Cloudflare Workers Static Assets:** Add `connect-src wss://...` upon enabling flag? (Currently no CSP configured.)
- **`agents.ts:26` shadowing `agentConnections` Map:** Latent bug (agent list always reports offline) — out of scope for this plan, separate issue recommended.
- **Protocol-level ping for agent WS:** Agent currently uses application-level `{type:'ping'}` — should agent migrate to `ws.ping()` for consistency? (Out of scope.)

## 10. Appendix: Merge Checklist / Production Flag Activation Checklist

### Merge Checklist (P1-P5)
- [ ] `pnpm --filter @ponter/server typecheck` passes
- [ ] `pnpm --filter @ponter/server test` passes (including new `ws-browser.test.ts`)
- [ ] `pnpm --filter @ponter/webrtc-core run test` passes (including new `ws-transport.test.ts`)
- [ ] `pnpm --filter @ponter/webrtc-core run test:e2e` passes (P4)
- [ ] `pnpm --filter @ponter/web build` passes
- [ ] `pnpm lint` passes (repository-wide)
- [ ] Review signoff: bidirectional scope separation (`authMiddleware` guard + `verifyWsTicket`), Origin allowlist, single-use ticket
- [ ] Integration test: agent→browser signal latency < 10ms
- [ ] No regression on REST polling (existing `signaling.test.ts` passes)
- [ ] `docker compose config` valid across all 3 compose files
- [ ] Manual: `docker stop` server → graceful (close 1001, exit 0, no SIGKILL)

### Production Flag Activation Checklist (Global Flip)
- [ ] Deploy server P1 (flag OFF) — verify stability, REST unchanged
- [ ] Smoke test WS path (E2E P4 + manual: ticket → subscribe → signal) prior to flip
- [ ] Set `VITE_BROWSER_WS_SIGNALING=true` in `deploy.yml` → merge → CI rebuild + deploy
- [ ] Post-flip verification: reconnect rate < 1%; SESSION_TERMINATED delivery verified (closing agent displays error immediately in tab); error rate 4408/4401 ≈ 0
- [ ] Fallback REST rate < 0.1%
- [ ] Rollback path verified: revert to `false` + rebuild (all-or-nothing)
- [ ] Once stable: remove flag branching (optional)

<!-- END OF PLAN -->
