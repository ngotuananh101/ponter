# Fleet Push over the Browser WebSocket — Design Spec

- **Status:** Implemented/merged — PR #87 (squash `b87a1c6`)
- **Phase:** Post-Phase-8 hardening (owner Issue 5)
- **Related:** `apps/server/src/routes/ws.ts`, `apps/server/src/routes/agents.ts`, `apps/server/src/routes/devices.ts`, `packages/shared/src/types/signaling.ts`, `apps/web/src/views/DashboardView.vue`, `apps/web/src/stores/`, `packages/webrtc-core/src/transport.ts`, `docs/plans/fe-ws-signaling.md`, `docs/guides/deployment.md` §3.1.

---

## 1. Context & Motivation

The web Dashboard (`apps/web/src/views/DashboardView.vue:126-134`) polls `GET /api/devices` + `GET /api/agents` every 10 s:

```ts
onMounted(() => {
  loadDashboardData();
  pollInterval = setInterval(() => {
    void loadDashboardData(true);
  }, 10000);
});
```

The owner believed an existing socket already reduced this polling. It does **not**. The browser socket at `/api/ws/browser` (`apps/server/src/routes/ws.ts`) is a **signaling-only** channel: every frame it carries is session-scoped (it nests a `SignalMessage` and is fanned out by `pushToBrowser(userId, sessionId, msg)` against a `sessionId` subscription). The server has **no** fleet/agent/device push surface:

- `GET /api/agents` computes `isOnline` per request from `agentConnections.has(agent.id)` (`apps/server/src/routes/agents.ts:28`).
- `pushToBrowser` is only ever called with session-scoped frames (`ws.ts:528,899`; `sessions.ts:147`).
- There is no single shared browser socket: each `WebSocketSignalTransport` (`packages/webrtc-core/src/transport.ts`) opens its **own** `/api/ws/browser` connection for one session. The Dashboard, which has no session, has nothing to listen to.

**Goal:** add a **fleet push** over the *existing* browser WebSocket endpoint and have the Dashboard consume it, keeping a **slow (≈60 s) poll only as a safety net**. Do **not** build a second socket system or an SSE channel: reuse `/api/ws/browser`, its ticket flow, and its JSON envelope, extending the protocol additively with a fleet topic.

---

## 2. Design Decisions (ADR-73 to ADR-77)

### ADR-73: The fleet frame is a coarse `fleet-changed` invalidation, not a snapshot or delta

- **Decision.** The server→browser fleet frame is exactly `{ "type": "fleet-changed" }` — a payload-free invalidation. On receipt, the Dashboard refetches `GET /api/devices` + `GET /api/agents` (the calls it already makes) and re-renders.
- **Why.**
  - **One source of truth.** `GET /api/agents` already computes `isOnline` from live socket presence and serializes each row via `toPublicAgent`. A snapshot/delta payload would duplicate that serialization in a second code path and create a second source of truth that can drift (the classic bug: push says online, REST says offline).
  - **Smallest correct surface.** An invalidation frame has no schema to version, no ordering semantics, no partial-update merge logic. The Dashboard's `loadDashboardData(isBackground=true)` is already idempotent and background-safe (`DashboardView.vue:59-81`), so refetch-on-invalidate is a one-line change.
  - **The data is small and changes rarely.** A user's fleet is a handful of rows; a refetch is cheap. The 60 s poll already bounds staleness; the push only tightens the latency.
- **Rejected alternative — full snapshot per push.** Requires serializing the whole fleet server-side on every connect/disconnect (frequent: an agent reconnect flaps `isOnline` twice) and keeping the browser's rendering merged with a payload that can arrive out of order relative to a REST refetch. More surface, more drift risk, no benefit at this scale.
- **Rejected alternative — typed delta (`{kind: 'agent-online', id}`).** Forces the client to re-implement the server's list semantics (filters, ordering, the `lastPingAt` freshness window) and to reconcile deltas with the poll. Rejected for the same drift reason.

### ADR-74: Fleet subscription is per-connection state on `BrowserConnection`

- **Decision.** Add `fleetSubscribed: boolean` to the `BrowserConnection` interface (`ws.ts:97-105`). Two new client→server frames toggle it: `{ "type": "subscribe-fleet" }` and `{ "type": "unsubscribe-fleet" }`. A connection that never subscribes receives no fleet frames.
- **Why.** Mirrors the existing per-connection `subscriptions: Map<string, BrowserSubscription>` model (`ws.ts:101`). It keeps a terminal-only tab (which never opens the Dashboard) from receiving fleet frames it has no use for, and makes `unsubscribe-fleet` (Dashboard unmount) a first-class, testable operation.
- **Lifecycle.** The flag lives on the connection object, which is already removed from `browserConnections` on socket close (`ws.ts:771-780`). No separate cleanup path is needed.
- **Coalescing (client side).** The Dashboard debounces refetches (≥ 500 ms) so an agent reconnect flap (close→open within a second) causes one refetch, not three. Server-side coalescing is explicitly *not* required (see §7, backpressure).

### ADR-75: `pushFleetToUser(userId)` fans out best-effort to the user's fleet-subscribed sockets

- **Decision.** A new exported helper in `ws.ts`, shaped exactly like `pushToBrowser`'s best-effort loop:

  ```ts
  /**
   * Best-effort fleet invalidation to every fleet-subscribed browser socket of
   * a user. Never throws — a browser mid-disconnect is an ordinary outcome, and
   * the fleet is still correct via the REST poll.
   */
  export function pushFleetToUser(userId: string): number {
    const set = browserConnections.get(userId);
    if (!set) return 0;
    let delivered = 0;
    for (const connection of set) {
      if (!connection.fleetSubscribed) continue;
      try {
        connection.send(JSON.stringify({ type: 'fleet-changed' }));
        delivered += 1;
      } catch {
        // Best-effort: a failing socket must not break the others.
      }
    }
    return delivered;
  }
  ```

- **Why.** Tenancy is **structural**: the fan-out iterates only `browserConnections.get(userId)`, so a fleet frame can never reach another user's socket — the same guarantee `pushToBrowser` already relies on. The per-connection `try/catch` mirrors `pushToBrowser` (`ws.ts:159-168`): one broken socket must not abort the loop.
- **Return value.** A delivered count (rather than `pushToBrowser`'s boolean) so a test can assert fan-out across N sockets; callers ignore it in production.

### ADR-76: The Dashboard consumes the fleet topic through a small dedicated client, gated by `VITE_BROWSER_WS_SIGNALING`

- **Decision.**
  - A new Pinia store `apps/web/src/stores/fleet.ts` owns the fleet socket lifecycle, and a small client `apps/web/src/services/fleet-socket.ts` opens **one** `/api/ws/browser` connection for the fleet topic.
  - The client mints its ticket with `POST /api/ws/ticket` (`Authorization: Bearer <access token>`), opens `GET /api/ws/browser?ticket=…`, sends `{type:'subscribe-fleet'}` on open, and on `fleet-changed` invokes the store's refetch callback.
  - Reconnect reuses the **same** backoff as `WebSocketSignalTransport`: `WS_INITIAL_BACKOFF_MS = 200`, `WS_MAX_BACKOFF_MS = 2000`, ±50 ms CSPRNG jitter (`transport.ts:330-344,678-696`). There is **no** fallback transport — the REST poll *is* the fallback.
  - Fleet push is gated by the **same** `VITE_BROWSER_WS_SIGNALING` flag as signaling (`deploy.yml:53`, default `true`). When the flag is off, the store opens no socket and the Dashboard relies on the 60 s poll alone.
- **Why a dedicated client, not a reuse of `WebSocketSignalTransport`.** `WebSocketSignalTransport` is *session-scoped* by construction: its constructor requires a `sessionId`, it sends `subscribe{sessionId}`, and it maintains load-bearing invariants (signal-id cursor, replay dedup, fallback hand-off) that exist only for signaling. The Dashboard has no session. A ~100-line fleet client that reuses the endpoint, the ticket mint, and the backoff constants is simpler and safer than generalizing a transport whose invariants must not change. This is **not** a second socket system: same endpoint, same ticket flow, same envelope — only new frame types.
- **Why gate on the same flag.** The flag's meaning is "this build may use the browser WebSocket." A deployment that turns it off (e.g., a proxy that refuses upgrades) must not have the Dashboard attempt an upgrade it knows will fail. One switch, one mental model.
- **Rejected alternative — piggyback on a session socket.** The Dashboard is not in a session; there is no socket to piggyback on. (A future refactor could hoist a single shared browser socket for both topics, but that is out of scope and would change signaling's invariants.)

### ADR-77: The wire contract is additive; both frame tables and both parsers must be updated

- **Decision.** Extend the existing unions additively — no existing frame changes:
  - `BrowserMessageInit` (`packages/shared/src/types/signaling.ts:96-101`) gains `{ type: 'subscribe-fleet' }` and `{ type: 'unsubscribe-fleet' }`.
  - `BrowserSocketMessage` (`signaling.ts:104-111`) gains `{ type: 'fleet-changed' }`.
  - `parseBrowserMessage` (`signaling.ts:123-153`) learns the two new client→server types.
  - **`normalizeBrowserFrame` (`ws.ts:343-386`) — the deliberate local mirror — must be updated in lockstep.** The comment at `ws.ts:334-341` explains why the server keeps a local copy (the production image runs `node apps/server/dist/index.js`; a runtime import of shared TS source would fail). A frame type added to one parser and not the other is silently dropped: the shared parser is the client contract, the local mirror is the server gate.
- **Why.** Every existing frame type, envelope convention, and close code is unchanged. A client or server that does not know the fleet frames keeps working exactly as before (it simply never sends or receives them).

---

## 3. Protocol Specification (additive)

### 3.1 Client → Server (new)

| Type | Data | Description |
|---|---|---|
| `subscribe-fleet` | — | Mark this connection fleet-subscribed. Idempotent. |
| `unsubscribe-fleet` | — | Clear the fleet subscription on this connection. Idempotent. |

```json
{"type":"subscribe-fleet"}
{"type":"unsubscribe-fleet"}
```

### 3.2 Server → Client (new)

| Type | Data | Description |
|---|---|---|
| `fleet-changed` | — | The user's fleet (agents and/or devices) changed; refetch the lists. |

```json
{"type":"fleet-changed"}
```

### 3.3 Envelope notes

- Both new client→server frames are **bare** (no `data`), exactly like `{type:'ping'}` — there is no per-subscription parameter. Fleet subscription is per-connection, not per-topic-key.
- `fleet-changed` is **idempotent and order-independent**: it carries no state, so duplicate or reordered deliveries are harmless. This is what makes a coarse invalidation safe on a lossy/reordering-prone reconnect path.
- **No existing frame changes.** `subscribe`, `signal`, `ping`, `pong`, `subscribed`, and `error` keep their exact shapes.

### 3.4 Emit points (server)

`pushFleetToUser(userId)` is called — best-effort, never throwing — at each place the fleet's *observable* state changes:

| Trigger | File:line | Call site |
|---|---|---|
| Agent connects (socket present → `isOnline` true) | `ws.ts:829` / `ws.ts:858-861` | after `agentConnections.set(...)` and the `isOnline: true` update |
| Agent disconnects (socket gone → `isOnline` false) | `ws.ts:874-879` | after `agentConnections.delete(...)` and the `isOnline: false` update |
| Agent created | `agents.ts:32` (`POST /api/agents`) | after the insert, `pushFleetToUser(user.id)` |
| Agent updated | `agents.ts:264` (`PATCH /api/agents/:id`) | after the update (covers `capabilities`/`hostname` changes) |
| Agent deleted | `agents.ts:301` (`DELETE /api/agents/:id`) | after the delete |
| Device created | `devices.ts:25` (`POST /api/devices`) | after the insert (line 80) |
| Device deleted | `devices.ts:85` (`DELETE /api/devices/:id`) | after the delete (line 111) |

- **Why both `agents.ts` and `devices.ts`.** The Dashboard's fleet is the union of `GET /api/agents` and `GET /api/devices` (`DashboardView.vue:65-68`). A push that covered only one would leave the other stale until the poll.
- **Never throws.** Each emit site calls the helper in a way that cannot propagate an error into the request/WS path (the helper's own per-connection `try/catch` plus a defensive no-throw contract). A fleet push is an optimization; it must never fail a registration, a delete, or an agent handshake.

---

## 4. Server changes (summary)

- `packages/shared/src/types/signaling.ts`: add the three frame variants (two init, one socket) and their `parseBrowserMessage` cases.
- `apps/server/src/routes/ws.ts`:
  - `BrowserConnection` gains `fleetSubscribed: boolean` (initialized `false` in `createBrowserWebSocketServer`, `ws.ts:724-734`).
  - `normalizeBrowserFrame` learns `subscribe-fleet` / `unsubscribe-fleet` (mirror update).
  - `handleBrowserMessage` (`ws.ts:407-538`) dispatches the two new frames to set/clear `connection.fleetSubscribed` (no DB access, no sessionId — the connection is already authenticated).
  - New exported `pushFleetToUser(userId)` (ADR-75).
  - Emit calls at the agent connect/close points (ADR-74 table).
- `apps/server/src/routes/agents.ts` and `apps/server/src/routes/devices.ts`: emit calls after create/update/delete.

## 5. Web changes (summary)

- `apps/web/src/services/fleet-socket.ts` (new): mint ticket → open `/api/ws/browser` → `subscribe-fleet` → emit `fleet-changed` to a callback; reconnect with the shared backoff constants; no fallback transport.
- `apps/web/src/stores/fleet.ts` (new): owns the client lifecycle (connect on Dashboard mount when the flag is on, disconnect on unmount), debounces refetch (≥ 500 ms), and exposes a `subscribe(cb)`/`start()`/`stop()` surface.
- `apps/web/src/views/DashboardView.vue`: keep the poll but relax it to ≈60 s; on `fleet-changed` (debounced) call `loadDashboardData(true)`. No change to the REST calls or the rendering.

## 6. Testing strategy

### 6.1 Server unit tests (`apps/server/test/`)

Add to the existing browser-WS suite (`ws-browser.test.ts`) or a focused `ws-fleet.test.ts`, using the established `startOnEphemeral()` harness:

- **Emit on agent connect.** Open a browser socket, `subscribe-fleet`, then connect an agent → the browser receives `fleet-changed`.
- **Emit on agent disconnect.** Connect an agent, subscribe, close the agent → the browser receives `fleet-changed`.
- **Emit on device create/delete** and **agent create/update/delete** (one case per route).
- **Only subscribed connections receive it.** A browser socket that did not send `subscribe-fleet` receives nothing when the fleet changes.
- **`unsubscribe-fleet` stops delivery.** After unsubscribing, a subsequent fleet change delivers nothing to that socket.
- **Tenancy isolation.** A fleet change for user A delivers to A's subscribed socket and **not** to B's subscribed socket (two users, two tickets).
- **`pushFleetToUser` never throws** when a socket is mid-close (assert the other socket still receives).

### 6.2 Web unit tests (`apps/web/src/stores/`)

New `fleet.test.ts` (mirroring `auth.test.ts`'s store-test style):

- Store opens a socket when `VITE_BROWSER_WS_SIGNALING === 'true'` and opens **none** when `'false'`.
- On a `fleet-changed` frame, the refetch callback fires; two rapid frames within the debounce window fire it **once**.
- Reconnect schedules with the shared backoff on an unexpected close, and stops after `stop()`.
- A malformed frame does not throw and does not trigger a refetch.

### 6.3 E2E (optional)

A real-server path (Playwright, like the ADR-49 smoke test) that loads the Dashboard, connects an agent, and asserts the agent's card flips to online **without** waiting for the 60 s poll. Feasible but optional: if the harness cost is high, the server + store unit tests above are the binding coverage, and the E2E is recorded as a manual procedure.

---

## 7. Out of scope, risks, and stop conditions

1. **Multi-replica fan-out (out of scope).** `browserConnections` is an in-process `Map`; with more than one server replica, a fleet change on replica A does not reach a browser connected to replica B. This is the **same single-instance assumption** already recorded in `docs/plans/fe-ws-signaling.md:569` ("Currently single-instance, documented"). Fleet push inherits it. Redis Pub/Sub or sticky sessions are out of scope.
2. **Frame ordering (non-risk).** `fleet-changed` is an invalidation with no payload, so reordering or duplication is harmless (ADR-73). No sequence numbers are needed.
3. **Backpressure (bounded, minor).** A fleet change emits at most one tiny frame per subscribed connection. Because the frame is a few dozen bytes, delivery is best-effort with per-connection `try/catch`, and the 60 s poll is the safety net, no server-side coalescing is required. (If a future workload makes pushes frequent, coalescing per connection — "skip if one is already queued" — is the natural extension, noted here so it is not invented ad hoc later.)
4. **Fleet socket down (poll fallback).** If the socket cannot open or keeps failing, the Dashboard stays correct via the 60 s poll — up to 60 s stale, never wrong. The client keeps retrying with backoff; there is no fallback transport because the poll already is one.
5. **Flag off.** With `VITE_BROWSER_WS_SIGNALING=false`, no fleet socket is opened and the 60 s poll is the sole path — the pre-change behavior, still correct.
6. **Dashboard-only consumer.** The frame is generic (`fleet-changed`), so another view (e.g. a future Agents page) can reuse the store; this spec only wires the Dashboard.

---

## 8. Definition of done

1. Shared + server frame types added; `parseBrowserMessage` and `normalizeBrowserFrame` updated **in lockstep** (ADR-77).
2. `pushFleetToUser` exported and called at all seven emit points; it never throws (test-asserted).
3. `apps/web/src/stores/fleet.ts` + `services/fleet-socket.ts` open, subscribe, reconnect, and refetch-on-invalidate; gated by `VITE_BROWSER_WS_SIGNALING`.
4. `DashboardView` poll relaxed to ≈60 s and wired to the store's refetch.
5. Server unit tests (emit, isolation, unsubscribe, no-throw) and web store tests (flag gate, debounce, reconnect) green; existing WS and signaling tests unchanged and green.
6. No `ui/` file touched (shadcn-vue generated files are off-limits).
7. Docs: `docs/ARCHITECTURE.md` §2.2.1 (Browser Signaling Socket) and §6.5 (Browser WebSocket Protocol) gain the fleet frame rows; `docs/plans/fe-ws-signaling.md` notes the additive fleet topic.
