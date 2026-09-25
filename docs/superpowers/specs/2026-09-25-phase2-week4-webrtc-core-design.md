# Phase 2 Week 4 — WebRTC Core Design Specification

**Status:** Draft — awaiting review
**Date:** 2026-09-25
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 2 Week 4 of `docs/ARCHITECTURE.md` (Section 8: "Tuần 4: WebRTC Core")

> **Scope note.** The roadmap item "Implement WebSocket signaling" is assigned to **Week 5**
> (`docs/ARCHITECTURE.md:1189`), not Week 4. Week 4 therefore delivers the REST signaling
> surface specified in §6.3 plus the `packages/webrtc-core` abstraction. Durable Objects,
> WebSocket relay, and Hibernation are **out of scope**; Week 4's obligation toward them is
> to leave a transport seam that makes them additive (ADR-02).

---

## 1. Executive Summary & Goals

Week 3 delivered the first client: `packages/crypto`, `packages/api-client`, and `apps/web`,
taking the repository to 97 passing tests. Week 4 opens Phase 2 by delivering the WebRTC
foundation both peers will share.

### Goals

1. Implement **`packages/webrtc-core`** — a runtime-agnostic WebRTC abstraction that drives a
   peer connection through offer/answer/ICE exchange and manages data channels.
2. Implement the **REST signaling surface** — four endpoints under `/api/signal/*` per
   `docs/ARCHITECTURE.md:976-979`, mounted on `workers/signaling` alongside the existing routers.
3. Implement **ICE/STUN/TURN configuration** consumption via the already-defined
   `IceServerConfig` type (`packages/shared/src/types/webrtc.ts`).
4. Implement **data channels** — the `terminal`, `desktop`, `files`, and `control` channel
   types already enumerated in `WebRTCChannelType`.
5. Deliver a **real P2P test**: two peers completing a genuine ICE + DTLS + SCTP handshake and
   exchanging data over a data channel, in CI, with no browser and no network dependency.
6. Consolidate the duplicated `RESET_STATEMENTS` fixture so schema evolution touches one file.

### Non-Goals (deferred)

- **Durable Objects, WebSocket relay, WebSocket Hibernation** — Week 5 (`ARCHITECTURE.md:1189`).
  Week 4 only defines the `SignalTransport` seam these will implement (ADR-02).
- **The Rust desktop agent (`apps/agent`)** — Week 5. It remains an empty stub; Week 4 does not
  create Rust code, `Cargo.toml`, or a Rust CI job.
- **Agent-specific authentication.** Today an agent authenticates as its owning user
  (`workers/signaling/src/middleware/auth.ts:28`). Per-user token separation is a Week 5 concern.
  See §3.4 for the exact limitation this leaves and why it is accepted.
- **`media-channel.ts`** — named in `ARCHITECTURE.md:417` but belongs to Phase 3 (desktop
  streaming). It is deferred, **not** created as an empty stub (ADR-06).
- **TURN provisioning.** No TURN server is deployed. `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL`
  are consumed if present but unset by default (ADR-05).
- **`packages/terminal-core`**, xterm.js, screen capture, H.265, file transfer — Weeks 5-11.
- **E2EE payload encryption** (`EncryptionManager`, `ARCHITECTURE.md:1056-1120`). Phase 5. Note
  that `packages/crypto` currently has no `encrypt.ts`; the `EncryptionManager` in the
  architecture document is documentation-only.
- **Session UI in `apps/web`.** Week 4 ships no new views; the web app is not wired to signaling.

---

## 2. Verified Findings

Every finding below was verified against the repository or by running code. Findings F1-F4 come
from two executed spikes (see §2.2); F5-F14 from direct file inspection.

| # | Finding | Evidence |
|---|---|---|
| **F1** | **ICE candidates arrive before the remote description.** `setLocalDescription()` emits candidates immediately, so a candidate can reach the peer before the offer/answer that gives it meaning. A naive handler crashes. | Spike 1 crashed with `TypeError: Cannot read properties of undefined (reading 'type')` at `setRemoteDescription`. Fixed by buffering: both peers logged `flushed 5 buffered ICE`. |
| **F2** | **`createDataChannel` must be called before `createOffer`.** Otherwise the initial SDP carries no `m=application` (SCTP) section and the remote peer never receives the channel. | Spike 2 failed with `timeout waiting for terminal (saw: missing)` until channel creation was moved ahead of `connect()`. |
| **F3** | **`werift` is not a drop-in for the browser API.** Events use `.subscribe()` on typed emitters (`pc.onIceCandidate.subscribe`, `dc.stateChanged.subscribe`), not `addEventListener`/`onicecandidate`; `setLocalDescription()` returns `SessionDescription` rather than `void`; a data channel's state event is `.stateChanged` while the browser's is `'open'`-style events on `.readyState`. **`getStats()` is *not* a difference**: both werift and the DOM return `RTCStatsReport`, which is `ReadonlyMap`-like in both. | Spike 2 failed with `stats.filter is not a function` because the *spike* wrongly assumed an `Array` — verified afterwards that werift's `getStats()` returns an `RTCStatsReport` with `values`/`forEach` and no `filter`, and that `lib.dom.d.ts:44846` declares `interface RTCStatsReport extends ReadonlyMap<string, any>`. `Object.getOwnPropertyNames` on the channel prototype lists `setReadyState`/`stateChanged`; `dc.readyState` read `'connecting'`. |
| **F4** | **Loopback needs no ICE servers.** Two peers on the same host connect using host candidates alone; CI needs neither STUN nor TURN. | Spike 1 reported `succeeded candidate pairs: 2` with `iceServers: []`, selecting `host/udp` pairs. |
| **F5** | **`werift` is pure TypeScript with no native build.** Install is fast and hermetic, so it is safe as a devDependency. | `npm install werift@0.24.4` → `added 42 packages in 3s`. Dependencies are `@noble/curves`, `tweetnacl`, `@peculiar/x509`, `multicast-dns`, `mediabunny`, etc. — no `node-gyp`, no prebuilt binary. |
| **F6** | **The `signals` table already exists and is unused.** It has `id`, `session_id`, `type`, `payload`, `created_at`, `expires_at`, with `ON DELETE CASCADE` to `sessions`. No source file reads or writes it. | `workers/signaling/db/migrations/0000_initial.sql:55-63`; `workers/signaling/src/db/schema.ts:79-92`; `grep -rn "signals" workers/signaling/src/` matches only the schema definition. |
| **F7** | **`signals` has no consumed/delivered marker and no indexes.** Only three indexes exist repository-wide, none on `signals`. | `0000_initial.sql` declares `devices_fingerprint_unique`, `users_username_unique`, `users_email_unique` only. |
| **F8** | **The existing test fixtures never create `signals`.** `db.test.ts`, `resources.test.ts`, and `auth.test.ts` `DROP TABLE IF EXISTS signals` but create only `users`, `devices`, `agents`, `sessions`. `middleware.test.ts` creates only `users`. | Per-file `CREATE TABLE` extraction across `workers/signaling/test/*.ts`. Any signal route will fail with "no such table: signals" until the fixtures are extended. |
| **F9** | **`RESET_STATEMENTS` is duplicated across four test files**, each an independent copy. | Defined in `test/auth.test.ts:49`, `test/db.test.ts:16`, `test/middleware.test.ts:17`, `test/resources.test.ts:79`. |
| **F10** | **`@cloudflare/workers-types` defines no `RTC*` types**, and `tsconfig.base.json` sets `lib: ["ES2024"]` with no DOM. | `grep -rl "RTCSessionDescriptionInit"` over the installed `workers-types` package returns nothing; `tsconfig.base.json` sets `"lib": ["ES2024"]`. |
| **F11** | **`packages/shared` deliberately uses `sdp: string`, not `RTCSessionDescriptionInit`.** This is correct given F10, not a defect. | `packages/shared/src/types/signaling.ts` declares `sdp: string` / `candidate: string`; `packages/shared/tsconfig.json` does not override `lib`. |
| **F12** | **A precedent exists for per-package DOM lib.** `api-client` and `crypto` override `lib: ["ES2024","DOM"]`; `shared` does not. | `packages/api-client/tsconfig.json`, `packages/crypto/tsconfig.json`. |
| **F13** | **`packages/webrtc-core` is an empty stub with no build wiring.** Its `package.json` declares `lint`/`typecheck` as `echo ok`, has no `test` script, no `tsconfig.json`, and no `src/`. Turbo therefore runs nothing for it. | `packages/webrtc-core/package.json`; `find packages/webrtc-core -type f` returns only that file plus stale `.turbo` logs. |
| **F14** | **`turbo.json` is minimal and auto-discovers workspace packages.** Tasks are bare (`lint`, `typecheck`, `test`), so any package with a matching script participates without a config change. | `turbo.json` defines only the three tasks; `pnpm-workspace.yaml` globs `packages/*`. |

### 2.1 Verified Toolchain State

| Item | Version / value | Source |
|---|---|---|
| Node | 24.21.0 (local); `>= 24` required | `node -v` |
| pnpm | 12.6.0 | `package.json` `packageManager` |
| TypeScript | 6.0.3 | package manifests |
| Vitest (`workers/signaling`) | 4.1.11 resolved (`^4.1.0` declared) | `pnpm-lock.yaml:4135` |
| `@cloudflare/vitest-pool-workers` | 0.22.0 resolved | `pnpm-lock.yaml` |
| Vitest (`apps/web`) | 5.0.1 | `apps/web/package.json` |
| drizzle-orm / drizzle-kit | `^0.45.3` / `^0.31.11` | `workers/signaling/package.json` |
| Hono | 4.13.9 | `workers/signaling/package.json` |
| `werift` (new devDependency) | 0.24.4 | verified by install (F5) |
| Baseline test count | **97 passing** | `pnpm test` at HEAD `9ba5613` |

### 2.2 Spike Record

Two throwaway spikes were executed before this spec was written, at `/tmp/werift-spike/`
(not committed; their conclusions are F1-F5). Both passed:

- **`spike.mjs`** — two `werift` peers, offer/answer/ICE through an in-memory bus, data channel
  round-trip (`ping` → `pong:ping`), `iceConnectionState: connected`, 2 succeeded host candidate
  pairs, `iceServers: []`.
- **`seam-spike.mjs`** — the same flow with the *proposed* architecture: a narrow
  `RTCPeerConnectionLike` adapter interface, a `SignalTransport` seam, and a `PeerConnection`
  class written only against those. Result: `hello-p2p` → `echo:hello-p2p`, both sides
  `connectionState=connected`, ICE buffered inside `PeerConnection`.

The seam spike is why ADR-01 and ADR-02 are stated with confidence rather than as hypotheses.

---

## 3. Architectural Decision Records

### ADR-01: A narrow `RTCPeerConnectionLike` interface with per-runtime adapters

**Context.** `webrtc-core` must run in the browser (production, `apps/web`) and under Node (tests).
Node has no native WebRTC; `werift` supplies one but with a different API surface (F3). Coupling
`webrtc-core` to either runtime would make it untestable or unshippable.

**Decision.** `webrtc-core` depends on a narrow interface, `RTCPeerConnectionLike`, containing only
the operations the flow needs. Two adapters implement it: `BrowserAdapter` (thin, near 1:1 over
the DOM API) and `WeriftAdapter` (normalises emitters to callbacks). `webrtc-core` imports neither
runtime directly.

**Rationale.** The seam spike proved both the interface and the adapter boundary work end-to-end
(§2.2). Normalisation is confined to two small adapter files, so the core logic is written once and
tested once. The alternative — feature-detecting the runtime inside the core — spreads runtime
branching through every method.

**Consequence.** Adding a runtime (a Tauri webview, a future native Node peer) means writing one
adapter, not touching the core. The cost is one extra indirection and the obligation to keep the
interface genuinely narrow; if it grows to mirror the full `RTCPeerConnection` API, the adapters
become a maintenance burden.

### ADR-02: `SignalTransport` is the seam Week 5's WebSocket transport will implement

**Context.** `ARCHITECTURE.md:1189` assigns WebSocket signaling to Week 5, while §6.3 specifies
REST endpoints now. If `webrtc-core` calls REST directly, Week 5 must modify it.

**Decision.** `webrtc-core` depends on a three-method interface:

```ts
export interface SignalTransport {
  send(msg: SignalMessage): Promise<void>;
  subscribe(handler: (msg: SignalMessage) => void): () => void;
  close(): void;
}
```

Week 4 ships `RESTPollingTransport`; Week 5 adds `WebSocketTransport`. `webrtc-core` is unchanged.

**Rationale.** The seam spike drove a complete offer/answer/ICE exchange through exactly this
interface (§2.2). It is also the minimum: `send` and `subscribe` are what signaling *is*, and
`close` is needed to release a polling loop. `webrtc-core` must not import `@remote/api-client` —
doing so would drag in auth and token storage, making the package untestable under `werift` and
unusable by the Rust agent.

**Consequence.** `webrtc-core` has no dependency on `@remote/api-client`; the caller wires the
transport. Week 5's work is additive. The cost is that transport selection is the caller's
responsibility, so `apps/web` (and later the agent) must construct the right one.

### ADR-03: Client-side cursor polling; no `consumed` column

**Context.** `GET /api/signal/poll/:sessionId` must deliver each signal to a peer. The `signals`
table has no delivered marker (F7), and the test fixtures never create the table (F8), so any
schema change has to be mirrored into fixtures that are already duplicated four ways (F9).

**Decision.** Polling is cursor-based: the client sends the id of the last signal it processed
(`?after=<signalId>`), and the server returns signals for that session ordered by `created_at`
(ties broken by `id`), excluding everything up to and including the cursor, capped at a fixed page
size. The table is unchanged except for an added index.

**Rationale.** Polling becomes **idempotent** — a crashed or retried client re-reads without loss,
and there is no window in which a signal is marked delivered but never received. Two peers polling
the same session cannot race to consume each other's messages. It also avoids a schema change,
which matters because F8 means a new column would have to be added to fixtures in four files.

**Consequence.** Signals accumulate until `expires_at`, so a sweep is required (§4.3). Clients must
persist a cursor. Delivery is at-least-once, so consumers must tolerate duplicates — acceptable for
ICE candidates, which are idempotent by nature.

**Rejected:** a `consumed_at` column (write on read makes polling non-idempotent, adds a race
between peers, and requires editing four fixtures); delete-on-read (a crash between read and delete
loses a signal permanently).

### ADR-04: Share `RESET_STATEMENTS` before extending it

**Context.** Four test files hold independent copies of the fixture (F9), and none of them create
`signals` (F8). Adding signal routes requires the table to exist.

**Decision.** Extract the fixture into `workers/signaling/test/helpers.ts`, add `signals` and
`audit_logs` `CREATE TABLE` statements there, and have all four test files import it. This is
Task 1, before any signal route is written.

**Rationale.** Doing this first means the schema is defined once. Doing it after would mean
repeating the same edit four times and leaving the duplication in place. SonarQube's Quality Gate
holds duplication on new code to ≤ 3.0%, and duplicated test fixtures are exactly what it flags.

**Consequence.** All four test files change in one commit. `middleware.test.ts` currently creates
only `users`; it will get the full schema, which is harmless but slightly more setup per test.

### ADR-05: No TURN; STUN by configuration; loopback needs neither

**Context.** `ARCHITECTURE.md:732-734` lists `TURN_URL`/`TURN_USERNAME`/`TURN_CREDENTIAL` and
§4.3 shows them in `wrangler.toml`, but the real `wrangler.toml` does not define them. No TURN
server is provisioned. The spike proved loopback connects with no ICE servers at all (F4).

**Decision.** `webrtc-core` accepts an `IceServerConfig[]` (the type already exists in
`packages/shared/src/types/webrtc.ts`) and defaults to a public STUN server. TURN variables are
read from the environment **if present** and otherwise omitted. CI uses `iceServers: []`.

**Rationale.** TURN only matters across symmetric NAT, which neither CI nor two peers on one host
exhibit (F4). Provisioning TURN now would add cost and operational surface for no testable benefit.
Making it configuration-driven means enabling it later is a deployment change, not a code change.

**Consequence.** Real-world deployments behind symmetric NAT will fail to connect until TURN is
provisioned. This is a known, documented limitation, not a silent gap.

### ADR-06: `media-channel.ts` is deferred, not stubbed

**Context.** `ARCHITECTURE.md:417` names five modules for `webrtc-core`, including
`media-channel.ts`. That module exists for Phase 3 desktop streaming (screen capture, H.265).

**Decision.** Week 4 creates `connection.ts`, `data-channel.ts`, `signal-handler.ts`,
`transport.ts`, `adapter.ts`, and `index.ts`. `media-channel.ts` is not created.

**Rationale.** An empty stub is a file that must be maintained, linted, and explained while doing
nothing. The architecture document describes a target layout, not a Week 4 deliverable; Phase 3
will add the module when it has content.

**Consequence.** `webrtc-core`'s file list differs from `ARCHITECTURE.md:414-420` by one file. This
is deliberate and recorded here so a future reader does not treat it as drift.

### ADR-07: `sdp` and `candidate` stay `string`; conversion happens at the adapter

**Context.** `packages/shared/src/types/signaling.ts` declares `sdp: string` and
`candidate: string`, while `ARCHITECTURE.md:935` declares `sdp: RTCSessionDescriptionInit`. These
contradict. `@cloudflare/workers-types` defines no `RTC*` types and `tsconfig.base.json` sets no
DOM lib (F10), so the architecture document's version would not compile in `packages/shared`.

**Decision.** The shared types are **correct** and remain `string`. `webrtc-core` converts between
the wire form (`string`) and `RTCSessionDescriptionInit`/`RTCIceCandidateInit` inside its adapter
boundary, using the one package that declares `lib: ["ES2024","DOM"]` (F12).

**Rationale.** Signaling crosses a JSON boundary; `string` is the only JSON-safe representation.
Keeping `shared` DOM-free lets the Worker consume the same types — a Worker cannot reference
browser-only interfaces. `webrtc-core` is the correct place for the conversion because it is the
only participant that genuinely holds DOM types.

**Consequence.** `ARCHITECTURE.md:935-947` is stale and should be corrected. There is exactly one
conversion point, in the adapter.

---

## 4. Package Design: `packages/webrtc-core`

### 4.1 File Structure

```
packages/webrtc-core/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── types.ts            # RTCPeerConnectionLike, RTCDataChannelLike, options
│   ├── adapter.ts          # createBrowserAdapter / createWeriftAdapter selection
│   ├── adapters/
│   │   ├── browser.ts      # BrowserAdapter over the DOM API
│   │   └── werift.ts       # WeriftAdapter (normalises F3 differences)
│   ├── transport.ts        # SignalTransport + RESTPollingTransport
│   ├── signal-handler.ts   # SignalMessage <-> SDP/candidate conversion (ADR-07)
│   ├── connection.ts       # PeerConnection: lifecycle, ICE buffering (F1)
│   ├── data-channel.ts     # DataChannelManager: channel registry (F2)
│   └── index.ts
└── test/
    ├── helpers.ts
    ├── signal-handler.test.ts
    ├── data-channel.test.ts
    ├── transport.test.ts
    └── p2p.test.ts         # real werift P2P
```

### 4.2 The Adapter Interface (`src/types.ts`)

Only what the flow needs. Deliberately excludes renegotiation, transceivers, and media.

```ts
export interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onStateChange(handler: (state: string) => void): void;
}

export interface RTCPeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike;
  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void;
  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void;
  onConnectionStateChange(handler: (state: string) => void): void;
  getStats(): Promise<RTCStatsReport>;
  close(): Promise<void>;
}

export interface PeerConnectionOptions {
  iceServers?: IceServerConfig[];
  role: 'offerer' | 'answerer';
  channelLabels: string[];
  connectTimeoutMs?: number;
}
```

`RTCSessionDescriptionInit` and `RTCIceCandidateInit` come from the DOM lib this package declares
(ADR-07).

### 4.3 `WeriftAdapter` Normalisation

The F3 differences, resolved in one file:

| Browser API | `werift` | Adapter action |
|---|---|---|
| `pc.addEventListener('icecandidate', h)` | `pc.onIceCandidate.subscribe(h)` | wrap in `onIceCandidate(handler)` |
| `dc.addEventListener('message', h)` | `dc.onMessage.subscribe(h)` | wrap in `onMessage(handler)` |
| `dc.addEventListener('close'\|'open', h)` | `dc.stateChanged.subscribe(h)` | wrap in `onStateChange(handler)` |
| `setLocalDescription()` → `Promise<void>` | → `Promise<SessionDescription>` | await and discard the return value |
| `getStats()` → `Promise<RTCStatsReport>` | `Promise<RTCStatsReport>` | **no conversion needed** (both `ReadonlyMap`-like; see F3) |
| `new RTCPeerConnection({iceServers})` | same constructor shape | pass through |

`RTCPeerConnectionLike.getStats()` therefore returns `RTCStatsReport`, not `unknown[]`.

### 4.4 `PeerConnection` (`src/connection.ts`)

Owns the peer lifecycle and the F1 buffering.

```ts
export class PeerConnection {
  static async create(options: PeerConnectionOptions, transport: SignalTransport): Promise<PeerConnection>;
  start(): Promise<void>;                    // offerer: createOffer + send
  readonly connectionState: string;
  onConnectionStateChange(handler: (state: string) => void): void;
  onChannel(handler: (channel: RTCDataChannelLike) => void): void;
  waitForChannel(label: string, timeoutMs?: number): Promise<RTCDataChannelLike>;
  close(): Promise<void>;
}
```

**ICE buffering (F1) — the core correctness requirement.** Candidates received before
`setRemoteDescription` resolves are queued, not dropped or passed through. The queue is flushed
immediately after the remote description is set:

```ts
private remoteDescriptionSet = false;
private readonly pendingCandidates: RTCIceCandidateInit[] = [];

private async handleSignal(msg: SignalMessage): Promise<void> {
  switch (msg.type) {
    case 'ice-candidate':
      if (this.remoteDescriptionSet) {
        await this.peer.addIceCandidate(toIceCandidateInit(msg.data));
      } else {
        this.pendingCandidates.push(toIceCandidateInit(msg.data));
      }
      return;
    case 'offer': /* answerer: setRemote -> flush -> createAnswer -> send */ return;
    case 'answer': /* offerer: setRemote -> flush */ return;
  }
}
```

**Channel ordering (F2).** All channels in `options.channelLabels` are created **during
construction**, before `start()` is ever called, so the first SDP offer carries the SCTP section.
The answerer learns them through `onDataChannel`.

**Signaling state guard.** A signal arriving after `close()` is ignored, not thrown, so a poll
response in flight during teardown cannot crash the peer.

### 4.5 `DataChannelManager` (`src/data-channel.ts`)

A registry keyed by label, with typed send helpers over `DataChannelMessage<T>`
(already defined in `packages/shared/src/types/webrtc.ts`). Responsibilities: track channels by
label, expose `send(channel, payload)`, expose `onMessage(channel, handler)`, and surface channel
state transitions. It does not implement retry, framing, or buffering — those belong to the
protocols layered above it in Weeks 6-11.

### 4.6 `RESTPollingTransport` (`src/transport.ts`)

Implements `SignalTransport` over the four REST endpoints. Polling uses an adaptive interval
(fast immediately after sending, backing off while idle) and stops on `close()`. It accepts an
injected `fetch`-like function so tests drive it without a network.

### 4.7 Tests

| File | Covers | Approx. count |
|---|---|---|
| `signal-handler.test.ts` | `SignalMessage` ↔ SDP/candidate conversion, malformed input | 6 |
| `data-channel.test.ts` | Registry, label routing, state transitions, send helpers | 6 |
| `transport.test.ts` | Cursor advance, page cap, `close()` stops polling, error propagation | 7 |
| `p2p.test.ts` | **Real ICE + DTLS + SCTP**: 2 peers connect, channel opens, data round-trips both ways, `iceServers: []` | 5 |

`p2p.test.ts` runs under `environment: 'node'` using the `WeriftAdapter` — a genuine handshake, not
a mock (F1-F5). Timeouts are bounded so a regression fails rather than hangs.

---

## 5. Application Design: Signaling Endpoints

### 5.1 Routes (`workers/signaling/src/routes/signal.ts`)

Mounted at `/api/signal` in `src/index.ts`, behind `authMiddleware` like every other resource
router.

| Method | Path | Auth | Request body | Response |
|---|---|---|---|---|
| POST | `/api/signal/offer` | bearer | `{ sessionId, sdp, capabilities? }` | `201 { id, sessionId, type, createdAt }` |
| POST | `/api/signal/answer` | bearer | `{ sessionId, sdp, approved }` | `201 { id, sessionId, type, createdAt }` |
| POST | `/api/signal/ice-candidate` | bearer | `{ sessionId, candidate, sdpMid, sdpMLineIndex }` | `201 { id, sessionId, type, createdAt }` |
| GET | `/api/signal/poll/:sessionId` | bearer | — (query `?after=<id>&limit=<n>`) | `200 { signals: [...], cursor }` |

Errors follow the existing shape (`AppError` → `{ error, code, details }`):

| Condition | Status | Code |
|---|---|---|
| Missing/invalid token | 401 | `UNAUTHORIZED` |
| Malformed JSON | 400 | `MALFORMED_JSON` (existing handler) |
| Missing/invalid field | 400 | `VALIDATION_ERROR` |
| Session not found **or not owned by caller** | 404 | `NOT_FOUND` |
| Session not in a signaling-permitting state | 409 | `SESSION_NOT_ACTIVE` |

### 5.2 Ownership Enforcement

Every route resolves the session with the same predicate the existing routes use
(`workers/signaling/src/routes/sessions.ts:109`):

```ts
.where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
```

A session belonging to another user returns **404**, never 403 — matching the existing convention
of not disclosing whether a resource exists. This is the security boundary that matters and it is
enforced on all four routes, including the poll.

### 5.3 Signal Lifecycle

- **Write.** Each POST inserts one row: `type` ∈ `offer|answer|ice-candidate`, `payload` = the
  JSON-encoded `SignalMessage` data, `expires_at` = now + 5 minutes.
- **Read.** Poll selects rows for the session ordered by `created_at` then `id`, excluding rows at
  or before the cursor, capped at `limit` (default 50, max 200). It returns the new cursor.
- **Expiry.** `expires_at` bounds how long an undelivered signal survives. A sweep deletes expired
  rows; Week 4 relies on the `WHERE expires_at > now` filter and documents the sweep as a follow-up
  (there is no cron trigger in `wrangler.toml`, and adding one is out of scope).
- **Cascade.** `signals.session_id` cascades on session delete (F6), so terminating a session
  removes its signals automatically.

### 5.4 Accepted Limitation: No Peer Separation Within a Session

**Stated plainly, because it is a real gap.** Today there is no agent-specific authentication: an
agent authenticates as the user who owns it (`middleware/auth.ts:28`). The ownership check in §5.2
therefore enforces that a caller may only touch **their own** sessions. It does **not** distinguish
the browser peer from the agent peer inside one session — both are the same principal.

The consequence: a user could post an `answer` to their own session that was meant to come from the
agent, or inject ICE candidates into their own session. No cross-user attack is possible.

**Accepted for Week 4** because: separating peers requires an agent token, which is Week 5 work
alongside the Rust agent; and the residual risk is confined to a user's own resources. Adding a
spoofable `role` field would create the appearance of enforcement without the substance, so it is
deliberately not done. Week 5 must introduce agent-scoped credentials before the agent ships.

### 5.5 Schema Change

One migration, `0001_signal_indexes.sql`, adding:

```sql
CREATE INDEX `signals_session_created_idx` ON `signals` (`session_id`, `created_at`);
CREATE INDEX `signals_expires_at_idx` ON `signals` (`expires_at`);
```

Generated with `pnpm --filter @remote/signaling db:generate` (drizzle-kit needs no credentials),
then applied locally with `db:migrate:local`. The `signals` table itself is unchanged (ADR-03).

### 5.6 Tests

| Area | Covers | Approx. count |
|---|---|---|
| `signal.test.ts` | All four routes: happy path, missing fields, malformed JSON, foreign-session 404, terminated-session 409, cursor paging, limit cap, expiry filter | 14 |

---

## 6. Workspace & CI Integration

1. **`packages/webrtc-core/package.json`** — replace the `echo ok` stubs with real scripts
   (`eslint .`, `tsc --noEmit`, `vitest run`), add `dependencies: { "@remote/shared": "workspace:*" }`
   and `devDependencies: { werift, typescript, vitest }`. No `@remote/api-client` dependency
   (ADR-02).
2. **`packages/webrtc-core/tsconfig.json`** — `lib: ["ES2024","DOM"]`, following F12's precedent.
3. **`packages/webrtc-core/vitest.config.ts`** — `environment: 'node'`, mirroring
   `packages/api-client/vitest.config.ts`.
4. **`turbo.json`** — no change; task discovery is automatic (F14).
5. **`workers/signaling/test/helpers.ts`** — the shared fixture (ADR-04), extended with `signals`
   and `audit_logs`.
6. **CI (`.github/workflows/ci.yml`)** — no change. `werift` is pure TypeScript (F5), the P2P test
   needs no STUN/TURN (F4), and no Rust job is required because `apps/agent` is out of scope.

**Verification gate:** `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`, with the
suite growing from **97** to **135** tests (24 in `webrtc-core`, 14 in `workers/signaling`).

---

## 7. Review Focus & Edge Cases

**Security**

- The ownership predicate (§5.2) must be present on **all four** routes; a missing check on the
  poll would leak another user's SDP.
- 404 (not 403) for a foreign session, consistent with existing routes.
- Signal payloads are attacker-controlled JSON. `JSON.parse` must be guarded, and the parsed shape
  validated before use.
- `payload` is stored as text and returned as parsed JSON; a malformed row must not 500 the poll.

**Correctness**

- **F1 is the highest-risk item.** If ICE buffering is wrong, P2P fails intermittently in ways that
  look like a network problem. The P2P test must assert a real `connected` state, not merely that
  no error was thrown.
- **F2 is second.** Channels created after `start()` are silently absent on the remote side.
- Cursor semantics must be stable under duplicate `created_at` values (hence the `id` tie-break).
- `limit` must be clamped server-side; an unbounded poll is a denial-of-service vector.

**Boundaries**

- `webrtc-core` must not import `@remote/api-client` or any browser-only global at module scope.
- `packages/shared` must stay DOM-free (F11) — do not "fix" `sdp: string` to
  `RTCSessionDescriptionInit`.
- The test fixture must create `signals` before any signal route runs (F8).

**Testing**

- The P2P test must not depend on external network access (F4).
- Polling tests must use an injected `fetch`, not a live server.
- Timeouts bounded so regressions fail fast rather than hanging CI.

---

## 8. Delivery Sequence

| # | Task | Deliverable | Tests |
|---|---|---|---|
| 1 | **Consolidate test fixtures** | `test/helpers.ts` with `signals` + `audit_logs`; four files import it | 0 (refactor; 97 stay green) |
| 2 | **`packages/webrtc-core` scaffold** | real scripts, `tsconfig.json`, `vitest.config.ts`, `src/types.ts` | 0 |
| 3 | **Adapters** | `adapters/browser.ts`, `adapters/werift.ts`, `adapter.ts` | 0 (exercised by task 6) |
| 4 | **Signal handling + transport** | `signal-handler.ts`, `transport.ts` | 13 (6 + 7) |
| 5 | **Data channels** | `data-channel.ts`, `index.ts` | 6 |
| 6 | **Connection + real P2P test** | `connection.ts`, `test/p2p.test.ts` | 5 |
| 7 | **Migration** | `0001_signal_indexes.sql` + drizzle journal | 0 |
| 8 | **Signaling routes** | `src/routes/signal.ts`, mounted in `src/index.ts` | 14 |
| 9 | **Docs** | Correct `ARCHITECTURE.md:935-947` (ADR-07); note the §5.4 limitation | 0 |

**Total new tests:** 38 (24 in `webrtc-core`, 14 in `workers/signaling`), taking the repository
from **97** to **135**.

Tasks 1-6 are backend-independent and can proceed in parallel with 7-8. Task 6 depends on 3-5;
task 8 depends on 1 and 7. `connection.ts` has no dedicated unit-test file: it is exercised
end-to-end by `p2p.test.ts`, and its ICE-buffering branch (F1) is only meaningful against a real
handshake.
