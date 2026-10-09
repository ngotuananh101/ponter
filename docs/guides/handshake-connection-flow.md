# The Terminal Connection Handshake Flow

A definitive, end-to-end description of how a terminal session is established between the **browser**, the **Node.js signaling server**, and the **Rust agent** in this self-hosted Docker deployment (Node.js 24 + SQLite + Hono + ws; Cloudflare is only the Web UI layer).

---

## 1. Actors and Artifacts

| Role | Component | Key file |
|------|-----------|----------|
| **Operator** | A user at the Web UI (Cloudflare Pages) who clicks an agent in the sidebar | `apps/web/src/views/WorkspaceView.vue` |
| **Offerer / Signaling client (browser side)** | Browser `RTCPeerConnection` + REST polling transport + WebRTC data-channel client + terminal client | `apps/web/src/stores/terminal.ts`, `packages/webrtc-core/src/connection.ts`, `packages/terminal-core/src/client.ts` |
| **Signaling server** | Node.js HTTP (Hono) + WebSocket server, backed by a single SQLite database | `apps/server/src/index.ts`, `apps/server/src/routes/signal.ts`, `apps/server/src/routes/ws.ts`, `apps/server/src/db/client.ts` |
| **Answerer** | Rust agent: WebRTC peer + terminal PTY bridge | `apps/agent/src/lib.rs`, `apps/agent/src/rtc.rs`, `apps/agent/src/pty.rs` |

### Wire artifacts

| Artifact | Where created | On-the-wire shape |
|----------|---------------|-------------------|
| WebRTC session row | `POST /api/sessions` → `apps/server/src/routes/sessions.ts:48` | `id`, `userId`, `agentId`, `status='pending'` |
| Signal envelope | `packages/shared/src/types/signaling.ts:9` (`SignalOffer`) and `:44` (`SignalMessage`) | `{ type: 'offer'\|'answer'\|'ice-candidate', data: {...} }` |
| WebSocket transport envelope (agent socket) | `packages/shared/src/types/signaling.ts:68` | `{ type: 'ping'\|'pong'\|'signal'\|'error', data?: SignalMessage }` |
| ICE-servers frame | `apps/server/src/routes/ws.ts:836` | `{ type: 'ice-servers', data: { iceServers: [...] } }` |
| Data-channel message envelope | `packages/shared/src/types/webrtc.ts:9`, `packages/webrtc-core/src/data-channel.ts:74` | `{ type: <string>, channel: 'terminal', payload: {...}, timestamp: <ms> }` |
| Terminal protocol messages | `packages/shared/src/types/terminal.ts` | `terminal-create`, `terminal-data`, `terminal-resize`, `terminal-close`, `terminal-exit`, `terminal-error` |
| Agent credential | `apps/server/src/utils/agent.ts:62` | `ag_` + 32 hex chars (128-bit CSPRNG) |

---

## 2. The Full Sequence

Numbered steps trace the code path for one terminal tab opening against one agent.

1. **User clicks an agent.** `WorkspaceView.vue:42` calls `terminalStore.openTab(agent.id, agent.hostname || ...)`.

2. **Connection is cached per agent.** `terminal.ts:504` `getOrConnectAgent` returns a cached `PeerConnection + TerminalClient` if one exists for this `agentId`; otherwise it starts a new one (and deduplicates concurrent callers via `pendingConnections` at `:270`).

3. **Session is created.** `getOrConnectAgent` → `apiClient.sessions.create({ agentId })` → `POST /api/sessions` (`sessions.ts:48`). The server resolves the agent within the user's tenancy (`resolveOwnedId`, `:29`), inserts a row with `status='pending'` (`sessions.ts:87`, `status: 'pending'` at `:92`), returns the `sessionId`.

4. **ICE servers are fetched.** `apiClient.webrtc.getIceServers()` → `GET /api/webrtc/ice-servers` (`webrtc.ts:15`). The server calls `buildIceServers(user.id)` (`utils/ice.ts:192`): if `TURN_SECRET` + `TURN_URL` are set, it mints RFC 5766 HMAC-SHA1 credentials (`username = "<expiry>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`, 86400s TTL); otherwise it returns the Google STUN fallback.

5. **Browser RTCPeerConnection is built.** `createBrowserAdapter({ iceServers })` wraps a native `RTCPeerConnection` (`browser.ts`). `new PeerConnection(...)` (`connection.ts:120`) registers:
   - `onIceCandidate` → `createCandidateSignal('', candidate)` → fire-and-forget `transport.send` (`connection.ts:126`). The empty `sessionId` is stamped by the transport at `:148` in `send`.
   - `onDataChannel` → `dataChannels.registerChannel(channel)` (`connection.ts:137`).
   - `onConnectionStateChange` → fan-out to `stateListeners` (`connection.ts:142`).
   - Pre-creates the offerer data channel `terminal` directly on the underlying peer (`connection.ts:161`): `peer.createDataChannel('terminal', { ordered: true })`.

6. **Transport subscribes.** `transport.subscribe(...)` (`connection.ts:167`) starts the REST polling loop on the first subscriber (`subscribe` at `transport.ts:164`).

7. **Offer is created and sent.** `peer.start()` (`terminal.ts:575`) → `peer.createOffer()` → `setLocalDescription` → `createOfferSignal('', offer, ['terminal'])` → `transport.send(signal)`. The transport POSTs `POST /api/signal/offer` with `Bearer <access-token>`, stamping the real `sessionId` (`transport.ts:118`): `body: JSON.stringify({ ...msg.data, sessionId: this.sessionId })`. **The `RESTPollingTransport` holds a bearer token field** (`transport.ts:57`) and refreshes it on 401 via the injected `onUnauthorized` callback, calling `apiClient.http.refreshAccessToken()` (`terminal.ts:388`); `withTokenRefresh` (`:102`) retries exactly once and rethrows the original 401 if the refresh fails. The server validates (`signal.ts:59`), inserts the signal via `recordSignal` (`utils/signals.ts:29`), and fire-and-forget pushes it to the agent's WebSocket (`pushToAgent`, `signal.ts:123`).

  (If `VITE_BROWSER_WS_SIGNALING === 'true'`, `createSignalingTransport` (`terminal.ts:377`) returns a `WebSocketSignalTransport` with the same `onUnauthorized` callback, falling back to REST only if the socket cannot be established. See §4.2.)

8. **ICE candidates trickle (browser → server → agent).** As `RTCPeerConnection` gathers, `onIceCandidate` fires, each candidate is sent as `POST /api/signal/ice-candidate`. The server (`signal.ts:198`) validates the candidate, stores it, and pushes to the agent socket. The browser's transport also polls `GET /api/signal/poll/:sessionId` (`transport.ts:192`) for any signals (including the eventual answer) that were queued while polling started.

9. **Agent WebSocket connection (background, pre-existing).** The Rust agent, started with `--credential ag_…` and `--server ws://host:8787/api/ws/agent` (`main.rs:31`), authenticates during the HTTP upgrade: `handleAgentUpgrade` (`ws.ts:562`) sha-256-hashes the `Authorization: Bearer ag_…` header (`ws.ts:583`) and looks up `agents.credentialHash` (`ws.ts:588`). On failure it writes a raw `HTTP/1.1 401` and `socket.destroy()` (`ws.ts:573`). On success the upgrade completes and the connection handler runs (`ws.ts:803`):
   - Evicts any previous connection for this agent via `previous.socket.close(4409)` (`ws.ts:815`).
   - Stores the socket in `agentConnections` (`ws.ts:829`).
   - **Pushes ICE servers** to the agent: `{ type: 'ice-servers', data: { iceServers: buildIceServers(userId) } }` (`ws.ts:836`). The agent receives this before any offer because it cannot call the user-JWT-protected REST endpoint.
   - Sets `isOnline=true, lastPingAt=NOW` (`ws.ts:860`).
   - Registers a `message` handler → `handleInboundMessage` (`ws.ts:865`).

10. **Agent receives the offer.** `handleInboundMessage` (`ws.ts:1000`) size-checks the frame (`<=256KB`, `:1011`), JSON-parses, validates the envelope shape, and — for a `signal` frame — calls `parseSignalMessage` (`ws.ts:1143`). It looks up the session by id **and** checks both `userId` and `agentId` match the connection's tenancy (`ws.ts:1071`), enforces `pending|active` status (`ws.ts:1081`), stores it via `recordSignal`, then echoes it back: `connection.socket.send({ type:'signal', data: message })` (`ws.ts:1106`). The echo is how the agent correlates the persisted row.

11. **Agent sends the answer (with buffering).** The `SignalClient.run()` loop (`signal.rs:401`) reads inbound frames from the socket stream and forwards them to the `supervise_sessions` loop (`lib.rs:784`). When the supervisor sees an `Offer`, it calls `run_one_session` (`lib.rs:965`):
    - Builds the peer from the pushed ICE servers (`rtc::build_peer`, `rtc.rs:405`).
    - **Registers `on_ice_candidate` BEFORE answering** (`lib.rs:996`) — gathering starts when the local description is set, and the handler must be installed first or host candidates are lost.
    - Calls `rtc::answer_offer` (`rtc.rs:758`): sets remote description to the offer, creates an answer, sets local description, then sends `SignalMessage::Answer { sessionId, sdp, approved }` where `approved = offer.capabilities contains TERMINAL_LABEL` (`rtc.rs:764`).
    - Calls `rtc::flush_pending_candidates` (`rtc.rs:724`) to apply any candidates buffered during the offer-handling race (`rtc.rs:724` is the definition; `lib.rs:1123` is the call site).

12. **Agent receives browser candidates (post-answer).** The browser's trickle arrives as `ice-candidate` signals. The supervisor's `route_inbound` (`lib.rs:2568`) routes them to `rtc::apply_candidate` (`rtc.rs:852`), which buffers them if `remote_description().is_none()` returns true (`rtc.rs:865`) or adds them directly otherwise (`rtc.rs:870`).

13. **Browser receives the answer.** The browser's polling loop (`transport.ts:192`) fetches the answer signal from `GET /api/signal/poll/:sessionId`. `PeerConnection.handleSignal` (`connection.ts:294`) matches `answer`, calls `setRemoteDescription`, sets `remoteDescriptionSet = true`, then `flushPendingCandidates()` (`connection.ts:319`) — draining the bounded browser-side candidate buffer (size 64, `MAX_PENDING_CANDIDATES`, oldest-first drop at `connection.ts:305`).

14. **Data channel opens (capability gate).** On the agent side, the `on_data_channel` callback fires (`rtc.rs:663`). The agent checks `dc.label() == self.accepted_label` (`rtc.rs:664`); a mismatch is closed with a warning. If the offer carried no recognised capability (`SessionMode::None`), `run_one_session` refuses it and returns `Ok(())` early (`lib.rs:1108`). On the browser side, `onDataChannel` auto-registers the incoming raw `RTCDataChannel` (`connection.ts:137`).

15. **Browser waits for the channel.** `terminal.ts:575` `peer.waitForChannel('terminal', 10000)` polls every 30ms for an `open` data channel, throwing `timeout waiting for channel "terminal" (saw state: ${...})` (`connection.ts:241-260`) after 10s.

16. **TerminalClient subscribes.** Once the channel is open, `new TerminalClient(agentId, peer.dataChannels)` (`terminal.ts:575`) subscribes to typed messages on channel `'terminal'` (`client.ts:71`): `dataChannelManager.onMessage('terminal', handleMessage)`. Then `openTab` calls `client.createSession({ cols: 80, rows: 24, shell })` (`terminal.ts:724`).

17. **Browser sends `terminal-create`.** `createSession` (`client.ts:77`) generates a `terminalId` (`crypto.randomUUID` if available, else a fallback), then `sendJson('terminal', 'terminal-create', { terminalId, cols, rows, shell })` (`client.ts:104`). This is the first frame on the data channel.

18. **Agent spawns the PTY.** The dispatcher task (`lib.rs:1128`) parses the envelope, and for `terminal-data`/`terminal-create` it calls `PtyManager::spawn_session` (`lib.rs:2722`). The manager creates a `PtySession` (`pty.rs:338`) which calls `openpty`, spawns the configured shell (default `$SHELL` or `/bin/sh`), drops the slave end (so EOF propagates on child exit — `pty.rs:353`), and installs two pump directions:
    - Browser → PTY: a `spawn_blocking` writer thread draining a bounded 64-slot channel (`pty.rs:357`).
    - PTY → browser: a `spawn_blocking` reader (16 KiB buffer, `MAX_PTY_CHUNK`) feeding an async converter that frames output via `frame_pty_output` (`pty.rs:141`) — base64-standard-encoding the raw bytes (ADR-10: no UTF-8 assumption, bytes move as `Vec<u8>`).

19. **Terminal is interactive.** Browser keystrokes → `sendInput` → base64-encoded `terminal-data` frame (`client.ts:169`); PTY output → base64 `terminal-data` frame → `TerminalSession.receiveOutput` → `TerminalSession.state` flips `connecting → active` on first output (`session.ts:42`).

20. **Session enters the active loop.** The agent's `run_one_session` enters its steady-state `select!` (`lib.rs:1553`): pump completion, inbound candidate, the **1-hour session cap** (`session_deadline = now + 3600s`, `lib.rs:1551`), or a shutdown signal. On any exit, teardown runs: `manager.close_all()`, `drop(frame_tx)`, `peer.close()` (`lib.rs:1582`).

---

## 3. The Two State Machines

### 3.1 Session lifecycle (server-side, in SQLite)

Defined in `packages/shared/src/types/session.ts:1` and enforced by `recordSignal` (`utils/signals.ts:29`):

```
                POST /api/sessions
pending ──────► (answer received & was pending) ────► active
  │                                              │
  │ 1 h cap / agent disconnect                   │
  │ browser or server DELETE                     │
  ▼                                              ▼
terminated ◄──────────────────────────────────── terminated
```

- `pending` is set on insert (`sessions.ts:92`).
- `pending → active` happens **only** in `recordSignal` when an `answer` signal is inserted **and** the session is still `pending` (guard: `eq(sessions.status, 'pending')` — not `IN ('pending','active')`, `signals.ts:62`). This runs for both the REST answer path and the agent WebSocket echo path.
- A stale `answer` for an already-`active` session is a no-op (the `WHERE` matches 0 rows).
- `terminated` is set by `DELETE /api/sessions/:id` (`sessions.ts:117`), by agent-socket close (`ws.ts:877`), or by the background reaper. The 1-hour cap on a *running* session is agent-side and invisible to the browser.

**The reaper** (`startCleanup`, `index.ts:190`, started by `startServer` and repeating every `CLEANUP_INTERVAL_MS` = 15 min) calls `runCleanup` (`utils/cleanup.ts`), which deletes `signals` past `expires_at` and flips `pending` sessions untouched for 60 min to `terminated`. Both operations are idempotent, so the job keeps no state between passes. It logs only when it actually reaped something, and a failed pass is caught rather than thrown — housekeeping must never take the server down. Before this existed, `signals.expires_at` was honoured by the poll query but nothing ever deleted the rows, and a session abandoned mid-handshake stayed `pending` forever: both tables grew without bound.
- The shared type lists `awaiting_approval` and `expired` (`session.ts:1`), but **no server code writes those values** — they are dead states today.

### 3.2 Terminal session lifecycle (client-side, in the browser)

Defined in `packages/terminal-core/src/types.ts:1` and implemented in `packages/terminal-core/src/session.ts`:

```
connecting ──first receiveOutput ──► active
   │                                 │
   │  terminal-close / browser      │  terminal-exit
   ▼                                 ▼
 closed                            exited
```

- `connecting` on construction (`session.ts:5`).
- `connecting → active` on the first `receiveOutput` (`session.ts:42`), i.e. the first base64 `terminal-data` frame decoded and delivered.
- `exited` on `markExited(code)` (`session.ts:49`), triggered by a `terminal-exit` data-channel frame (`client.ts:321`).
- `closed` on `close()` (`session.ts:33`), triggered by `terminal-close` (`client.ts:248`) or tab teardown. This is terminal and irreversible.

The browser's `TabItem.status` (`terminal.ts:61`) maps this to UI labels: `connecting | active | exited | error`.

---

## 4. The Wire Protocol

### 4.1 Signaling messages (REST + WebSocket)

Envelope (shared by REST bodies, REST poll responses, and WebSocket `signal` frames):
```ts
{ type: 'offer' | 'answer' | 'ice-candidate', data: {...} }
```
The serde tag is `type`, content is `data`, with kebab-case outer type and camelCase inner fields — pinned by `offer_round_trip` (`signal.rs:546`).

**Offer** (`SignalOffer`, `signaling.ts:9`):
```json
{ "type": "offer", "data": { "sessionId": "s_…", "sdp": "v=0…", "capabilities": ["terminal"] } }
```

**Answer** (`SignalAnswer`, `signaling.ts:23`):
```json
{ "type": "answer", "data": { "sessionId": "s_…", "sdp": "v=0…", "approved": true } }
```
`approved` is the agent's capability gate: `true` when the offer's `capabilities` contained `"terminal"` (`rtc.rs:764`), and `false` for an ADR-14 refusal. Since Week 14 (WS3) the server enforces it: `recordSignal` only transitions a session `pending → active` when `approved !== false`, and the browser refuses a refusal answer before `setRemoteDescription` (`connection.ts`). The refusal is still recorded and relayed — enforcement gates the transition, not the message.

**ICE candidate** (`IceCandidateSignal`, `signaling.ts:37`):
```json
{ "type": "ice-candidate", "data": { "sessionId": "s_…", "candidate": "candidate:…", "sdpMid": null, "sdpMLineIndex": 0 } }
```
- `sdpMid` is `string | null`; `sdpMLineIndex` is `number | null`, validated to an integer in `0..=65535` (`ws.ts:1194` via `parseSignalMessage`).
- The agent sends `sdp_mid: None` on the wire (`rtc.rs:884` `prepare_outbound_candidate`) to work around webrtc 0.21's `to_json()` hardcoding `sdp_mid: Some("")`, so the browser falls back to `sdpMLineIndex` — the agent has exactly one m-line.

### 4.2 REST transport specifics

- `POST /api/signal/{offer|answer|ice-candidate}`: the browser's `RESTPollingTransport.send` (`transport.ts:118`) stamps `sessionId` onto the payload (`{...msg.data, sessionId: this.sessionId }`). Bearer auth uses a bearer token field (`transport.ts:57`) that is refreshed on 401 via the injected `onUnauthorized` callback: `withTokenRefresh` (`transport.ts:102`) calls `onUnauthorized` (which calls `apiClient.http.refreshAccessToken()`, `terminal.ts:388`), retries exactly once, and rethrows the original 401 if the refresh fails.
- `GET /api/signal/poll/:sessionId?after=<cursor>&limit=N`: long-poll style. Response is `{ signals: [{ id, sessionId, type, payload, createdAt }], cursor }`. `payload` is the parsed JSON object (or `{ raw: <string> }` if it was not valid JSON, `signal.ts:311`). Cursor is the last signal's `id`, which maps to a `rowid` comparison so same-second signals are never skipped (`signal.ts:285`).
- Polling backoff: starts at 200 ms, ×1.5 per empty/error cycle, capped at 2000 ms, reset to initial on activity (`transport.ts:233` for receive-signals reset, `transport.ts:160` for send reset, `transport.ts:90` for error backoff cap).

### 4.3 WebSocket transport (agent)

Outer envelope (`AgentSocketMessage`, `signaling.ts:68`):
```json
{ "type": "signal", "data": <SignalMessage> }   // push OR echo
{ "type": "ping" }                               // agent → server keepalive
{ "type": "pong" }                               // server → agent
{ "type": "error", "code": "<AgentErrorCode>" }  // server → agent
```
The server pushes a signal frame to the agent (`pushToAgent`, `ws.ts:65`) and then **echoes it back** (`ws.ts:1106`) so the agent has a correlated DB row. The `ice-servers` frame uses a separate envelope:
```json
{ "type": "ice-servers", "data": { "iceServers": [{ "urls": ["stun:…"] }, { "urls": ["turn:…?transport=udp","turn:…?transport=tcp"], "username": "expiry:user", "credential": "…" }] } }
```
`ice-servers` is matched by the agent *before* `parse_inbound` (`signal.rs:214`) — it is not a `SignalMessage` variant — so it never reaches the signaling channel.

### 4.4 Data channel (the actual terminal I/O)

A single ordered data channel labeled `"terminal"` (`connection.ts:161`, `lib.rs:1013`, `data-channel.ts`). Frames are JSON strings wrapped in:
```ts
{ type: string, channel: 'terminal', payload: any, timestamp: number }
```
Typed sub-messages on `channel: "terminal"`:

| `type` | Payload (`packages/shared/src/types/terminal.ts`) | Direction |
|--------|---------------------------------------------------|-----------|
| `terminal-create` | `{ terminalId, cols, rows, shell? }` | browser → agent |
| `terminal-data` | `{ terminalId, data: "<base64>" }` | both (output is base64 of raw bytes) |
| `terminal-resize` | `{ terminalId, cols, rows }` | browser → agent (debounced 100 ms, `client.ts:200`) |
| `terminal-close` | `{ terminalId }` | browser → agent |
| `terminal-exit` | `{ terminalId, exitCode?: number }` | agent → browser |
| `terminal-error` | `{ terminalId, code, message }` | agent → browser |

`terminal-error` is how a refused PTY reaches the user. `code` is the agent's `PtyErrorCode` — `pty-spawn-failed` (no such shell, or `openpty` failed) or `session-limit-reached` (the 10-session cap). Without it the agent could only log, and the browser showed a terminal that opened and stayed blank forever.

`data` on `terminal-data` is **standard base64** (RFC 4648, padded) of the raw PTY byte stream — `frame_pty_output` (`pty.rs:141`) uses `base64::engine::general_purpose::STANDARD`. No UTF-8 assumption (ADR-10); a multi-byte sequence split across two `read()` calls survives because the framing is byte-oriented.

---

## 5. Where TURN Comes In

TURN is provisioner per **user**, not per agent, because the credential mint is signed with the agent's own credential and the agent cannot call the user-authenticated REST endpoint.

1. The browser calls `GET /api/webrtc/ice-servers` (`terminal.ts:430`, `webrtc.ts:15`). The server runs `buildIceServers(user.id)` (`utils/ice.ts:192`):
   - With `TURN_SECRET` + `TURN_URL`: returns `[{ urls: [stunUrl \|\| Google-STUN] }, { urls: [turn+udp, turn+tcp], username: "<expiry>:<userId>", credential: <base64 HMAC-SHA1> }]`. `expiry = now + 86400` (`ice.ts:53`).
   - Without TURN: returns `[{ urls: ["stun:stun.l.google.com:19302"] }]`.

2. The agent cannot call that endpoint (it is behind `authMiddleware`, which expects a user JWT). Instead, **on WebSocket connect** the server pushes the same `ice-servers` frame, built from the **agent's `userId`** (`ws.ts:836`): `buildIceServers(userId)`. The agent maps `IceServerEntry` → `RTCIceServer` (`rtc.rs:347` `ice_servers_from_entries`) with an empty-username fallback for the no-TURN branch, and **drops `turn:` URLs carrying `transport=tcp`** (`rtc.rs:380` `is_unusable_turn_tcp`): webrtc-rs 0.21 gathers only TURN over UDP (the `ProtoType::Udp && SchemeType::Turn` arm in the crate's own gather logic), so a TURN/TCP URL would otherwise log `Skipping unsupported non-UDP TURN url` once per gather and never produce a candidate. An entry left with no URLs is dropped with them. This does **not** rescue a network where UDP is blocked — the crate has no TURN/TCP client to fall back to; it only removes an attempt that cannot succeed.

3. Both peers thus receive an identical-shaped list, **except for the TURN transports**: the browser keeps `transport=tcp` (browsers support TURN/TCP), the agent drops it. For TURN they share a short-lived credential valid for 24 h; for STUN-only deployments both fall back to Google's public resolver. Loopback peers need nothing (`rtc.rs:389`: the loopback bind comment explains how `127.0.0.1:0` restores loopback candidates that 0.21's wildcard expansion skips).

The `--stun` CLI flag (`main.rs:54`, default `stun:stun.l.google.com:19302`) is the fallback when the server pushes an empty `ice-servers` frame — which `buildIceServers` never produces (it always emits at least Google STUN), but is kept for an air-gapped or older-server deployment. If **both** the pushed list and `--stun` are empty the peer is built with no ICE server at all, which only works over loopback.

---

## 6. Failure Modes

| # | Failure | Where it happens | Behavior |
|---|---------|------------------|----------|
| F1 | ICE candidate arrives before remote description | Both peers | **Browser**: `connection.ts:69` — buffered in `pendingCandidates` (cap 64 at `connection.ts:52`; oldest dropped at `connection.ts:305`). **Agent**: `rtc.rs:852` — `apply_candidate` returns `Ok(false)`, pushes to `pending` (`rtc.rs:865`). Flushed after `setRemoteDescription`. |
| F2 | Offerer data channel created before offer | Browser | `connection.ts:161` — channel pre-created in constructor, so it is registered before `peer.start()` creates the offer. |
| F3 | Remote candidate applied before offer | Agent | Same buffer as F1, flushed in `run_one_session` after `answer_offer` (`lib.rs:1123`). |
| F4 | Empty ICE server config | Agent | `build_peer` (`rtc.rs:405`) — empty pushed list falls back to `--stun`. Empty `--stun` is the air-gapped path. |
| F5 | Second concurrent session for one agent | Agent supervisor | `supervise_sessions` (`lib.rs:784`) — `active.is_some()` is true, so it builds a throwaway peer, sends `approved: false`, closes, and continues. (ADR-14.) |
| F6 | Agent credential missing or invalid | `handleAgentUpgrade` | `ws.ts:573` — no credential (`extractAgentCredential` returns null, `ws.ts:568`) or hash mismatch (`agent` not found, `ws.ts:595`) → raw `HTTP/1.1 401`, `socket.destroy()`, returns `false`. |
| F7 | Agent WebSocket dies mid-session | Server `socket.on('close')` | `ws.ts:869` registers the handler; stale-guard `current?.socket !== socket` is at `ws.ts:871`, skipping superseded reconnects; otherwise marks `isOnline=false` (`ws.ts:877`) and terminates `pending|active` sessions bound to that agent (`ws.ts:887`). |
| F8 | Agent process exits abruptly (no close frame) | Browser | Polling continues against a server with no live socket; `pushToAgent` silently no-ops. The session stays `pending` until the user closes the tab or the server's close handler runs in a sibling process. |
| F9 | `terminal` channel never opens (capability missing) | Agent `run_one_session` | `lib.rs:1108` — offer without `"terminal"` capability → returns `Ok(())` early, no PTY spawn. |
| F10 | Channel open times out | Browser | `waitForChannel` (`connection.ts:241`) — throws after 10 s polling at 30 ms. `openTab` catches it and opens a tab with `status:'error'`, the error message, and a retry button (`terminal.ts` `recordFailedTab`, `retryTab`; banner in `WorkspaceView.vue`). |
| F11 | Answer never arrives at browser | Browser | The poll loop has **no timeout**: it backs off to the 2000 ms cap and retries forever, silently. `waitForChannel` is what ends it, at 10 s. The agent's 1 h session cap (`lib.rs:1551`) is **agent-side and invisible to the browser** — nothing tells the user, so this surfaces identically to F10. |
| F12 | Malformed signaling frame | Server | REST: `signal.ts` throws `AppError` → 400 (missing/invalid body, `signal.ts:69`/`signal.ts:149`/`signal.ts:212`), 404 (session not found, `signal.ts:29`/`signal.ts:157`/`signal.ts:220`/`signal.ts:272`), 409 (session not active, `signal.ts:32`), or 500 (recordSignal insert failed, `signal.ts:97`/`signal.ts:179`/`signal.ts:234`). WS (browser, `handleBrowserMessage`): `sendError` calls at `ws.ts:425` for `MALFORMED_JSON` size, `ws.ts:433` for `MALFORMED_JSON` parse, `ws.ts:439` for `VALIDATION_ERROR`, `ws.ts:468` for `NOT_FOUND`, `ws.ts:493` for `SESSION_TERMINATED`, `ws.ts:499` for `INTERNAL_SERVER_ERROR`. WS (agent, `handleInboundMessage`): `ws.ts:1013` for `MALFORMED_JSON` size, `ws.ts:1023`/`1030` for `MALFORMED_JSON` parse/envelope, `ws.ts:1054`/`1062` for `VALIDATION_ERROR`, `ws.ts:1076` for `NOT_FOUND`, `ws.ts:1083` for `SESSION_NOT_ACTIVE`, `ws.ts:1091` for `INTERNAL_SERVER_ERROR`. |
| F13 | Oversized inbound frame | Agent WS | `ws.ts:424` (server-side 256 KB cap checked before parse) / `signal.rs:227` (agent-side `MAX_INBOUND_FRAME_BYTES` cap). |
| F14 | Stale close evicts a live reconnect | Server | `ws.ts:871` — identity compare (`current?.socket !== socket`) skips the old socket's close handler. |
| F15 | Access token expires mid-session | Browser | The transport uses its own `fetch`, not the api-client, so it has no refresh of its own. `withTokenRefresh` (`transport.ts:102`) calls the injected `onUnauthorized` on a 401 and retries **exactly once**; a refresh returning null rethrows the original 401 rather than looping. A session outliving its token used to hit a permanent 401 the poll loop retried in silence forever. |
| F16 | PTY cannot be spawned (no such shell, session cap reached) | Agent -> browser | `spawn_failure_frame` (`lib.rs:2662`) turns the refusal into a `terminal-error` frame; `TerminalClient.handleMessage` dispatches it to `onError` subscribers; the tab switches to `status:'error'`. This was a `tracing::warn!` on the agent and **nothing at all** in the browser: the terminal opened and stayed blank forever, indistinguishable from a slow one. |
| F17 | ICE negotiation fails outright | Browser -> agent | The browser peer is the only side that can observe this, and it used to observe nothing: a `connectionState` of `failed` was delivered to no subscriber, so the tab sat on `connecting` for the full 10 s of F10 with nothing to distinguish a blocked TURN or symmetric NAT from an offline agent. The store now subscribes via `peer.onConnectionStateChange` (`connection.ts:223`) and, on `failed` only, flips every tab for that agent to `status:'error'` and drops the dead peer from the connection cache so a retry builds a fresh one. `disconnected` is deliberately **not** treated as failure: it is transient and recovers on its own, and failing on it would strand a working terminal on every network blip. |

---

## 7. Sequence Diagram

```
User          Browser (offerer)                 Server (Hono+SQLite+ws)            Rust Agent (answerer)
 |                   |                                   |                                     |
 | click agent      |                                   |                                     |
 | ────────────────► |                                   |                                     |
 |                   | POST /api/sessions {agentId}      |                                     |
 |                   | ────────────────────────────────► |                                     |
 |                   |    201 {id, status:'pending'}     |                                     |
 |                   | ◄───────────────────────────────  |                                     |
 |                   | GET /api/webrtc/ice-servers       |                                     |
 |                   | ────────────────────────────────► |                                     |
 |                   |          {iceServers:[…]}         |                                     |
 |                   | ◄───────────────────────────────  |                                     |
 |                   | create RTCPeerConnection          |                                     |
 |                   | start() → createOffer           |                                     |
 |                   | POST /api/signal/offer            |                                     |
 |                   | ────────────────────────────────► |                                     |
 |                   |                                   | POST /signal/offer validates         |
 |                   |                                   | INSERT signals (5m TTL)              |
 |                   |                                   | pushToAgent (fire-and-forget)        |
 |                   |                                   | ── WS {type:'signal',data:{…offer}}► |
 |                   |                                   |                             parseSignalMessage
 |                   |                                   |                               on_data_channel not yet
 |                   |                      [Agent WS was already open:]               |
 |                   |                                   | on 'connection':                    |
 |                   |                                   |  1. evict previous (4409)           |
 |                   |                                   |  2. push ice-servers frame          |
 |                   |                                   |  3. isOnline=true                   |
 |                   |                                   |  4. on 'ping' → isOnline/lastPing   |
 |                   |                                   |                               on_ice_candidate(forward_candidates)
 |                   |                                   |                               setRemoteDesc(offer)
 |                   |                                   |                               createAnswer
 |                   |                                   |                               setLocalDesc
 |                   |                                   | ◄── WS {type:'signal',data:{…answer}} |
 |                   |                                   | (also echoed back)                   |
 |                   | ◄───────────────────────────────  | (via poll or echo)                  |
 |                   | setRemoteDesc(answer)             |                                     |
 |                   | flushPendingCandidates            |                                     |
 |                   | [channel 'terminal' opens]        |                                     |
 |                   | waitForChannel('terminal') ✓      |                                     |
 |                   | new TerminalClient                |                                     |
 |                   | sendJson('terminal-create',…)     |                                     |
 |                   | ──► (data channel, base64) ───────►|◄──── pushToAgent / echo ─────────────►|
 |                   |                                   |                               spawn PTY (openpty)
 |                   |                                   |                               on_data_channel
 |                   |                                   |                               PtyManager + pump tasks
 |                   | [keystrokes → terminal-data]      |                                     |
 |                   | ──► (data channel) ──────►        |                                     |
 |                   |                                   |                               shell writes → base64 terminal-data
 |                   | ◄── (data channel) ──────         | ◄─────────────────────────────────── |
 |                   | receiveOutput → active             |                                     |
 |                   | 1 h cap or close → teardown       |                                     |
 |                   | DELETE /api/sessions/:id OR       |                                     |
 |                   | agent WS close                   |                                     |
 |                   |                                   | sessions.status='terminated'        |
 |                   |                                   | close_all + peer.close             |
```
