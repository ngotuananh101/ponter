# Phase 2 Week 5 — Desktop Agent & Terminal Design Specification

**Status:** Draft — awaiting review
**Date:** 2026-09-26
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 2 Week 5 of `docs/ARCHITECTURE.md` (Section 8: "Tuần 5: Desktop Agent - Terminal")

> **Scope note.** Week 5 delivers Phase 2's second half: a real **Rust desktop agent** (`apps/agent`)
> with a real PTY via `portable-pty`, real P2P WebRTC DataChannel via the `webrtc` crate, in-memory
> WebSocket signaling on `workers/signaling` (`GET /api/ws/agent`), agent-scoped credentials
> (`ag_<32 hex>` stored as sha256), session lifecycle management (`pending` → `active` → `terminated`),
> and an automated cross-language E2E test exercising real terminal I/O over DataChannel in CI.
> Durable Objects, Hibernation, terminal resize, multi-session, and UI in `apps/web` are **out of scope** (deferred to Week 6).

---

---

## 1. Executive Summary & Goals

Week 4 delivered `packages/webrtc-core` (adapters, `PeerConnection` state machine, real loopback
handshake) and the tenant-isolated REST signaling surface, taking the repository to **135 passing
tests**. Week 5 closes Phase 2's second half: a real **Rust desktop agent** that owns a **real PTY**
and reaches the browser over **real P2P**, with the signaling Worker relaying WebSocket frames
in memory.

This is the week the roadmap item *"Implement WebSocket signaling"* (`docs/ARCHITECTURE.md:1195`)
finally lands, together with the Week 4 security boundary note's obligation: an agent must stop
authenticating as its owning user. The five roadmap items — *Tạo Rust agent*, *Implement WebSocket
signaling*, *Tích hợp portable-pty*, *Xử lý terminal I/O*, *Implement session management*
(`docs/ARCHITECTURE.md:1193-1199`) — map one-to-one onto Goals 2-5 and 8 below.

### Goals

1. **Land the R24 mutation-gap tests as the first commit, before any feature work.** Six reachable
   branches were proven under-covered by mutation in Week 4 (2 in `webrtc-core/src/transport.ts`,
   2 in `src/data-channel.ts`, 2 in `workers/signaling/src/routes/signal.ts`; ledger R24).
   *Testable:* each of the six mutants, re-applied to source, must now turn the suite **red** —
   measured by applying, running, and reverting each mutant, with the tree clean afterward.
2. **Ship a real Rust agent (`apps/agent`)** — a `remote-agent` crate (edition 2021, 4 modules:
   `signal.rs`, `rtc.rs`, `pty.rs`, `main.rs`) that builds and tests in CI. *Testable:*
   `cargo build --release` and `cargo test` pass on the Rust CI job, and the crate is not a stub
   (`apps/agent` today holds only `package.json`).
3. **Implement WebSocket signaling** — `GET /api/ws/agent` on `workers/signaling`, backed by an
   **in-memory `Map<agentId, WebSocket>` relay**; D1 remains the source of truth. *Testable:*
   under `@cloudflare/vitest-pool-workers`, an authenticated agent connects (HTTP 101), the
   browser's `POST /api/signal/*` push arrives at that socket, and an agent-sent `answer` is
   persisted to D1 and returned by the browser's existing poll route.
4. **Introduce agent-scoped credentials** — `ag_<32 hex>` issued once on registration, stored only
   as a **sha256 hex** in `agents.credential_hash` (UNIQUE). *Testable:* `POST /api/agents` returns
   the credential exactly once and never again on subsequent reads; a WS connect with a missing or
   wrong credential is **401 `UNAUTHORIZED`**; the raw secret never appears in any GET response.
5. **Integrate `portable-pty` and drive real terminal I/O.** The agent spawns a real shell
   (`sh`/`cmd`, overridable via `--shell`) and pumps bytes two-way between the PTY and the
   `terminal` DataChannel as `DataChannelMessage<TerminalDataMessage>`. *Testable:* a `cargo test`
   spawns a shell, runs `echo hello`, and asserts the PTY output contains `hello`; E2E (Goal 7)
   observes the same bytes on the browser side.
6. **Deliver the E2E done-criteria: real PTY output round-trips over the WebRTC DataChannel.**
   Approach **A1** — the Rust agent is the **answerer** with the `webrtc` crate against a browser-
   style **offerer** (Node `WeriftAdapter` + `PeerConnection` in CI). *Testable:* the harness
   completes offer → answer → ICE (both directions over WS) → DTLS/SCTP on loopback with no STUN,
   then sends a terminal message and asserts the received payload contains the PTY's echoed
   `hello` — Linux-only in CI, no browser and no network dependency.
7. **Implement session management** — the `pending → active → terminated` state machine, with
   `started_at` set when the agent's answer is persisted, `is_online` flipped by a 30s ping and
   read with a 90s online threshold at request time (no sweep job), and `terminated` on agent WS
   disconnect or browser `DELETE`. *Testable:* a session with an agent answer becomes `active`
   with a non-null `started_at`; a killed agent socket marks `is_online = 0`; signals for a
   terminated session are rejected **409 `SESSION_NOT_ACTIVE`**.
8. **Keep the Week 4 contract intact.** `packages/webrtc-core`'s public API is unchanged and its
   suite stays green; the transport seam is consumed, not modified. *Testable:* the Week 4
   `webrtc-core` suite passes unmodified, and the monorepo test count is strictly greater than
   **135**.

### Non-Goals (deferred)

- **A TypeScript `WebSocketTransport` in `packages/webrtc-core`.** The architecture is hybrid
  (`ARCHITECTURE.md:2.1`): REST for the browser, WS for the agent only. With no TS consumer this
  week, adding it would be speculative. **Owner: Week 6** — the session UI is its first real
  consumer (ADR-03).
- **Terminal resize and multi-session.** PTY scope this week is **portable-pty + real shell,
  exactly 1 session, no resize**. `TerminalResizeMessage` exists in
  `packages/shared/src/types/terminal.ts` but is not wired. **Owner: Week 6**
  (`ARCHITECTURE.md:1203-1204`).
- **Terminal UI in `apps/web` (xterm.js, data-channel-to-terminal wiring, mobile keyboard).**
  Week 5 ships no new views; the browser offerer is a CI harness, not a product surface.
  **Owner: Week 6** (`ARCHITECTURE.md:1201-1205`).
- **`packages/terminal-core`.** Remains a stub. The Rust agent uses `portable-pty` directly; the
  TS terminal package serves the web UI. **Owner: Week 6.**
- **Durable Objects, WebSocket Hibernation.** Rejected, not deferred (ADR-01): free-tier
  simplicity, and `ARCHITECTURE.md` never names DO. Accepted cost — connections drop on Worker
  restart or isolate rebalance, and the agent reconnects with backoff.
- **`media-channel.ts`, screen capture, H.265, 60fps desktop streaming.** **Owner: Phase 3,
  Weeks 7-9** (`ARCHITECTURE.md:1207`).
- **File transfer.** **Owner: Phase 4, Weeks 10-11** (`ARCHITECTURE.md:1232`).
- **E2EE payload encryption (`EncryptionManager`).** **Owner: Phase 5, Weeks 12-14.** Note that
  `packages/crypto` still has no `encrypt.ts`; the `EncryptionManager` in the architecture
  document remains documentation-only.
- **TURN provisioning.** No TURN server is deployed; loopback needs neither STUN nor TURN
  (Week 4 ADR-05). **Owner: Phase 6 / release hardening** (`ARCHITECTURE.md:1275`).

---

## 2. Verified Findings

| # | Finding | Evidence (file:line or command output) |
|---|---|---|
| 1 | **Agent type declares `lastHeartbeat`, DB column is `last_ping_at`** — name mismatch, no mapping layer between them. | `packages/shared/src/types/user.ts:39` (`lastHeartbeat: string \| null;`) vs `workers/signaling/src/db/schema.ts:53` (`lastPingAt: text('last_ping_at')`) |
| 2 | **`Agent.capabilities: string[]` has no backing column** — the field is non-optional in the shared type but `agents` has no `capabilities` column; `capabilities` appears only in the signal payload (`SignalOffer`). | `packages/shared/src/types/user.ts:40` vs `workers/signaling/src/db/schema.ts:42-57` (columns: id, user_id, hostname, platform, os_version, agent_version, public_key, is_online, last_ping_at, created_at); `packages/shared/src/types/signaling.ts:4` |
| 3 | **`Session.startedAt` has no DB column** — type requires it (nullable), `sessions` table never defines `started_at`. | `packages/shared/src/types/session.ts:12` vs `workers/signaling/src/db/schema.ts:59-77` |
| 4 | **`Session.expiresAt` has no DB column** — and must not be confused with `signals.expires_at`, which does exist (TTL on the signal row, not the session). | `packages/shared/src/types/session.ts:14` vs `workers/signaling/src/db/schema.ts:59-77`; `signals.expiresAt` at `workers/signaling/src/db/schema.ts:93` |
| 5 | **`SessionStatus` union is wider than anything the DB enforces** — `'awaiting_approval' \| 'expired'` exist in the type; `sessions.status` is a free `text` defaulting to `'pending'` with no CHECK constraint. | `packages/shared/src/types/session.ts:1-2,7` vs `workers/signaling/src/db/schema.ts:68` |
| 6 | **agents route has no PUT/PATCH/DELETE** — read + create only; an agent record cannot be updated (heartbeat, isOnline) or removed over REST. | `workers/signaling/src/routes/agents.ts:12` (GET /), `:19` (POST /), `:71` (GET /:id) — no other `router.<method>` |
| 7 | **`agents.id` is a client-supplied primary key** (no `$defaultFn`, unlike `users`/`devices`/`sessions`); POST requires the caller to supply `id` + `publicKey`. | `workers/signaling/src/db/schema.ts:43` (`id: text('id').primaryKey()`) vs `:5-7`, `:24-26`, `:60-62`; validation at `workers/signaling/src/routes/agents.ts:32-38` |
| 8 | **Repeat registration is a pre-checked 409 `AGENT_EXISTS`, not a raw UNIQUE 500** — explicit SELECT-then-throw before insert. | `workers/signaling/src/routes/agents.ts:44-52` |
| 9 | **signal offer/answer/ice-candidate enforce tenancy as 404, never 403** — lookup is `id AND userId`; a foreign session is indistinguishable from a missing one. | `workers/signaling/src/routes/signal.ts:22-30` (`WHERE sessions.id = ? AND sessions.userId = ?` → 404 `NOT_FOUND`) |
| 10 | **409 `SESSION_NOT_ACTIVE` is gated on status `pending`/`active`** for the three POST routes only. | `workers/signaling/src/routes/signal.ts:32-34`; called at `:57`, `:108`, `:164` |
| 11 | **poll deliberately performs no status check** — only ownership; a terminated session can still be drained. | `workers/signaling/src/routes/signal.ts:208-219` (comment + `select({ id: sessions.id })` with no status predicate) |
| 12 | **Cursor is rowid-based, not `created_at`** — `rowid > COALESCE((SELECT rowid ... WHERE id = after), 0)`, ordered `rowid ASC`; rationale: SQLite `created_at` has 1s resolution and would skip same-second signals. | `workers/signaling/src/routes/signal.ts:221-242`; next cursor = last returned `id` at `:268-271` |
| 13 | **Limit is clamped to [1, 200] with default 50** (`Number(q) \|\| 50`, then `Math.max(1, Math.min(raw, 200))`). | `workers/signaling/src/routes/signal.ts:203-204` |
| 14 | **Signal TTL is 5 minutes, stamped on insert and enforced on read** — all three insert paths set `datetime('now','+5 minutes')`; poll filters `expires_at IS NULL OR expires_at > datetime('now')`. | `workers/signaling/src/routes/signal.ts:71`, `:122`, `:179` (inserts); `:230`, `:239` (poll filter) |
| 15 | **Seam `SignalTransport` is exactly send/subscribe/close** — `subscribe` returns an unsubscribe closure; `close()` is sync and returns void. | `packages/webrtc-core/src/types.ts:36-40` |
| 16 | **`RESTPollingTransport` exists and implements the seam** — POSTs to `/api/signal/{offer,answer,ice-candidate}`, GETs `/api/signal/poll/:sessionId?after=<cursor>`, exponential backoff 200ms→2000ms, stamps `sessionId` onto the wire payload. | `packages/webrtc-core/src/transport.ts:26` (class), `:50-92` (send), `:94-103` (subscribe), `:105-112` (close), `:122-180` (poll), `:182-218` (parse) |
| 17 | **No WebSocket code anywhere in the signaling worker** — grep for `websocket|WebSocketPair|upgrade|101|Upgrade|Durable Object` over `workers/signaling/src` exits 1 (zero matches); deps are only `hono`, `drizzle-orm`, `@remote/shared`. Transport is pure REST polling. | `grep -rn -iE "websocket\|WebSocketPair\|upgradeWebSocket" workers/signaling/src` → `grep_exit=1`; `workers/signaling/package.json` dependencies block |
| 18 | **`apps/agent` is a greenfield stub** — `package.json` only, no `src/`; `lint`/`typecheck` are `echo ok` placeholders. | `find apps/agent -type f -not -path '*/.turbo/*'` → `apps/agent/package.json` only |
| 19 | **`packages/terminal-core` is a greenfield stub** — same shape: `package.json` only, `echo ok` scripts. The PTY/terminal contract it must eventually satisfy already exists in shared types. | `find packages/terminal-core -type f -not -path '*/.turbo/*'` → `packages/terminal-core/package.json` only; contract at `packages/shared/src/types/terminal.ts:1-25` (`TerminalSize`, `TerminalSession`, `TerminalDataMessage`, `TerminalResizeMessage`) |
| 20 | **Toolchain measured**: Node `v24.21.0`, pnpm `12.6.0`, cargo `1.98.1 (797e8a9bc 2026-08-05)`, rustc `1.98.1 (48a229cea 2026-09-01)`. | `node -v` → `v24.21.0`; `pnpm -v` → `12.6.0`; `cargo --version` → `cargo 1.98.1 (797e8a9bc 2026-08-05)`; `rustc --version` → `rustc 1.98.1 (48a229cea 2026-09-01)` |

---

## 3. Architectural Decision Records

### ADR-01: In-memory WebSocket relay on the Worker; D1 stays the source of truth

**Context.** Week 5 adds the first real-time path to the Worker: the desktop agent must be told a
session exists, and `ARCHITECTURE.md:165` ("`W->>H: Notify via WebSocket`") and
`ARCHITECTURE.md:129` ("`G -.->|WebSocket Signaling| H`") both describe that push. Cloudflare
offers two ways to hold a socket server-side: Durable Objects (with WebSocket Hibernation, so an
idle socket costs no duration) or plain in-memory state inside the Worker isolate. The Week 4
spec deferred this wholesale — "Durable Objects, WebSocket relay, WebSocket Hibernation — Week 5"
(`2026-09-25-phase2-week4-webrtc-core-design.md:38`) — and left the `SignalTransport` seam
(ADR-02 of that spec, `packages/webrtc-core/src/types.ts:36`) so this week is additive. Two facts
constrain the choice: `docs/ARCHITECTURE.md` never mentions Durable Objects (zero occurrences of
"Durable" or "Hibernation" in the file, and `ARCHITECTURE.md:105` names the component only as
"WebSocket Relay"), and no `durable_objects` binding exists in any `wrangler*.toml` today.

**Decision.** The relay is a module-scope `Map<agentId, WebSocket>` in `workers/signaling`, held
on the isolate that accepted the upgrade. A signal written by a browser peer is pushed to the
mapped socket if one is present; the push is **best-effort**. D1 remains the source of truth:
every signal is persisted to `signals` (Week 4 §5) *before* any push is attempted, and the agent's
authoritative view of a session is still what it reads back from D1. A push that finds no socket —
agent offline, socket owned by another isolate, isolate recycled — is not retried and not recorded
as a delivery; the agent's reconnect path re-reads state from D1. No Durable Object, no
Hibernation, no `durable_objects` binding is added.

**Rationale.** Durable Objects would be the correct answer at scale: they give one authoritative
owner per agent id, they survive isolate rebalance, and Hibernation makes an idle socket nearly
free. They also add a second storage system, a new binding, a class-based runtime model, and a
migration path for every environment, for a Week 5 whose only WebSocket consumer is one local Rust
binary. The in-memory Map is a few lines, needs no configuration change, and is honest about what
it is: a fast path over a store that is already correct without it. Free-tier simplicity wins
here precisely because D1 was made authoritative in Week 4 — the relay is an optimisation, not a
dependency.

**Consequence.** The accepted cost is stated plainly: **connections drop on Worker restart and on
isolate rebalance**, and a push can miss an agent whose socket lives in a different isolate, since
the Map is per-isolate. The system degrades to "the agent learns about the session on its next
poll/reconnect" rather than failing — acceptable because the agent must handle a cold D1 read
anyway, and because Week 5's P2P handshake is driven by the agent's own request, not by the push.
The cost is bounded by a second constraint: **the relay must never be load-bearing**. If a future
week makes the push the only way a peer learns something, this ADR is superseded and Durable
Objects become mandatory.

**Rejected:** Durable Objects with Hibernation (correct at scale, but adds a binding, a second
runtime model, and per-environment setup for a single local consumer this week, and
`ARCHITECTURE.md` was written without them — introducing them silently would be undocumented
architecture drift, not an implementation detail); long-polling the agent instead of a socket
(the agent already needs a socket for its own liveness, so this trades a real capability for
nothing); treating a missed push as an error (it is the normal state, not an exception).

### ADR-02: Agent-scoped credential `ag_<secret>` verified against a `sha256` column

**Context.** Week 4 shipped signaling with a stated, accepted gap: an agent authenticates as the
user who owns it (`workers/signaling/src/middleware/auth.ts:28`), so nothing distinguishes the
browser peer from the agent peer inside one session
(`2026-09-25-phase2-week4-webrtc-core-design.md` §5.4, lines 466-479). That spec says the gap must
be closed before the agent ships — "Week 5 must introduce agent-scoped credentials before the
agent ships" — and `ARCHITECTURE.md:955` states the same requirement: "Differentiating the browser
client from the desktop agent within the same user's account requires agent-scoped credentials."
Week 5 is the first week a second principal exists in the loop, so the gap is now blocking rather
than theoretical: without separation, an agent's `answer` and a browser's `offer` are the same
principal writing to the same session.

**Decision.** Introduce a per-agent credential, format `ag_<secret>` where `<secret>` is at least
32 bytes of CSPRNG output rendered URL-safe. The Worker stores only a `sha256` digest of the full
`ag_<secret>` string in a new `agents.credential_hash` column, added by the Week 5 migration
(§ADR-06). Verification is: parse the `ag_` prefix, hash the presented string with `sha256`,
compare against the stored digest in constant time using the XOR loop already present at
`workers/signaling/src/utils/crypto.ts:102-107`, then load the agent row and check tenancy. A
request carrying an agent credential is resolved to the **agent** principal, not to
`agents.user_id`; the signal routes take the peer's role from the credential, so the agent may
write `answer` and `ice-candidate` for a session it owns but may not write an `offer` attributed
to the browser. The browser continues to use the existing user JWT unchanged.

**Rationale.** The `ag_` prefix makes the principal decidable from the credential alone, before
any database read, which keeps the two auth paths — user JWT and agent credential — from being
confused by a fallback. A single `sha256` is the right digest here, and the contrast with
`hashPassword` (`utils/crypto.ts:18`) is the point: that helper uses PBKDF2 with 100,000
iterations because a user password is low-entropy and guessable offline, whereas `ag_<secret>` is
high-entropy random output with no dictionary to attack. Stretching it would buy nothing and cost
a Worker CPU budget on every agent request. Constant-time comparison still matters, because a
byte-wise early-exit compare leaks the digest prefix and the digest is a stable secret-equivalent.
JWT reuse is rejected outright: see below.

**Consequence.** The credential is long-lived and per-agent, so rotation is an agent-scoped
operation (regenerate, re-register) rather than a user-wide one — the blast radius of a leaked
credential is one agent, not the account. The credential must be delivered to the agent exactly
once, at registration, and never returned by `GET /api/agents`; `credential_hash` therefore joins
`password_hash` on the list of columns that must never be serialised wholesale, which is why
§ADR-06 introduces a `toPublicAgent` projection rather than returning rows directly as
`routes/agents.ts:16,68,86` does today. Revocation is a row delete or hash clear, checked on the
next request — there is no token-expiry semantics to reason about, and no KV blacklist entry to
write, unlike the JWT path (`utils/auth.ts:74`). The cost: an agent offline for a long time holds
a credential that never expires on its own, so a rotation story is owed in a later week.

**Rejected:** reusing the user JWT for the agent (a JWT is user-scoped and carries the full user
authority, so it cannot separate the two peers — the exact problem §5.4 names; it also expires in
15 minutes, which a long-lived desktop agent cannot satisfy without a refresh loop that would give
the agent a *user* refresh token, a strictly worse escalation); a signed JWT with an `agent` claim
(same authority problem with extra steps, and it reintroduces expiry/rotation into a path that
does not need them); a bare shared secret per user with no per-agent identity (cannot attribute
which host answered, and one leaked secret exposes every agent that user owns).

### ADR-03: No TypeScript `WebSocketTransport` this week

**Context.** Week 4 built the `SignalTransport` seam specifically so that a WebSocket transport
could be added without touching `webrtc-core` (`2026-09-25-phase2-week4-webrtc-core-design.md`
ADR-02, line 149: "Week 4 ships `RESTPollingTransport`; Week 5 adds `WebSocketTransport`.
`webrtc-core` is unchanged"). Week 5 is the week WebSockets arrive, so the natural reflex is to
add that second implementation now. But `ARCHITECTURE.md` §2.1 describes a **hybrid**: the browser
reaches the Worker over HTTP (`ARCHITECTURE.md:121`, `A --> D`) and receives signaling by reading
back through it, while the WebSocket edge is drawn only to the host — `ARCHITECTURE.md:129`,
`G -.->|WebSocket Signaling| H`, where `H` is the Rust Desktop Agent. The Week 5 roadmap item is
scoped the same way: `ARCHITECTURE.md:1195` says "Implement WebSocket signaling" under "Tuần 5:
Desktop Agent - Terminal". And there is no consumer: `apps/web` does not import
`@remote/webrtc-core` at all, the only implementation of the interface is
`RESTPollingTransport` (`packages/webrtc-core/src/transport.ts:26`), and the agent is Rust, so a
TypeScript transport could not be used by it under any design.

**Decision.** Week 5 ships **no** `WebSocketTransport` in `packages/webrtc-core`. The browser keeps
`RESTPollingTransport`; the agent speaks WebSocket to the relay in Rust. `SignalTransport`
(`packages/webrtc-core/src/types.ts:36`) is left exactly as Week 4 defined it — three methods, no
new methods, no signature change — so the seam stays honest rather than being widened for an
implementation that does not exist.

**Rationale.** A transport is a consumer-facing abstraction; written without a consumer it is
written against an imagined one. Concretely, the design questions a browser transport must answer
are all still open — how the browser authenticates the upgrade (it holds a user JWT, not an
`ag_` credential), whether the relay accepts browser sockets at all under §ADR-01's
`Map<agentId, WebSocket>`, and how reconnection interacts with the polling cursor Week 4 made
idempotent (ADR-03 of that spec). Guessing those now would produce a file that must be rewritten
when the first real browser consumer appears, and its tests would pin the guess rather than the
requirement. YAGNI applies with unusual force here: the seam was built so this work is
*additive*, and additive means it can wait for a caller.

**Consequence.** The Week 4 seam goes a second week with one implementation, so it remains
unexercised as a *seam* in-repo — the risk this carries is that its shape is subtly wrong for a
WebSocket implementation, and that risk is not retired by this week's work; it is retired the
first time a browser transport is written. Nothing in this week depends on the browser gaining
push, because the browser drives the session and can poll. When a browser transport is needed, it
is a new file plus a caller-side construction, with `webrtc-core` unchanged — the same claim Week
4 made, still untested but still cheap to satisfy.

**Rejected:** a speculative `WebSocketTransport` "for symmetry" (an untested implementation of an
interface with no caller, pinning guesses about browser auth and reconnection); extending
`SignalTransport` with a WebSocket-only method such as `isConnected` (widens the seam for a
capability the polling transport cannot implement meaningfully); switching the browser from
polling to WebSocket this week (no relay design accepts browser sockets, and it would put the
browser on a path §ADR-01 explicitly calls best-effort).

### ADR-04: The Rust agent is the real P2P answerer, built on the `webrtc` crate

**Context.** Week 4 proved a genuine ICE + DTLS + SCTP handshake in CI with two `werift` peers in
Node (`2026-09-25-phase2-week4-webrtc-core-design.md` §2.2). That is a test harness, not a peer:
the production answerer is the Rust desktop agent, which this week must actually exist —
`ARCHITECTURE.md:1194` ("Tạo Rust agent") and `ARCHITECTURE.md:1195` ("Implement WebSocket
signaling"). Two ways to get a P2P peer in the loop were on the table. **A1:** the agent
implements the answerer natively with the `webrtc` crate, the same crate family the architecture
already lists (`ARCHITECTURE.md:658`, `webrtc = "0.10"`). **A2:** the agent shells out to the
existing Node `werift` harness and relays frames over stdio, so the P2P stack under test is the
one Week 4 already proved. The deciding constraint is the week's done-criteria: it requires a
real agent binary completing the handshake, not a Node process standing in for it.

**Decision.** Adopt A1. `apps/agent` — today an empty stub whose only file is
`apps/agent/package.json` — gains a Rust crate whose binary is the P2P **answerer**: it registers
with the Worker using its `ag_<secret>` credential (§ADR-02), opens the WebSocket signaling
connection (§ADR-01), receives the offer, answers it with the `webrtc` crate, exchanges ICE, and
brings up the `terminal` data channel. The Rust module layout follows
`ARCHITECTURE.md:348-357` — `main.rs`, `config.rs`, and `webrtc/{mod,connection,data_channel,
signal_handler}.rs` — with `terminal/` arriving as the week's terminal work proceeds.
`media_channel.rs` is not created, for the same reason Week 4 deferred the TypeScript
`media-channel.ts` (`ARCHITECTURE.md:418`): Phase 3 owns it.

**Rationale.** A2 would test the Node harness again while shipping nothing that runs on a user's
machine, and the week's whole point is that a real binary completes the handshake. It also
inverts the deployment story: the agent is the one process that must run on a host without a Node
runtime, so making it depend on Node to negotiate its only transport is a dependency the product
cannot afford. Choosing A1 accepts a harder problem — the Rust `webrtc` crate is an independent
implementation from the browser's `RTCPeerConnection` and from `werift`, so the three must
interoperate on the wire rather than sharing code — but that interop is exactly the property the
product needs, and it is better discovered this week than at release.

**Consequence.** CI gains a Rust job it does not have today: `.github/workflows/ci.yml` currently
runs only `pnpm lint`/`typecheck`/`format:check`/`test`, and the done-criteria cannot be met
without a `cargo build` (and a `cargo test`) step, so this week's CI change is as load-bearing as
the code. The wire contract between the three stacks — channel labels from `WebRTCChannelType`,
SCTP framing, and the `WEBRTC_STRING` PPID detail Week 4 pinned for `werift` — must be held by
tests rather than by shared code, because there is no shared code to hold it. The Node `werift`
harness stays: it is the fast, hermetic peer for CI, while the Rust binary is the artifact under
test.

**Rejected:** werift-as-agent via a Node sidecar (the done-criteria demands a real binary in the
loop, and it would make a Node runtime a prerequisite for the agent's own transport); a Rust
answerer that reuses `webrtc-core` through a WASM bridge (no such bridge exists, and it would
route the agent through a browser-shaped API for no benefit); deferring the answerer to Week 6
and testing the agent's signaling only (leaves the done-criteria unmet and pushes the
three-implementation interop problem into the week that also builds the terminal UI).

### ADR-05: Crate versions are pinned by `Cargo.lock`, not by `ARCHITECTURE.md` §4.2

**Context.** `ARCHITECTURE.md:649-718` prints a full `apps/agent/Cargo.toml`, and its versions are
stale by construction: it was written against a `webrtc` line that has since moved
(`ARCHITECTURE.md:658`, `webrtc = "0.10"`), `portable-pty = "0.8"` (`ARCHITECTURE.md:663`), and
`tokio-tungstenite = "0.21"` (`ARCHITECTURE.md:660`). It also lists Phase 3 crates —
`scrap`, `x264`, `openh264`, `ring`, `rustls`, `notify`, `walkdir`, `vt100`, `bincode`, `dirs`,
`sysinfo`, `uuid`, `chrono` — that Week 5's terminal-only scope does not use, and it reaches for
`log`/`env_logger` (`ARCHITECTURE.md:686-687`) where the approved logging choice for this week is
`tracing`. Week 4 hit the same class of problem in `packages/shared` types and resolved it by
recording the stale document location rather than silently diverging
(`2026-09-25-phase2-week4-webrtc-core-design.md` ADR-07).

**Decision.** Crate versions are chosen and pinned at implementation time, and the pin of record
is the committed `apps/agent/Cargo.lock`. Indicative targets for `apps/agent/Cargo.toml` are:
`webrtc` on the 0.13 line, `portable-pty` on the 0.9 line, `tokio-tungstenite` on the 0.26 line,
`tokio` 1, `serde` + `serde_json`, `clap` 4, and `tracing` for logging. These are **floors and
starting points, not the expected pins**: the implementer confirms each against `crates.io` before
committing, and the lock file records what is actually built. `ARCHITECTURE.md` §4.2 is not
hand-edited as part of this week's code changes.

**Rationale.** A version written into prose is a second source of truth that drifts the moment
anyone runs `cargo update`, which is how §4.2 became stale in the first place. `Cargo.lock` is the
only artifact that is guaranteed to match what CI builds, so it is the only one worth trusting.
Keeping the *targets* as line-level ranges rather than exact versions is deliberate: the point of
the implementer's `crates.io` confirmation is to catch a target that no longer resolves, and an
exact version in this document would just be the same drift with more digits.

**Drafting-time check (2026-09-26).** A `crates.io` query made while drafting this section
returned `webrtc` 0.21.0, `portable-pty` 0.9.0, `tokio-tungstenite` 0.30.0, `tokio` 1.53.1,
`serde` 1.0.229, `clap` 4.6.7, and `tracing` 0.1.44. The 0.13 and 0.26 targets above are therefore
well below what resolves today, which is the expected outcome and precisely why the decision is
"pin in the lock file, confirm at implementation" rather than "copy §4.2".

**Consequence.** `ARCHITECTURE.md` §4.2 remains knowingly stale and diverges further from
`apps/agent/Cargo.toml` this week; correcting it is a documentation commit, tracked separately,
not a side effect of a code change. The Week 5 manifest is a strict subset of the §4.2 list —
Phase 3 capture and crypto crates are simply absent, not stubbed — so a reader comparing the two
sees a smaller crate set and a newer version line, both intentional and both recorded here. The
cost of the decision is that "what version is the agent on?" is answered by reading
`Cargo.lock`, not by reading the architecture document.

### ADR-06: Drift resolved by mapping in a projection, not by renaming columns

**Context.** Three artifacts disagree about the `agents` and `sessions` tables. The D1 schema of
record (`workers/signaling/db/migrations/0000_initial.sql`) declares `agents.last_ping_at`
(line 10) and no `agents.capabilities`; `sessions` has no `started_at` or `expires_at`.
`ARCHITECTURE.md:822-823` declares `agents.last_heartbeat` and `agents.capabilities TEXT`, and
`ARCHITECTURE.md:804,806` declare `sessions.started_at` and `sessions.expires_at`. The TypeScript
layer splits down the middle: the Drizzle schema and fixtures follow the database
(`src/db/schema.ts:53` `lastPingAt: text('last_ping_at')`, `test/helpers.ts:50` `last_ping_at`),
while the public type follows the document (`packages/shared/src/types/user.ts:39-40`
`lastHeartbeat`, `capabilities`; `packages/shared/src/types/session.ts:12` `startedAt`). The
existing test suite pins the database spelling — `resources.test.ts:40-52` declares
`AgentResponse` with `lastPingAt: string | null` — so the two names are already load-bearing in
opposite directions.

**Decision.** No column is renamed. The database keeps `last_ping_at`. The missing columns are
added by the Week 5 migration: `agents.capabilities` (TEXT, JSON array, matching
`ARCHITECTURE.md:823`) and `sessions.started_at` (TEXT), the latter alongside the
`agents.credential_hash` column from §ADR-02. The naming difference is absorbed in one place: a
new `toPublicAgent` projection — mirroring `toPublicUser` at `workers/signaling/src/utils/user.ts:21`
— maps the row's `lastPingAt` to the public type's `lastHeartbeat`, surfaces `capabilities`, and
**omits `credential_hash`**, so agent rows stop being serialised wholesale as they are today at
`routes/agents.ts:16,68,86`.

**Rationale.** A rename is the expensive fix and it buys nothing. `last_ping_at` is referenced by
the migration, the Drizzle schema, the shared test fixture, and the assertions in
`resources.test.ts`; renaming it means a new migration, a coordinated edit across all four, and a
public-type change — to make a column name read better, while the wire name the client actually
sees (`lastHeartbeat`) is unchanged either way. A projection is the opposite trade: one new
function, one call site per route, and the mapping lives next to the `toPublicUser` precedent that
already exists for exactly this reason (keeping a projection in one place so a row is never
serialised wholesale). ADR-02 makes the projection mandatory anyway, because `credential_hash`
must not leave the Worker; once that helper exists, folding the name mapping into it is free.

**Consequence.** The database and `ARCHITECTURE.md` keep different names for the same column,
deliberately and now on the record, so a future reader does not treat it as a defect — the same
disposition Week 4 gave `media-channel.ts` and the `sdp: string` contradiction. Adding
`capabilities` and `started_at` extends the test fixture (`test/helpers.ts`), which since Week 4
ADR-04 is a single shared `RESET_STATEMENTS`, so the schema change lands in one file and the five
suites that import it stay in sync automatically. Residual drift is out of scope and remains:
`sessions.expires_at` (`ARCHITECTURE.md:806`) and `devices.platform` / `browser` / `ip_address` /
`approved_at` (`ARCHITECTURE.md:785-788`) are still declared in the document and absent from the
database; Week 5 adds only the columns the agent path needs.

**Rejected:** renaming `last_ping_at` to `last_heartbeat` (a migration plus edits to the schema,
fixture, and assertions, for a name no client sees); renaming the shared type's `lastHeartbeat`
down to the database spelling (would make the public type disagree with `ARCHITECTURE.md:822`
*and* change the wire contract for no functional gain); leaving the projection out and returning
raw rows (already the current behaviour, and it cannot survive §ADR-02, which puts a secret hash
on the row).

---

## 4. Application Design: Agent WebSocket & Credentialed Registration

**Scope of this section.** Week 4 shipped the REST signaling surface and deferred three things to Week 5: the WebSocket transport, agent-scoped credentials, and the Rust agent (`2026-09-25-phase2-week4-webrtc-core-design.md` §1 Non-Goals; `ARCHITECTURE.md:955`). This section specifies the **worker half** of that debt: a credentialed agent socket (`GET /api/ws/agent`), credential issuance on agent registration, best-effort server→agent push, agent→worker signal ingest, and the schema migration both require. The Rust client, `packages/terminal-core`, xterm.js, Durable Objects, and Hibernation are **out of scope** (§4.13).

---

### 4.1 File Map

| File | Change | Why |
|---|---|---|
| `src/routes/ws.ts` | **new** | `GET /api/ws/agent`; owns `agentConnections` and `pushToAgent` |
| `src/utils/agent.ts` | **new** | `generateAgentCredential`, `toPublicAgent` — mirrors the existing `src/utils/user.ts` projection pattern |
| `src/utils/signals.ts` | **new** | `parseSignalMessage`, `recordSignal`, `SIGNAL_TTL_SQL` — the single insert path shared by the WS ingest and the three POST routes |
| `src/utils/crypto.ts` | modify | export the existing private `buf2hex`; add `sha256Hex` |
| `src/routes/agents.ts` | modify | `POST /` issues a credential; all three routes project through `toPublicAgent` |
| `src/routes/signal.ts` | modify | route each POST through `recordSignal`; `pushToAgent` after insert |
| `src/index.ts` | modify | `app.route('/api/ws', ws)` |
| `src/db/schema.ts` | modify | `agents.credentialHash`, `agents.capabilities`, `sessions.startedAt` |
| `db/migrations/0002_agent_credentials.sql` | **new** | the three columns + one unique index |
| `db/migrations/meta/0002_snapshot.json`, `_journal.json` | **new / modify** | drizzle-kit bookkeeping; a hand-written journal entry cannot work (Week 4 ruling R2) |
| `test/helpers.ts` | modify | fixture gains the three columns |
| `test/resources.test.ts` | modify | `AgentResponse` type follows the projection |
| `test/ws.test.ts` | **new** | the socket suite |
| `test/signal.test.ts`, `test/db.test.ts` | modify | push assertions; migration assertions |

No new binding: `Bindings` (`src/types.ts`) is unchanged. There is no Durable Object, no new KV namespace, and no `wrangler.toml` change.

---

### 4.2 Verified Findings

Every row below was settled by running code against this repository's real toolchain — the `@cloudflare/vitest-pool-workers` runner for `workers/signaling`, `node:sqlite` 3.53.4, `drizzle-kit 0.31.11`, and `wrangler dev` (real workerd) — not by reading documentation. Probe files were deleted; `git status` is clean.

| # | Finding | Evidence |
|---|---|---|
| **W1** | **`ALTER TABLE ... ADD COLUMN credential_hash TEXT UNIQUE` is rejected by SQLite and D1.** The task's shorthand for the column constraint is not expressible as an `ADD COLUMN`. | `node:sqlite`: `ALTER TABLE agents ADD COLUMN credential_hash TEXT UNIQUE` → `Cannot add a UNIQUE column`. D1 in the pool: `D1_ERROR: Cannot add a UNIQUE column: SQLITE_ERROR`. The working form is `ADD COLUMN credential_hash TEXT` **followed by** `CREATE UNIQUE INDEX agents_credential_hash_unique ON agents (credential_hash)` — which is exactly what `drizzle-kit generate` emits (§4.9). |
| **W2** | **A `UNIQUE` index permits many `NULL`s.** Agents registered before the migration keep `credential_hash = NULL` and do not collide, so the migration is safe on a populated table. | Two `INSERT`s leaving the column `NULL` both succeeded; a second `UPDATE` to an already-taken hash failed with `UNIQUE constraint failed: agents.credential_hash`. Verified against D1 and in a fixture `CREATE TABLE` with inline `UNIQUE`. |
| **W3** | **`ALTER TABLE ADD COLUMN` preserves existing rows with `NULL` defaults.** | Inserted a legacy `agents` row, applied the three statements, re-read it: `{"c":null,"cap":null}`; `pragma_table_info('agents')` then listed `credential_hash, capabilities` and `pragma_table_info('sessions')` listed `started_at`. |
| **W4** | **Hono's `upgradeWebSocket` helper never fires `onOpen` for a Cloudflare server socket.** Registration placed in `onOpen` silently never runs. | Lifecycle probe on `upgradeWebSocket(c, {onOpen, onMessage, onClose, onError})`: `LIFECYCLE ["onMessage","onClose"]`. Independently, a raw server socket emits no `open` at all, with the listener attached both before and after `accept()`: `SERVER_LIFECYCLE ["readyState-after-accept:1","message","close"]`. |
| **W5** | **Registering in the route body works and is ordered correctly.** Building the `WebSocketPair` by hand, calling `agentConnections.set(...)` before returning, and `accept()`-ing the server end yields a `101` whose socket is in the map by the time the test observes it. | `C 101 ws= true` then `C_KEYS [ 'agent-1' ]`. The map is populated before the response leaves the worker. |
| **W6** | **Returning a raw `101` with a `webSocket` and no `Upgrade` header is a `500` in real workerd**, but the vitest pool is permissive and returns `101`. The pool therefore *cannot* catch this class of bug. | `wrangler dev` (real workerd) on a plain `GET /ws`: `500` — `TypeError: Worker tried to return a WebSocket in a response to a request which did not contain the header "Upgrade: websocket"`. Same request through the pool: `status=101 ws=true`. An explicit guard returns `426 UPGRADE_REQUIRED` in both. |
| **W7** | **A closed server socket throws on `send()`; a socket whose *client* end closed does not.** Best-effort push must therefore be wrapped, and a no-throw is not proof of delivery. | After `server.close()`: `throw: Can't call WebSocket send() after close()`, `readyState 2`. After the client end closed: `no-throw`, `readyState 2`. |
| **W8** | **A superseded socket's `close` event evicts the live socket and clears `is_online` unless guarded.** Two connections for one `agentId` are possible (a reconnecting agent), and the old socket's close fires afterwards. | Unguarded: closing the *first* client end left `size 0` while the second socket was still open. With `current?.socket === server`: `AFTER_OLD_CLOSE size=1 {"o":1}` and, after the new socket closes, `AFTER_NEW_CLOSE size=0 {"o":0}`. |
| **W9** | **`setInterval` fires inside a live WS isolate and can write to D1.** A worker-side heartbeat timer is technically available. | `TICKS 14`, row `{"o":1,"p":"2026-09-26 02:42:25"}` after an 80 ms socket with a 5 ms interval. |
| **W10** | **`datetime('now')` is space-separated UTC, not ISO-8601.** | `SELECT datetime('now')` → `'2026-09-26 02:41:05'`; `+5 minutes` → `'2026-09-26 02:46:05'`. Any field written with `new Date().toISOString()` would be a *different* lexical format in the same column. |
| **W11** | **`sha256` over the full token string is available and stable in the worker.** `crypto.subtle.digest` works under both the pool and `workerd`. | `ag_` + 16 random bytes → `/^ag_[0-9a-f]{32}$/`; digest → `/^[0-9a-f]{64}$/`. Lookup by the stored hash returns the agent and upgrades: `OK_STATUS 101`, `CONNS ['agent-1']`. |
| **W12** | **The full loop closes: `POST /api/agents` → credential → socket.** | `CREATE 201 {"agent":{...,"lastHeartbeat":null,"capabilities":["terminal","files"]},"credential":"ag_79c08e66ef39bdc782ff2a1519abfc46"}`; `DUP 409 AGENT_EXISTS`; `WS 101 ['agent-1']`; `LIST` returned the projection with **no** `credentialHash`. |
| **W13** | **An agent-sent `answer` becomes a D1 row the browser's existing poll returns unchanged.** | Inbound `{"type":"signal","data":{"type":"answer","data":{...}}}` → `POLL 200 {"signals":[{"type":"answer","payload":{"sessionId":...,"sdp":"v=0 agent","approved":true}}]}` — byte-identical to what `POST /api/signal/answer` writes. A candidate round-tripped as `{"sessionId":...,"candidate":"c","sdpMid":"audio","sdpMLineIndex":0}`. |
| **W14** | **Tenancy mismatch and malformed frames are rejected without touching D1.** | Foreign `sessionId` → `{"type":"error","code":"NOT_FOUND"}`; non-JSON → `MALFORMED_JSON`; unknown `type` and a missing `sdp` → `VALIDATION_ERROR`. |
| **W15** | **`agentConnections` is module-scope and therefore per-isolate.** Cloudflare may run several isolates; the socket lives in the isolate that accepted it, and a `POST /api/signal/*` may be served elsewhere and find an empty map. | Design consequence of W5 + module-scope state. This is *why* the push is specified as best-effort and why D1 + poll remains the delivery guarantee. It is not a defect to be fixed in this section (§4.13). |
| **W16** | **`toPublicAgent` is assignable to the shared `Agent` contract.** | A compile-time proof — `const _assignable: (a: PublicAgent) => SharedAgent = (a) => a;` — typechecks clean against `packages/shared/src/types/user.ts`. |
| **W17** | **`POST /api/agents`'s response shape change is breaking but test-safe.** The route currently returns the bare row; no existing test reads the body, only the status. | `test/resources.test.ts` asserts `createRes.status === 201` and then re-reads via list/get. Its local `AgentResponse` type carries `lastPingAt` and lacks `capabilities`; the type must be updated (§4.11) even though the assertions still pass. |
| **W18** | **Baseline is 135 passing tests**, matching the Week 4 spec's target. | `pnpm test`: signaling 60, web 30, webrtc-core 24, api-client 11, crypto 10. |

---

### 4.3 Wire Protocol

#### 4.3.1 The envelope

Every WebSocket frame is a JSON object with a discriminating `type`. Signal frames reuse the shipped `SignalMessage` union (`packages/shared/src/types/signaling.ts`) **unmodified** as the `data` member:

```ts
type SignalMessage =
  | { type: 'offer';         data: SignalOffer }
  | { type: 'answer';        data: SignalAnswer }
  | { type: 'ice-candidate'; data: IceCandidateSignal };

type AgentSocketMessage =
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage }
  | { type: 'error'; code: AgentErrorCode };
```

**The nesting is deliberate and easy to get wrong.** A signal frame is `{ type, data }` where `data` is itself `{ type, data }`: the outer `type: 'signal'` is the *transport* discriminator, the inner `type` is the *signal* discriminator. `packages/shared` is not touched, so `webrtc-core`'s `SignalTransport` consumers and the REST bodies keep one definition. Flattening to `{ type: 'answer', data: {...} }` was rejected: it makes the transport frame ambiguous with a bare `SignalMessage` and would force the Rust agent to re-derive which union it is holding.

#### 4.3.2 Exact frames

**Agent → worker, heartbeat:**

```json
{ "type": "ping" }
```

**Agent → worker, a signal (this is the `answer` case; `offer` and `ice-candidate` are identical in shape):**

```json
{
  "type": "signal",
  "data": {
    "type": "answer",
    "data": { "sessionId": "0d44e7c9-…", "sdp": "v=0\r\n…", "approved": true }
  }
}
```

**Worker → agent, the heartbeat reply:**

```json
{ "type": "pong" }
```

**Worker → agent, the tenancy rejection (identical for every rejected `sessionId`, so the socket cannot be used to probe which sessions exist):**

```json
{ "type": "error", "code": "NOT_FOUND" }
```

**Worker → agent, the push that follows a `POST /api/signal/*`.** This is byte-identical to the frame an agent receives when *another* peer posts the same signal, so the agent needs one handler:

```json
{
  "type": "signal",
  "data": {
    "type": "offer",
    "data": { "sessionId": "0d44e7c9-…", "sdp": "v=0\r\n…", "capabilities": ["terminal"] }
  }
}
```

#### 4.3.3 Error codes

| `code` | When |
|---|---|
| `MALFORMED_JSON` | The frame is not JSON, or is not a JSON object |
| `VALIDATION_ERROR` | The frame parses but is not a recognised member of the union (unknown `type`, missing/empty `sdp` or `candidate`, missing `sessionId`, `data` absent) |
| `NOT_FOUND` | The `sessionId` does not resolve to a session owned by this agent (§4.7) |
| `INTERNAL_SERVER_ERROR` | The D1 insert returned no row |

`NOT_FOUND` is reused rather than introducing a WS-specific code, matching the REST convention of never distinguishing "absent" from "not yours" (`routes/sessions.ts:109`).

#### 4.3.4 What the browser sees

The browser is unchanged. It still polls `GET /api/signal/poll/:sessionId`, and a signal that arrived over the agent socket is indistinguishable from one posted over REST — same `type`, same `payload`, same `rowid` cursor semantics. **The agent socket is a second writer to one table, not a second delivery path for the browser.**

---

### 4.4 `GET /api/ws/agent` — `src/routes/ws.ts`

#### 4.4.1 Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **The route is written by hand with `WebSocketPair`, not with `upgradeWebSocket`.** | W4: the helper's `onOpen` never fires, so the natural place to register is unreachable. The helper also offers no way to register *before* the `101`. A plain handler returning `new Response(null, { status: 101, webSocket: client })` is the documented Cloudflare form and is fully typed (`workers-types` `ResponseInit.webSocket`). |
| **D2** | **Registration happens in the route body, before the response is returned.** | W5. A `POST /api/signal/*` that lands while the upgrade response is in flight must not see an upgraded-but-unregistered socket. |
| **D3** | **`authMiddleware` is not applied.** | The caller is an agent presenting `ag_…`, not a user presenting a JWT. `authMiddleware` calls `verifyTokenForUser(..., 'access', ...)`, which would reject every agent credential as `UNAUTHORIZED` — verified: `Bearer ag_…` against a JWT route returns `401`. Agent credentials are a second, disjoint principal. |
| **D4** | **Credential check runs before the `Upgrade` guard, so an unauthenticated request is `401` and never `426`.** | The task fixes `401 UNAUTHORIZED` for missing/wrong. Ordering the guard first would make `GET /api/ws/agent` with no headers a `426`, changing that observable. |
| **D5** | **The credential travels in `Authorization: Bearer`, not a query string.** | Query strings land in access logs, `Referer`, and browser history. The only WS client is the Rust agent (`tokio-tungstenite` sets arbitrary request headers), so the header is available; a browser could not set one, but the browser does not use this endpoint. |
| **D6** | **The `Upgrade` guard returns `426 UPGRADE_REQUIRED`.** | W6: without it, a valid credential plus a non-upgrade `GET` is a `500` in real workerd — an avoidable server error, and one the pool cannot detect. |
| **D7** | **`sha256` of the full token, `ag_` prefix included.** | The token is 128 bits of CSPRNG output, not a human-chosen password, so a fast hash is correct and PBKDF2 (used for passwords in `utils/crypto.ts`) would be wasted work per connect. Hashing the whole string keeps client and server from having to agree on a stripping rule. The `UNIQUE` index makes lookup a single indexed probe. |
| **D8** | **The map holds the raw server `WebSocket`; the close handler is identity-guarded.** | W8. Without the guard a reconnect races its own predecessor and a live agent reads `is_online = false`. |

#### 4.4.2 The map and the push helper

```ts
// src/routes/ws.ts
export type AgentConnection = {
  agentId: string;
  userId: string;
  socket: WebSocket;
};

/**
 * Live agent sockets, keyed by `agents.id`.
 *
 * Module scope, and therefore **per isolate**: Cloudflare may run several
 * isolates, the socket lives in the isolate that accepted it, and a request
 * served elsewhere sees an empty map. Nothing may depend on a hit here —
 * D1 plus the browser's poll is the delivery guarantee, and this map is a
 * latency optimisation. See D9.
 */
export const agentConnections = new Map<string, AgentConnection>();

/**
 * Best-effort delivery of a freshly persisted signal to the owning agent.
 *
 * Never throws. A miss (no socket in this isolate) and a dead socket are both
 * ordinary outcomes, not request failures: the row is already in D1, so the
 * agent can still recover the signal through the same poll the browser uses.
 */
export function pushToAgent(agentId: string | null, message: SignalMessage): void {
  if (!agentId) return;

  const connection = agentConnections.get(agentId);
  if (!connection) return;

  try {
    connection.socket.send(JSON.stringify({ type: 'signal', data: message }));
  } catch {
    // W7: a server-side socket throws on send() once it has closed. Drop it so
    // the next push skips it. `onClose` also fires for this socket and is
    // identity-guarded, so removing the entry here cannot evict a newer one.
    if (agentConnections.get(agentId)?.socket === connection.socket) {
      agentConnections.delete(agentId);
    }
  }
}
```

| # | Decision | Rationale |
|---|---|---|
| **D9** | **`pushToAgent` is synchronous, returns `void`, and swallows every failure.** | The task requires that a push failure never fails the request. A `Promise` return would invite a caller to `await` it and turn a latency optimisation into a failure mode. W15 makes the miss case common rather than exotic, so "no socket" must be silent. |
| **D10** | **`pushToAgent` lives beside the map rather than in `routes/signal.ts`.** | `routes/signal.ts` imports from `routes/ws.ts`; `routes/ws.ts` imports neither. The dependency stays acyclic without a third module. |

#### 4.4.3 The route

```ts
// src/routes/ws.ts
const PING_TTL_SQL = sql`(datetime('now'))`;

function extractAgentCredential(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  return token;
}

const router = new Hono<AppContext>();

router.get('/agent', async (c) => {
  // D4: authenticate before the Upgrade guard so a missing credential is 401.
  const raw = extractAgentCredential(c.req.header('Authorization'));
  const db = getDb(c.env.DB);

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.credentialHash, await sha256Hex(raw)))
    .get();

  if (!agent) {
    // Same status, message, and code for "unknown credential" and "malformed
    // header", so the endpoint cannot be used to enumerate credentials.
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  // D6 / W6: without this, a non-upgrade GET is a 500 in real workerd.
  if (c.req.header('Upgrade') !== 'websocket') {
    throw new AppError('Upgrade Required', 426, 'UPGRADE_REQUIRED');
  }

  const agentId = agent.id;
  const userId = agent.userId;

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  // D2 / W5: registered before the 101 is returned.
  agentConnections.set(agentId, { agentId, userId, socket: server });

  server.addEventListener('message', (evt) => {
    void handleInbound(evt.data, server, { db, agentId, userId });
  });

  server.addEventListener('close', () => {
    // D8 / W8: a superseded socket may already own this agentId.
    const current = agentConnections.get(agentId);
    if (current?.socket !== server) return;

    agentConnections.delete(agentId);
    void db
      .update(agents)
      .set({ isOnline: false })
      .where(eq(agents.id, agentId))
      .run();
  });

  server.accept();

  // Set on connect, not only on the first ping: otherwise `is_online` is
  // wrong for up to one ping interval (D11).
  await db
    .update(agents)
    .set({ isOnline: true, lastPingAt: PING_TTL_SQL })
    .where(eq(agents.id, agentId))
    .run();

  return new Response(null, { status: 101, webSocket: client });
});

export default router;
```

| # | Decision | Rationale |
|---|---|---|
| **D11** | **`is_online` is set `true` at `accept()`, and refreshed by each ping.** | A literal reading of "ping updates `is_online`" alone would leave a connected agent reading `offline` for up to 30 s after connect — a UI that shows a freshly connected agent as offline. Setting it at connect makes the column truthful from the first observable moment; the ping keeps `last_ping_at` fresh and repairs a value cleared by a sibling isolate. |
| **D12** | **The heartbeat is agent-initiated, not worker-initiated.** | "Reply pong" fixes the direction: the worker answers. A worker-side timer is *possible* (W9) but is per-isolate, dies with the isolate, and would need its own liveness policy; a client-driven ping is the standard shape and needs no timer lifecycle. A worker-side probe for half-open sockets is deferred (§4.13). |
| **D13** | **`last_ping_at` is written with `sql`(datetime('now'))``.** | W10. `new Date().toISOString()` would write a `T`-and-`Z` string into the same column that already holds space-separated UTC, making every lexical comparison and every `datetime()` expression wrong for half the rows. |

---

### 4.5 Heartbeat and Inbound Handling

```ts
// src/routes/ws.ts
const PING_TTL_SQL = sql`(datetime('now'))`;

async function handleInbound(
  raw: unknown,
  socket: { send: (data: string) => void },
  ctx: { db: Database; agentId: string; userId: string },
): Promise<void> {
  // Binary frames carry no defined meaning on this socket.
  if (typeof raw !== 'string') return;

  let frame: { type?: unknown; data?: unknown };
  try {
    frame = JSON.parse(raw) as { type?: unknown; data?: unknown };
  } catch {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  if (frame.type === 'ping') {
    await ctx.db
      .update(agents)
      .set({ isOnline: true, lastPingAt: PING_TTL_SQL })
      .where(eq(agents.id, ctx.agentId));
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (frame.type !== 'signal') {
    socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
    return;
  }

  const message = parseSignalMessage(frame.data);
  if (!message) {
    socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
    return;
  }

  const session = await ctx.db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      agentId: sessions.agentId,
    })
    .from(sessions)
    .where(eq(sessions.id, message.data.sessionId))
    .get();

  // Tenancy, verbatim from the task: BOTH halves must hold. `session.agentId`
  // is nullable, so an agentless session is rejected here too — a session the
  // agent was never bound to is not the agent's to answer.
  if (
    !session ||
    session.userId !== ctx.userId ||
    session.agentId !== ctx.agentId
  ) {
    socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
    return;
  }

  const inserted = await recordSignal(ctx.db, message);
  if (!inserted) {
    socket.send(JSON.stringify({ type: 'error', code: 'INTERNAL_SERVER_ERROR' }));
    return;
  }

  // Echo the accepted signal so the agent can correlate it with the D1 row
  // without a second round trip. Same envelope as a push, so one client
  // handler covers both.
  socket.send(JSON.stringify({ type: 'signal', data: message }));
}
```

| # | Decision | Rationale |
|---|---|---|
| **D14** | **No session `status` check on ingest.** | The task fixes the condition as tenancy only. It also matches the deliberate choice already made for the poll (`routes/signal.ts:210`): a session that has just been terminated must still be able to deliver its final `answer`. Adding a `409`-style rejection here would strand that signal. |
| **D15** | **The accepted signal is echoed back.** | It is the only way the agent learns the row landed without a separate ack frame, and the envelope is identical to a push, so the Rust client needs one arm. |
| **D16** | **`recordSignal` is shared with the POST routes rather than duplicated.** | "Persisted exactly like POST" is a contract, and the only way to keep it true is one insert. A second copy would drift on `expires_at`, which is the field nobody looks at until signals start surviving their TTL. `SIGNAL_TTL_SQL` is defined once. |
| **D17** | **Validation reuses `parseSignalMessage`, which is stricter than the POST routes.** | The POST routes coerce `capabilities` with `body.capabilities ?? []` and do not filter element types; `parseSignalMessage` filters to strings. A POST with `capabilities: ["a", 1]` therefore stores `["a",1]` while the WS path stores `["a"]`. The WS path is the correct one; converging the POST routes onto the same validator is a follow-up (§4.13), not a silent behaviour change in this section. |

---

### 4.6 `POST /api/agents` — Credential Issuance

The response becomes `201 { agent, credential }`. `credential` is present **exactly once**, on this response; it is never recoverable afterwards, because only its hash is stored and there is no rotation endpoint in this section.

```ts
// src/utils/agent.ts
export function generateAgentCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ag_${buf2hex(bytes.buffer)}`;
}
```

```ts
// src/routes/agents.ts  — POST /
const credential = generateAgentCredential();

const [created] = await db
  .insert(agents)
  .values({
    id: body.id,
    userId: user.id,
    hostname: body.hostname ?? null,
    platform: body.platform ?? null,
    osVersion: body.osVersion ?? null,
    agentVersion: body.agentVersion ?? null,
    publicKey: body.publicKey,
    isOnline: false,
    credentialHash: await sha256Hex(credential),
    capabilities: body.capabilities ? JSON.stringify(body.capabilities) : null,
  })
  .returning();

if (!created) {
  throw new AppError('Failed to register agent', 500, 'INTERNAL_SERVER_ERROR');
}

return c.json({ agent: toPublicAgent(created), credential }, 201);
```

| # | Decision | Rationale |
|---|---|---|
| **D18** | **The `409 AGENT_EXISTS` pre-check is kept, unchanged and first.** | `agents.id` is a caller-supplied primary key with no `$defaultFn`, so a repeat registration is a `UNIQUE` violation. The existing pre-check converts it to a typed `409`; issuing a credential before that check would mint a credential for an agent that is never created. The check runs before `generateAgentCredential()`. |
| **D19** | **The plaintext credential is never stored and never logged.** | Only `sha256` hex reaches D1. There is no `credential` column, so a database read cannot yield a usable credential. |
| **D20** | **`capabilities` is stored as a JSON string or `NULL`, not `'[]'`.** | Mirrors `sessions.metadata` (`body.metadata ? JSON.stringify(...) : null`). `NULL` means "not reported"; `'[]'` would mean "reported, and it supports nothing". The projection collapses both to `[]` for the wire (§4.10). |
| **D21** | **The `201` body is a projection, not the row.** | W12. After this section the row contains `credential_hash`; returning the row wholesale would hand every caller the hash. `toPublicAgent` is now a security boundary, not a convenience. |
| **D22** | **The response shape change is accepted and the test type is updated in the same commit.** | W17. `{ agent, credential }` is required by the task. Existing assertions read only the status, so no assertion changes — but `AgentResponse` in `test/resources.test.ts` must gain `capabilities` and rename `lastPingAt` to `lastHeartbeat` so the file keeps describing reality. |

#### 4.6.1 `GET /api/agents` and `GET /api/agents/:id`

Both must route through `toPublicAgent`:

```ts
router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(list.map(toPublicAgent));
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = getDb(c.env.DB);
  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!agent) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  return c.json(toPublicAgent(agent));
});
```

The list filter stays `userId = caller`, matching the existing tenancy predicate. `GET /:id` keeps its combined `(id, userId)` lookup — the ownership half must not be dropped when the projection is added.

---

### 4.7 `POST /api/signal/*` — Best-Effort Push

Each of the three POST routes changes in exactly two places: the insert goes through `recordSignal`, and `pushToAgent` follows it.

```ts
// src/routes/signal.ts  — POST /answer, shown in full; /offer and /ice-candidate differ only in the message
const db = getDb(c.env.DB);
const session = await getOwnedActiveSession(db, body.sessionId, user.id);

const message: SignalMessage = {
  type: 'answer',
  data: {
    sessionId: body.sessionId,
    sdp: body.sdp,
    approved: body.approved !== false,
  },
};

const inserted = await recordSignal(db, message);
if (!inserted) {
  throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
}

// Fire-and-forget, synchronous, never throws (D9). `session.agentId` comes
// from the row `getOwnedActiveSession` already fetched, so no extra query.
pushToAgent(session.agentId, message);

return c.json(
  {
    id: inserted.id,
    sessionId: inserted.sessionId,
    type: inserted.type,
    createdAt: inserted.createdAt,
  },
  201,
);
```

```ts
// src/utils/signals.ts
export const SIGNAL_TTL_SQL = sql`datetime('now', '+5 minutes')`;

/**
 * The single write path for `signals`, shared by the REST routes and the agent
 * socket. `type` and `payload` are derived from the `SignalMessage` so the two
 * callers cannot disagree about a row's shape.
 */
export async function recordSignal(
  db: Database,
  message: SignalMessage,
): Promise<SignalSelect | null> {
  const [inserted] = await db
    .insert(signals)
    .values({
      sessionId: message.data.sessionId,
      type: message.type,
      payload: JSON.stringify(message.data),
      expiresAt: SIGNAL_TTL_SQL,
    })
    .returning();

  return inserted ?? null;
}
```

| # | Decision | Rationale |
|---|---|---|
| **D23** | **The refactor is byte-identical on the wire, and that was checked.** | The `201` body is rebuilt from the returned row with the same four fields in the same order. `JSON.stringify(message.data)` reproduces the current payload construction key-for-key: `{sessionId, sdp, approved}` for an answer, `{sessionId, sdp, capabilities}` for an offer, `{sessionId, candidate, sdpMid, sdpMLineIndex}` for a candidate. W13 confirms the stored row is indistinguishable. No existing `signal.test.ts` assertion changes. |
| **D24** | **The push target is `session.agentId`, read from the row the route already has.** | `getOwnedActiveSession` returns the full session row, so the push costs no additional query. |
| **D25** | **The push is not awaited and its result is discarded.** | The task's requirement is that a push failure never fails the request. A `Promise`-returning helper would be `await`-able by a future edit and reintroduce the coupling; `void` makes the intent structural. |
| **D26** | **No push when `session.agentId` is `NULL`.** | An agentless session has no socket to push to; `pushToAgent` returns immediately on a `null` id. |
| **D27** | **The push is not the browser's delivery path.** | W15. When the agent is in another isolate, or offline, or the socket died without a `close` event, the row is still in D1 and the browser's existing poll returns it. The push only removes latency. |

---

### 4.8 Migration `0002_agent_credentials.sql`

#### 4.8.1 Schema additions (`src/db/schema.ts`)

```ts
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  hostname: text('hostname'),
  platform: text('platform'),
  osVersion: text('os_version'),
  agentVersion: text('agent_version'),
  publicKey: text('public_key').notNull(),
  isOnline: integer('is_online', { mode: 'boolean' }).notNull().default(false),
  lastPingAt: text('last_ping_at'),
  credentialHash: text('credential_hash').unique(),
  capabilities: text('capabilities'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const sessions = sqliteTable('sessions', {
  // …unchanged fields…
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at'),
  // …unchanged fields…
});
```

`credentialHash` is nullable on purpose: rows that predate the migration have no credential and cannot authenticate. That is correct — an agent must be re-registered to obtain one — and it is what makes W2 (many `NULL`s under one unique index) load-bearing.

`startedAt` has no default and no writer in this section. It is added because `packages/shared`'s `Session` already declares `startedAt: string | null` (`types/session.ts`) and the Week 5 session lifecycle needs the column to exist; adding it here keeps the Week 5 migration from being a second `ALTER TABLE sessions`.

#### 4.8.2 The migration

Generated with `pnpm --filter @remote/signaling db:generate`, then the random tag renamed to `0002_agent_credentials` in both the filename and `_journal.json`'s `tag` field (keep the generated `when`). **The exact generated statements are:**

```sql
ALTER TABLE `agents` ADD `credential_hash` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `capabilities` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_credential_hash_unique` ON `agents` (`credential_hash`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `started_at` text;
```

| # | Decision | Rationale |
|---|---|---|
| **D28** | **`credential_hash TEXT UNIQUE` is written as `ADD COLUMN` + `CREATE UNIQUE INDEX`, not as an inline column constraint.** | **W1: the inline form does not exist.** `ALTER TABLE … ADD COLUMN … TEXT UNIQUE` fails with `Cannot add a UNIQUE column` on SQLite 3.53.4 and on D1. The task's shorthand is the *intent*; this is the only SQL that expresses it. |
| **D29** | **The unique index is the enforcement point, and it is what the lookup relies on.** | W2: it rejects a duplicate hash while permitting any number of `NULL`s, so the migration applies to a populated `agents` table. `eq(agents.credentialHash, hash)` then resolves to one indexed probe. |
| **D30** | **`meta/0002_snapshot.json` is mandatory; the migration is not hand-written.** | Week 4 ruling R2: without the snapshot, the next `db:generate` emits a duplicate migration, and a hand-invented `when` is not a value the tool produces. |
| **D31** | **The test fixture keeps the *inline* `UNIQUE`, while the migration uses the separate index.** | The fixture is a `CREATE TABLE` (`test/helpers.ts`), where inline `UNIQUE` is valid and creates the same auto-index — verified: the fixture rejects a duplicate hash and reports `sqlite_autoindex_agents_2`. The asymmetry is real, is required by W1, and is the single most likely thing for a later reader to "fix" into breakage. |

#### 4.8.3 `test/helpers.ts`

The `agents` and `sessions` `CREATE TABLE` strings in `RESET_STATEMENTS` gain the three columns:

```sql
  credential_hash TEXT UNIQUE,
  capabilities TEXT,
```

```sql
  started_at TEXT,
```

Because the inline `UNIQUE` admits multiple `NULL`s (W2), the existing fixtures that insert agents without a credential continue to work untouched.

---

### 4.9 `toPublicAgent`

`src/utils/agent.ts`, mirroring `src/utils/user.ts` exactly — one projection, in one place, applied by every route that lets an `agents` row leave the worker.

```ts
import type { Agent as SharedAgent } from '@remote/shared';
import type { AgentSelect } from '../db/schema';

export type PublicAgent = SharedAgent;

/**
 * `capabilities` is stored as a JSON string. A malformed value, a non-array, or
 * non-string members all collapse to `[]` rather than throwing: this runs on
 * the response path of every agent route, and a bad column value must not turn
 * a list request into a 500.
 */
function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function toPublicAgent(agent: AgentSelect): PublicAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    hostname: agent.hostname,
    platform: agent.platform,
    osVersion: agent.osVersion,
    agentVersion: agent.agentVersion,
    publicKey: agent.publicKey,
    isOnline: agent.isOnline,
    lastHeartbeat: agent.lastPingAt,
    capabilities: parseCapabilities(agent.capabilities),
    createdAt: agent.createdAt,
  };
}
```

| # | Decision | Rationale |
|---|---|---|
| **D32** | **The return type is `SharedAgent` itself, not a hand-copied shape.** | W16: the compile-time proof `const _assignable: (a: PublicAgent) => SharedAgent = (a) => a` typechecks. Typing the projection as the shared contract means a future divergence between D1 and the wire type is a compile error rather than a silent drift. |
| **D33** | **`last_ping_at` is exposed as `lastHeartbeat`.** | The shared `Agent` contract names the field `lastHeartbeat` (`types/user.ts:39`); the D1 column is `last_ping_at`. The projection is the only place the rename happens. This closes the drift the Week 5 reconnaissance flagged between the table and `packages/shared`. |
| **D34** | **`credentialHash` is absent from the projection by construction, not by omission.** | The field is not in the object literal, so it cannot be spread in later. W12 confirms the serialized list body contains no `credentialHash`. |
| **D35** | **`capabilities` is defensive on the read path.** | The column is `TEXT` written by this worker, but it is also readable by anything with D1 access, and a `JSON.parse` on the response path is exactly where an unguarded throw becomes a 500. |

---

### 4.10 Test Plan

| File | Covers | ≈ count |
|---|---|---|
| `test/ws.test.ts` **(new)** | `401` for missing header, for a non-`Bearer` scheme, and for an unknown credential — all three with the identical body; `426` for a valid credential with no `Upgrade`; `101` + registration in `agentConnections`; socket replacement leaves exactly one entry; closing the superseded socket leaves the map and `is_online` alone (W8); close evicts and sets `is_online = 0`; `ping` → `pong` and `is_online = 1` with a space-format `last_ping_at` (W10); `MALFORMED_JSON`; unknown `type` → `VALIDATION_ERROR`; `answer` with no `sdp` → `VALIDATION_ERROR`; an accepted `answer` is echoed **and** appears in the browser's poll with the POST-identical payload (W13); a candidate round-trips with `sdpMid`/`sdpMLineIndex` coerced to `null`; foreign `sessionId` → `NOT_FOUND`; a session whose `agentId` is `NULL` → `NOT_FOUND`; nothing is written to `signals` on either rejection (W14) | 16 |
| `test/resources.test.ts` (extend) | `201 { agent, credential }`; `credential` matches `/^ag_[0-9a-f]{32}$/`; the stored value is the 64-char hash and not the credential; `capabilities` round-trips; `lastHeartbeat` is `null` before any ping; duplicate id still `409 AGENT_EXISTS` **and no credential is minted**; list and get contain no `credentialHash` (W12) | 6 |
| `test/signal.test.ts` (extend) | a POST pushes to a connected agent's socket with the `{ type: 'signal', data }` envelope; a push to an agent with no socket still returns `201`; a push to a dead socket still returns `201` and drops the entry (W7); no push when `session.agentId` is `NULL`; the `201` body is unchanged by the `recordSignal` refactor (D23) | 5 |
| `test/db.test.ts` (extend) | the three statements apply on top of `0000`+`0001`; a legacy row survives with `NULL` in both new agent columns (W3); a duplicate `credential_hash` is rejected while `NULL` repeats (W2); `sessions.started_at` exists | 4 |

**Suite: 135 → ≈166.**

| # | Decision | Rationale |
|---|---|---|
| **D36** | **Tests drive the real `app` from `src/index.ts`, and the WS cases use `app.request(url, init, env)` with `res.webSocket`.** | The pool supports the upgrade (`res.status === 101`, `res.webSocket` present, `accept()`, `message`/`close` events) and CORS headers survive onto the `101` (`Access-Control-Allow-Origin: *`). Mounting through the real app exercises the mount path and the global CORS middleware, which a separately-mounted probe router would not. |
| **D37** | **The `426` case is pinned in the pool even though the pool cannot reproduce the underlying `500`.** | W6: the pool is permissive and returns `101` where real workerd returns `500`. The guard's *observable* — `426` — is testable in the pool, so it is pinned there; the `500` it prevents was confirmed once in `wrangler dev` and is recorded in W6 rather than left as an untested claim. |
| **D38** | **The migration is asserted against a legacy row, not just an empty table.** | W3. An empty-table test passes for a migration that would fail on real data. |
| **D39** | **Timers are never faked in `ws.test.ts`.** | The heartbeat under test is agent-initiated (D12); no worker-side interval exists to advance. Tests drive it by sending a `ping` frame, which is deterministic. |

---

### 4.11 Review Focus & Edge Cases

**Security**

- **The projection is now load-bearing.** `credentialHash` reaches the response body the moment any route returns a raw `agents` row. All three agent routes (`POST /`, `GET /`, `GET /:id`) must go through `toPublicAgent`; a missed one leaks the hash of every agent that user owns.
- **`401` must be identical for "no header", "wrong scheme", and "unknown credential".** A distinguishing body or status turns the endpoint into a credential oracle.
- **Tenancy is two conjuncts, not one.** `session.userId === agent.userId` **and** `session.agentId === agent.id`. Checking only the first re-creates the Week 4 gap (`2026-09-25-phase2-week4-webrtc-core-design.md` §5.4) where the browser and the agent were the same principal; checking only the second would let an agent answer a session belonging to another user.
- **A `NULL` `session.agentId` must reject.** `session.agentId !== agent.id` covers it, but only because the comparison is `!==` against a non-null id — an `if (session.agentId && …)` guard would let agentless sessions through.
- **The credential never appears in a URL.** D5. A query parameter would be logged by Cloudflare, stored in `Referer`, and retained in browser history.
- **`sha256` is the right primitive here and PBKDF2 would be wrong.** The credential is 128 bits of CSPRNG output (W11); there is no dictionary to slow an attacker down with, and per-connect PBKDF2 at 100k iterations would be a self-inflicted cost.

**Correctness**

- **The `close` identity guard is the highest-risk item.** W8 shows the unguarded version evicting a live socket and clearing `is_online` for a connected agent, and the symptom — an agent that shows offline while its socket is open — reads as a UI bug, not a server bug.
- **Registration must precede the `101`.** D2. Registering after the response, or in an `onOpen` that never fires (W4), produces an agent that connects and is never reachable by a push.
- **The `Upgrade` guard must not reorder the `401`.** D4. Guarding first makes an unauthenticated `GET` a `426`, contradicting the specified `401`.
- **`recordSignal` must not change the POST bodies.** D23. The refactor is only safe because the payload key order and the four response fields are preserved; a reordering would break a client comparing payloads and is invisible to the existing tests.
- **`pushToAgent` must stay non-throwing.** W7 shows `send()` throwing on a closed server socket; the `try/catch` plus the identity-guarded delete is what keeps a dead socket from turning a successful insert into a `500`.
- **`last_ping_at` and `started_at` must use `datetime('now')`.** W10. A single `toISOString()` in either column mixes two lexical formats and breaks every `datetime()` comparison over that column.

**Boundaries**

- **`packages/shared` is not modified.** The union is reused as-is; the transport discriminator lives in the worker's own frame type. `sdp: string` and `candidate: string` stay `string` (Week 4 ADR-07).
- **No new binding, no Durable Object.** `Bindings` and `wrangler.toml` are untouched; `agentConnections` is process-local state and nothing may depend on a hit (W15).
- **The fixture's inline `UNIQUE` is intentional.** D31/W1. The fixture is a `CREATE TABLE`; the migration is an `ALTER TABLE`. They cannot use the same spelling.

**Testing**

- **The socket-replacement case needs both ends.** A test that only opens one socket cannot observe W8; it must open two, close the first, and assert the second survives.
- **The tenancy tests must assert D1 was not written**, not merely that an error frame came back. A rejected frame that still inserts is the failure mode that matters.
- **The migration test needs a pre-migration row.** D38.
- **No timers are faked.** D39.

---

### 4.12 Delivery Sequence

| # | Task | Deliverable | Tests |
|---|---|---|---|
| 1 | **Schema + migration** | `schema.ts` fields; `0002_agent_credentials.sql` + snapshot + journal; fixture columns | 4 |
| 2 | **Shared helpers** | `utils/crypto.ts` (`sha256Hex`, exported `buf2hex`), `utils/agent.ts`, `utils/signals.ts` | 0 (covered via 3-5) |
| 3 | **Credential issuance** | `routes/agents.ts`: credential on `POST`, projection on all three routes | 6 |
| 4 | **Agent socket** | `routes/ws.ts`; mount in `index.ts` | 16 |
| 5 | **Best-effort push** | `routes/signal.ts` through `recordSignal` + `pushToAgent` | 5 |

Tasks 1 and 2 have no tests of their own and must land first: 3 depends on 1 (the column) and 2 (the generator and projection); 4 depends on 1, 2, and the map; 5 depends on 4 for `pushToAgent` and on 2 for `recordSignal`. Task 3 and 4 are independent of each other once 1 and 2 land, and can proceed in parallel.

**Verification gate:** `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`, with the suite growing from **135** to **≈166**.

---

### 4.13 Out of Scope

| Item | Why, and what this section owes it |
|---|---|
| **The Rust agent (`apps/agent`)** | Week 5's other half. This section defines the wire contract it must implement (§4.3) and the credential it authenticates with (§4.6); it writes no Rust. |
| **Credential rotation and revocation** | No `POST /api/agents/:id/rotate`, no revocation list. The operational consequence is stated plainly: a leaked credential can only be invalidated by deleting and re-registering the agent, which changes its `id` and detaches its sessions. |
| **`PUT`/`DELETE /api/agents/:id`** | Listed in `ARCHITECTURE.md:968-973` and still missing. Deleting an agent must detach `sessions.agent_id` first, exactly as `routes/devices.ts` does for `devices` — otherwise the FK rejects the delete. |
| **Durable Objects and Hibernation** | Would replace `agentConnections` with a per-agent object that outlives an isolate, closing W15. The map is deliberately the smallest thing that makes the push work today. |
| **Worker-initiated liveness probing** | W9 proves a `setInterval` can run and write to D1, so a half-open socket could be detected by a worker-side ping. Deferred: it needs a timeout policy, it is per-isolate, and it is unnecessary while the agent pings every 30 s. |
| **A TTL sweep for `signals`** | Week 4 follow-up C11. `expires_at` is written and filtered but nothing deletes expired rows; `signals_expires_at_idx` exists for it. |
| **Converging the POST routes onto `parseSignalMessage`** | D17. The validator is stricter than the POST coercion; using it on both paths would make the two writers provably identical. That is a behaviour change to existing routes and belongs in its own commit. |
| **`WebSocketTransport` in `packages/webrtc-core`** | Week 4's ADR-02 seam. It is a *browser* transport and the browser keeps polling; this section does not touch `webrtc-core`. |
| **Session lifecycle (`started_at` writes, approval flow)** | The column lands here; the Week 5 session-management work writes it. |

---

## 5. Application Design: Rust Desktop Agent (`apps/agent`)

**Crate:** `remote-agent` (edition 2021), binary target `remote-agent` · **Roadmap:** `docs/ARCHITECTURE.md:1193` — Tuần 5: Desktop Agent - Terminal

> **Scope note.** This section designs the **answerer** half of the Week 4 connection. Week 4 delivered
> `packages/webrtc-core` (browser/Node offerer) and the four `/api/signal/*` REST routes; the agent is
> the peer that completes the handshake and turns a `terminal` data channel into a real PTY.
> Week 5 also introduces the **agent-scoped credential** that `ARCHITECTURE.md:955` and the Week 4 spec
> §5.4 both deferred to this week.

---

### 5.1 Scope & Non-Goals

### In scope

1. A Rust binary crate `remote-agent` at `apps/agent/`, four source files: `main.rs`, `signal.rs`,
   `rtc.rs`, `pty.rs`.
2. A **WebSocket signaling client** over `tokio-tungstenite` carrying the same `SignalMessage` wire
   shape Week 4 already fixed in `packages/shared/src/types/signaling.ts`.
3. A **`webrtc`-crate answerer**: accept an `offer`, produce an `answer`, trickle ICE in both
   directions over the WS, and receive the `terminal` data channel.
4. A **PTY bridge**: spawn a shell through `portable-pty` and pump bytes both ways, framed as
   `DataChannelMessage<TerminalDataMessage>` with base64 payloads.
5. A **clap CLI** and a linear startup pipeline, with `Ctrl-C` teardown.
6. Agent authentication: `Authorization: Bearer ag_…` on the WS handshake.

### Non-goals (deferred, with the phase that owns each)

| Deferred | Owned by | Why it is not stubbed |
|---|---|---|
| **`media_channel` / screen capture / H.264-H.265** | Phase 3 (`ARCHITECTURE.md:1207-1230`) | Same call as Week 4's ADR-06. No file, no feature flag, no dead code. The `desktop` channel label exists in `WebRTCChannelType` but the agent never requests it. |
| **File transfer (`files` channel)** | Phase 4 (Tuần 10-11) | Nothing in Week 5's pipeline reads a filesystem path from the peer. |
| **Terminal resize end-to-end** | Week 6 (Tuần 6: *"Handle resize events"*) | `TerminalResizeMessage` already exists in `packages/shared/src/types/terminal.ts:21`; `pty.rs` exposes `resize()` and the frame decoder accepts `terminal-resize`, but the browser sender is Week 6. See §5.7.4. |
| **Multi-session concurrency** | Week 11+/hardening | Week 5 serves **one active session per agent process**; a second offer is refused with `approved: false` (§5.6.4). |
| **ICE restart on WS reconnect** | follow-up | Week 5 reconnects the socket and re-joins as a *new* session; an in-place ICE restart is not attempted (§5.5.5). |
| **Physical approval dialog** | Week 12 (`ARCHITECTURE.md:1255`) | The `approved` flag is a **policy check**, not a human prompt (§5.6.4). |
| **`agent.toml`, `config.rs`** | not scheduled | Configuration is CLI + environment (§5.8.1). `ARCHITECTURE.md:351,384` describes a target layout, not a Week 5 deliverable. |
| **`capture/`, `files/`, `security/`, `utils/` trees** | Phases 3-5 | `ARCHITECTURE.md:349-382` lists ~20 files; Week 5 creates 4 (§5.3, ADR-07). |

---

### 5.2 Verified Findings

Every finding was checked against the crates.io API, upstream source at the pinned tags, or this
repository. Versions are as published on **2026-09-26**.

| # | Finding | Evidence |
|---|---|---|
| **R1** | **`webrtc` 0.13 is a real, installable line; `0.21.0` is current.** The 0.13 line contains exactly one release, `0.13.0` (2025-05-14). | `crates.io/api/v1/crates/webrtc/versions` → `0.21.0, 0.20.5, …, 0.17.2, 0.14.0, 0.13.0, 0.12.0`. |
| **R2** | **`webrtc` 0.13.0's default feature set is empty** (`features = {openssl, pem, vendored-openssl}`, no `default` key), so the default build uses **rustls 0.23.27 + ring 0.17.14**, not OpenSSL. No `libssl-dev` is required; a C toolchain is (`ring` compiles asm via `cc`). | `webrtc/Cargo.toml` at tag `v0.13.0`; `crates.io/api/v1/crates/webrtc/0.13.0` → `features: {…}` with no `default`. |
| **R3** | **`add_ice_candidate` hard-fails before the remote description is set.** This is the Rust twin of Week 4's F1, and it is *worse* than the TypeScript case: werift silently mis-handles it, `webrtc` returns an error, so a naive implementation drops candidates and the connection fails with `ErrNoRemoteDescription`. | `webrtc/src/peer_connection/mod.rs:1651-1654` — `pub async fn add_ice_candidate(…) { if self.remote_description().await.is_none() { return Err(Error::ErrNoRemoteDescription); } … }`. |
| **R4** | **ICE gathering completion is signalled by `on_ice_candidate(None)`.** The handler type is `Box<dyn FnMut(Option<RTCIceCandidate>) -> …>`. | `webrtc/src/ice_transport/ice_gatherer.rs:33-37`; doc note on `on_ice_candidate`: *"the handler is gonna be called with a nil pointer when gathering is finished"*. |
| **R5** | **The answerer must not create the data channel.** `create_data_channel` is an offerer-side call; the answerer learns channels through `on_data_channel(Arc<RTCDataChannel>)`. | `peer_connection/mod.rs:1837` (`create_data_channel`) vs `:315` (`on_data_channel`); `examples/data-channels-create` creates, `examples/data-channels` accepts. |
| **R6** | **`RTCIceServer.username` / `.credential` are `String`, not `Option<String>`** — a STUN-only server needs `..Default::default()`, and there is no "absent credential" representation. | `webrtc/src/ice_transport/ice_server.rs:14-18`. |
| **R7** | **`RTCIceCandidateInit.sdp_mid` / `sdp_mline_index` are `Option`, and `sdp_mline_index` is `u16`** — narrower than the wire type's `number \| null`. A candidate with a negative or >65535 index must be rejected, not truncated. | `webrtc/src/ice_transport/ice_candidate.rs:154-160`. |
| **R8** | **`RTCDataChannel::on_open` takes an `FnOnce`**, while `on_message` takes an `FnMut`. A closure that fires more than once cannot be reused for `on_open`. | `webrtc/src/data_channel/mod.rs:41-45` (`OnOpenHdlrFn` uses `FnOnce`), `:35-39` (`OnMessageHdlrFn` uses `FnMut`). |
| **R9** | **Inbound frames are `DataChannelMessage { is_string: bool, data: Bytes }`** — a struct, not an enum, and **not** a `Result`. Text and binary are distinguished by a flag, so a base64-in-JSON-text frame arrives with `is_string == true`. | `webrtc/src/data_channel/data_channel_message.rs:1-10`. |
| **R10** | **`portable-pty`'s reader and writer are blocking `std::io` objects.** `try_clone_reader() -> Box<dyn Read + Send>` and `take_writer() -> Box<dyn Write + Send>`; there is no async variant. Dropping the writer sends EOF to the child. | `pty/src/lib.rs:99,104` (+ doc comment at `:102`). |
| **R11** | **`portable-pty` 0.9.0 is the newest release in that line** (2025-02-11); the architecture document's `portable-pty = "0.8"` (`ARCHITECTURE.md:663`) is stale. | `crates.io/api/v1/crates/portable-pty/versions` → `0.9.0, 0.8.1, 0.8.0, …`. |
| **R12** | **`tokio-tungstenite`'s default features do not include TLS.** `default = ["connect", "handshake"]`; `wss://` requires `rustls-tls-webpki-roots` (or `native-tls`). A `wss://` deployment silently fails to build/connect without it. | `tokio-tungstenite/Cargo.toml` at `v0.26.2:19-21`; feature list on crates.io. |
| **R13** | **`futures-util` is not re-exported and is required.** `SinkExt`/`StreamExt` (`send`, `next`, `split`) come from `futures-util`, which `tokio-tungstenite` only `use`s internally; it re-exports `tungstenite`, `Bytes`, the TLS connector and the `connect_*` functions. Without a direct dependency the client does not compile. | `tokio-tungstenite/src/lib.rs:27-28,53-64`; `Cargo.toml:33`. |
| **R14** | **`tungstenite` re-exports `bytes::Bytes`**, so `Message::Ping` payloads need no direct `bytes` dependency. | `tungstenite/src/lib.rs:43` — `pub use bytes::Bytes;`. |
| **R15** | **`tungstenite` answers inbound pings automatically but does not flush them.** *"upon receiving ping messages tungstenite queues pong replies automatically"*, and `write` *"will generally not flush"*. The client must `flush()` on a timer or the queued pong sits in the buffer. | `tungstenite/src/protocol/mod.rs:267-277,538-540`. |
| **R16** | **`base64` 0.23 uses the `Engine` API.** The old free functions (`base64::encode`) were removed in 0.22; code must use `base64::prelude::BASE64_STANDARD.encode(…)` / `.decode(…)`. | `base64/src/lib.rs:1-41` at `v0.23.1`. |
| **R17** | **The `ag_` credential does not exist server-side.** `workers/signaling/src/middleware/auth.ts` validates only user JWTs via `verifyTokenForUser(…, 'access', …)`; `grep -rn "ag_" workers/signaling/src/` returns nothing, and there is no agent-token column or table. | `middleware/auth.ts:28-52`; `db/schema.ts:52-68` (`agents` has `publicKey`, no secret/token column). |
| **R18** | **There is no WebSocket endpoint anywhere in the Worker.** `src/index.ts` mounts six REST routers and a `/health` route; there is no `/ws`, no `Upgrade` handling, no `WebSocketPair`, and no Durable Object. `wrangler.toml` declares no `[[durable_objects]]`. | `workers/signaling/src/index.ts` (26 lines, read in full); `grep -rn "WebSocketPair\|upgrade" workers/signaling/src/` → no matches; `wrangler.toml`. |
| **R19** | **`POST /api/signal/answer` rejects an empty `sdp`.** `if (!body?.sessionId \|\| typeof body.sdp !== 'string' \|\| !body.sdp.trim())` → `400 VALIDATION_ERROR`. A refusal cannot be expressed as an empty-SDP answer. | `workers/signaling/src/routes/signal.ts:100-107`. |
| **R20** | **The existing ownership predicate can host an agent token unchanged.** Every signal route resolves the session with `and(eq(sessions.id, sessionId), eq(sessions.userId, user.id))`; if an `ag_` token resolves to `agents.userId`, the owner id is the same value the predicate already compares. | `routes/signal.ts:22-43`; `routes/sessions.ts:109`. |
| **R21** | **The JS toolchain is already inert on `.rs` files, and `target/` is ignored.** Prettier does not parse Rust (verified: `prettier --check` on a directory containing `.rs` exits 0 with *"All matched files use Prettier code style"*); the ESLint flat config only matches `packages/**/*.ts`, `apps/**/*.{ts,vue}`, `workers/**/*.ts` (verified: `eslint` on a directory containing only `a.ts` + `main.rs` exits 0 without touching the `.rs`); `.prettierignore` already lists `target`; `.gitignore` already lists `target/` and does not ignore `Cargo.lock`. | `eslint.config.js` `files` arrays; `.prettierignore`; `.gitignore`; both probes run locally. |
| **R22** | **`apps/agent/package.json` is a 10-line stub** with `lint`/`typecheck` as `echo ok`, **no `test` script**, and no dependencies. Turbo therefore runs nothing for it, and it has no Cargo project behind it. | `apps/agent/package.json` (read in full); `find . -name Cargo.toml` → no matches. |
| **R23** | **`ARCHITECTURE.md:1308` references `apps/agent/.env.example`**, which does not exist; `.gitignore` does **not** match `.env.example` (it matches `.env`, `.env.local`, `.env.*.local`, `*.env`), so a template file is safe to commit. | `ARCHITECTURE.md:1303-1310`; `.gitignore`. |
| **R24** | **Local Rust toolchain is 1.98.1** (`cargo 1.98.1 (797e8a9bc 2026-08-05)`), which clears every MSRV in the dependency set (clap 4.6.7 → 1.85; base64 0.23.1 → 1.71; tokio-tungstenite 0.26.2 → 1.63). | `rustc --version`; `cargo --version`; per-crate `rust_version` from the crates.io API. |

#### 5.2.1 What this section cannot verify from this repository

- **The WS wire protocol has no server to agree with.** R18 means the endpoint the client dials does
  not exist yet. §5.9 therefore *specifies* the protocol as a contract and names the Worker-side
  relay as a companion deliverable; it is not "verified" because there is nothing to verify against.
- **No Rust code has been compiled.** The API facts above come from upstream source at the pinned
  tags and from `docs.rs`, not from a successful `cargo build`. §5.4's version note and the
  scaffold-time checklist exist because of this.

---

### 5.3 Architectural Decision Records

### ADR-07: Four files, not the twenty in `ARCHITECTURE.md`

**Context.** `ARCHITECTURE.md:348-384` sketches `config.rs`, `webrtc/{mod,connection,data_channel,media_channel,signal_handler}.rs`, `terminal/{mod,pty,process_manager,session}.rs`, `capture/`, `files/`, `security/`, `utils/` — roughly twenty files across five phases.

**Decision.** Week 5 creates exactly four: `main.rs`, `signal.rs`, `rtc.rs`, `pty.rs`. Configuration
folds into `main.rs` (clap derive). `agent.toml` is not created.

**Rationale.** Identical to Week 4's ADR-06: a file that exists to hold nothing must be linted,
reviewed and explained. `config.rs` would contain one `#[derive(Parser)]` struct that already lives
naturally in `main.rs`. The architecture document describes a destination; each phase adds the module
when it has content.

**Consequence.** The crate layout diverges from `ARCHITECTURE.md:349-357` by sixteen files. Recorded
here so a future reader does not file it as drift. `ARCHITECTURE.md:663` (`portable-pty = "0.8"`) and
`:658` (`webrtc = "0.10"`) are also stale and should be corrected when the agent lands (R1, R11).

### ADR-08: `webrtc` crate, pinned to the 0.13 line, with the exact version confirmed at scaffold

**Context.** The agent needs a native WebRTC stack. The alternatives are `webrtc` (pure Rust, the
`webrtc-rs` project), `str0m` (Sans-IO, no data-channel/PTY-shaped ergonomics, smaller surface but
requires the caller to drive the state machine by hand), or linking a browser engine (not viable for
a headless host agent).

**Decision.** Use `webrtc = "0.13"`, resolving to `0.13.0`, with default features (R2). Do **not**
enable `openssl` or `vendored-openssl`.

**Rationale.** `webrtc` is the only crate in the set that ships the exact primitives the design needs
as first-class API — `create_answer`, `set_remote_description`, `on_ice_candidate`,
`on_data_channel`, `send_text` — and its `examples/data-channels` is a working answerer, which is
precisely the shape of this component. The 0.13 line is what the Week 5 task pins, and R1 confirms it
is a real, non-yanked release. Staying on default features keeps OpenSSL out of the build (R2), which
matters because a system TLS library is the most common reason a Rust CI job fails on a fresh runner.

**Consequence.** `webrtc` 0.13.0 depends on `rustls 0.23.27` + `ring 0.17.14`, so the build needs a C
compiler and the CI job needs a cache. Upstream is on 0.21 (R1); a future bump is a deliberate
migration, not a `cargo update`. Because nothing here has been compiled (§5.2.1), the scaffold task
must re-confirm the exact patch versions on crates.io and **commit `Cargo.lock`** (R21: it is not
gitignored).

### ADR-09: The agent is answerer-only and never creates a data channel

**Context.** The browser is the offerer: it creates the session, posts the offer, and (per Week 4's
F2) declares the `terminal` channel *before* `createOffer`. The agent receives the offer.

**Decision.** `rtc.rs` calls `set_remote_description` → `create_answer` → `set_local_description` and
accepts channels only via `on_data_channel` (R5). It never calls `create_data_channel`. It also
enforces that the inbound channel's `label()` is exactly `terminal`, and closes any channel whose
label is not in the `WebRTCChannelType` set.

**Rationale.** This mirrors the browser's own F2 ordering requirement from the other side: only the
offerer declares channels, so an answerer that also declares one produces a second `m=application`
section and the two peers disagree about the SCTP association. Enforcing the label set is a
correctness *and* security property — an unexpected label (`desktop`, `files`, `control`) is a
channel the agent has no handler for, and silently keeping it open would be an unreviewed surface.

**Consequence.** `capabilities` in the offer is advisory metadata; the authoritative check is the
label that actually opens. If the offer advertises `terminal` but no `terminal` channel opens within
the connect timeout, the agent tears the session down rather than idling (§5.6.4).

### ADR-10: Base64 inside JSON text frames, not binary frames

**Context.** PTY output is arbitrary bytes. Terminal streams routinely split a multi-byte UTF-8
sequence across two `read()` calls, so the agent cannot assume any given chunk is valid UTF-8. The
browser peer receives whatever the offerer's channel was created with, and Week 4 commit `5b8ed86`
(`fix(webrtc-core): pass string directly in WeriftAdapter to preserve WEBRTC_STRING PPID`) shows the
channel is string-oriented end to end.

**Decision.** Every data-channel frame is a JSON `DataChannelMessage<TerminalDataMessage>` sent with
`send_text`, whose `payload.data` is standard base64 (RFC 4648, padded) of the raw PTY bytes. Inbound
frames are decoded the same way. `terminalId` carries the session id.

**Rationale.** It keeps the channel in text mode (consistent with the Week 4 fix and with
`DataChannelMessage<T>`'s existing shape in `packages/shared/src/types/webrtc.ts:9-14`), it is
byte-exact for any input including `0x00` and invalid UTF-8, and it reuses the framing the browser
already knows. The cost is a 4/3 size inflation, which §5.7.3's chunk size accounts for.

**Rejected:** raw binary frames (a second framing mode the browser peer would have to negotiate, and
it breaks the `DataChannelMessage` envelope the shared types already fix); lossy UTF-8 text
(corrupts output on split sequences and on non-UTF-8 terminal output).

**Consequence.** `base64` 0.23's `Engine` API is mandatory (R16). Frame size is bounded by the chunk
size, not by the SCTP limit alone (§5.7.3).

### ADR-11: Backpressure by bounded channel, not by polling `buffered_amount`

**Context.** A user can run `yes` or `cat /dev/urandom`. If the PTY reader pushes into an unbounded
queue, the agent's memory grows without limit while the browser drains slowly. `webrtc` does expose
`buffered_amount()` and `set_buffered_amount_low_threshold()`, but wiring those into a reader loop
means the reader must poll an async accessor from a blocking thread.

**Decision.** The PTY reader thread writes into a **bounded `tokio::sync::mpsc` channel** (capacity
64 frames ≈ 1 MiB). When the channel is full the blocking send blocks, the PTY kernel buffer fills,
and the child process blocks on `write(2)`. That is backpressure applied at the source, for free.
`buffered_amount()` is logged at `trace` for diagnosis but does not gate the loop.

**Rationale.** Kernel-level flow control is exact, requires no threshold tuning, and cannot be got
wrong by a slow consumer. Polling `buffered_amount` from a blocking thread would need a
`Handle::block_on` round trip per frame and would still need a queue behind it.

**Consequence.** A `yes`-style flood slows the child rather than the agent. The trade is that the
agent cannot coalesce output during a stall; if profiling later shows frame-rate inefficiency, the
bounded queue's drain point is the place to batch.

### ADR-12: Reconnect re-joins a new session; it does not restart ICE

**Context.** The WS can drop (laptop suspend, Cloudflare edge eviction, network change). The peer
connection's ICE state is bound to the signaling exchange that created it.

**Decision.** On an unexpected socket close, `signal.rs` reconnects with the mirrored backoff (§5.5.4)
and re-sends `hello`. The **peer connection and PTY session are torn down** at that point; the agent
does not attempt to resume the old session. An in-place ICE restart (`create_offer` with
`ice_restart`, renegotiation) is a follow-up.

**Rationale.** An ICE restart needs a renegotiation the browser must also participate in, and Week 5
has no browser-side terminal client (that is Week 6). Reconnecting the socket is the part that is
independently useful — the agent becomes reachable again for the *next* session — and it is the part
that can be tested without a peer. Claiming transparent session resumption would be a promise the
code does not keep.

**Consequence.** A dropped socket ends the terminal session, visibly. The user reconnects. Recorded as
a known limitation, not a silent gap.

### ADR-13: Credential from the environment by default; `--credential` is a local-dev convenience

**Context.** The agent needs a long-lived secret to authenticate (R17: this credential does not exist
server-side yet; the Worker side must add it — §5.11.4).

**Decision.** Resolution order: `--credential` → `AGENT_CREDENTIAL` → fail fast with a non-zero exit
and a message naming both. The value is sent **only** in the WS handshake `Authorization` header,
never in a URL, never in a log line, never echoed. `tracing` output redacts it to a fixed `ag_…`
marker plus the token's length.

**Rationale.** A credential passed as an argv element is visible to every user on the host through
`ps` and lands in shell history; an environment variable is not. The flag stays because it is the
ergonomic path for local development, and the spec says so rather than pretending the flag is safe.

**Consequence.** The default deployment path is `AGENT_CREDENTIAL` in the service's environment (or a
0600 file read by the unit). A `--credential-file` flag and OS-keyring storage are follow-ups. The
agent also never trusts its own `--agent-id` for authorization: identity is derived server-side from
the token, and `hello`'s `agentId` is a convenience the server must cross-check (§5.9.1).

### ADR-14: One active session per agent process

**Context.** The Worker can, in principle, push offers for several sessions to one agent socket.

**Decision.** `main.rs` runs a single `Session` at a time. A second `offer` while one is active is
answered `approved: false` (with a real SDP — see R19/§5.6.4) and dropped. After the active session
closes, the agent is ready for the next offer.

**Rationale.** One PTY per process keeps the shutdown path, the Ctrl-C handler and the pump ownership
unambiguous — there is exactly one child, one reader, one writer. Concurrent sessions multiply the
teardown matrix (partial failure, one session closing while another pumps) for a benefit no Week 5
test can demonstrate. The `Session` type is structured so the supervisor loop can hold a `HashMap`
later without touching `rtc.rs` or `pty.rs`.

**Consequence.** A second concurrent request from the same user is refused. Multi-session support is
a supervisor-loop change plus a per-session id map, deferred to hardening.

---

### 5.4 Crate Layout & Dependencies

#### 5.4.1 Layout

```
apps/agent/
├── Cargo.toml
├── Cargo.lock              # committed (R21: not gitignored)
├── rust-toolchain.toml     # pins the toolchain for CI and contributors
├── .env.example            # AGENT_CREDENTIAL / AGENT_SERVER template (R23)
├── package.json            # scripts delegate to cargo (§5.11.1)
└── src/
    ├── main.rs             # clap CLI, startup pipeline, Ctrl-C, tracing init
    ├── signal.rs           # WS client: handshake, inbound queue, outbound, ping, backoff
    ├── rtc.rs              # answerer: offer -> answer, ICE both ways, terminal channel
    └── pty.rs              # portable-pty spawn, two-way pump, framing, resize seam
```

No `lib.rs`: this is a binary crate, and the unit tests live in `#[cfg(test)] mod tests` inside each
module plus `tests/` integration files. A `lib.rs` would exist only to let the integration tests
import the modules, and the PTY echo test (§5.10.2) needs the real binary path anyway.

#### 5.4.2 `Cargo.toml`

```toml
[package]
name = "remote-agent"
version = "0.1.0"
edition = "2021"
rust-version = "1.85"          # clap 4.6.7's MSRV is the highest in the set (R24)

[dependencies]
# Async runtime. "full" is required for: signal (Ctrl-C), process, io-util,
# time, sync, net, macros, rt-multi-thread, fs.
tokio = { version = "1", features = ["full"] }

# WebRTC. Default features only: the openssl/vendored-openssl features are
# deliberately NOT enabled (R2) so the build needs no system TLS library.
webrtc = "0.13"

# WebSocket client. TLS is opt-in: wss:// needs rustls-tls-webpki-roots (R12).
tokio-tungstenite = { version = "0.26", features = ["rustls-tls-webpki-roots"] }
# Required for SinkExt/StreamExt (send/next/split); NOT re-exported by
# tokio-tungstenite (R13).
futures-util = { version = "0.3", default-features = false, features = ["sink", "std"] }

# PTY. Blocking std::io reader/writer (R10) - pumped from spawn_blocking.
portable-pty = "0.9"

# Serialization
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# CLI
clap = { version = "4", features = ["derive", "env"] }

# Diagnostics
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# Encoding (Engine API - R16)
base64 = "0.23"

# Errors
anyhow = "1"

[[bin]]
name = "remote-agent"
path = "src/main.rs"
```

#### 5.4.3 Version table — confirm at scaffold, then pin in `Cargo.lock`

| Crate | Line in `Cargo.toml` | Latest in line on 2026-09-26 | Latest overall | Note |
|---|---|---|---|---|
| `tokio` | `"1"` | `1.53.1` | `1.53.1` | `features = ["full"]` is required for `signal` |
| `webrtc` | `"0.13"` | `0.13.0` | `0.21.0` | One release in the line; upstream is 7 minors ahead (R1) |
| `tokio-tungstenite` | `"0.26"` | `0.26.2` | `0.30.0` | TLS feature is not in `default` (R12) |
| `futures-util` | `"0.3"` | `0.3.34` | `0.3.34` | Mandatory, not re-exported (R13) |
| `portable-pty` | `"0.9"` | `0.9.0` | `0.9.0` | Single release in the line (R11) |
| `serde` | `"1"` | `1.0.229` | `1.0.229` | `features = ["derive"]` |
| `serde_json` | `"1"` | `1.0.151` | `1.0.151` | — |
| `clap` | `"4"` | `4.6.7` | `4.6.7` | MSRV 1.85 drives `rust-version` (R24) |
| `tracing` | `"0.1"` | `0.1.44` | `0.1.44` | — |
| `tracing-subscriber` | `"0.3"` | `0.3.23` | `0.3.23` | `env-filter` for `RUST_LOG` |
| `base64` | `"0.23"` | `0.23.1` | `0.23.1` | `Engine` API only (R16) |
| `anyhow` | `"1"` | `1.0.104` | `1.0.104` | Binaries only; no library error type in this crate |

**No Rust code in this repository has been compiled (§5.2.1).** The first scaffold task must run
`cargo add`/`cargo update` against a live registry, resolve the exact patch versions, and commit
`Cargo.lock` so the build is reproducible. Every version above is a *starting point verified against
crates.io on the spec date*, not a build result. `rust-toolchain.toml` pins `channel = "1.98.1"` to
match the verified local toolchain (R24); bumping it is a deliberate change.

**`bytes` is deliberately absent.** `Message::Ping` payloads and `DataChannelMessage.data` both use
`bytes::Bytes`, which `tungstenite` re-exports (R14) — reach it as
`tokio_tungstenite::tungstenite::Bytes`. Adding a direct `bytes` dependency would risk a version
split for no benefit.

---

### 5.5 `signal.rs` — WebSocket Signaling Client

Owns the socket: connect, authenticate, queue inbound, send outbound, keep alive, reconnect.

#### 5.5.1 Types

```rust
/// Mirrors packages/shared/src/types/signaling.ts exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum SignalMessage {
    Offer(SignalOffer),
    Answer(SignalAnswer),
    #[serde(rename = "ice-candidate")]
    IceCandidate(IceCandidateSignal),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalOffer {
    pub session_id: String,
    pub sdp: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalAnswer {
    pub session_id: String,
    pub sdp: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidateSignal {
    pub session_id: String,
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<i32>,   // wire: number | null; narrowed in rtc.rs (R7)
}
```

The `#[serde(tag = "type", content = "data")]` shape is the whole interop contract: it is byte-for-byte
what `RESTPollingTransport.parseSignalItem` produces and consumes
(`packages/webrtc-core/src/transport.ts:182-218`). A round-trip test pins it (§5.10.1).

Control frames are a **separate** enum, never merged into `SignalMessage`, so a malformed control
frame cannot be mistaken for a signal:

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientFrame {
    Hello { agent_id: String, version: String, platform: String },
}
```

#### 5.5.2 Handshake and authentication

```rust
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
use tokio_tungstenite::connect_async;

let mut request = url.as_str().into_client_request()?;   // IntoClientRequest for &str (R12/R13 path)
request.headers_mut().insert(
    "Authorization",
    HeaderValue::from_str(&format!("Bearer {credential}"))?,   // ag_... — never logged (ADR-13)
);
let (ws, _response) = connect_async(request).await?;
```

- The credential goes in the **header**, not a query string: a URL is logged by every proxy and by
  Cloudflare's own request log. `IntoClientRequest` on `&str`/`Uri`/`Url` plus `headers_mut()` is the
  supported path (R13/R14 — `Request` is `tungstenite::http::Request`).
- The first frame sent is `ClientFrame::Hello`. The server must bind the token to the agent id and
  reject a mismatch (R17/§5.11.4); the agent's `--agent-id` is not an authorization input (ADR-13).
- A non-101 handshake response or an immediate close is a fatal error surfaced with the HTTP status —
  `401` means the credential is wrong (do not retry with backoff; exit non-zero), while a connection
  error is retryable (ADR-12).

#### 5.5.3 Split, inbound queue, outbound channel

```rust
let (mut sink, mut stream) = ws.split();                 // futures_util::StreamExt::split

// Inbound: socket -> mpsc -> rtc task. The read loop never awaits RTC work, so a
// slow SDP parse cannot stall the socket and trip the peer's ICE timeout.
let (inbound_tx, inbound_rx) = mpsc::channel::<SignalMessage>(32);

// Outbound: rtc task -> mpsc -> write loop. One owner of `sink`, so no locking.
let (outbound_tx, mut outbound_rx) = mpsc::channel::<SignalMessage>(32);
```

- **Inbound queue.** Decode each text frame into `SignalMessage`; on a decode error log at `warn` with
  the frame's byte length (never the body — an SDP is session-identifying) and drop it. A dropped
  malformed signal is strictly better than a panic on attacker-influenced JSON, mirroring Week 4's
  `parseSignalItem` guard.
- **Outbound.** `rtc.rs` holds `outbound_tx` and sends `answer` and `ice-candidate` messages. The
  write loop owns `sink`; `send()` on a closed socket surfaces as an error the supervisor handles.
- **Binary frames** are ignored (the protocol is text-only), and `Message::Close` ends the loop.

#### 5.5.4 Liveness: 30 s ping, mirrored backoff

```rust
const PING_INTERVAL:   Duration = Duration::from_secs(30);
const IDLE_TIMEOUT:    Duration = Duration::from_secs(90);   // 3 missed pings
// Mirrored from packages/webrtc-core/src/transport.ts:45-46 (initialIntervalMs, maxIntervalMs)
// and the `* 1.5` / `Math.min(.., maxIntervalMs)` at :140-143, :165-168, :171-174.
const BACKOFF_INITIAL: Duration = Duration::from_millis(200);
const BACKOFF_MAX:     Duration = Duration::from_millis(2000);
const BACKOFF_FACTOR:  f64      = 1.5;
```

- Every `PING_INTERVAL`, send `Message::Ping(Bytes::new())` **and** `sink.flush()`. The flush is not
  optional: tungstenite queues the automatic pong reply to an inbound ping but does not flush it
  (R15), so without a periodic flush the pong sits in the buffer and the peer sees a dead socket.
- Inbound `Message::Pong` (or any inbound frame) resets the idle clock. `IDLE_TIMEOUT` without
  activity ⇒ treat the socket as dead and reconnect, even if the TCP connection looks alive — this is
  the case a half-open connection produces and a ping interval alone does not catch.
- Backoff on reconnect: `delay = min(delay * 1.5, BACKOFF_MAX)` starting at `BACKOFF_INITIAL`, reset
  to `BACKOFF_INITIAL` on a successful handshake or any inbound frame — the same reset-on-activity
  rule as the TS transport (`transport.ts:90,154`).
- **Rounding.** The TS implementation multiplies a `number`, so its sequence is
  `200, 300, 450, 675, 1012.5, 1518.75, 2278→2000`. `Duration::from_millis` takes an integer, so the
  Rust accumulator is `f64` and the delay is `Duration::from_millis(v.round() as u64)`. The parity
  test (§5.10.1) asserts the factor, the initial value, the cap and the reset rule — **not** the
  fractional milliseconds, which would be a brittle cross-language assertion.
- **Deviation considered and not taken:** jitter. A fleet of agents reconnecting after an edge
  eviction would synchronize. Jitter would break the "same constants" requirement, so it is recorded
  here as a candidate for the hardening pass rather than smuggled in.

#### 5.5.5 Reconnect semantics

On an unexpected close, the client reconnects and re-sends `hello`. Per ADR-12 it does **not** attempt
to resume the peer connection or the PTY: `main.rs` tears the active session down and returns to the
"ready" state. A `401` is not retried (bad credential is not transient); a `4xx` other than 401 is
surfaced and the process exits; transport errors and `5xx` back off and retry.

#### 5.5.6 Public surface

```rust
pub struct SignalClient { /* … */ }

impl SignalClient {
    pub async fn connect(url: &str, credential: &str, agent_id: &str)
        -> Result<(Self, mpsc::Receiver<SignalMessage>, mpsc::Sender<SignalMessage>)>;
    pub async fn run(self) -> Result<()>;   // read + write + ping loop; returns on close
}
```

`run` returns `Ok(())` on a clean close and `Err` on a fatal condition; the supervisor in `main.rs`
decides whether that is a reconnect or an exit.

---

### 5.6 `rtc.rs` — WebRTC Answerer

Owns one `RTCPeerConnection` for the lifetime of one session.

#### 5.6.1 Construction

```rust
use webrtc::api::{interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
                  setting_engine::SettingEngine, APIBuilder};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::interceptor::registry::Registry;

let mut media = MediaEngine::default();
media.register_default_codecs()?;                     // required by the builder
let registry = register_default_interceptors(Registry::new(), &mut media)?;

let mut setting = SettingEngine::default();
// Headless hosts and containers frequently have no mDNS responder; leaving mDNS on
// produces unresolvable .local candidates. Disable it (verified setter).
setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);

let api = APIBuilder::new()
    .with_media_engine(media)
    .with_interceptor_registry(registry)
    .with_setting_engine(setting)
    .build();

let config = RTCConfiguration {
    ice_servers: vec![RTCIceServer {
        urls: vec![stun_url],           // e.g. "stun:stun.l.google.com:19302"
        ..Default::default()            // username/credential are String, not Option (R6)
    }],
    ..Default::default()
};

let peer = Arc::new(api.new_peer_connection(config).await?);
```

Loopback needs no ICE server at all (Week 4 F4); the STUN URL is configuration with a public default,
and `--no-stun` (or an empty list) is the loopback/air-gapped path.

#### 5.6.2 The ICE-buffering requirement (R3 — the Week 4 F1 twin)

```rust
// Candidates may arrive before the offer is applied. webrtc-rs returns
// ErrNoRemoteDescription from add_ice_candidate in that state (R3), so a naive
// implementation loses them and the connection fails with an unhelpful error.
let mut remote_description_set = false;
let mut pending: Vec<RTCIceCandidateInit> = Vec::new();

async fn on_candidate(cand: RTCIceCandidateInit) -> Result<()> {
    if remote_description_set {
        peer.add_ice_candidate(cand).await
    } else {
        pending.push(cand);
        Ok(())
    }
}

// After set_remote_description(offer).await? succeeds:
remote_description_set = true;
for cand in pending.drain(..) {
    peer.add_ice_candidate(cand).await?;   // sequential, in arrival order
}
```

This is the same correctness requirement Week 4 verified in TypeScript, with a sharper failure mode:
`add_ice_candidate` **errors** rather than silently dropping (R3), so the buffering is load-bearing.
The `p2p` parity is the point — both peers must buffer, or neither connects.

#### 5.6.3 Offer → answer → ICE, both directions

```rust
peer.on_ice_candidate(Box::new(move |cand: Option<RTCIceCandidate>| {
    let tx = outbound_tx.clone();
    Box::pin(async move {
        let Some(cand) = cand else { return };        // None = gathering complete (R4)
        match cand.to_json() {
            Ok(init) => { let _ = tx.send(SignalMessage::IceCandidate(/* … */)).await; }
            Err(e)   => tracing::warn!(error = %e, "candidate conversion failed"),
        }
    })
}));

// answerer flow
peer.set_remote_description(RTCSessionDescription::offer(offer.sdp)?).await?;
flush_pending_candidates(&peer, &mut pending).await?;
let answer = peer.create_answer(None).await?;
peer.set_local_description(answer.clone()).await?;
outbound_tx.send(SignalMessage::Answer(SignalAnswer {
    session_id, sdp: answer.sdp, approved,
})).await?;
```

- `on_ice_candidate(None)` is the gathering-complete signal (R4) — not an error, and not something to
  forward. Because the agent trickles, `gathering_complete_promise()` is **not** used; that helper is
  for non-trickle (blocking) gathering.
- Candidate conversion is `RTCIceCandidate::to_json() -> RTCIceCandidateInit` (yields
  `candidate:<marshal>`), then narrowed to the wire type. `sdp_mline_index` is `u16` upstream (R7), so
  a value outside `0..=65535` is rejected at the boundary rather than truncated — a truncated index
  produces a candidate the peer associates with the wrong media section.
- Inbound candidates: `rtc.rs` checks `session_id` against the active session and **drops mismatches**.
  With one active session (ADR-14) this is a cheap guard against cross-session candidate injection
  (Week 4 §7 lists exactly this class of concern for the REST path).
- `set_remote_description` and `create_answer` errors are fatal for the session: log with the
  session id, send no answer, tear down. A malformed SDP is attacker-influenced input.

#### 5.6.4 Accepting the `terminal` channel, and the `approved` flag

```rust
peer.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
    let tx = state.clone();
    Box::pin(async move {
        if dc.label() != "terminal" {                 // ADR-09: exact label, nothing else
            tracing::warn!(label = dc.label(), "refusing unexpected channel");
            let _ = dc.close().await;
            return;
        }
        dc.on_open(Box::new(move || { /* signal the pipeline: channel is up */ Box::pin(async {}) }));
        // … register on_message with the decoder from pty.rs …
    })
}));
```

The pipeline (§5.8.2) then waits for `terminal` to reach `Open` before spawning the PTY, with the
session's connect timeout. `on_open` is `FnOnce` (R8), so the closure is constructed per channel and
cannot be reused for a second channel — which is exactly right here, since ADR-09 allows one.

**The `approved` flag is a policy check, not a prompt.** Week 5 sets `approved = true` when the
offer's `capabilities` contains `"terminal"` **and** the channel that opens is labelled `terminal`; it
sets `approved = false` otherwise (unknown capability set, or a session already active — ADR-14).
Physical approval is Week 12 (`ARCHITECTURE.md:1255`).

**A refusal still carries a real SDP.** `POST /api/signal/answer` rejects an empty `sdp` with
`400 VALIDATION_ERROR` (R19). So the refusal path calls `create_answer` first and sends the real SDP
with `approved: false`, then closes the peer connection. A refusal is therefore indistinguishable from
a success at the transport layer and is only visible in the flag — which is honest, because today the
Worker does not act on the flag at all: `routes/signal.ts:113` stores `approved: body.approved !== false`
and nothing enforces it. The browser learns of the refusal by reading the answer; Week 12 makes it
authoritative. This is stated rather than glossed because it is the same "cooperative enforcement"
gap the Week 4 spec recorded in §5.4.

---

### 5.7 `pty.rs` — PTY Bridge

#### 5.7.1 Spawn

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child:  Box<dyn Child + Send + Sync>,
    // …
}

impl PtySession {
    pub fn spawn(shell: &str, cols: u16, rows: u16) -> Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows, cols, pixel_width: 0, pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(shell);          // shell resolved by main.rs (§5.8.1)
        cmd.env("TERM", "xterm-256color");                 // the browser terminal is xterm.js (Week 6)
        cmd.env("LANG", "C.UTF-8");
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);                                  // required: the slave fd must be released

        Ok(Self { master: pair.master, child, /* … */ })
    }
}
```

`drop(pair.slave)` is not optional — holding the slave end open keeps the PTY from reporting EOF when
the child exits, and the reader loop then never terminates.

#### 5.7.2 The two-way pump

`try_clone_reader()` and `take_writer()` are **blocking** `std::io` objects (R10), so each direction
gets a dedicated `spawn_blocking` thread bridged to async by a bounded channel (ADR-11).

```
PTY -> browser   spawn_blocking(read loop)  --bounded mpsc(64)-->  async: base64 + frame + send_text
browser -> PTY   async read loop           --bounded mpsc(64)-->  spawn_blocking(write loop)
```

```rust
// PTY -> browser
let mut reader = self.master.try_clone_reader()?;
let tx = pty_out_tx.clone();
tokio::task::spawn_blocking(move || {
    let mut buf = vec![0u8; MAX_PTY_CHUNK];               // 16 KiB (§5.7.3)
    loop {
        match reader.read(&mut buf) {
            Ok(0)  => break,                              // child exited, slave closed
            Ok(n)  => if tx.blocking_send(buf[..n].to_vec()).is_err() { break },  // backpressure
            Err(e) => { tracing::warn!(error = %e, "pty read failed"); break }
        }
    }
});
```

```rust
// browser -> PTY
let mut writer = self.master.take_writer()?;
tokio::task::spawn_blocking(move || {
    while let Some(bytes) = pty_in_rx.blocking_recv() {
        if writer.write_all(&bytes).is_err() { break }
        let _ = writer.flush();
    }
    // Dropping `writer` here sends EOF to the slave end (R10).
});
```

- **No UTF-8 assumption anywhere.** Bytes are moved as `Vec<u8>` and base64-encoded; a multi-byte
  sequence split across two `read()` calls is harmless (ADR-10). This is the single most important
  property of the pump.
- **Backpressure is the bounded channel** (ADR-11): `blocking_send` blocks the reader thread, the
  kernel PTY buffer fills, the child blocks on write. No unbounded queue.
- **Outbound frames** are `send_text` with `DataChannelMessage<TerminalDataMessage>`:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataMessage { pub terminal_id: String, pub data: String }   // data = base64

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChannelMessage<T> {
    pub r#type: String,          // "terminal-data"
    pub channel: String,         // "terminal" — matches WebRTCChannelType
    pub payload: T,
    pub timestamp: i64,          // epoch ms
}
```

This is the exact envelope from `packages/shared/src/types/webrtc.ts:9-14` with the payload from
`packages/shared/src/types/terminal.ts:16-19`.

#### 5.7.3 Chunk size

```rust
pub const MAX_PTY_CHUNK: usize = 16 * 1024;      // 16 KiB raw
pub const MAX_FRAME_BYTES: usize = 64 * 1024;    // inbound guard
```

16 KiB raw becomes 21 848 base64 characters, plus the JSON envelope (~120 bytes) — comfortably under
the browser DataChannel's default `maxMessageSize` (64 KiB in Chromium) and under the SCTP limit. An
inbound frame larger than `MAX_FRAME_BYTES` is rejected **before** `serde_json` parses it, so a hostile
peer cannot make the agent allocate arbitrarily.

#### 5.7.4 Inbound decode and the resize seam

Inbound `terminal-data` frames are base64-decoded (strict, padded standard alphabet — R16) and pushed
to the writer channel. A decode failure is logged and dropped; the terminal stream has no
retransmission, and a partially corrupt frame must not kill the session.

`terminal-resize` is **decoded** (`TerminalResizeMessage { terminalId, cols, rows }` already exists in
`packages/shared/src/types/terminal.ts:21-25`) and applied via `master.resize(PtySize { … })`, which is
a one-line, already-verified call. The browser side that *sends* it is Week 6
(`ARCHITECTURE.md:1204` — *"Handle resize events"*). The seam exists so Week 6 is a UI change only;
until then the handler is exercised by a unit test that calls the resize path directly.

#### 5.7.5 Shutdown

```rust
pub async fn close(mut self) -> Result<()> {
    drop(self.pty_in_tx);                 // writer thread drains and drops `writer` -> EOF (R10)
    let _ = self.child.kill();            // SIGHUP on unix, TerminateProcess on windows
    let child = self.child;
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || child.wait()),   // wait() is blocking
    ).await;
    Ok(())
}
```

Drop the writer, then signal, then wait **with a timeout** — `Child::wait` is blocking (R10) and a
wedged child must not hang the agent's exit path. On `Err(_)` the timeout is logged; the process exits
regardless.

---

### 5.8 `main.rs` — CLI and Pipeline

#### 5.8.1 CLI

```rust
#[derive(Parser, Debug)]
#[command(name = "remote-agent", version, about = "Ponta remote desktop agent")]
struct Cli {
    /// Agent id registered with the signaling service.
    #[arg(long, env = "AGENT_ID")]
    agent_id: String,

    /// Signaling WebSocket URL, e.g. wss://host/ws/agent
    #[arg(long, env = "AGENT_SERVER", default_value = "ws://localhost:8787/ws/agent")]
    server: String,

    /// Shell to spawn. Defaults to $SHELL (unix) or cmd.exe (windows).
    #[arg(long, env = "AGENT_SHELL")]
    shell: Option<String>,

    /// Agent credential (ag_...). Prefer AGENT_CREDENTIAL: argv is visible via ps (ADR-13).
    #[arg(long, env = "AGENT_CREDENTIAL")]
    credential: Option<String>,

    /// STUN server; empty string disables ICE servers entirely (loopback).
    #[arg(long, env = "STUN_SERVER", default_value = "stun:stun.l.google.com:19302")]
    stun: String,

    /// Terminal size for the initial PTY.
    #[arg(long, default_value_t = 80)] cols: u16,
    #[arg(long, default_value_t = 24)] rows: u16,
}
```

`--credential-or-env` in the roadmap is realised as clap's `env = "AGENT_CREDENTIAL"` on `--credential`:
clap resolves flag → env → default in that order, which is exactly ADR-13's rule, with one struct
field instead of two. If neither is present the process exits non-zero with a message naming both
sources — never a default.

**Shell resolution** (`--shell` → `AGENT_SHELL` → platform default):

```rust
fn resolve_shell(cli: &Cli) -> Result<String> {
    if let Some(s) = &cli.shell { return Ok(s.clone()) }
    #[cfg(unix)]    { Ok(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())) }
    #[cfg(windows)] { Ok("cmd.exe".into()) }
}
```

`sh`/`cmd` is the floor, `--shell` is the override, `$SHELL` is the polite default on a real desktop.
The path is passed through to `CommandBuilder::new` unmodified — no shell interpolation of user input,
because the value is the executable, not a command line.

#### 5.8.2 The pipeline

```
  connect WS (Bearer ag_...)  ──►  send hello  ──►  wait for offer
        │
        ▼
  rtc: set_remote_description(offer) → flush buffered candidates → create_answer → send answer
        │
        ▼
  wait for the `terminal` channel to reach Open   (connect timeout; abort on timeout)
        │
        ▼
  pty: spawn shell → start both pump directions
        │
        ▼
  run until: channel closes │ child exits │ WS closes │ Ctrl-C
        │
        ▼
  graceful teardown: close channel → close child → close WS → exit
```

```rust
#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();                                   // tracing-subscriber + RUST_LOG env-filter
    let cli = Cli::parse();
    let credential = resolve_credential(&cli)?;       // flag → env → hard error (ADR-13)

    let (client, inbound_rx, outbound_tx) =
        SignalClient::connect(&cli.server, &credential, &cli.agent_id).await?;

    tokio::select! {
        r = client.run()            => r,             // socket closed / fatal
        r = supervise_sessions(inbound_rx, outbound_tx, &cli) => r,
        _ = shutdown_signal()       => { /* graceful close, ADR-12 teardown */ Ok(()) }
    }
}
```

`supervise_sessions` is the ADR-14 loop: take an `offer` from `inbound_rx`; if a session is active,
answer `approved: false` and drop it; otherwise run `Session::run(offer, …)` to completion, then
return to ready.

#### 5.8.3 `Ctrl-C` and termination

```rust
async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("ctrl-c handler") };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler").recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
```

`SIGTERM` matters as much as `Ctrl-C`: a systemd unit or a container stop sends `SIGTERM`, and an
agent that ignores it leaves a shell running on the host after the service is "stopped". The handler
runs the same teardown as a normal session end: close the data channel, `kill()` the child, close the
WS with a `Close` frame, exit `0`. `tokio`'s `signal` feature is included by `features = ["full"]`.

---

### 5.9 Wire Protocol Contract

#### 5.9.1 Signaling WebSocket

| Direction | Frame | Body |
|---|---|---|
| agent → server | `hello` | `{ "type": "hello", "agentId": "…", "version": "0.1.0", "platform": "linux" }` — **first frame**, within 5 s of the handshake or the server closes |
| server → agent | `offer` | `SignalMessage::Offer` — `{ "type": "offer", "data": { "sessionId", "sdp", "capabilities" } }` |
| agent → server | `answer` | `SignalMessage::Answer` — `{ "type": "answer", "data": { "sessionId", "sdp", "approved" } }` |
| either → either | `ice-candidate` | `SignalMessage::IceCandidate` — `{ "type": "ice-candidate", "data": { "sessionId", "candidate", "sdpMid", "sdpMLineIndex" } }` |
| server → agent | `error` | `{ "type": "error", "code": "UNAUTHORIZED" \| "BAD_FRAME" \| "SESSION_NOT_FOUND", "message": "…" }` — control frame, not a `SignalMessage` |

- **Transport:** WebSocket, `Authorization: Bearer ag_…` on the handshake. Text frames only.
- **Liveness:** protocol-level `Ping`/`Pong` every 30 s (server may also ping; the client's automatic
  pong plus a periodic flush satisfies it — R15).
- **Routing:** the server pushes offers for sessions whose `sessions.agentId` is this agent. The agent
  does not subscribe to a session id, so a session created after the socket opened still reaches it.
- **Identity:** the server derives the owner from the token; a `hello.agentId` that does not match the
  token's agent is rejected with `UNAUTHORIZED` (ADR-13).

#### 5.9.2 Data channel

One channel, label `terminal` (`WebRTCChannelType`, `packages/shared/src/types/webrtc.ts:7`), ordered,
created by the browser (ADR-09).

| `type` | Direction | `payload` |
|---|---|---|
| `terminal-data` | both | `TerminalDataMessage { terminalId, data }` — `data` is base64 of raw bytes |
| `terminal-resize` | browser → agent | `TerminalResizeMessage { terminalId, cols, rows }` — Week 6 sender (§5.7.4) |

Wrapped in `DataChannelMessage<T>` (`type`, `channel: "terminal"`, `payload`, `timestamp`). The agent
ignores any `channel` value other than `terminal`.

#### 5.9.3 Companion Worker deliverable (out of this section's scope, blocking for end-to-end)

R18 and R17 mean the agent has nothing to talk to until the Worker side lands. Week 5 therefore
requires a **companion signaling change**, specified elsewhere but named here so it is not lost:

1. A WebSocket route (`/ws/agent`) with `Upgrade` handling — a Durable Object per agent, or the
   Week 4 ADR-02 `SignalTransport` seam realised server-side.
2. An `ag_` token verifier: prefix check, constant-time hash comparison, resolving to the owning
   `userId` so the existing ownership predicate (`routes/signal.ts:22-43`) works unchanged (R20).
   A token column or a separate table on `agents` (R17: none exists today).
3. Routing: `POST /api/signal/offer` for a session with an `agentId` pushes the offer to that agent's
   socket instead of (or in addition to) the D1 row, so the agent does not have to poll.

Until all three exist, the Rust agent can be built and unit-tested but not run end-to-end. This
section does not claim otherwise.

---

### 5.10 Test Plan (`cargo test`)

#### 5.10.1 Unit — parsing, framing, backoff

| Test | Asserts | ~Count |
|---|---|---|
| `signal::offer_round_trip` | A JSON offer matching `packages/shared` parses; re-serializing yields the same keys (`type`/`data`, `sessionId`/`sdpMid`/`sdpMLineIndex` camelCase) | 4 |
| `signal::rejects_malformed` | Unknown `type`, missing `data`, missing `sdp`, non-string `candidate`, and a `null` body all return `Err` — no panic | 5 |
| `signal::candidate_index_narrowing` | `sdpMLineIndex: -1` and `70000` are rejected; `0` and `65535` accepted (R7) | 3 |
| `pty::frame_round_trip` | Arbitrary bytes (including `0x00`, `0xFF`, an invalid UTF-8 sequence, and a 3-byte char split across two chunks) survive encode → frame → decode byte-exact (ADR-10) | 5 |
| `pty::chunk_boundaries` | Empty data, exactly `MAX_PTY_CHUNK`, `MAX_PTY_CHUNK + 1` (two frames), and a frame above `MAX_FRAME_BYTES` rejected before parsing | 4 |
| `signal::backoff_sequence` | `200 → 300 → 450 → 675 → 1012 → 1518 → 2000 → 2000`, and a reset to `200` on inbound activity (factor, initial, cap, reset — not fractional ms) | 3 |

**~24 unit tests.** No network, no PTY, no WebRTC — pure functions, so they run in milliseconds and
gate every commit.

#### 5.10.2 Integration — PTY echo (the roadmap's own check)

```rust
#[test]
#[cfg(unix)]
fn pty_echo_round_trip() {
    let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, ..Default::default() }).unwrap();
    let mut cmd = CommandBuilder::new("sh");
    cmd.args(["-c", "echo hello"]);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut out = Vec::new();
    reader.read_to_end(&mut out).unwrap();       // bounded by a watchdog thread (§below)

    assert!(String::from_utf8_lossy(&out).contains("hello"),
            "expected echo output, got {:?}", String::from_utf8_lossy(&out));
    assert!(child.wait().unwrap().success());
}
```

This is the Week 5 roadmap line *"Tích hợp portable-pty"* verified end to end: a real shell, a real
PTY, real output. Details that make it a reliable test:

- `#[cfg(unix)]` for the `sh -c` variant, with a `#[cfg(windows)]` twin running
  `cmd.exe /C echo hello` so the file compiles everywhere and CI (ubuntu) runs the unix path.
- `read_to_end` returns when the child exits and the slave is closed — which is exactly why
  `drop(pair.slave)` matters (§5.7.1). A regression there hangs the test, so a watchdog thread closes
  the master after 10 s and fails the test with a clear message rather than hanging CI.
- `String::from_utf8_lossy` on the assertion only: the pump itself never assumes UTF-8, but `echo
  hello` output is ASCII and the assertion should be readable.
- A second case runs the **framing** path: bytes from the PTY → base64 → `DataChannelMessage` JSON →
  decode, asserting the decoded bytes contain `hello`. That is the seam the two halves meet at, and it
  is testable without a peer connection.

**~4 integration tests.** Gated in CI.

#### 5.10.3 Deferred — Rust↔Rust loopback handshake

A full in-process `webrtc` offerer/answerer handshake mirroring Week 4's `p2p.test.ts` is **written and
`#[ignore]`d**, run explicitly with `cargo test -- --ignored` (or in a nightly/scheduled job). Rationale,
stated so the omission is a decision and not a hole:

- Week 4's `p2p.test.ts` already proves the **wire protocol** (offer/answer/ICE/data round-trip)
  against a real handshake. A Rust↔Rust test would prove the *same* protocol against the *same* crate
  family, while the thing that is genuinely unproven — cross-language interop between `werift` and
  `webrtc` — needs a *browser* peer, which arrives with Week 6's terminal UI.
- `webrtc` 0.13.0's compile time dominates the agent's CI cost; a second handshake test does not pay
  for itself in the same job.
- When the Week 6 browser client lands, the real cross-language test replaces this one.

#### 5.10.4 Test-runner configuration

- `#[tokio::test]` for async units; `tokio::time::pause()` where a test touches the backoff clock so
  the 2000 ms cap is asserted in microseconds rather than by sleeping.
- Every test that can block on I/O (PTY, sockets) carries a watchdog with a hard timeout. Week 4's
  §7 requirement — *"Timeouts bounded so regressions fail fast rather than hanging CI"* — applies
  verbatim.

---

### 5.11 Workspace & CI Integration

#### 5.11.1 `apps/agent/package.json` — replace the stubs, drive Rust through the existing gate

```json
{
  "name": "@remote/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "cargo fmt --check && cargo clippy --all-targets -- -D warnings",
    "typecheck": "cargo check --all-targets",
    "test": "cargo test"
  }
}
```

Today the file is a 10-line stub with `lint`/`typecheck` as `echo ok` and **no `test` script** (R22), so
Turbo runs nothing for the agent. Wiring the three scripts to `cargo` means the repository's existing
single gate — `pnpm lint && pnpm typecheck && pnpm test`, i.e. `turbo run lint|typecheck|test` — covers
the Rust crate with no new command to remember. `cargo check` is the typecheck step (it type-checks
without codegen), which keeps the second of the three passes cheap.

`clippy -D warnings` is the agent's equivalent of ESLint's `recommended` set: warnings fail the build,
so they are fixed rather than accumulated.

#### 5.11.2 `turbo.json` — no change

`turbo.json` defines bare `lint`/`typecheck`/`test` tasks and auto-discovers workspace packages
(Week 4 F14). `apps/agent` gains the three scripts and participates automatically.

#### 5.11.3 Prettier / ESLint — no change, and this is verified, not assumed

- Prettier does not parse `.rs` and does not error on it: `prettier --check` on a directory containing
  a `.rs` file exits 0 with *"All matched files use Prettier code style"* (R21). `format:check`
  therefore ignores the Rust sources without a config change.
- `eslint .` inside `apps/agent` matches only the config's `files` globs (`apps/**/*.ts`,
  `apps/**/*.vue`), so it walks `.rs` files and lints nothing — verified exit 0 (R21).
- `target/` is already in both `.prettierignore` and `.gitignore` (R21).
- `Cargo.lock` is **not** gitignored and **must** be committed (ADR-08).

#### 5.11.4 `.github/workflows/ci.yml` — toolchain, cache, and the token gap

Add to the existing `verify` job, before `pnpm lint`:

```yaml
      - name: Setup Rust toolchain
        uses: dtolnay/rust-toolchain@<pinned-sha>      # v1
        with:
          toolchain: 1.98.1                             # matches rust-toolchain.toml (R24)
          components: rustfmt, clippy

      - name: Cache Rust build
        uses: Swatinem/rust-cache@<pinned-sha>          # v2
        with:
          workspaces: apps/agent
```

Three notes:

- **A C compiler is required** — `ring` 0.17.14 builds C and asm (R2). `ubuntu-latest` ships `gcc`;
  no extra step.
- **No OpenSSL is required** — default features only (ADR-08, R2). Do not add `libssl-dev`.
- **The cache is not optional.** `webrtc` 0.13.0 compiles a large dependency tree; an uncached job
  would dominate CI wall-clock. If the `verify` job becomes the bottleneck, split Rust into a sibling
  job sharing the same cache key — but keep the `pnpm` scripts wired to `cargo` (§5.11.1) so there is
  one source of truth for how the agent is checked.

**The token gap is a Week 5 deliverable, not a CI detail.** R17 and R18 mean the credential the agent
sends is not accepted by anything today, and the endpoint it dials does not exist. The companion
Worker change named in §5.9.3 (WS route + `ag_` verifier + offer routing) must land for the agent to
run end-to-end. Until then the agent's tests are unit and PTY tests, and the CI job proves it compiles,
lints and passes those — which is the honest bar for this section.

#### 5.11.5 `.env.example`

`ARCHITECTURE.md:1308` instructs `cp apps/agent/.env.example apps/agent/.env`, and that file does not
exist (R23). Create it, since `.env.example` is not matched by `.gitignore` and is therefore a safe
template:

```env
# apps/agent/.env.example — copy to .env (gitignored) and fill in.
AGENT_CREDENTIAL=ag_replace_me
AGENT_SERVER=ws://localhost:8787/ws/agent
AGENT_ID=my-laptop
# AGENT_SHELL=/bin/bash
# STUN_SERVER=stun:stun.l.google.com:19302
```

No real credential is ever committed; `.env` is already ignored.

---

### 5.12 Review Focus & Edge Cases

**Security**

- The credential appears in exactly one place — the handshake `Authorization` header — and is redacted
  in every log path (ADR-13). A `Debug` derive on any struct holding it must be checked by hand;
  prefer a newtype whose `Debug` prints `ag_…` plus a length.
- `--credential` on argv is visible via `ps`. Documented, not hidden (ADR-13); `AGENT_CREDENTIAL` is
  the default path.
- The agent does **not** trust `--agent-id` for authorization; the server derives identity from the
  token and rejects a `hello` mismatch (ADR-13, §5.9.1).
- Only the exact `terminal` label is accepted; every other channel is closed (ADR-09). Unknown
  inbound `DataChannelMessage.channel` values are ignored.
- Candidates whose `sessionId` does not match the active session are dropped (§5.6.3).
- Inbound frames above `MAX_FRAME_BYTES` are rejected before deserialization; malformed JSON is logged
  by length only — never by body, since an SDP identifies a session (§5.5.3, §5.7.3).
- A malformed SDP or candidate from the peer must produce a logged teardown, never a panic. Week 4's
  §7 rule — signal payloads are attacker-controlled JSON — applies to the WS path identically.

**Correctness**

- **ICE buffering (R3) is the highest-risk item**, exactly as F1 was for Week 4. `webrtc` returns
  `ErrNoRemoteDescription` rather than dropping silently, so a missing buffer fails loudly but
  confusingly. The flush must be sequential and ordered.
- **`drop(pair.slave)` after spawn** — without it the reader never sees EOF and shutdown hangs.
- **`on_open` is `FnOnce` (R8)** — do not attempt to reuse the closure.
- **`sink.flush()` on the ping tick** — an unflushed auto-pong (R15) makes a healthy socket look dead
  to the peer's idle detector.
- **`sdp_mline_index` is `u16` (R7)** — out-of-range values are rejected, never truncated.
- **A refusal answer must carry a real SDP** — an empty one is a `400` on the REST path (R19).
- The PTY writer thread must drop its writer on exit, or the child never receives EOF (§5.7.2).
- `Child::wait` is blocking (R10) — always behind a timeout (§5.7.5).

**Boundaries**

- `media_channel`, screen capture, file transfer and the `desktop`/`files`/`control` channels are not
  present, not stubbed, and not feature-flagged (ADR-07, §5.1).
- `agent.toml` and `config.rs` are not created; configuration is CLI + environment (§5.8.1).
- One active session per process (ADR-14). A second offer is refused, not queued.
- Reconnect re-joins as a new session; no ICE restart (ADR-12).

**Testing**

- Unit + PTY tests gate CI; the Rust↔Rust handshake is `#[ignore]`d with the rationale recorded
  (§5.10.3).
- Every blocking test carries a watchdog timeout (Week 4 §7 rule, restated in §5.10.4).
- The backoff parity test asserts factor/initial/cap/reset, not fractional milliseconds (§5.5.4).

---

### 5.13 Delivery Sequence

| # | Task | Deliverable | Tests |
|---|---|---|---|
| 1 | **Crate scaffold** | `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `src/main.rs` (CLI only), `.env.example`; versions re-confirmed on crates.io and pinned (ADR-08) | 0 |
| 2 | **`signal.rs` types + framing** | `SignalMessage`, `ClientFrame`, JSON round-trip and rejection | 12 |
| 3 | **`signal.rs` transport** | handshake with `Authorization`, inbound queue, outbound channel, 30 s ping + flush, mirrored backoff, reconnect | 3 |
| 4 | **`pty.rs` framing** | `DataChannelMessage<TerminalDataMessage>`, base64 encode/decode, chunk bounds | 9 |
| 5 | **`pty.rs` spawn + pump** | `PtySession::spawn`, both pump directions, bounded backpressure, `resize`, `close` | 4 (incl. PTY echo) |
| 6 | **`rtc.rs` answerer** | `APIBuilder` wiring, `on_ice_candidate`, candidate buffering (R3), offer → answer, `on_data_channel` label check | 0 (exercised by 7) |
| 7 | **Pipeline + Ctrl-C** | `main.rs` supervisor loop, session state machine, `shutdown_signal`, graceful teardown | 0 |
| 8 | **Workspace & CI** | `package.json` scripts → cargo; rustup + `rust-cache` in `ci.yml` | 0 |
| 9 | **Docs** | Correct `ARCHITECTURE.md:658,663` (ADR-08 note); record the §5.1 cuts and the ADR-12 limitation | 0 |
| 10 | **Companion Worker change** | WS route + `ag_` verifier + offer routing (§5.9.3) — a separate spec | own |

Tasks 2-7 are strictly sequential within the crate (each module is exercised by the next). Task 8 can
proceed in parallel with 5-7. Task 10 blocks any end-to-end run and is named here so it cannot be
forgotten; it is not part of this section's implementation.

**Verification gate:** the repository's existing `pnpm lint && pnpm typecheck && pnpm format:check &&
pnpm test` now covers the Rust crate through the `apps/agent` scripts (§5.11.1), with
**~28 new Rust tests** (24 unit, 4 integration) added to the TypeScript baseline. No existing
TypeScript test changes; Week 5 adds no code to `packages/` or `workers/` in this section.

---

## 6. Session Management

Week 4 left the session lifecycle half-built: `POST /api/sessions` writes `status: 'pending'` (`workers/signaling/src/routes/sessions.ts:93`) and `DELETE /api/sessions/:id` writes `terminated` + `ended_at` (`sessions.ts:134-141`), but nothing ever advances a session out of `pending`, and `sessions.started_at` does not exist as a column at all — it exists only in the `Session` type (`packages/shared/src/types/session.ts:12`). Week 5 closes that gap with the minimum machine the E2E criterion needs, and nothing more.

### 6.1 State Machine

```
                 POST /api/sessions                 agent answer persisted
   (none) ──────────────────────────► pending ──────────────────────────────► active
                                        │                                        │
                                        │  agent WS close                        │  agent WS close
                                        │  browser DELETE /api/sessions/:id      │  browser DELETE /api/sessions/:id
                                        ▼                                        ▼
                                    terminated ◄─────────────────────────────────┘
                                    (terminal; ended_at set)
```

| Transition | Trigger | Enforcement point | Written columns |
|---|---|---|---|
| → `pending` | Browser `POST /api/sessions` (unchanged) | `sessions.ts:87-96` | `status='pending'` |
| `pending` → `active` | An `answer` signal is persisted for the session | shared persistence helper, called from the agent WS inbound path (`routes/ws.ts`) | `status='active'`, `started_at=datetime('now')`, `updated_at=datetime('now')` |
| `pending`/`active` → `terminated` | Agent WebSocket closes | `ws.ts` socket `close` handler | `status='terminated'`, `ended_at=datetime('now')`, `updated_at=datetime('now')` |
| `pending`/`active` → `terminated` | Browser `DELETE /api/sessions/:id` (unchanged) | `sessions.ts:134-141` | `status='terminated'`, `ended_at`, `updated_at` |

**Guard: transition only from a non-terminal state.** Both writers apply `WHERE status IN ('pending','active')`. A second `answer` therefore cannot reset `started_at`, and a socket close after an explicit browser `DELETE` cannot overwrite `ended_at` with a later timestamp. This is the idempotency property the tests in §7.1 assert directly.

**One code path for persistence.** The REST `POST /api/signal/*` routes (`routes/signal.ts:65-88`, `:116-139`, `:173-196`) and the WS inbound path must not grow two copies of "insert the signal, then maybe transition the session". Both call one helper that (a) inserts the `signals` row, and (b) when `type === 'answer'` and the session is `pending`, applies the `active` transition. Honest statement of what this means: the transition keys on *the signal type*, not on *which peer sent it*, because at the database level the browser and the agent of one user are still the same principal for REST (Week 4 §5.4, `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md:466-479`). In practice the browser is the offerer and never produces an `answer`, so "an `answer` was persisted" and "the agent answered" coincide. The alternative — a `role` column or a transport tag on the row — would be the appearance of enforcement without the substance, and is deliberately not added.

**Terminal is terminal.** Once `terminated`, a WS `answer` or `ice-candidate` for that session is refused (§7.4 edge 3), and a REST `POST /api/signal/*` already returns `409 SESSION_NOT_ACTIVE` via `getOwnedActiveSession` (`signal.ts:32-34`). No path reopens a session.

**Out of scope, stated so it is not mistaken for an omission.** The shared `SessionStatus` union also declares `'awaiting_approval'` and `'expired'` (`session.ts:1-2`). Neither is reachable after Week 5: physical approval is a Phase 5 concern, and `sessions.expires_at` plus its TTL sweep remain unbuilt (Week 4 ledger R23/C11). The state machine ships three states.

### 6.2 Poll Keeps the Week 4 Drain Rule

`GET /api/signal/poll/:sessionId` deliberately performs **no status check** — the ownership predicate is the only gate (`signal.ts:208-219`, with the intent stated in the comment at `:208-210`). Week 5 preserves this verbatim, and it is now load-bearing for a second reason beyond the Week 4 one: a browser whose session was just terminated by the agent's socket close must still be able to poll the final `answer`/`ice-candidate` rows that were written before the close. Adding a status check here would break the week's E2E path, which is why the Week 4 ledger names it as a mutation to prove (§8 task 1, mutant #5).

### 6.3 Heartbeat and Online Determination

The agent sends `{ type: 'ping' }` on a **30 s** interval. The Worker, on receipt, writes `is_online = 1` and `last_ping_at = datetime('now')`, and replies `{ type: 'pong' }`. On socket open the same write happens immediately, so a freshly connected agent is pushable without waiting a full interval; on socket close, `is_online = 0`.

**Online is computed at read time, not by a background job.** A single predicate is the only definition in the codebase:

```ts
// workers/signaling/src/routes/ws.ts (or a small util imported by agents.ts and ws.ts)
const ONLINE_WINDOW_SECONDS = 90;
const isAgentOnline = (agent, socketPresent: boolean) =>
  socketPresent && agent.isOnline === true &&
  agent.lastPingAt !== null &&
  agent.lastPingAt > sql`datetime('now', '-90 seconds')`;
```

Three consequences worth writing down:

1. **Two conditions, not one.** A live socket in the in-memory `Map` is not sufficient — a half-open TCP connection keeps the map entry while the agent is gone. A fresh `last_ping_at` is not sufficient either — the socket is what a push needs. Both are required.
2. **`is_online` in D1 is a hint; the 90 s window is the truth.** A row can read `is_online = 1` while the agent has been dark for two minutes, because nothing clears it. Every consumer (`GET /api/agents` via `toPublicAgent`, and the push path) must go through `isAgentOnline`, never read the column alone.
3. **No sweep job.** There is no cron trigger in `wrangler.toml` and none is added; a stale `is_online = 1` is corrected on the next socket open, socket close, or ping, and is *ignored* by every read in the meantime. The cost is that `is_online` is not a trustworthy standalone field for an external reader — documented, not silent.

`toPublicAgent` is the projection that reconciles the remaining Week 4 drift, and it is where the read-time check lands: `last_ping_at → lastHeartbeat`, `JSON.parse(capabilities) → string[]`, and `is_online → isOnline` computed through `isAgentOnline`. Column names stay as they are; no rename migration (the drift is in the type/DB naming, not the semantics).

### 6.4 Schema Touchpoints

`started_at` is the only new session column, and it arrives in the same migration as the agent credential columns (§8 task 3, `0002_agent_credentials.sql`). One verified trap to record: D1's `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` in UTC with a **space** separator and no `Z` — measured locally, `2026-09-26 02:32:51`. That is exactly the format the existing `created_at`/`ended_at` columns already carry, so `started_at` matches them for consistent lexicographic comparison in SQL. It is *not* ISO 8601, so a JavaScript consumer doing `new Date('2026-09-26 02:32:51')` gets local-time interpretation. Week 5 keeps consistency with the existing columns and does not introduce a second, ISO-only timestamp convention; the mismatch is recorded here rather than fixed in one column.

The Worker test fixture must be extended in the same commit: `RESET_STATEMENTS` (`workers/signaling/test/helpers.ts:11`) currently creates `agents` at `:41`, `sessions` at `:53`, `signals` at `:64`; it needs `credential_hash`, `capabilities`, and `started_at`, plus the new unique index. This is the Week 4 ADR-04 single-fixture decision paying off — one edit, not four.

### 6.5 Accepted Limitations

- **One session per agent.** The socket-close handler terminates every non-terminal session bound to that `agent_id`. With one agent and one session in scope that is exact; with concurrent sessions it would be over-broad, and the correct rule (terminate only the sessions that were signaling on that socket) is Week 6 work.
- **No `expires_at` on sessions.** A `pending` session whose agent never connects stays `pending` forever. The Week 4 `signals.expires_at` TTL is unaffected.
- **No session-level approval.** `pending → active` is triggered by the agent's answer, not by a user confirmation dialog.

---

## 7. Testing & Review Focus

Three layers, deliberately at three different altitudes. Layer 1 proves the Worker's own logic against a real D1 and a real WebSocket pair. Layer 2 proves the Rust agent's own logic without a network. Layer 3 is the week's done-criterion: a real PTY's bytes travelling over a real DTLS/SCTP connection between two independent implementations of the Week 4 wire contract. Layer 3 is the only test that can fail because the contract itself is wrong.

### 7.1 Layer 1 — Worker (`vitest` + `@cloudflare/vitest-pool-workers`)

New file `workers/signaling/test/ws.test.ts`, plus extensions to `signal.test.ts`, `resources.test.ts`, and `helpers.ts`. Harness style follows the existing suites: `app.request(...)` against `src/index.ts` with `env` from `cloudflare:test`, and `env.DB.batch(RESET_STATEMENTS.map(...))` in `beforeEach`.

| # | Case | Asserts |
|---|---|---|
| W1 | WS auth, valid credential | `101` upgrade; `is_online` becomes `1`; the agent appears in `GET /api/agents` as `isOnline: true` |
| W2 | WS auth, wrong credential | `401 UNAUTHORIZED`; no map entry; the failure is indistinguishable from an unknown agent id |
| W3 | WS auth, missing header | `401 UNAUTHORIZED` (same code as W2 — no oracle) |
| W4 | Offer push to an online agent | `POST /api/signal/offer` → `201` **and** the agent socket receives `{ type: 'signal', data: { type: 'offer', data: { ... } } }` |
| W5 | Offer for an offline agent | `POST /api/signal/offer` → `201`; no push; the row is still returned by `GET /api/signal/poll/:sessionId` (D1 is the source of truth) |
| W6 | Agent `answer` over WS → D1 → browser poll | The `signals` row exists with `type='answer'`; the poll returns it; the session is `active` with non-null `started_at` |
| W7 | Cross-tenant `answer` over WS | `{ type: 'error', code: 'NOT_FOUND' }`; **no** row written (session belongs to another user) |
| W8 | Malformed WS JSON | Non-JSON text and unknown `{ type }` both yield `{ type: 'error', code: 'VALIDATION_ERROR' }` and the socket stays open |
| W9 | Heartbeat flips `is_online` | A `ping` sets `is_online=1`/`last_ping_at` and returns `pong`; `last_ping_at` older than 90 s reports `isOnline: false` at read time even with `is_online = 1` in D1 |
| W10 | Second connection with the same credential | Supersedes: the stale socket is closed and the map holds exactly one entry (no double-push) |
| W11 | Agent socket close terminates the session | Session `pending`/`active` → `terminated` with `ended_at`; a second close does not overwrite `ended_at` |
| W12 | Terminated session is not reopened | An `answer` over WS for a terminated session → `{ type: 'error', code: 'SESSION_NOT_ACTIVE' }`; status stays `terminated` |
| W13 | Credential issuance | `POST /api/agents` returns `{ agent, credential }` once; the stored value is the SHA-256 hex, not `ag_<secret>`; a repeat registration is still `409 AGENT_EXISTS` |
| W14 | `toPublicAgent` projection | `lastHeartbeat` mirrors `last_ping_at`; `capabilities` round-trips as `string[]`, not a JSON string |

Plus the two Week 4 mutation gaps that live in this package, added in task 1 (§8): poll drain on a terminated session (mutant #5) and the `answer` route's sdp validation (mutant #6). Note that W6/W11/W12 cover the session transitions, so the state machine of §6.1 has no separate unit file — as with `connection.ts` in Week 4, the branches are only meaningful against a real socket and a real D1.

### 7.2 Layer 2 — Rust (`cargo test`)

Pure logic, no network, no WebRTC — so it runs everywhere and fast.

| # | Case | Asserts |
|---|---|---|
| R1 | WS message parsing | A `{ type: 'signal', data: { type: 'offer', data: { ... } } }` frame deserialises into the inbound enum; an unknown `type` is rejected without panicking |
| R2 | Framing round-trip | `DataChannelMessage<TerminalDataMessage>` with base64 `data` encodes and decodes byte-identically, including a payload that is not valid UTF-8 (`0xFF 0xFE`) |
| R3 | PTY echo | `pty.rs` spawns the platform shell, runs `echo hello`, and the captured output contains `hello` |
| R4 | Credential precedence | `--credential` beats `AGENT_CREDENTIAL`; neither present is a clean startup error, not a panic |
| R5 | CLI defaults | `--server` defaults to `ws://localhost:8787`; `--shell` override is honoured |

The base64-in-`data` choice is what makes R2 a real test rather than a formality: PTY output is a raw byte stream that can split a UTF-8 sequence across reads, so `data: string` carrying decoded text would corrupt it. Framing the bytes as base64 keeps `TerminalDataMessage` (`packages/shared/src/types/terminal.ts:16-19`) JSON-safe without loss, and R2 pins it.

### 7.3 Layer 3 — Cross-Language E2E (the week's done-criterion)

The harness is the Week 4 `SignalTransport` seam (`packages/webrtc-core/src/types.ts`) consumed by a second, independent implementation — the strongest available validation of Week 4 ADR-02, because a contract that only one side implements is a contract that is only assumed to work.

**Placement and execution.** The harness lives at `packages/webrtc-core/test/e2e/terminal.e2e.test.ts` with its own `packages/webrtc-core/vitest.e2e.config.ts`, and the default `vitest.config.ts` gains `exclude: [...configDefaults.exclude, 'test/e2e/**']`. Rationale: `webrtc-core` is the package that owns the offerer, already resolves `@remote/shared` and `werift` in tests, and already runs under `environment: 'node'`; this needs **no new dependency and no new workspace member**, and it leaves the default `webrtc-core` suite at its Week 4 count. The file is `it.skipIf(process.platform !== 'linux')`, so it is Linux-only in CI (§8.2) and skipped elsewhere.

**Steps.**

1. Start the local Worker: `pnpm --filter @remote/signaling exec wrangler dev --local --port 8787` as a child process (Miniflare's `workerd` under the hood), then poll `GET /health` until it answers. Bounded wait, hard failure on timeout.
2. Seed over REST: register a user, `POST /api/agents` to obtain `credential = ag_<secret>`, `POST /api/sessions` with that `agentId`.
3. Spawn the **real binary**: `apps/agent/target/debug/remote-agent --agent-id <id> --server ws://127.0.0.1:8787 --credential <secret>`. It connects over WS, authenticates by credential hash, and registers in the in-memory map.
4. Offerer: `new PeerConnection(new WeriftAdapter({ iceServers: [] }), new RESTPollingTransport({ baseUrl, sessionId, token, fetch }), { role: 'offerer', channelLabels: ['terminal'] })` and `start()`.
5. Wait for the agent to be online (`GET /api/agents` → `isOnline: true`) before posting the offer, so step 6's push is not racing the socket registration.
6. Exchange: `offer` (POST → pushed to the agent) → agent `answer` (WS → D1) → harness polls the answer → ICE both directions (`POST /api/signal/ice-candidate` for the browser; WS for the agent) → DTLS/SCTP completes on loopback with `iceServers: []` and no STUN.
7. `await offererPC.waitForChannel('terminal', 20000)` → assert `readyState === 'open'`.
8. Send a `DataChannelMessage<TerminalDataMessage>` whose `data` is base64 of `echo hello\n`; assert the received frame is a `DataChannelMessage` on `channel: 'terminal'` whose decoded PTY output contains `hello`.
9. Teardown in a `finally`: kill the agent child process, close the peer, stop the Worker.

**Two assertions that carry the design.** First, the offerer must assert `typeof data === 'string'` is *not* assumed anywhere: the Week 4 PPID bug (`5b8ed86`) proved that wrapping a string in a `Buffer` silently downgrades the frame to `WEBRTC_BINARY`, so the harness must accept both frame kinds and dispatch on the decoded envelope, not on the JavaScript type of the raw message. Second, the harness sends a second message whose PTY output is `printf '\377'` and asserts the received bytes are `0xFF` — this is R2's framing guarantee re-proved end to end, through Rust, webrtc-rs, D1, and werift, where a lossy string conversion anywhere in the chain would corrupt it.

**Why this is not a flaky CI liability.** Loopback needs no STUN (Week 4 F4), the only external process is one binary that is built in the same job, all waits are bounded, and the one wall-clock-sensitive step (step 5) is ordered rather than raced.

### 7.4 Review Focus & Edge Cases

**Five edge inputs, each with the failure it would cause if unhandled.**

1. **Credential leak / replay.** The credential is returned exactly once and only its SHA-256 hex is stored, so a database read cannot yield a usable secret. It must travel in the `Authorization` header and never in the query string — a query-string credential lands in Worker request logs and browser history. A second connection presenting a valid credential supersedes the first (W10) rather than creating two push targets, which would otherwise double-deliver every signal. Lookup is an index probe on a `UNIQUE` hash, so there is no plaintext comparison and no timing-comparable secret in memory.
2. **Push to an offline agent.** Push is best-effort and must never fail the request: `POST /api/signal/offer` returns `201` because D1 accepted the row, regardless of whether a socket exists (W5). A push that throws must be caught and swallowed; an exception escaping into the route would turn a normal "agent not connected yet" case into a `500`.
3. **Answer for a terminated session.** Refused with `SESSION_NOT_ACTIVE`, no row written, status unchanged (W12). This is the mirror of the REST `409` at `signal.ts:32-34`; if the WS path skipped the guard, a late answer would resurrect a dead session and the browser would sit waiting on a peer that is gone.
4. **Malformed WS JSON.** Inbound text that is not JSON, is JSON but not an object, or carries an unknown `{ type }` must all produce `{ type: 'error', code: 'VALIDATION_ERROR' }` and leave the socket open (W8). A throw out of a message handler is the dangerous case — it can tear down the socket and, in the worst case, the isolate. An inbound size cap (reject frames above ~256 KiB) is required for the same reason `limit` is clamped in the poll: the peer is authenticated but not trusted.
5. **PTY binary output framing.** PTY output is bytes, not text: it can contain invalid UTF-8 and can split a multi-byte sequence across reads. Framing is base64 inside `TerminalDataMessage`, wrapped in `DataChannelMessage<TerminalDataMessage>`, and no layer may assume a JavaScript `string` (§7.3). This is the one edge case where a "looks fine on my machine" implementation passes every unit test and corrupts output in production.

**Security.** The WS route must not use the JWT `authMiddleware` (`middleware/auth.ts:19`) — it authenticates with the agent credential and nothing else; the two must not be conflated. The tenancy predicate on the WS path is stricter than REST's: `session.userId == agent.userId` **and** `session.agentId == agent.id`, so an agent cannot speak for a session that is not bound to it even within its own user (W7). A credential failure and an unknown agent id return the same `401`/`NOT_FOUND` shape, matching the no-enumeration convention (`signal.ts:28-30`). The credential hash must never be selected into any response — `toPublicAgent` is the only agent projection and it excludes it.

**Correctness.** The 90 s read-time window (§6.3) is the item most likely to be implemented as a single `is_online` read; W9 exists to catch exactly that. The session transition guards (§6.1) are second — an unguarded `UPDATE` would let a late `answer` reset `started_at` or a late socket close overwrite `ended_at`.

**Boundaries.** No TypeScript `WebSocketTransport` is added to `webrtc-core` this week (ADR-03): the browser keeps `RESTPollingTransport`, and the only WS client is Rust. `webrtc-core`'s public API must not change — the harness consumes it, it does not modify it. `packages/terminal-core` stays a stub; the agent uses `portable-pty` directly.

**Testing.** The E2E harness must not reach the network beyond `127.0.0.1` (no STUN, no TURN — `iceServers: []`). All Layer 1 waits are bounded. Layer 3 is Linux-only and skipped, not failed, on other platforms.

### 7.5 Verification Gate

- `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test` — the Week 4 gate, extended by `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build --locked`, `cargo test --locked`, and the E2E job (§8.2).
- **Baseline: 135 passing JS tests** (signaling 60, `webrtc-core` 24, `apps/web` 30, `api-client` 11, `crypto` 10), unchanged and green before any Week 5 feature code — task 1 adds tests without adding behaviour.
- Target: **≈161 JS tests** (signaling ≈78, `webrtc-core` ≈32, the other three unchanged), reported **separately** from the Rust suite (≈5) and the E2E config (2), whose counts do not enter the JS total because they run under different runners. Exact per-file counts are pinned in the Week 5 plan, as in Week 4 §8.

---

## 8. Delivery Sequence

The plan below states the order, the deliverable, and the test count each step adds; tasks are ordered so the Week 4 residual closes first and the E2E gate lands last.

### 8.1 Ordered Tasks

Task 1 exists to close Week 4's quantified residual before any new feature code is written. The Week 4 ledger measured six reachable branches whose deletion leaves the suite green (`.superpowers/sdd/2026-09-25-phase2-week4-webrtc-core/progress.md`, ruling **R24**), and named two more of the same class (**R30** — the two error paths spec §4.7 promises by name; **R32** — the unbounded candidate buffer and the flush that drops its tail when one candidate rejects). All eight are tests, not behaviour changes.

| # | Task | Deliverable | Tests | Depends on |
|---|---|---|---|---|
| 1 | **R24 six-test commit** (no feature code) | `webrtc-core`: `send()` non-2xx throw; `data-channel` typed-listener `JSON.parse` guard; `poll()` non-2xx error backoff; unknown-label throws. `signaling`: poll drain on a terminated session (mutant #5); `answer` route sdp validation (mutant #6) | +6 (4 + 2) | — |
| 2 | **Week 4 residual tests (R30, R32)** | `webrtc-core`: `send()` HTTP-error propagation; `poll()` error-backoff; candidate-buffer bound; N-candidates flushed with one rejecting. `signaling`: decide and pin the malformed-JSON contract (**R31**) — either let `SyntaxError` reach `MALFORMED_JSON` or correct spec §5.1/§5.6 to say `VALIDATION_ERROR` | +4 | 1 |
| 3 | **Migration `0002_agent_credentials.sql`** + credential issuance | `agents.credential_hash` (added as a plain column, then a `UNIQUE` index — SQLite rejects `ALTER TABLE ... ADD COLUMN ... UNIQUE`, verified), `agents.capabilities`, `sessions.started_at`; drizzle `schema.ts` fields with the `datetime('now')` convention; `POST /api/agents` returns `{ agent, credential }` once; `toPublicAgent` projection | +3 (W13, W14) | 2 |
| 4 | **WS route + push + heartbeat** | `workers/signaling/src/routes/ws.ts` mounted at `/api/ws`; `AgentConnections` in-memory map; credential auth; inbound `signal` persisted through the shared helper; best-effort push from `POST /api/signal/*`; `ping`/`pong`; `AgentSocketMessage` type added to `packages/shared/src/types/signaling.ts` and imported by the Worker (this also closes the Week 4 finding that `@remote/shared` was declared but never imported) | +10 (W1-W10) | 3 |
| 5 | **Session state machine** | `pending → active` on persisted `answer` (+`started_at`); `terminated` on socket close (+`ended_at`); idempotent guards; `isAgentOnline` read-time window used by `toPublicAgent` and the push path | +3 (W11, W12, W9) | 3, 4 |
| 6 | **Rust agent** | `apps/agent`: `Cargo.toml` (crate `remote-agent`), `src/main.rs`, `src/signal.rs`, `src/rtc.rs`, `src/pty.rs`; `Cargo.lock` committed; versions pinned against crates.io at scaffold (ADR-05) | +5 (R1-R5) | 4 |
| 7 | **Cross-language E2E harness** | `packages/webrtc-core/test/e2e/terminal.e2e.test.ts` + `vitest.e2e.config.ts`; default config excludes `test/e2e/**` | +2 | 5, 6 |
| 8 | **CI: Rust + E2E jobs** | New jobs in `.github/workflows/ci.yml`; `apps/agent/package.json` scripts call `cargo` | 0 | 6, 7 |
| 9 | **Docs sync** | `ARCHITECTURE.md` §6.2 `SignalMessage` union (**R26**); §6.2 boundary note superseded by the Week 5 credential; §8 roadmap ticks; §4.2 Cargo sketch marked stale with a pointer to `Cargo.toml`; §3.1 agent tree annotated with the four modules actually shipped | 0 | 5, 6 |

Tasks 3-5 (Worker) and task 6 (Rust) are independent once the wire contract in task 4's `AgentSocketMessage` is frozen, and can proceed in parallel. Task 7 depends on both. Task 9's §6.2 edit closes the Week 4 ledger's own deferral, which explicitly assigned the union to "Week 5 documentation".

### 8.2 CI Updates

`.github/workflows/ci.yml` currently has a single `verify` job running `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test` (`.github/workflows/ci.yml:9-41`). Two jobs are added; `verify` is unchanged.

**`rust`** — `runs-on: ubuntu-latest`. `dtolnay/rust-toolchain` (pinned by SHA, stable toolchain with `rustfmt` + `clippy`), `Swatinem/rust-cache`, then in `apps/agent`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo build --locked`, `cargo test --locked`. `--locked` everywhere so `Cargo.lock` is authoritative and a dependency bump is a reviewable diff rather than a CI surprise. No system packages are needed: `portable-pty` and `webrtc-rs` are pure Rust on Linux. `target/` is already ignored in three places (`.gitignore`, `eslint.config.js`'s `**/target/**`, `.prettierignore`), so the crate adds no ignore churn.

**`e2e`** — `needs: [verify, rust]`, `runs-on: ubuntu-latest`, Linux-only by construction. Steps: install, `cargo build` in `apps/agent` (debug), then run the E2E config (`pnpm --filter @remote/webrtc-core exec vitest run --config vitest.e2e.config.ts`). This job is the week's done-criterion and is blocking; its child-process teardown runs in a `finally` so a failure does not leak a `wrangler dev` process into the next step.

**`apps/agent/package.json`** — the `echo ok` stubs are replaced with `build`, `test`, `lint`, and `typecheck` scripts that shell out to `cargo` (`--manifest-path Cargo.toml`). Effect to state plainly: `turbo run test` (and therefore `pnpm test`) now also invokes the Rust suite, so the JS test total and the Rust total are reported by different runners in the same gate — the JS counts in §7.5 are unaffected.

### 8.3 Documentation Updates

- **`ARCHITECTURE.md` §6.2 (`:929-955`)** — add the `SignalMessage` discriminated union (`packages/shared/src/types/signaling.ts:20-23`) and the new `AgentSocketMessage` envelope to the code block, so a reader implementing the agent from the document alone learns the `{ type, data }` shape rather than three payload interfaces. This is the Week 4 ledger's R26, deferred there to Week 5 by its own ruling.
- **§6.2 boundary note (`:955`)** — the Week 4 note says agent-scoped credentials "are introduced in Week 5"; Week 5 replaces it with what actually exists: `ag_<secret>` issued once at registration, SHA-256 at rest, enforced on `GET /api/ws/agent` and on the WS inbound tenancy check (`session.userId == agent.userId` **and** `session.agentId == agent.id`), with the residual stated — the REST `POST /api/signal/*` routes still authenticate as the owning user, so browser/agent separation holds on the WS path only.
- **§8 roadmap (`:1193-1199`)** — tick the Week 5 items that ship: Rust agent, WebSocket signaling, `portable-pty`, terminal I/O, session management. Add a line noting the deliberate hybrid: REST for the browser, WS for the agent (ADR-03), so "WebSocket signaling" is not read as "all signaling".
- **§4.2 Cargo sketch (`:647-718`)** — the listed versions (`webrtc 0.10`, `portable-pty 0.8`, `tokio-tungstenite 0.21`) are stale; mark the sketch as indicative and point to `apps/agent/Cargo.toml` as the source of truth (ADR-05).
- **§3.1 agent tree (`:348-384`)** — annotate the four modules shipped (`main.rs`, `signal.rs`, `rtc.rs`, `pty.rs`) against the document's fuller tree, and record that `media_channel`/`capture`/`files` remain Phase 3-4, so the difference is not mistaken for drift.
- **Week 5 spec, §7.5 note** — the eight Week 4 residual tests (R24, R30, R31, R32) are closed by tasks 1-2; the ledger entries can be marked resolved once the commit lands.
