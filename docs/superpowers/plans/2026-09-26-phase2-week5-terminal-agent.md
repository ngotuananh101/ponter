# Phase 2 Week 5 — Terminal Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Week 4 residual (eight untested reachable branches), then ship the credentialed agent WebSocket relay on `workers/signaling` (`GET /api/ws/agent`), the `pending → active → terminated` session state machine, the Rust `remote-agent` binary at `apps/agent` (WS signaling client + `webrtc` answerer + `portable-pty` bridge), a cross-language E2E harness that runs real PTY bytes over a real DTLS/SCTP connection, and the CI jobs that gate all of it.

**Architecture:** Two independent implementations of one wire contract, meeting at a real P2P connection. The browser keeps Week 4's `RESTPollingTransport`; the Rust agent dials a WebSocket relay that lives in the same Worker (`agentConnections`, a module-scope `Map`, therefore per-isolate — the push is a latency optimisation and D1 + poll remains the delivery guarantee). The agent is answerer-only: `set_remote_description` → `create_answer` → accept the `terminal` data channel → spawn a PTY → pump bytes as base64 inside `DataChannelMessage<TerminalDataMessage>`. One shared persistence helper (`recordSignal`) is the only writer of `signals`, and it is where the `answer → active` transition lives.

**Tech Stack:** TypeScript 6.0.3, Node >= 24 (24.21.0 local), pnpm 12.6.0 workspaces, Vitest 5.0.1 (`packages/webrtc-core`) & Vitest 4.1.x + `@cloudflare/vitest-pool-workers` 0.22.0 (`workers/signaling`), Hono 4.13.9, Drizzle ORM 0.45.3 / drizzle-kit 0.31.11, `werift@0.24.4` (devDependency only), ESLint 10 flat config, Prettier 3.9.9 (`singleQuote: true`), Rust 1.98.1 (`cargo 1.98.1`), `webrtc = "0.13"`, `tokio-tungstenite = "0.26"`, `portable-pty = "0.9"`, `clap = "4"`, `base64 = "0.23"`.

**Spec:** `docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md`

---

## Global Constraints

- Root `packageManager` is `pnpm@12.6.0`. Node floor is `>= 24`. TypeScript is pinned at `6.0.3` across all workspaces.
- `workers/signaling/wrangler.toml` must keep its exact name and path; `@cloudflare/vitest-pool-workers` references it directly (`workers/signaling/vitest.config.ts` → `configPath: './wrangler.toml'`).
- `wrangler.prod.toml` is gitignored and contains real Cloudflare D1/KV IDs; NEVER commit it or remove it from `.gitignore`.
- Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `JWT_SECRET`, `REFRESH_TOKEN_SECRET`) are never hardcoded or committed; they are set with `wrangler secret put`. Test suites use `TEST_JWT_SECRET` from `workers/signaling/test/helpers.ts`.
- **SQLite datetime format compatibility:** every D1 timestamp write and comparison this plan adds MUST use `datetime('now')` (space-separated `YYYY-MM-DD HH:MM:SS`, UTC). NEVER write `new Date().toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`) into a column that holds `datetime('now')` values: the `'T'` sorts after the `' '`, so an ISO value compares lexicographically greater than every SQLite timestamp and any `> datetime('now', '-90 seconds')` window silently becomes a no-op. When JS must produce this format, use `sqliteNow()` (Task 5).
  The rule is scoped to columns that participate in a `datetime()` comparison, which is why it does **not** reach `users.last_login_at`. That column is written as an ISO string (`routes/auth.ts:162`) and is never compared against a `datetime()` value anywhere in the Worker — it is only projected opaquely through `toPublicUser`. Converging it is a Week 4 cleanup with no observable effect and no test to pin it, so it is deliberately left alone rather than swept into this week's diff. `sessions.ended_at`/`updated_at` are the opposite case — they *are* compared — which is why D-6 converges them.
- `packages/shared` MUST remain DOM-free: `sdp: string`, `candidate: string`, no `RTCSessionDescriptionInit`, no `RTCIceCandidateInit`. The existing `SignalMessage` union is **not modified** this week.
- `packages/webrtc-core`'s public API MUST NOT change (ADR-03). The E2E harness consumes it; nothing in `src/` is edited except the two error-path guards Task 1 and Task 2 pin with tests, and `vitest.config.ts`'s `exclude`.
- No TypeScript `WebSocketTransport` is added to `packages/webrtc-core`. The browser keeps polling.
- `apps/agent/target/` is already ignored by `.gitignore`, `.prettierignore` and `eslint.config.js` (`**/target/**`). `apps/agent/Cargo.lock` is NOT ignored and MUST be committed (ADR-08).
- The E2E harness must not reach the network beyond `127.0.0.1`: `iceServers: []`, no STUN, no TURN. It is gated by `describe.skipIf(!isLinux)` — **not** `it.skipIf`, even though spec §7.3 spells it that way. `it.skipIf` skips the test but still runs `beforeAll`, which spawns `wrangler dev` and applies migrations; on macOS or Windows that fails rather than skips. Task 7 carries the full rationale.
- The credential (`ag_<32 hex>`) is returned exactly once, stored only as a SHA-256 hex digest, and travels only in the WS handshake `Authorization: Bearer` header — never in a query string, never in a log line, never selected into a response body.
- Prettier: `singleQuote: true`. Run `pnpm format:check` and `pnpm format` as needed. Drizzle's generated `meta/*_snapshot.json` and `_journal.json` must be run through `npx prettier --write` before committing or `format:check` exits 1 (Week 4 R17).
- A task is not done until `pnpm format:check` exits 0.
- **Every commit ends with the attribution trailer.** The ten `git commit` blocks below print only the subject line; append the body the repository requires:

  ```
  Co-Authored-By: Claude Code <noreply@anthropic.com>
  ```

  Use `git commit -m "subject" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"` (a second `-m` keeps it as a separate paragraph), or `git commit -F -` with the subject and trailer on their own lines. A PR description written from this plan ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Test baseline: 135 passing JS tests** at `264277f` (signaling 60, `webrtc-core` 24, `apps/web` 30, `api-client` 11, `crypto` 10). Target: **164 JS tests** — signaling **81**, `webrtc-core` **32**, the other three unchanged. Reported **separately** from the Rust suite (**11 test functions**, `cargo test`) and the E2E config (**2**), which run under different runners and do not enter the JS total. The Rust number is a function count, not a case count: §8.1 task 6's `+5` counts the R1–R5 cases the spec names, and several functions cover more than one. One of the 11 (`pty_echo_round_trip`) is `#[cfg(unix)]`, so a Windows run reports 10 — CI is Linux and sees all 11; Task 6 Step 10 says so.
- **Week 4 ledger residual — closed by Tasks 1, 2 and 9.** §8.3 names eight residual tests across four rulings, all now covered. `R24` (six reachable branches whose deletion left the suite green) is closed by Task 1's six tests. `R30` (the two `transport.ts` error paths spec §4.7 promises by name) and `R32` (the unbounded candidate buffer, and the flush that drops its tail when one candidate rejects) are closed by Task 2. `R31` (the unreachable `MALFORMED_JSON` path) is closed by Task 2, which pins the contract as `VALIDATION_ERROR` for a non-JSON body and corrects the Week 4 spec's row. `R26` (the `SignalMessage` union missing from `ARCHITECTURE.md` §6.2) is closed by Task 9 Step 2, which is the Week 5 documentation the ledger's own ruling deferred it to. The ledger itself is `.superpowers/sdd/2026-09-25-phase2-week4-webrtc-core/progress.md`, which is gitignored (`.gitignore:38`) and therefore not reviewable in a diff — this line, not a ledger edit, is the durable record (D-15).

### Spec deviations resolved in this plan

The spec is a design document written before the code it describes was read line by line. Fifteen places where it is self-contradictory, where its printed code cannot compile, where a step describes a shape the code does not have, or where a documentation instruction contradicts the document it targets are resolved here. Each is called out again at the task that owns it.

| # | Spec location | Resolution in this plan |
|---|---|---|
| D-1 | §4.1/§4.5 name `parseSignalMessage` but never give its body | Authored in Task 3, `src/utils/signals.ts`. Validation rules are pinned in that task's Interfaces block. |
| D-2 | §5.9.1 requires a `hello` frame within 5 s; §4.5's `handleInbound` has no `hello` arm, so `{type:'hello'}` falls through to `VALIDATION_ERROR` | The Worker contract (§4.3.3 + §4.5) is authoritative. The Rust client sends **no** `hello`; identity is derived server-side from the credential (ADR-13 already says this). §5.9.1's `hello` row and its error-code list are superseded and recorded in Task 9. |
| D-3 | §5.9.1's error list is `UNAUTHORIZED \| BAD_FRAME \| SESSION_NOT_FOUND`, contradicting §4.3.3 and §4.5 | §4.3.3 is authoritative: `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`, plus the HTTP-level `UNAUTHORIZED` (401) and `UPGRADE_REQUIRED` (426). `SESSION_NOT_ACTIVE` appears in **both** transports — as the REST `409` on the three `POST /api/signal/*` routes, and as a WS error frame emitted by `handleInbound` for a terminated session (Task 5 Step 9). It is a member of `AgentErrorCode`, so it is a legal frame code; it is not part of §4.3.3's inbound-validation set, which is why Task 4's four codes and Task 5's fifth are introduced separately. |
| D-4 | §5.5.1's `ClientFrame::Hello` puts `rename_all = "kebab-case"` on the enum, which renames variants only, so fields would serialize `agent_id` not `agentId` | Moot: the frame is removed by D-2. Task 6's `signal.rs` has no `ClientFrame`. |
| D-5 | §6.3's `isAgentOnline` compares a `string` to a drizzle `SQL` object — invalid TypeScript | Real implementation in Task 5: `isAgentOnline(agent, socketPresent, nowMs?)` with a JS-side `sqliteNow()` producing the byte-identical space-separated UTC shape. |
| D-6 | §6.4 says `created_at`/`ended_at` already carry `datetime('now')`, but `routes/sessions.ts:138-139` writes `new Date().toISOString()` | `DELETE /api/sessions/:id` is converged onto ``sql`datetime('now')``` in Task 5, with a format-asserting test. This is a bug fix: the current write contradicts §6.4 and breaks every `datetime()` comparison over that column. |
| D-7 | ADR-04's Decision text says the Rust layout follows `ARCHITECTURE.md:348-357` (`config.rs` + `webrtc/` subdir); ADR-07 and §5.4.1 fix four flat files | Follow ADR-07/§5.4.1: `main.rs`, `signal.rs`, `rtc.rs`, `pty.rs`. No `config.rs`, no `webrtc/` subdirectory, no `agent.toml`. |
| D-8 | §6.1's guard paragraph says both transitions apply `WHERE status IN ('pending','active')`, but §6.1 two paragraphs later says the `active` transition applies "when `type === 'answer'` and the session is `pending`" | The two sentences conflict, and the blanket `IN` form is wrong for the `active` transition: it matches an already-`active` session and overwrites `started_at` on every duplicate `answer`, which is precisely what the guard paragraph promises it prevents. Task 5 splits them: `active` uses `WHERE status = 'pending'`, `terminated` keeps `IN ('pending','active')` (correct there — it stops a socket close from moving `ended_at` after a browser `DELETE`). Task 5's Step 1 test pins both halves. |
| D-9 | §7.4 edge 3 names only "a WS `answer` or `ice-candidate` for a terminated session is refused" and §8.1 task 5 lists `+3` tests (W11, W12, W9) | Task 5 writes **5**: the three the spec names (`ws.test.ts`: `pending→active` + W11 close-terminates + W9 the 90 s window) plus two the spec's own Review Focus requires but does not count — the terminated-session refusal of edge 3 (asserted in `ws.test.ts`, so the `SESSION_NOT_ACTIVE` frame is not merely declared in a type) and the `ended_at` format assertion for D-6 (`resources.test.ts`, the only test that pins the D-6 convergence). Without them two of this plan's stated guarantees would ship unasserted. |
| D-10 | The WS path is `/ws/agent` in §5.8.1's clap default, §5.9.3 and §5.11.5's `.env.example`; it is `/api/ws/agent` in §4.4, §4.13 and §8.1 task 4 | **Follow §4.4/§4.13.** Task 4 mounts `app.route('/api/ws', ws)`, so the reachable path is `/api/ws/agent`, and every other Worker route in this repository is under `/api`. The spec's four `/ws/agent` spellings describe a route that does not exist — an agent built from them gets a 404 at the handshake. Task 6's clap `default_value` and `.env.example` use the `/api` form, and Task 9 records the correction at the §5.8.1/§5.11.5 doc sites. |
| D-11 | §7.3 step 2: "`POST /api/agents` to obtain `credential = ag_<secret>`" | Task 3 changed that response to `{ agent, credential }`. Task 7's harness reads `body.credential` from the envelope and `body.agent.id` for the `--agent-id` flag. §7.3's phrasing describes the pre-Task-3 shape — which is also the shape on `main` today (a bare agent row with no `credential` key at all), so a harness written from the spec would send `Bearer undefined` and be answered `401`. |
| D-12 | §7.3 step 3: `--server ws://127.0.0.1:8787` | Missing the route path — the same root cause as D-10. Task 4 mounts `/api/ws` with a `/agent` route, so the URL is `ws://127.0.0.1:8787/api/ws/agent`. Task 7's harness passes the full path, which also overrides Task 6's `localhost` default with `127.0.0.1` — the address `wrangler dev` actually binds and prints as `Ready on`. |
| D-13 | §7.3 step 9: teardown "kill the agent child process" | `remote-agent` **is** the child process; it has none of its own. Task 7's harness spawns it directly and kills the handle it holds (`child.kill('SIGKILL')`), then awaits its `exit`. No wrapper script, no process group. |
| D-14 | §8.3's third bullet instructs: "tick the Week 5 items that ship" | **Annotate, do not tick.** `docs/ARCHITECTURE.md` contains **zero** ticked boxes (`grep -c '^- \[x\]'` → 0) across **85** unticked ones, and `git log -S'- [x]' -- docs/ARCHITECTURE.md` is empty — it has never contained one, including for the Phase 1 and Week 4 items that shipped. Ticking only Week 5 would assert that Phase 1 and Week 4 are *not* done while Week 5 is, contradicting the same roadmap. Task 9's Step 4 adds a `Trạng thái:` line and leaves the boxes as `[ ]`. |
| D-15 | §8.3's last bullet: "the ledger entries can be marked resolved once the commit lands" | **Recorded in this plan instead.** The ledger is `.superpowers/sdd/2026-09-25-phase2-week4-webrtc-core/progress.md`, and `.superpowers/` is gitignored (`.gitignore:38`) — it is not part of the repository, so an edit there is unreviewable and unshippable. Task 9's Step 11 appends a Global Constraints bullet to this plan, which is the artifact that ships. |

Two further spec statements are corrected rather than implemented:

- **§4.11 "Boundaries" says `packages/shared` is not modified.** The `SignalMessage` union is indeed untouched, but `AgentSocketMessage` and `AgentErrorCode` are added to `src/types/signaling.ts` **and to the `src/types/index.ts` barrel** (the barrel is not mentioned in §8.1 task 4; without it the Worker's `import ... from '@remote/shared'` does not resolve).
- **§4.10's per-file test counts (16 + 6 + 5 + 4 = +31) contradict §7.5's target of 161, and §8.1's per-task counts (+6, +4, +3, +10, +3 = +26) double-book the same work twice**: W9 appears in both task 4's list (W1–W10) and task 5's list (W11, W12, W9), and §4.12's task 5 ("best-effort push", +5) is a slice of §8.1's task 4 (+10, the whole socket suite) rather than an addition to it. The spine's own sum is therefore +25 by its own accounting and +26 by its list. This plan pins the counts exactly, from the tests the tasks below actually write:

  | Suite | Baseline | After | Per-file additions |
  |---|---|---|---|
  | `workers/signaling` | 60 | **81** | `test/signal.test.ts` **+5** — 2 in Task 1 (mutants #5, #6), 1 in Task 2 (R31), 2 in Task 4 (the push cases); `test/resources.test.ts` **+4** — 2 in Task 3, 2 in Task 5; `test/db.test.ts` **+1** (Task 3); `test/ws.test.ts` **+11 (new file)** — 8 in Task 4, 3 in Task 5 |
  | `packages/webrtc-core` | 24 | **32** | `test/transport.test.ts` **+4** (2 in Task 1, 2 in Task 2); `test/data-channel.test.ts` **+2** (Task 1); `test/p2p.test.ts` **+2** (Task 2) |
  | `apps/web` | 30 | 30 | — |
  | `packages/api-client` | 11 | 11 | — |
  | `packages/crypto` | 10 | 10 | — |
  | **Total** | **135** | **164** | |

  Running total after each task: T1 +6 → **141**, T2 +5 → **146**, T3 +3 → **149**, T4 +10 → **159**, T5 +5 → **164**, T6–T9 **164**. Reported separately and NOT in that total: `cargo test` (**11 test functions**, Layer 2) and `vitest.e2e.config.ts` (**2**, Layer 3). §4.10's `ws.test.ts ≈ 16` and §4.12's per-task counts are a coverage checklist, not a count — every scenario they name is still covered, several folded into one test where they share a code path. The split above is what the tasks below deliver; it is 3 over §7.5's "≈161", which was itself an approximation.

---

## Review Focus

Five input classes the spec names as dangerous but which no single task's happy-path test covers. Each line's test is added to the owning task, in that task's own step style.

1. **A credential that leaks or replays.** The credential is returned exactly once and only its SHA-256 hex is stored, so a database read yields no usable secret; it travels in the `Authorization` header and never in a query string, because a query-string credential lands in Worker request logs, `Referer`, and browser history. A second connection presenting a valid credential must *supersede* the first, not create a second push target — two entries would double-deliver every signal. A distinguishing `401` body for "no header" vs "unknown credential" would turn the endpoint into a credential oracle.
   *Expected behavior:* all three `401` variants (missing header, non-`Bearer` scheme, unknown credential) return the identical status, message and code; the map holds exactly one entry per `agentId`; a superseded socket's `close` event does not evict the live socket and does not clear `is_online`.
   *Owning task:* Task 4 (auth + supersede tests in `workers/signaling/test/ws.test.ts`), Task 3 (the projection that keeps `credentialHash` out of every response body).

2. **A push to an agent that is not there.** `agentConnections` is module-scope and therefore per-isolate: the socket lives in the isolate that accepted it, and a `POST /api/signal/*` served elsewhere sees an empty map. A push must never fail the request, and a dead socket must not turn a successful insert into a `500`.
   *Expected behavior:* `POST /api/signal/offer` returns `201` and the row is still returned by `GET /api/signal/poll/:sessionId` whether the agent has a socket, has no socket, or has a socket whose server end already closed. `pushToAgent` is synchronous, returns `void`, and swallows every failure; a throwing `send()` drops the stale map entry.
   *Owning task:* Task 4 (`pushToAgent` + the offline/dead-socket tests in `workers/signaling/test/signal.test.ts`).

3. **An `answer` for a session that is already terminated.** A late answer that reopens a dead session leaves the browser waiting on a peer that is gone, and an unguarded `UPDATE` lets a late socket close overwrite `ended_at` with a later timestamp.
   *Expected behavior:* a WS `answer` or `ice-candidate` for a terminated session is refused with `{type:'error', code:'SESSION_NOT_ACTIVE'}`, no `signals` row is written, and the status stays `terminated`. The `active` transition applies `WHERE status = 'pending'` and the `terminated` transition applies `WHERE status IN ('pending','active')` (D-8), so a second `answer` cannot reset `started_at` and a socket close cannot move `ended_at` after a browser `DELETE`.
   *Owning task:* Task 5 (`test/ws.test.ts` for the refusal, `test/resources.test.ts` for the `ended_at` format).

4. **Malformed WebSocket JSON.** Inbound text that is not JSON, is JSON but not an object, carries an unknown `{type}`, or exceeds the size cap must produce an error frame and leave the socket open. A throw escaping a `message` handler is the dangerous case — it can tear the socket down and, in the worst case, the isolate.
   *Expected behavior:* every malformed inbound frame yields `{type:'error', code:'MALFORMED_JSON'}` (not JSON, not an object, or above the `MAX_INBOUND_FRAME_BYTES` cap — refused before parsing) or `{type:'error', code:'VALIDATION_ERROR'}` (parses but is not a recognised member), and the socket stays open and usable. Binary frames are ignored without a reply.
   *Owning task:* Task 4 (`handleInbound` + the malformed/oversize test in `test/ws.test.ts`).

5. **PTY binary output framing.** PTY output is bytes, not text: it can contain invalid UTF-8 and can split a multi-byte sequence across two `read()` calls. A "looks fine on my machine" implementation passes every unit test and corrupts output in production.
   *Expected behavior:* frames are `DataChannelMessage<TerminalDataMessage>` sent as JSON text with `payload.data` = standard base64 of the raw bytes; a payload that is not valid UTF-8 (`0xFF 0xFE`) round-trips byte-identically; no layer assumes a JavaScript `string`. The E2E harness dispatches on the decoded envelope rather than on the JavaScript type of the raw message, because Week 4's `5b8ed86` proved a `Buffer`-wrapped string silently downgrades a frame to `WEBRTC_BINARY`.
   *Owning task:* Task 6 (Rust framing unit tests) and Task 7 (the `0xFF` assertion end to end).

---

### Task 1: R24 Six-Mutant Commit (tests only, no feature code)

The Week 4 ledger (`.superpowers/sdd/2026-09-25-phase2-week4-webrtc-core/progress.md`, ruling **R24**) measured six reachable branches whose deletion leaves the suite green. This task adds the six tests that turn each mutant red. **No production code changes in this task** — if any test here requires a source edit, the test is wrong or the branch is already correct and must be re-examined.

**Files:**
- Test: `packages/webrtc-core/test/transport.test.ts` (append two tests; file is 257 lines, 7 tests today)
- Test: `packages/webrtc-core/test/data-channel.test.ts` (append two tests; file is 162 lines, 6 tests today)
- Test: `workers/signaling/test/signal.test.ts` (append two tests; file is 428 lines, 14 tests today)

**Interfaces:**
- Consumes: `RESTPollingTransport` (`packages/webrtc-core/src/transport.ts:50-92` `send`, `:122-180` `poll`), `DataChannelManager` (`packages/webrtc-core/src/data-channel.ts:19-56` `registerChannel`, `:66-88` `sendRaw`/`sendJson`), `app` from `workers/signaling/src/index.ts`, `RESET_STATEMENTS` from `workers/signaling/test/helpers.ts`.
- Produces: nothing. Test-only.

- [ ] **Step 1: Pin mutant #1 — `send()` throws on a non-2xx response**

`packages/webrtc-core/src/transport.ts:82-87` throws `Failed to send signal ...: HTTP <status> <text>`. Deleting that block leaves all 24 `webrtc-core` tests passing.

Append to `packages/webrtc-core/test/transport.test.ts` (inside the existing `describe('RESTPollingTransport')` block, before the closing `});`):

```typescript
  it('throws when send() receives a non-2xx response', async () => {
    // Mutant #1 (Week 4 R24): deleting the `!res.ok` throw at
    // src/transport.ts:82-87 leaves the suite green. A signal that D1 refused
    // must not look like a delivered signal, or the peer negotiates against a
    // description the other side never received.
    const fetchSpy = vi.fn(
      async () => new Response('session is terminated', { status: 409 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await expect(
      transport.send({
        type: 'offer',
        data: { sessionId: '', sdp: 'v=0', capabilities: ['terminal'] },
      }),
    ).rejects.toThrow('Failed to send signal offer: HTTP 409');

    transport.close();
  });
```

- [ ] **Step 2: Pin mutant #3 — `poll()` backs off on a non-2xx response**

`packages/webrtc-core/src/transport.ts:138-146` grows `currentIntervalMs` by 1.5× on `!res.ok`. Deleting that branch leaves 7/7 transport tests passing.

Append to `packages/webrtc-core/test/transport.test.ts`:

```typescript
  it('backs off polling interval on a non-2xx response', async () => {
    // Mutant #3 (Week 4 R24): deleting the `!res.ok` branch at
    // src/transport.ts:138-146 makes the transport retry at the base interval
    // forever against a Worker that is returning 500, turning a transient
    // outage into a request flood.
    const fetchSpy = vi.fn(
      async () => new Response('boom', { status: 500 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});

    // Poll 1 at 100ms, then back off to 150ms scheduled from that instant.
    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(139); // 249ms — not yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 250ms — second poll
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    transport.close();
  });
```

- [ ] **Step 3: Run the two transport tests and confirm they pass against the current source**

Run: `pnpm --filter @remote/webrtc-core test transport`
Expected: 9 tests PASS. If either new test fails, the branch under test is already broken — stop and report rather than editing `src/`.

- [ ] **Step 4: Pin mutant #2 — the typed-listener `JSON.parse` guard**

`packages/webrtc-core/src/data-channel.ts:34-45` wraps `JSON.parse` in `try/catch` for typed listeners. Removing the `try/catch` leaves 24/24 passing because no existing test feeds a registered typed listener non-JSON data.

Append to `packages/webrtc-core/test/data-channel.test.ts` (inside `describe('DataChannelManager')`, before the closing `});`):

```typescript
  it('survives non-JSON data on a channel with a typed listener', () => {
    // Mutant #2 (Week 4 R24): removing the try/catch around JSON.parse at
    // src/data-channel.ts:35-44 lets a raw PTY byte frame throw out of the
    // channel's message handler. A PTY stream is bytes, so this is the normal
    // case, not an edge case.
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('terminal');
    mgr.registerChannel(ch);

    const received: string[] = [];
    mgr.onMessage('terminal', (msg) => received.push(msg.type));

    expect(() => ch.simulateMessage('not json at all')).not.toThrow();
    expect(received).toEqual([]);

    // The channel must still work: the guard swallows one bad frame, it does
    // not tear the listener down.
    ch.simulateMessage(
      JSON.stringify({
        channel: 'terminal',
        type: 'terminal-data',
        payload: { terminalId: 't1', data: '' },
        timestamp: Date.now(),
      }),
    );
    expect(received).toEqual(['terminal-data']);
  });
```

- [ ] **Step 5: Pin mutant #4 — both unknown-label throws**

`packages/webrtc-core/src/data-channel.ts:66-72` (`sendRaw`) and `:74-88` (`sendJson`) each throw `Data channel "<label>" is not registered`. Replacing both `throw`s with `return` leaves 6/6 passing.

Append to `packages/webrtc-core/test/data-channel.test.ts`:

```typescript
  it('throws when sending on an unregistered channel label', () => {
    // Mutant #4 (Week 4 R24): replacing either throw at src/data-channel.ts:66
    // or :74 with `return` makes a send to a label that does not exist a silent
    // no-op — the caller believes the frame left the machine.
    const mgr = new DataChannelManager();

    expect(() => mgr.sendRaw('terminal', 'bytes')).toThrow(
      'Data channel "terminal" is not registered',
    );
    expect(() => mgr.sendJson('terminal', 'terminal-data', {})).toThrow(
      'Data channel "terminal" is not registered',
    );
  });
```

- [ ] **Step 6: Run the data-channel tests**

Run: `pnpm --filter @remote/webrtc-core test data-channel`
Expected: 8 tests PASS.

- [ ] **Step 7: Pin mutant #5 — the poll still drains a terminated session**

`workers/signaling/src/routes/signal.ts:199-219` deliberately performs no session-status check on the poll. Adding a `409` check there leaves 14/14 `signal.test.ts` tests passing. This is load-bearing for Week 5: the browser must still be able to poll the final `answer` rows written before the agent's socket closed.

Append to `workers/signaling/test/signal.test.ts` (inside `describe('Signaling REST API (/api/signal)')`, before the closing `});`):

```typescript
  it('still returns signals for a terminated session (poll drain)', async () => {
    // Mutant #5 (Week 4 R24): adding a status check to the poll route leaves
    // the suite green. Week 5 makes the poll load-bearing — the browser must be
    // able to read the final answer written before the agent's socket closed.
    await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'final_answer' }),
      },
      env,
    );

    await app.request(
      `/api/sessions/${sessionIdA}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tokenUserA}` } },
      env,
    );

    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      { headers: { Authorization: `Bearer ${tokenUserA}` } },
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.payload.sdp).toBe('final_answer');
  });
```

- [ ] **Step 8: Pin mutant #6 — the `answer` route validates `sdp`**

`workers/signaling/src/routes/signal.ts:99-105` rejects a missing/empty `sdp` on `POST /api/signal/answer` with `400 VALIDATION_ERROR`. Deleting that check leaves 14/14 passing. The existing "rejects missing sdp on offer/answer" test at `signal.test.ts:338` only exercises the **offer** route.

Append to `workers/signaling/test/signal.test.ts`:

```typescript
  it('rejects a missing sdp on the answer route with 400 VALIDATION_ERROR', async () => {
    // Mutant #6 (Week 4 R24): deleting the sdp check at
    // src/routes/signal.ts:99-105 leaves the suite green because the existing
    // coverage only posts to the offer route.
    const res = await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });
```

- [ ] **Step 9: Run the signaling suite**

Run: `pnpm --filter @remote/signaling test`
Expected: 62 tests PASS (60 + 2).

- [ ] **Step 10: Run the whole gate and the format check**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **141 passing JS tests** (signaling 62, `webrtc-core` 28, `apps/web` 30, `api-client` 11, `crypto` 10).

- [ ] **Step 11: Commit**

```bash
git add packages/webrtc-core/test/transport.test.ts packages/webrtc-core/test/data-channel.test.ts workers/signaling/test/signal.test.ts
git commit -m "test: pin six reachable branches from Week 4 R24 (webrtc-core + signaling)"
```

---

### Task 2: Week 4 Residual — R30, R32, and the R31 Malformed-JSON Contract

Task 1 closed the six mutants. Three Week 4 findings remain: **R30** (the two error paths Week 4 spec §4.7 promises by name are untested — the error *message* of `send()`, and `poll()` backing off when `fetch` itself rejects), **R32** (the ICE candidate buffer is unbounded, and `flushPendingCandidates` drops its tail when one candidate rejects), and **R31** (spec §5.1 promises `MALFORMED_JSON` for a non-JSON body, but all three POST routes do `await c.req.json().catch(() => null)`, so a `SyntaxError` becomes `null` and then `VALIDATION_ERROR` — the `MALFORMED_JSON` path is unreachable).

**Files:**
- Test: `packages/webrtc-core/test/transport.test.ts` (append one test)
- Test: `packages/webrtc-core/test/p2p.test.ts` (append two tests; file is 293 lines, 5 tests today)
- Modify: `packages/webrtc-core/src/connection.ts:22` (the buffer becomes bounded)
- Modify: `packages/webrtc-core/src/connection.ts:169-174` (`flushPendingCandidates` survives a rejection)
- Test: `workers/signaling/test/signal.test.ts` (append one test)
- Modify: `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md` (correct the `MALFORMED_JSON` contract row)

**Interfaces:**
- Consumes: `RESTPollingTransport`, `PeerConnection` (`packages/webrtc-core/src/connection.ts`), `RTCPeerConnectionLike` (`packages/webrtc-core/src/types.ts:12-27`).
- Produces:
  ```typescript
  // packages/webrtc-core/src/connection.ts
  /** Hard cap on ICE candidates buffered before the remote description lands. */
  export const MAX_PENDING_CANDIDATES = 64;
  ```
  `MAX_PENDING_CANDIDATES` is the only new public symbol in `webrtc-core` this week. It is a named export from `connection.ts`; `src/index.ts` is unchanged, so the package's documented API surface is unaffected (ADR-03).

**Why the R31 decision is "correct the spec", not "change the route".** `workers/signaling/src/middleware/error.ts:28-40` already implements `SyntaxError → 400 MALFORMED_JSON`, with a comment explaining that `instanceof SyntaxError` is the discriminator that fires. It is unreachable from the signal routes only because each route pre-empts it with `.catch(() => null)`. `workers/signaling/src/routes/sessions.ts:60` makes the opposite choice **deliberately**, with its own test (`rejects a null JSON body with 400 VALIDATION_ERROR`). Converging all four routes onto `MALFORMED_JSON` would be a behaviour change to shipped, tested routes in a commit whose stated purpose is closing test gaps. The `VALIDATION_ERROR` answer is also the more useful one for a client: "your payload is not a valid signal" is actionable, while "your JSON is malformed" tells a caller who sent `null` nothing. So the spec is corrected and the current behaviour is pinned.

- [ ] **Step 1: Write the failing test for `send()`'s error message (R30a)**

Task 1 pinned *that* `send()` throws on a non-2xx. R30 is about the message: a caller diagnosing a rejection needs the status and the server's body text, not just "failed".

Append to `packages/webrtc-core/test/transport.test.ts`:

```typescript
  it('includes the status and response body in the send() error message', async () => {
    // R30: Week 4 spec §4.7 names this error path; only the fact of throwing
    // was untested, and the message is what a caller debugs with.
    const fetchSpy = vi.fn(
      async () => new Response('{"code":"SESSION_NOT_ACTIVE"}', { status: 409 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await expect(
      transport.send({
        type: 'ice-candidate',
        data: {
          sessionId: '',
          candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
          sdpMid: null,
          sdpMLineIndex: null,
        },
      }),
    ).rejects.toThrow(
      'Failed to send signal ice-candidate: HTTP 409 {"code":"SESSION_NOT_ACTIVE"}',
    );

    transport.close();
  });
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `pnpm --filter @remote/webrtc-core test transport`
Expected: 10 tests PASS. (`src/transport.ts:82-87` already interpolates both values; this test pins the contract so a future edit cannot drop them.)

- [ ] **Step 3: Write the failing test for `poll()` backing off when `fetch` rejects (R30b)**

Task 1 pinned the `!res.ok` path. This is the other half of R30: `fetch` itself throwing (DNS failure, connection refused) must also back off rather than retry at the base interval.

Append to `packages/webrtc-core/test/transport.test.ts`:

```typescript
  it('backs off polling interval when fetch rejects', async () => {
    // R30: src/transport.ts:170-174 catches a thrown fetch and backs off.
    // Without it a Worker that is down turns into a hot retry loop.
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(139); // 249ms — not yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 250ms — backed off to 150ms
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    transport.close();
  });
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm --filter @remote/webrtc-core test transport`
Expected: 11 tests PASS.

- [ ] **Step 5: Write the failing test for the candidate-buffer bound (R32a)**

`packages/webrtc-core/src/connection.ts:22` declares `pendingCandidates` as a plain array with no cap. A peer that trickles candidates while the answerer's remote description never arrives grows the buffer without limit; Week 4 confirmed by mutation that removing the buffer entirely still leaves the suite green, and no test bounds it.

Append to `packages/webrtc-core/test/p2p.test.ts` (inside `describe('Real P2P Handshake (werift)')`, before the closing `});`):

```typescript
  it('bounds the pending ICE candidate buffer before remote description (R32)', async () => {
    // R32: src/connection.ts:22 is unbounded. This drives the answerer with a
    // hand-rolled transport that never delivers an offer, so nothing ever sets
    // the remote description and every candidate is buffered.
    const bus = new InProcessBus();
    const tB = bus.createTransport('B', 'A');

    const adapterB = new WeriftAdapter({ iceServers: [] });
    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    for (let i = 0; i < MAX_PENDING_CANDIDATES + 20; i += 1) {
      bus.deliverTo('B', {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: `candidate:${i} 1 UDP 2130706431 192.168.1.1 ${50000 + i} typ host`,
          sdpMid: null,
          sdpMLineIndex: null,
        },
      });
      // handleSignal is dispatched through a void'd promise chain; yield so the
      // buffer actually receives each candidate before the next one is sent.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(answererPC.pendingCandidateCount).toBeLessThanOrEqual(
      MAX_PENDING_CANDIDATES,
    );
  }, 20000);
```

This test needs two things the current code does not have: a `deliverTo` method on `InProcessBus` (today it only creates transports that *send to* a target, and `deliver` lives on `MemorySignalBus` in `test/helpers.ts`), and a `pendingCandidateCount` accessor on `PeerConnection`. Add both in the next two steps.

- [ ] **Step 6: Add `deliverTo` to `InProcessBus` and the import for `MAX_PENDING_CANDIDATES`**

In `packages/webrtc-core/test/p2p.test.ts`, extend the `InProcessBus` class (currently `:12-41`) with a direct-delivery method, and extend the import from `../src/connection`:

```typescript
// Replace:  import { PeerConnection } from '../src/connection';
import { PeerConnection, MAX_PENDING_CANDIDATES } from '../src/connection';
```

```typescript
  // Add inside class InProcessBus, after createTransport():
  /**
   * Deliver a signal to a named transport without going through a sender.
   * Used to drive the answerer with candidates whose offer never arrives.
   */
  deliverTo(id: string, msg: SignalMessage): void {
    for (const handler of [...(this.handlers.get(id) ?? [])]) {
      handler(msg);
    }
  }
```

- [ ] **Step 7: Run the R32a test and confirm it fails**

Run: `pnpm --filter @remote/webrtc-core test p2p`
Expected: FAIL — `MAX_PENDING_CANDIDATES` is not exported from `../src/connection` (and `pendingCandidateCount` does not exist).

- [ ] **Step 8: Implement the bound in `packages/webrtc-core/src/connection.ts`**

Replace line `:22`:

```typescript
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
```

with:

```typescript
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];

  /**
   * Read-only view of the pre-remote-description candidate buffer, for tests
   * and diagnostics. The buffer is a private detail; its *size* is not.
   */
  get pendingCandidateCount(): number {
    return this.pendingCandidates.length;
  }
```

and add, above `export class PeerConnection {`:

```typescript
/**
 * Hard cap on ICE candidates buffered before the remote description is set.
 *
 * The buffer exists because `addIceCandidate` before `setRemoteDescription`
 * is a protocol error (Week 4 F1). A peer that trickles candidates while never
 * sending an offer would otherwise grow it without limit — the candidate count
 * is attacker-influenced, and each entry is a small object retained for the
 * life of the connection.
 *
 * 64 is chosen against the real shape of a loopback/single-STUN exchange: a
 * browser emits a handful of host candidates plus one per STUN server, so 64 is
 * far above any honest handshake and far below a useful memory-exhaustion
 * vector. When the cap is reached the oldest entry is dropped rather than the
 * newest: an ICE agent retries connectivity checks against its full candidate
 * set, so a stale candidate is the cheaper one to lose.
 */
export const MAX_PENDING_CANDIDATES = 64;
```

Then replace the ICE-candidate arm of `handleSignal` (currently `:129-138`):

```typescript
      case 'ice-candidate': {
        const candInit = toIceCandidateInit(msg.data);
        if (this.remoteDescriptionSet) {
          await this.peer.addIceCandidate(candInit);
        } else {
          // F1 ICE candidate buffering
          this.pendingCandidates.push(candInit);
        }
        break;
      }
```

with:

```typescript
      case 'ice-candidate': {
        const candInit = toIceCandidateInit(msg.data);
        if (this.remoteDescriptionSet) {
          await this.peer.addIceCandidate(candInit);
        } else {
          // F1 ICE candidate buffering, bounded (R32).
          if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
            this.pendingCandidates.shift();
          }
          this.pendingCandidates.push(candInit);
        }
        break;
      }
```

- [ ] **Step 9: Run the R32a test and confirm it passes**

Run: `pnpm --filter @remote/webrtc-core test p2p`
Expected: PASS.

- [ ] **Step 10: Write the failing test for a rejecting candidate dropping the tail (R32b)**

`packages/webrtc-core/src/connection.ts:169-174` does `const queued = this.pendingCandidates.splice(0);` and then `await`s each `addIceCandidate` in a loop. Because the buffer is emptied *before* the first `await`, a rejection on candidate *k* leaves candidates *k+1…n* gone: they are neither added nor still buffered. Week 4 confirmed this by mutation.

Append to `packages/webrtc-core/test/p2p.test.ts`:

```typescript
  it('flushes the remaining candidates when one is rejected (R32)', async () => {
    // R32: src/connection.ts:170 splices the whole buffer out before the first
    // await, so a rejection on candidate 2 of 3 discards candidate 3 — it is
    // neither added nor still queued.
    const bus = new InProcessBus();
    const tB = bus.createTransport('B', 'A');

    const added: string[] = [];
    let remoteSet = false;

    const inner = new WeriftAdapter({ iceServers: [] });
    const recorder: RTCPeerConnectionLike = {
      createOffer: () => inner.createOffer(),
      createAnswer: () => inner.createAnswer(),
      setLocalDescription: (d) => inner.setLocalDescription(d),
      setRemoteDescription: async (d) => {
        await inner.setRemoteDescription(d);
        remoteSet = true;
      },
      addIceCandidate: async (c) => {
        added.push(c.candidate ?? '');
        if (c.candidate?.includes('cand_2')) {
          throw new Error('bad candidate');
        }
        await inner.addIceCandidate(c);
      },
      createDataChannel: (label, options) =>
        inner.createDataChannel(label, options),
      onIceCandidate: (handler) => inner.onIceCandidate(handler),
      onDataChannel: (handler) => inner.onDataChannel(handler),
      onConnectionStateChange: (handler) =>
        inner.onConnectionStateChange(handler),
      getStats: () => inner.getStats(),
      close: () => inner.close(),
    };

    answererPC = new PeerConnection(recorder, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    for (const name of ['cand_1', 'cand_2', 'cand_3']) {
      bus.deliverTo('B', {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: name,
          sdpMid: null,
          sdpMLineIndex: null,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Deliver an offer so the answerer sets its remote description and flushes.
    // The offer is real enough to parse; werift's setRemoteDescription is the
    // only part that has to succeed, and the answer it produces is discarded.
    const offererAdapter = new WeriftAdapter({ iceServers: [] });
    const tA = bus.createTransport('A', 'B');
    offererPC = new PeerConnection(offererAdapter, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });
    const offer = await offererAdapter.createOffer();
    bus.deliverTo('B', {
      type: 'offer',
      data: { sessionId: 'sess_1', sdp: offer.sdp ?? '', capabilities: ['terminal'] },
    });

    await vi.waitFor(() => expect(remoteSet).toBe(true));
    await vi.waitFor(() => expect(added).toHaveLength(3));

    // cand_2 threw, and cand_3 was still attempted: the tail was not dropped.
    expect(added).toEqual(['cand_1', 'cand_2', 'cand_3']);
  }, 20000);
```

Add `vi` to the existing vitest import at `packages/webrtc-core/test/p2p.test.ts:1`:

```typescript
// Replace:  import { describe, it, expect, afterEach } from 'vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
```

- [ ] **Step 11: Run it and confirm it fails**

Run: `pnpm --filter @remote/webrtc-core test p2p`
Expected: FAIL — the run times out at `await vi.waitFor(() => expect(added).toHaveLength(3))`, with `added` stuck at `['cand_1']`.

Why it stops at one rather than two: **werift rejects all three candidates, not just the mock's `cand_2`.** All three carry `sdpMid: null` / `sdpMLineIndex: null`, and `secureTransportManager.js`'s `resolveCandidateMediaIndices` falls to its `else` branch — `typeof null` is `'object'`, so neither the `string` nor the `number` branch matches and `isEndOfCandidates` is false — and throws `TypeError('sdpMid or sdpMLineIndex must be provided with a candidate')`. The recorder pushes `cand_1` onto `added` *before* delegating to `inner.addIceCandidate`, so the first candidate is recorded and then throws; the throw propagates out of `flushPendingCandidates`' bare `await` and exits the loop. `cand_2` and `cand_3` are never reached. After Step 12's `try`/`catch` the loop survives all three throws and `added` becomes `['cand_1', 'cand_2', 'cand_3']` — which is what Step 13 asserts. If you see `added` at length 3 before Step 12, the test is not exercising the bug and must not be treated as passing.

- [ ] **Step 12: Make `flushPendingCandidates` survive a rejection**

Replace `packages/webrtc-core/src/connection.ts:169-174`:

```typescript
  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const cand of queued) {
      await this.peer.addIceCandidate(cand);
    }
  }
```

with:

```typescript
  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const cand of queued) {
      try {
        await this.peer.addIceCandidate(cand);
      } catch (error: unknown) {
        // R32: one bad candidate must not discard the rest. The buffer was
        // already emptied by splice(), so a bare `await` in the loop would
        // leave every later candidate neither added nor queued. ICE recovers
        // from a missing candidate as long as one pair succeeds, so dropping
        // one and keeping the others is strictly better than dropping the tail.
        console.error('[PeerConnection] failed to add ICE candidate', error);
      }
    }
  }
```

- [ ] **Step 13: Run it and confirm it passes**

Run: `pnpm --filter @remote/webrtc-core test p2p`
Expected: 7 tests PASS (5 existing + R32a + R32b).

- [ ] **Step 14: Write the failing test that pins the malformed-JSON contract (R31)**

Append to `workers/signaling/test/signal.test.ts`:

```typescript
  it('rejects a non-JSON body with 400 VALIDATION_ERROR, not MALFORMED_JSON', async () => {
    // R31: the routes do `await c.req.json().catch(() => null)` before
    // validating, so a SyntaxError never reaches the MALFORMED_JSON branch in
    // middleware/error.ts:28-40. This test pins the observable so a future edit
    // that lets the SyntaxError through is a deliberate, visible change.
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: 'this is not json',
      },
      env,
    );

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });
```

- [ ] **Step 15: Run it and confirm it passes against the current routes**

Run: `pnpm --filter @remote/signaling test signal`
Expected: 17 tests PASS (16 + 1).

- [ ] **Step 16: Correct the Week 4 spec's malformed-JSON contract row**

In `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md`, the table row at **line 435** currently reads:

```
| Malformed JSON | 400 | MALFORMED_JSON (existing handler) |
```

Change it to:

```
| Malformed JSON | 400 | `VALIDATION_ERROR` (see the note below) |
```

and insert immediately after the table it belongs to:

```markdown
> **Errata (2026-09-26, Week 5 plan Task 2).** This row originally promised
> `MALFORMED_JSON`. It is not reachable on these routes: each POST does
> `await c.req.json().catch(() => null)` and then validates, so a `SyntaxError`
> becomes `null` and then `VALIDATION_ERROR`. The `SyntaxError` branch in
> `src/middleware/error.ts` remains in place for any route that does not
> pre-catch. The observable contract is pinned by
> `test/signal.test.ts` → *"rejects a non-JSON body with 400 VALIDATION_ERROR,
> not MALFORMED_JSON"*. Changing the routes to surface `MALFORMED_JSON` would
> contradict `routes/sessions.ts`, which chooses `VALIDATION_ERROR`
> deliberately and has its own test.
```

- [ ] **Step 17: Run the whole gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **146 passing JS tests** (signaling 63, `webrtc-core` 32, `apps/web` 30, `api-client` 11, `crypto` 10).

- [ ] **Step 18: Commit**

```bash
git add packages/webrtc-core/test/transport.test.ts packages/webrtc-core/test/p2p.test.ts packages/webrtc-core/src/connection.ts workers/signaling/test/signal.test.ts docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md
git commit -m "test(webrtc-core): close R30/R32 gaps; bound ICE buffer and keep flush tail"
git commit --allow-empty -m "docs(spec): correct Week 4 malformed-JSON contract to VALIDATION_ERROR (R31)"
```

(If the two commits are easier as one, use a single message: `test: close Week 4 R30/R32 gaps and pin the R31 malformed-JSON contract`.)

---

### Task 3: Migration `0002_agent_credentials.sql`, Shared Helpers, and Credential Issuance

Three spec sub-tasks land together because they have one deliverable: an agent that can be registered with a credential and projected safely. §4.12 tasks 1–3 are merged here — the migration has no test of its own until the credential write exists, and the credential write cannot be tested without the column.

**Files:**
- Modify: `workers/signaling/src/db/schema.ts:42-77`
- Create (generated): `workers/signaling/db/migrations/0002_agent_credentials.sql`
- Create (generated): `workers/signaling/db/migrations/meta/0002_snapshot.json`
- Modify (generated): `workers/signaling/db/migrations/meta/_journal.json`
- Modify: `workers/signaling/test/helpers.ts:41-63`
- Modify: `workers/signaling/src/utils/crypto.ts:4-8`
- Create: `workers/signaling/src/utils/agent.ts`
- Create: `workers/signaling/src/utils/signals.ts`
- Modify: `workers/signaling/src/routes/agents.ts` (all three handlers)
- Test: `workers/signaling/test/resources.test.ts` (append two tests; file is 500 lines, 14 tests today)
- Test: `workers/signaling/test/db.test.ts` (append one test; file is 72 lines, 2 tests today)

**Interfaces:**
- Consumes: `crypto.getRandomValues`, `crypto.subtle.digest`; `AgentSelect` (`src/db/schema.ts`); `Agent` from `@remote/shared` (`packages/shared/src/types/user.ts:30-42`).
- Produces:
  ```typescript
  // workers/signaling/src/utils/crypto.ts
  export function buf2hex(buffer: ArrayBuffer): string;
  export function sha256Hex(input: string): Promise<string>;

  // workers/signaling/src/utils/agent.ts
  export type PublicAgent = SharedAgent;
  export function generateAgentCredential(): string; // `ag_` + 32 lowercase hex
  export function parseCapabilities(raw: string | null): string[];
  export function toPublicAgent(agent: AgentSelect): PublicAgent;
  // NOTE: toPublicAgent gains a second parameter in Task 5. Task 3 ships the
  // one-argument form; no Task 3 test asserts `isOnline`, so the signature
  // change in Task 5 does not touch this task's tests.

  // workers/signaling/src/utils/signals.ts
  export const SIGNAL_TTL_SQL: SQL;
  export const NOW_SQL: SQL;
  export function parseSignalMessage(frame: unknown): SignalMessage | null;
  export function recordSignal(
    db: Database,
    message: SignalMessage,
  ): Promise<SignalSelect | null>;

  // workers/signaling/db/migrations/0002_agent_credentials.sql
  //   agents.credential_hash TEXT (nullable) + UNIQUE index
  //   agents.capabilities TEXT
  //   sessions.started_at TEXT
  ```

- **`parseSignalMessage` validation rules (spec D-1 — the spec names this function but never gives its body).** It takes the **inner** `data` member of a `{type:'signal', data}` envelope and returns a `SignalMessage` or `null`. Rules, in order:
  1. `frame` must be a non-null, non-array object, else `null`.
  2. `frame.type` must be exactly `'offer'`, `'answer'`, or `'ice-candidate'`, else `null`.
  3. `frame.data` must be a non-null, non-array object, else `null`.
  4. `data.sessionId` must be a non-empty string, else `null`.
  5. `offer`/`answer`: `data.sdp` must be a non-empty string, else `null`.
  6. `ice-candidate`: `data.candidate` must be a non-empty string, else `null`.
  7. Normalisations (never rejections): `capabilities` → `string[]` with non-string members filtered out and a missing/non-array value becoming `[]`; `approved` → `data.approved !== false`; `sdpMid` → a non-empty string or `null`; `sdpMLineIndex` → an integer in `[0, 65535]` or `null` (R7: `webrtc`'s `RTCIceCandidateInit.sdp_mline_index` is `u16`, so a negative or >65535 index must be rejected rather than truncated — out-of-range becomes `null`, and a candidate with no index is still valid).

- [ ] **Step 1: Declare the three columns in the Drizzle schema**

In `workers/signaling/src/db/schema.ts`, add two fields to the `agents` table (`:42-57`) — `credentialHash` immediately after `lastPingAt` (`:53`) and `capabilities` after it — so the generated column order matches the spec's migration SQL:

```typescript
  lastPingAt: text('last_ping_at'),
  credentialHash: text('credential_hash').unique(),
  capabilities: text('capabilities'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
```

and one field to `sessions` (`:59-77`), immediately after `status` (`:68`):

```typescript
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at'),
  createdAt: text('created_at')
```

`credentialHash` is nullable on purpose: rows that predate the migration have no credential and cannot authenticate, which is correct — an agent must be re-registered to obtain one. A `UNIQUE` index permits any number of `NULL`s (Week 5 W2), so the migration is safe on a populated table.

- [ ] **Step 2: Generate the migration**

Run:
```bash
pnpm --filter @remote/signaling db:generate
```
Expected: drizzle-kit writes `db/migrations/0002_<random-name>.sql` plus `db/migrations/meta/0002_snapshot.json`, and appends an entry to `db/migrations/meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL is exactly the four expected statements**

Read `db/migrations/0002_<random-name>.sql`. It must contain exactly:

```sql
ALTER TABLE `agents` ADD `credential_hash` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `capabilities` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_credential_hash_unique` ON `agents` (`credential_hash`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `started_at` text;
```

If drizzle emitted an inline `UNIQUE` on the `ADD COLUMN` instead, the schema field's `.unique()` is being rendered as a column constraint — replace `.unique()` with a table-level `uniqueIndex('agents_credential_hash_unique').on(table.credentialHash)` in the `agents` table's third callback argument, delete the generated `0002_*` files, and repeat from Step 2. (`ALTER TABLE ... ADD COLUMN ... TEXT UNIQUE` is rejected by both SQLite 3.53.4 and D1 with `Cannot add a UNIQUE column` — Week 5 W1.)

- [ ] **Step 4: Rename the generated migration to `0002_agent_credentials`**

Rename `db/migrations/0002_<random-name>.sql` to `db/migrations/0002_agent_credentials.sql`, and in `db/migrations/meta/_journal.json` change that entry's `tag` from `0002_<random-name>` to `0002_agent_credentials`. Leave its generated `when` and `version` values exactly as drizzle wrote them — do not invent a timestamp. Do **not** rename `meta/0002_snapshot.json`; drizzle resolves snapshots by index, not by tag.

- [ ] **Step 5: Verify the rename left no drift**

Run:
```bash
pnpm --filter @remote/signaling db:generate
```
Expected: "No schema changes, nothing to migrate" and **no** new `0003_*` file. If one appeared, the snapshot is out of sync: delete the stray file and repeat from Step 2.

- [ ] **Step 6: Format the generated JSON artifacts**

Run:
```bash
npx prettier --write workers/signaling/db/migrations/meta/0002_snapshot.json workers/signaling/db/migrations/meta/_journal.json
pnpm format:check
```
Expected: exit 0. Without this, `format:check` exits 1 on the drizzle-generated JSON (Week 4 R17). `.sql` files are silently skipped by Prettier and need no formatting.

- [ ] **Step 7: Apply the migration to the local D1**

Run:
```bash
pnpm --filter @remote/signaling db:migrate:local
```
Expected: `0002_agent_credentials` applied successfully.

- [ ] **Step 8: Extend the test fixture with the three columns**

In `workers/signaling/test/helpers.ts`, the `agents` `CREATE TABLE` (`:41-52`) gains two columns after `last_ping_at`:

```sql
  credential_hash TEXT UNIQUE,
  capabilities TEXT,
```

and the `sessions` `CREATE TABLE` (`:53-63`) gains one after `status`:

```sql
  started_at TEXT,
```

The fixture keeps the **inline** `UNIQUE` while the migration uses a separate index. That asymmetry is real and required (W1: a `CREATE TABLE` accepts inline `UNIQUE`; an `ALTER TABLE ADD COLUMN` does not), and it is the single most likely thing for a later reader to "fix" into breakage. Inline `UNIQUE` creates an equivalent auto-index, so behaviour is identical. Leave a comment saying so directly above the `agents` table in the fixture:

```sql
-- NOTE: inline UNIQUE is deliberate. The 0002 migration cannot use this form
-- (ALTER TABLE ADD COLUMN rejects it); it creates agents_credential_hash_unique
-- as a separate index instead. Both admit many NULLs. Do not "converge" them.
```

- [ ] **Step 9: Write the failing migration test**

Append to `workers/signaling/test/db.test.ts` (inside the existing top-level `describe`, before the closing `});`):

```typescript
  it('applies migration 0002 on a populated agents table', async () => {
    // Week 5 W3/W2: the three statements must be safe on real data, and the
    // unique index must reject a duplicate hash while allowing many NULLs.
    // A test against an empty table would pass for a migration that fails on
    // production rows.
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));

    await env.DB.prepare(
      `INSERT INTO users (id, username, public_key) VALUES ('u1', 'user_a', 'pk_a')`,
    ).run();

    // A row shaped like one that predates the migration: no credential, no
    // capabilities. It must survive and stay readable.
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key) VALUES ('legacy', 'u1', 'pk_legacy')`,
    ).run();

    const legacy = await env.DB.prepare(
      `SELECT credential_hash, capabilities FROM agents WHERE id = 'legacy'`,
    ).first<{ credential_hash: string | null; capabilities: string | null }>();
    expect(legacy).toEqual({ credential_hash: null, capabilities: null });

    // sessions.started_at exists and defaults to NULL.
    const sessionCols = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('sessions') WHERE name = 'started_at'`,
    ).first<{ name: string }>();
    expect(sessionCols?.name).toBe('started_at');

    // NULL repeats under the unique index; a duplicate non-NULL hash does not.
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a2', 'u1', 'pk2', NULL)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a3', 'u1', 'pk3', 'hash_abc')`,
    ).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a4', 'u1', 'pk4', 'hash_abc')`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
```

- [ ] **Step 10: Run it and confirm it passes**

Run: `pnpm --filter @remote/signaling test db`
Expected: 3 tests PASS. (The fixture is extended in Step 8; if you skipped that, this fails with `no such column: credential_hash`.)

- [ ] **Step 11: Export `buf2hex` and add `sha256Hex`**

In `workers/signaling/src/utils/crypto.ts`, change the private helper at `:4-8` to an export:

```typescript
// Replace:  function buf2hex(buffer: ArrayBuffer): string {
export function buf2hex(buffer: ArrayBuffer): string {
```

and append at the end of the file:

```typescript
/**
 * SHA-256 of a UTF-8 string, lowercase hex.
 *
 * Used for the agent credential, and deliberately not for passwords. The
 * credential is 128 bits of CSPRNG output, so there is no dictionary for a
 * slow KDF to defend against and a per-connect PBKDF2 at 100k iterations would
 * be a self-inflicted cost on every agent reconnect. Passwords keep
 * `hashPassword`.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return buf2hex(digest);
}
```

- [ ] **Step 12: Create `workers/signaling/src/utils/signals.ts`**

```typescript
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { signals } from '../db/schema';
import type { SignalSelect } from '../db/schema';
import type { Database } from '../db/client';
import type { SignalMessage } from '@remote/shared';

/** Matches the TTL the three REST routes wrote before this helper existed. */
export const SIGNAL_TTL_SQL = sql`datetime('now', '+5 minutes')`;

/**
 * Space-separated UTC, matching every other timestamp column in the schema.
 *
 * `datetime('now')` returns `YYYY-MM-DD HH:MM:SS`; `new Date().toISOString()`
 * returns `YYYY-MM-DDTHH:MM:SS.sssZ`. The `'T'` sorts after the `' '`, so a
 * single ISO value in one of these columns compares lexicographically greater
 * than every SQLite timestamp and makes any `> datetime('now', '-90 seconds')`
 * window silently true for it (W10).
 */
export const NOW_SQL = sql`(datetime('now'))`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Narrow an untrusted frame body to a `SignalMessage`.
 *
 * This is the only validator on the agent-socket path and it is deliberately
 * stricter than the REST routes' inline coercion (Week 5 D17): it filters
 * `capabilities` to strings and rejects an out-of-range `sdpMLineIndex`
 * instead of truncating it. `sdpMLineIndex` is `u16` on the Rust side
 * (Week 5 R7), so a negative or >65535 value would otherwise be silently
 * mangled by the peer.
 *
 * Returns `null` rather than throwing: the caller turns a `null` into a
 * `VALIDATION_ERROR` frame, and an inbound frame is attacker-influenced.
 */
export function parseSignalMessage(frame: unknown): SignalMessage | null {
  if (!isPlainObject(frame)) return null;
  if (!isPlainObject(frame.data)) return null;

  const sessionId = nonEmptyString(frame.data.sessionId);
  if (!sessionId) return null;

  if (frame.type === 'offer') {
    const sdp = nonEmptyString(frame.data.sdp);
    if (!sdp) return null;
    const raw = frame.data.capabilities;
    const capabilities = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : [];
    return { type: 'offer', data: { sessionId, sdp, capabilities } };
  }

  if (frame.type === 'answer') {
    const sdp = nonEmptyString(frame.data.sdp);
    if (!sdp) return null;
    return {
      type: 'answer',
      data: { sessionId, sdp, approved: frame.data.approved !== false },
    };
  }

  if (frame.type === 'ice-candidate') {
    const candidate = nonEmptyString(frame.data.candidate);
    if (!candidate) return null;
    const sdpMid = nonEmptyString(frame.data.sdpMid);
    const rawIndex = frame.data.sdpMLineIndex;
    const sdpMLineIndex =
      typeof rawIndex === 'number' &&
      Number.isInteger(rawIndex) &&
      rawIndex >= 0 &&
      rawIndex <= 65535
        ? rawIndex
        : null;
    return {
      type: 'ice-candidate',
      data: { sessionId, candidate, sdpMid, sdpMLineIndex },
    };
  }

  return null;
}

/**
 * The single write path for `signals`, shared by the REST routes and the agent
 * socket.
 *
 * `type` and `payload` are derived from the `SignalMessage`, so the two callers
 * cannot disagree about a row's shape. The `answer → active` session
 * transition lives here too (added in Task 5) for the same reason: two copies
 * of "insert the signal, then maybe transition the session" would drift.
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

`SQL` is exported as a type from `drizzle-orm`; if the type-only import is flagged by `consistent-type-imports`, keep it as written (it already uses `import type`).

- [ ] **Step 13: Create `workers/signaling/src/utils/agent.ts`**

```typescript
import type { Agent as SharedAgent } from '@remote/shared';
import type { AgentSelect } from '../db/schema';
import { buf2hex } from './crypto';

/** The shared contract, not a hand-copied shape (Week 5 D32). */
export type PublicAgent = SharedAgent;

/**
 * `ag_` + 32 lowercase hex characters: 16 bytes of CSPRNG output, 128 bits.
 *
 * The prefix makes the credential greppable in logs and instantly
 * distinguishable from a JWT, which matters because it is the one secret that
 * must never appear in one.
 */
export function generateAgentCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ag_${buf2hex(bytes.buffer)}`;
}

/**
 * `capabilities` is stored as a JSON string. A malformed value, a non-array, or
 * non-string members all collapse to `[]` rather than throwing: this runs on
 * the response path of every agent route, and a bad column value must not turn
 * a list request into a 500.
 */
export function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * Project an `agents` row onto the wire contract.
 *
 * This is a security boundary, not a convenience: after migration 0002 the row
 * carries `credential_hash`, so returning a row wholesale would hand every
 * caller the hash of every agent the user owns. `credentialHash` is absent from
 * the literal below by construction, so it cannot be spread in later.
 *
 * `last_ping_at` is exposed as `lastHeartbeat` because the shared `Agent`
 * contract names it that (`packages/shared/src/types/user.ts:39`); the rename
 * happens here and nowhere else.
 */
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

- [ ] **Step 14: Route all three agent handlers through the credential and the projection**

In `workers/signaling/src/routes/agents.ts`, add the imports:

```typescript
import { generateAgentCredential, toPublicAgent } from '../utils/agent';
import { sha256Hex } from '../utils/crypto';
```

Replace the `POST /` insert-and-return block (currently `:44-68`, from the `existing` pre-check through the final `return c.json(created, 201)`) with:

```typescript
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, body.id))
    .get();

  if (existing) {
    throw new AppError('Agent already exists', 409, 'AGENT_EXISTS');
  }

  // Minted only after the 409 pre-check: issuing a credential for an agent that
  // is never created would leave a live secret with no owner (Week 5 D18).
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

  // The credential is present exactly once, on this response. It is never
  // recoverable: only its hash is stored and there is no rotation endpoint.
  return c.json({ agent: toPublicAgent(created), credential }, 201);
```

Keep the existing `body.capabilities` type widening consistent with the route's body type — if the handler destructures a local `body` type that lacks `capabilities`, add `capabilities?: string[] | null` to it.

Replace the `GET /` return (`:16`):

```typescript
  return c.json(list.map(toPublicAgent));
```

Replace the `GET /:id` return (`:86`):

```typescript
  return c.json(toPublicAgent(agent));
```

- [ ] **Step 15: Update the test file's `AgentResponse` type**

In `workers/signaling/test/resources.test.ts`, the local `AgentResponse` type at `:40-51` currently ends `lastPingAt: string | null; createdAt: string;` and has no `capabilities`. Replace it with:

```typescript
type AgentResponse = {
  id: string;
  userId: string;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  publicKey: string;
  isOnline: boolean;
  lastHeartbeat: string | null;
  capabilities: string[];
  createdAt: string;
};
```

This is a type-only change: the two existing agent tests (`:267` registers/lists/fetches, `:312` duplicate → `409`) read only statuses and re-read via list/get, so their assertions are unaffected. The type must change anyway or the file stops describing reality (Week 5 W17).

- [ ] **Step 16: Write the failing credential-issuance test**

Append to `workers/signaling/test/resources.test.ts` (inside `describe('Agents API (/api/agents)')`, before its closing `});`):

```typescript
  it('issues a credential once and stores only its SHA-256 hash', async () => {
    // Week 5 W12/D19: the plaintext is returned exactly once and never stored.
    const createRes = await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_cred',
          publicKey: 'pk_cred',
          capabilities: ['terminal', 'files'],
        }),
      },
      env,
    );

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      agent: AgentResponse;
      credential: string;
    };

    expect(created.credential).toMatch(/^ag_[0-9a-f]{32}$/);
    expect(created.agent.capabilities).toEqual(['terminal', 'files']);
    expect(created.agent.lastHeartbeat).toBeNull();
    expect(created.agent.isOnline).toBe(false);
    // The projection must not carry the hash.
    expect(Object.keys(created.agent)).not.toContain('credentialHash');

    // D1 holds the digest, not the secret.
    const stored = await env.DB.prepare(
      `SELECT credential_hash FROM agents WHERE id = 'agent_cred'`,
    ).first<{ credential_hash: string }>();
    expect(stored?.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.credential_hash).not.toBe(created.credential);

    // The digest is of the full token, `ag_` prefix included (D7).
    const expected = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(created.credential),
    );
    const expectedHex = [...new Uint8Array(expected)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(stored?.credential_hash).toBe(expectedHex);

    // A repeat registration is still 409 and mints no second credential.
    const dupRes = await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: 'agent_cred', publicKey: 'pk_cred_2' }),
      },
      env,
    );
    expect(dupRes.status).toBe(409);
    const dupBody = (await dupRes.json()) as ErrorResponse;
    expect(dupBody.code).toBe('AGENT_EXISTS');
    const afterDup = (await dupRes.json().catch(() => null)) as unknown;
    expect(afterDup).toBeNull();
  });
```

- [ ] **Step 17: Run it and confirm it passes**

Run: `pnpm --filter @remote/signaling test resources`
Expected: 15 tests PASS (14 + 1).

- [ ] **Step 18: Write the failing projection test**

Append to `workers/signaling/test/resources.test.ts`:

```typescript
  it('projects agents without leaking the credential hash (list and get)', async () => {
    // Week 5 W12/D34: `credentialHash` must not reach any response body. A
    // single un-projected route leaks the hash of every agent the user owns.
    await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_proj',
          publicKey: 'pk_proj',
          capabilities: ['terminal'],
        }),
      },
      env,
    );

    const listRes = await app.request(
      '/api/agents',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as AgentResponse[];
    const listed = list.find((a) => a.id === 'agent_proj');
    expect(listed).toBeDefined();
    expect(listed?.capabilities).toEqual(['terminal']);
    expect(listed?.lastHeartbeat).toBeNull();
    expect(Object.keys(listed ?? {})).not.toContain('credentialHash');

    const getRes = await app.request(
      '/api/agents/agent_proj',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as AgentResponse;
    expect(fetched.capabilities).toEqual(['terminal']);
    expect(Object.keys(fetched)).not.toContain('credentialHash');
  });
```

- [ ] **Step 19: Run it and confirm it passes**

Run: `pnpm --filter @remote/signaling test resources`
Expected: 16 tests PASS.

- [ ] **Step 20: Run the whole gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **149 passing JS tests** (signaling 66, `webrtc-core` 32, `apps/web` 30, `api-client` 11, `crypto` 10).

- [ ] **Step 21: Commit**

```bash
git add workers/signaling/src/db/schema.ts \
        workers/signaling/db/migrations/0002_agent_credentials.sql \
        workers/signaling/db/migrations/meta/0002_snapshot.json \
        workers/signaling/db/migrations/meta/_journal.json \
        workers/signaling/test/helpers.ts \
        workers/signaling/src/utils/crypto.ts \
        workers/signaling/src/utils/agent.ts \
        workers/signaling/src/utils/signals.ts \
        workers/signaling/src/routes/agents.ts \
        workers/signaling/test/resources.test.ts \
        workers/signaling/test/db.test.ts
git commit -m "feat(signaling): add migration 0002 and agent-scoped credential issuance"
```

---

### Task 4: The Agent Socket — `src/routes/ws.ts`, Push, and Heartbeat

The worker half of the wire contract. One route (`GET /api/ws/agent`), one module-scope map, one inbound handler, one best-effort push, and the `AgentSocketMessage` envelope in `packages/shared`.

**Files:**
- Create: `workers/signaling/src/routes/ws.ts`
- Modify: `workers/signaling/src/index.ts:20-25` (add the mount)
- Modify: `packages/shared/src/types/signaling.ts` (append the envelope types)
- Modify: `packages/shared/src/types/index.ts:33-38` (barrel export)
- Modify: `workers/signaling/src/routes/signal.ts` (all three POST routes: `recordSignal` + `pushToAgent`)
- Modify: `workers/signaling/test/helpers.ts:41-52` (nothing — the `credential_hash`/`capabilities` columns landed in Task 3)
- Create: `workers/signaling/test/ws.test.ts`
- Test: `workers/signaling/test/signal.test.ts` (append two push tests)

**Interfaces:**
- Consumes: `sha256Hex` (`src/utils/crypto.ts`), `parseSignalMessage` + `recordSignal` + `SIGNAL_TTL_SQL` (`src/utils/signals.ts`), `getDb` (`src/db/client.ts`), `AppError` (`src/middleware/error.ts`), `agents`/`sessions` (`src/db/schema.ts`).
- Produces:
  ```typescript
  // packages/shared/src/types/signaling.ts  (and re-exported from types/index.ts)
  export type AgentErrorCode =
    | 'MALFORMED_JSON'
    | 'VALIDATION_ERROR'
    | 'NOT_FOUND'
    | 'INTERNAL_SERVER_ERROR'
    | 'SESSION_NOT_ACTIVE';

  export type AgentSocketMessage =
    | { type: 'ping' }
    | { type: 'pong' }
    | { type: 'signal'; data: SignalMessage }
    | { type: 'error'; code: AgentErrorCode };

  // workers/signaling/src/routes/ws.ts
  export type AgentConnection = {
    agentId: string;
    userId: string;
    socket: WebSocket;
  };
  export const agentConnections: Map<string, AgentConnection>;
  export const MAX_INBOUND_FRAME_BYTES: number; // 256 * 1024
  export function pushToAgent(
    agentId: string | null,
    message: SignalMessage,
  ): void;

  // workers/signaling/src/routes/signal.ts (unchanged public shape; now via recordSignal + pushToAgent)
  // POST /api/signal/{offer,answer,ice-candidate} → 201 { id, sessionId, type, createdAt }
  ```

- **Error-code set (spec D-3 — §4.3.3 is authoritative, not §5.9.1).** Inbound failures emit `{ type: 'error', code }` with exactly these four codes: `MALFORMED_JSON` (not JSON, JSON that is not an object, or a frame above `MAX_INBOUND_FRAME_BYTES` — refused before parsing, so no member check is possible), `VALIDATION_ERROR` (parses but is not a recognised member — unknown `type`, missing `sessionId`/`sdp`/`candidate`, `data` absent), `NOT_FOUND` (the session is not this agent's), `INTERNAL_SERVER_ERROR` (the insert returned no row). `SESSION_NOT_ACTIVE` is added in Task 5 for the terminated-session refusal. `UNAUTHORIZED` and `UPGRADE_REQUIRED` are **HTTP** responses, not frames.
- **No `hello` frame (spec D-2).** The spec's §5.9.1 requires a `hello` within 5 s, but §4.5's `handleInbound` has no arm for it, so a `hello` would be answered `VALIDATION_ERROR` — a contract the Rust client cannot satisfy. Identity comes from the credential (ADR-13), which the handshake already proves. The Rust client sends no `hello`; §5.9.1's row is superseded and recorded in Task 9.

- [ ] **Step 1: Add the `AgentSocketMessage` envelope to `packages/shared`**

Append to `packages/shared/src/types/signaling.ts`:

```typescript
/**
 * The WebSocket transport envelope for the agent socket.
 *
 * A signal frame nests `{ type, data }` inside `{ type: 'signal', data }`: the
 * outer `type` is the *transport* discriminator, the inner one is the *signal*
 * discriminator. Flattening them would make a transport frame ambiguous with a
 * bare `SignalMessage`, and would force every consumer to re-derive which union
 * it is holding.
 *
 * `SignalMessage` above is deliberately unchanged: `webrtc-core`'s
 * `SignalTransport` and the REST bodies keep one definition.
 */
export type AgentErrorCode =
  | 'MALFORMED_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR'
  | 'SESSION_NOT_ACTIVE';

export type AgentSocketMessage =
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage }
  | { type: 'error'; code: AgentErrorCode };
```

- [ ] **Step 2: Export them from the barrel**

In `packages/shared/src/types/index.ts`, replace the `./signaling` block (`:33-38`) with:

```typescript
export type {
  SignalOffer,
  SignalAnswer,
  IceCandidateSignal,
  SignalMessage,
  AgentErrorCode,
  AgentSocketMessage,
} from './signaling';
```

**This step is not optional and the spec's §8.1 task 4 does not mention it.** `packages/shared`'s `package.json` resolves `@remote/shared` to `src/index.ts`, which re-exports `./types` — so a type that is not in this barrel is invisible to the Worker even though it is in the file.

- [ ] **Step 3: Verify the shared package still typechecks and its consumers still build**

Run:
```bash
pnpm --filter @remote/shared typecheck && pnpm typecheck
```
Expected: exit 0. `webrtc-core` and `apps/web` consume `SignalMessage` through the barrel; an accidental change to that union would surface here.

- [ ] **Step 4: Write the failing test for the `401` and `426` cases**

Create `workers/signaling/test/ws.test.ts`:

```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { agentConnections, MAX_INBOUND_FRAME_BYTES } from '../src/routes/ws';
import { RESET_STATEMENTS } from './helpers';

type AuthResponse = { token: string; user: { id: string } };

type ErrorResponse = { error: string; code: string };

type AgentCreated = {
  agent: { id: string; userId: string };
  credential: string;
};

const WS_URL = '/api/ws/agent';

/** Register a user, an agent, and a session bound to that agent. */
async function seed(): Promise<{
  token: string;
  userId: string;
  agentId: string;
  credential: string;
  sessionId: string;
}> {
  const res = await app.request(
    '/api/auth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ws_user',
        password: 'Password123!',
        publicKey: 'pk_ws',
      }),
    },
    env,
  );
  const auth = (await res.json()) as AuthResponse;

  const agentRes = await app.request(
    '/api/agents',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        id: 'agent_ws',
        publicKey: 'pk_agent_ws',
        capabilities: ['terminal'],
      }),
    },
    env,
  );
  const created = (await agentRes.json()) as AgentCreated;

  const sessRes = await app.request(
    '/api/sessions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ agentId: created.agent.id }),
    },
    env,
  );
  const session = (await sessRes.json()) as { id: string };

  return {
    token: auth.token,
    userId: auth.user.id,
    agentId: created.agent.id,
    credential: created.credential,
    sessionId: session.id,
  };
}

describe('Agent WebSocket (/api/ws/agent)', () => {
  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));
    agentConnections.clear();
  });

  it('returns an identical 401 for a missing header, a wrong scheme, and an unknown credential', async () => {
    // Review Focus #1: a distinguishing body or status turns this endpoint into
    // a credential oracle. All three must be byte-identical.
    const missing = await app.request(WS_URL, { headers: {} }, env);
    const wrongScheme = await app.request(
      WS_URL,
      { headers: { Authorization: 'Basic ag_whatever' } },
      env,
    );
    const unknown = await app.request(
      WS_URL,
      { headers: { Authorization: 'Bearer ag_00000000000000000000000000000000' } },
      env,
    );

    for (const res of [missing, wrongScheme, unknown]) {
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorResponse;
      expect(body).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    expect(agentConnections.size).toBe(0);
  });

  it('returns 426 UPGRADE_REQUIRED for a valid credential on a non-upgrade GET', async () => {
    // W6: without this guard, real workerd returns a 500. The pool cannot
    // reproduce the 500, but it can pin the guard's observable.
    const { credential } = await seed();

    const res = await app.request(
      WS_URL,
      { headers: { Authorization: `Bearer ${credential}` } },
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe('UPGRADE_REQUIRED');
    expect(agentConnections.size).toBe(0);
  });

  it('authenticates a credential and registers before the 101', async () => {
    // D2/W5: registration happens in the route body, so a POST that lands
    // while the upgrade response is in flight cannot see an unregistered socket.
    const { credential, agentId } = await seed();

    const res = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );

    expect(res.status).toBe(101);
    expect(res.webSocket).toBeDefined();

    // Registered by the time the response is observable (W5).
    expect(agentConnections.has(agentId)).toBe(true);
    expect(agentConnections.get(agentId)?.agentId).toBe(agentId);

    // D11: is_online is set at accept(), not only on the first ping.
    const row = await env.DB.prepare(
      `SELECT is_online, last_ping_at FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number; last_ping_at: string | null }>();
    expect(row?.is_online).toBe(1);
    // W10: space-separated UTC, never ISO-8601.
    expect(row?.last_ping_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    res.webSocket?.accept();
    res.webSocket?.close();
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `pnpm --filter @remote/signaling test ws`
Expected: FAIL — `Cannot find module '../src/routes/ws'`.

- [ ] **Step 6: Write `workers/signaling/src/routes/ws.ts`**

```typescript
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../types';
import type { Database } from '../db/client';
import { getDb } from '../db/client';
import { agents, sessions } from '../db/schema';
import { AppError } from '../middleware/error';
import { sha256Hex } from '../utils/crypto';
import { NOW_SQL, parseSignalMessage, recordSignal } from '../utils/signals';
import type { SignalMessage } from '@remote/shared';

/**
 * Live agent sockets, keyed by `agents.id`.
 *
 * Module scope, and therefore **per isolate**: Cloudflare may run several
 * isolates, the socket lives in the isolate that accepted it, and a request
 * served elsewhere sees an empty map. Nothing may depend on a hit here — D1
 * plus the browser's poll is the delivery guarantee, and this map is a latency
 * optimisation (W15).
 */
export type AgentConnection = {
  agentId: string;
  userId: string;
  socket: WebSocket;
};

export const agentConnections = new Map<string, AgentConnection>();

/**
 * Refuse an inbound text frame larger than this before `JSON.parse` sees it.
 *
 * §7.4 edge 4: "the peer is authenticated but not trusted". A 64 KiB SDP is
 * already implausible and a megabyte frame is certainly hostile, so this bounds
 * the allocation a single frame can force. `parseSignalMessage` cannot help
 * here — by the time it runs, `JSON.parse` has already built the object graph.
 */
export const MAX_INBOUND_FRAME_BYTES = 256 * 1024;

/**
 * Best-effort delivery of a freshly persisted signal to the owning agent.
 *
 * Never throws. A miss (no socket in this isolate) and a dead socket are both
 * ordinary outcomes, not request failures: the row is already in D1, so the
 * agent can still recover the signal through the same poll the browser uses.
 * Returning `void` rather than a `Promise` makes that structural — there is
 * nothing for a future edit to `await` (D9).
 */
export function pushToAgent(
  agentId: string | null,
  message: SignalMessage,
): void {
  if (!agentId) return;

  const connection = agentConnections.get(agentId);
  if (!connection) return;

  try {
    connection.socket.send(JSON.stringify({ type: 'signal', data: message }));
  } catch {
    // W7: a server-side socket throws on send() once it has closed. Drop it so
    // the next push skips it. `close` also fires for this socket and is
    // identity-guarded, so removing the entry here cannot evict a newer one.
    if (agentConnections.get(agentId)?.socket === connection.socket) {
      agentConnections.delete(agentId);
    }
  }
}

// `NOW_SQL` is deliberately NOT defined here: Task 3 defines it once in
// `utils/signals.ts` and this file imports it. A second local copy is exactly
// how two files drift into `(datetime('now'))` vs `datetime('now')`.

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

/**
 * Handle one inbound frame from an agent socket.
 *
 * Every failure is an error *frame*, never a throw: this runs inside a
 * `message` event listener, and an exception escaping it can tear down the
 * socket and, in the worst case, the isolate (Review Focus #4).
 */
async function handleInbound(
  raw: unknown,
  socket: { send: (data: string) => void },
  ctx: { db: Database; agentId: string; userId: string },
): Promise<void> {
  // Binary frames carry no defined meaning on this socket.
  if (typeof raw !== 'string') return;

  // Size is checked before parsing (D18). A frame at or over the cap is refused
  // without ever reaching `JSON.parse`, so a hostile peer cannot make the
  // isolate allocate an object graph proportional to the frame.
  if (raw.length > MAX_INBOUND_FRAME_BYTES) {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  const envelope = frame as { type?: unknown; data?: unknown };

  if (envelope.type === 'ping') {
    await ctx.db
      .update(agents)
      .set({ isOnline: true, lastPingAt: NOW_SQL })
      .where(eq(agents.id, ctx.agentId))
      .run();
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (envelope.type !== 'signal') {
    socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
    return;
  }

  const message = parseSignalMessage(envelope.data);
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

  // Tenancy is BOTH halves. `session.agentId` is nullable, so the `!==`
  // comparison against a non-null id rejects an agentless session too — an
  // `if (session.agentId && …)` guard would let it through. Every rejection
  // returns the same NOT_FOUND, so the socket cannot enumerate sessions.
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
  // without a second round trip. Same envelope as a push, so the Rust client
  // needs one arm (D15).
  socket.send(JSON.stringify({ type: 'signal', data: message }));
}

const router = new Hono<AppContext>();

router.get('/agent', async (c) => {
  // D4: authenticate before the Upgrade guard, so a request with no credential
  // is 401 and never 426.
  const raw = extractAgentCredential(c.req.header('Authorization'));
  const db = getDb(c.env.DB);

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.credentialHash, await sha256Hex(raw)))
    .get();

  if (!agent) {
    // Same status, message, and code as a malformed header, so the endpoint
    // cannot be used to enumerate credentials.
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  // D6/W6: without this, a valid credential plus a non-upgrade GET is a 500 in
  // real workerd.
  if (c.req.header('Upgrade') !== 'websocket') {
    throw new AppError('Upgrade Required', 426, 'UPGRADE_REQUIRED');
  }

  const agentId = agent.id;
  const userId = agent.userId;

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  // D2/W5: registered before the 101 is returned. A reconnect replaces the
  // previous socket, so the map holds exactly one entry per agent.
  agentConnections.set(agentId, { agentId, userId, socket: server });

  server.addEventListener('message', (evt) => {
    void handleInbound(evt.data, server, { db, agentId, userId });
  });

  server.addEventListener('close', () => {
    // D8/W8: a superseded socket may still fire close after a newer socket has
    // replaced it. Without this guard the stale close evicts the live socket
    // and clears `is_online` for a connected agent.
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

  // D11: set on connect, not only on the first ping, so a freshly connected
  // agent is not reported offline for up to one ping interval.
  await db
    .update(agents)
    .set({ isOnline: true, lastPingAt: NOW_SQL })
    .where(eq(agents.id, agentId))
    .run();

  return new Response(null, { status: 101, webSocket: client });
});

export default router;
```

- [ ] **Step 7: Mount the route**

In `workers/signaling/src/index.ts`, add the import beside the other route imports:

```typescript
import ws from './routes/ws';
```

and the mount beside the other `app.route(...)` calls:

```typescript
app.route('/api/ws', ws);
```

- [ ] **Step 8: Run the ws tests and confirm they pass**

Run: `pnpm --filter @remote/signaling test ws`
Expected: 3 tests PASS.

- [ ] **Step 9: Write the failing tests for the inbound signal path**

Append to `workers/signaling/test/ws.test.ts` (inside the `describe`, before its closing `});`):

```typescript
  it('persists an inbound answer so the browser poll returns it, and echoes it', async () => {
    // W6/W13: the agent's answer must be indistinguishable from one posted over
    // REST — same type, same payload, same rowid cursor.
    const { credential, agentId, sessionId, token } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    expect(ws).toBeDefined();
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 agent', approved: true },
        },
      }),
    );

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    const echo = JSON.parse(received[0] ?? '{}') as {
      type: string;
      data: { type: string; data: { sessionId: string; sdp: string } };
    };
    expect(echo.type).toBe('signal');
    expect(echo.data.type).toBe('answer');
    expect(echo.data.data.sdp).toBe('v=0 agent');

    // The row exists and the browser's existing poll returns it unchanged.
    const poll = await app.request(
      `/api/signal/poll/${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as {
      signals: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(polled.signals).toHaveLength(1);
    expect(polled.signals[0]?.type).toBe('answer');
    expect(polled.signals[0]?.payload).toEqual({
      sessionId,
      sdp: 'v=0 agent',
      approved: true,
    });

    // The session advanced (Task 5 completes the transition; this asserts the
    // row the transition reads).
    expect(agentConnections.get(agentId)?.userId).toBeDefined();

    ws?.close();
  });

  it('rejects malformed frames without writing and leaves the socket open', async () => {
    // Review Focus #4: every malformed inbound frame yields an error frame and
    // the socket stays usable. A throw out of the message handler is the
    // dangerous case.
    const { credential, sessionId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    const cases: Array<{ frame: string; code: string }> = [
      { frame: 'not json at all', code: 'MALFORMED_JSON' },
      { frame: '[]', code: 'MALFORMED_JSON' },
      { frame: 'null', code: 'MALFORMED_JSON' },
      { frame: '{"type":"unknown"}', code: 'VALIDATION_ERROR' },
      { frame: '{"type":"signal"}', code: 'VALIDATION_ERROR' },
      {
        frame: JSON.stringify({
          type: 'signal',
          data: { type: 'answer', data: { sessionId, sdp: '' } },
        }),
        code: 'VALIDATION_ERROR',
      },
      // Review Focus #4 / §7.4 edge 4: the cap is refused before parsing.
      // This frame is a well-formed *object* carrying a syntactically valid
      // answer for a session that does not exist, so it is the cap and nothing
      // else that produces MALFORMED_JSON — without the cap it would be
      // NOT_FOUND, and the assertion below would fail. That is what makes this
      // case pin the cap rather than merely pass alongside it.
      {
        frame: JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: { sessionId: 'oversize', sdp: 'v=0 ' + 'x'.repeat(MAX_INBOUND_FRAME_BYTES) },
          },
        }),
        code: 'MALFORMED_JSON',
      },
    ];

    for (const { frame, code } of cases) {
      const before = received.length;
      ws?.send(frame);
      await vi.waitFor(() =>
        expect(received.length).toBeGreaterThan(before),
      );
      const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
        type: string;
        code: string;
      };
      expect(reply.type).toBe('error');
      expect(reply.code).toBe(code);
    }

    // Nothing was written by any rejected frame.
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    // The socket survived every one of them.
    ws?.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() =>
      expect(received.some((r) => r.includes('"pong"'))).toBe(true),
    );

    ws?.close();
  });

  it('rejects a foreign session and an agentless session with NOT_FOUND, writing nothing', async () => {
    // W7/W14: tenancy is two conjuncts. A rejected frame that still inserts is
    // the failure mode that matters, so this asserts D1 was not written.
    const { credential, token } = await seed();

    // A second user's session, not bound to this agent.
    const otherRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ws_other',
          password: 'Password123!',
          publicKey: 'pk_other',
        }),
      },
      env,
    );
    const other = (await otherRes.json()) as AuthResponse;
    const foreignSess = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const foreign = (await foreignSess.json()) as { id: string };

    // Same user as the agent, but the session carries no agentId. This is the
    // `session.agentId === null` branch specifically: an
    // `if (session.agentId && …)` guard would let it through, and only the
    // `!==` comparison against a non-null id rejects it.
    const agentlessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const agentless = (await agentlessRes.json()) as { id: string };

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    for (const sessionId of [foreign.id, agentless.id]) {
      const before = received.length;
      ws?.send(
        JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: { sessionId, sdp: 'v=0 sneaky', approved: true },
          },
        }),
      );
      await vi.waitFor(() =>
        expect(received.length).toBeGreaterThan(before),
      );
      const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
        type: string;
        code: string;
      };
      expect(reply).toEqual({ type: 'error', code: 'NOT_FOUND' });
    }

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);

    ws?.close();
  });
```

Add `vi` to the vitest import at the top of the file:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
```

The `ws_other` user registered at the top of the test is what makes the first case a *foreign* session; the second case is a session belonging to the agent's own user with no `agentId`, so the two rejections exercise the two different halves of the tenancy predicate.

- [ ] **Step 10: Run them and confirm they pass**

Run: `pnpm --filter @remote/signaling test ws`
Expected: 6 tests PASS.

- [ ] **Step 11: Write the failing test for socket supersession**

Append to `workers/signaling/test/ws.test.ts`:

```typescript
  it('a second connection supersedes the first without evicting it', async () => {
    // W8/Review Focus #1: two connections for one agentId are possible (a
    // reconnecting agent). The stale socket's close must not evict the live one
    // nor clear is_online, or a connected agent reads offline.
    const { credential, agentId } = await seed();

    const first = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const wsA = first.webSocket;
    wsA?.accept();

    const second = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const wsB = second.webSocket;
    wsB?.accept();

    // Exactly one entry, and it is the newer socket.
    expect(agentConnections.size).toBe(1);
    expect(agentConnections.get(agentId)?.socket).toBeDefined();

    // Closing the superseded socket must leave the live one in the map...
    wsA?.close();
    await vi.waitFor(() => expect(agentConnections.size).toBe(1));

    // ...and must not have cleared is_online for the connected agent.
    const row = await env.DB.prepare(
      `SELECT is_online FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number }>();
    expect(row?.is_online).toBe(1);

    // Closing the live socket does evict and clear.
    wsB?.close();
    await vi.waitFor(() => expect(agentConnections.size).toBe(0));
    await vi.waitFor(async () => {
      const after = await env.DB.prepare(
        `SELECT is_online FROM agents WHERE id = ?`,
      )
        .bind(agentId)
        .first<{ is_online: number }>();
      expect(after?.is_online).toBe(0);
    });
  });

  it('a ping refreshes last_ping_at in the space-separated format and returns pong', async () => {
    // W9/W10: `is_online` in D1 is a hint; `last_ping_at` is the truth. An
    // ISO-8601 write here would break every datetime() comparison over the
    // column, silently.
    const { credential, agentId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    // Backdate the connect-time write so the ping's write is observable.
    await env.DB.prepare(
      `UPDATE agents SET last_ping_at = datetime('now', '-10 minutes') WHERE id = ?`,
    )
      .bind(agentId)
      .run();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(JSON.stringify({ type: 'ping' }));

    await vi.waitFor(() =>
      expect(received.some((r) => r.includes('"pong"'))).toBe(true),
    );

    const row = await env.DB.prepare(
      `SELECT is_online, last_ping_at FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number; last_ping_at: string }>();
    expect(row?.is_online).toBe(1);
    expect(row?.last_ping_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row?.last_ping_at).not.toContain('T');

    ws?.close();
  });
```

- [ ] **Step 12: Run them and confirm they pass**

Run: `pnpm --filter @remote/signaling test ws`
Expected: 8 tests PASS.

- [ ] **Step 13: Write the failing push tests in `signal.test.ts`**

Append to `workers/signaling/test/signal.test.ts` (inside the `describe`, before its closing `});`):

```typescript
  it('pushes an offer to a connected agent socket with the signal envelope', async () => {
    // Review Focus #2: the push is a latency optimisation on top of D1, and it
    // must use the same envelope as an inbound echo so the agent has one arm.
    const agentRes = await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ id: 'agent_push', publicKey: 'pk_push' }),
      },
      env,
    );
    const { credential } = (await agentRes.json()) as { credential: string };

    const sessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ agentId: 'agent_push' }),
      },
      env,
    );
    const bound = (await sessRes.json()) as { id: string };

    const upgrade = await app.request(
      '/api/ws/agent',
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    const post = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: bound.id,
          sdp: 'v=0 pushed',
          capabilities: ['terminal'],
        }),
      },
      env,
    );
    expect(post.status).toBe(201);

    await vi.waitFor(() =>
      expect(received.some((r) => r.includes('"offer"'))).toBe(true),
    );

    const pushed = JSON.parse(received[received.length - 1] ?? '{}') as {
      type: string;
      data: { type: string; data: { sessionId: string; sdp: string } };
    };
    expect(pushed.type).toBe('signal');
    expect(pushed.data.type).toBe('offer');
    expect(pushed.data.data.sessionId).toBe(bound.id);
    expect(pushed.data.data.sdp).toBe('v=0 pushed');

    ws?.close();
  });

  it('still returns 201 when the agent has no socket, and the row is pollable', async () => {
    // Review Focus #2: a push miss is an ordinary outcome, not a request
    // failure. D1 plus the poll is the delivery guarantee (W15).
    const agentRes = await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ id: 'agent_offline', publicKey: 'pk_offline' }),
      },
      env,
    );
    expect(agentRes.status).toBe(201);

    const sessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ agentId: 'agent_offline' }),
      },
      env,
    );
    const bound = (await sessRes.json()) as { id: string };

    const post = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: bound.id, sdp: 'v=0 offline' }),
      },
      env,
    );

    expect(post.status).toBe(201);
    const body = (await post.json()) as SignalResponse;
    expect(body.type).toBe('offer');

    const poll = await app.request(
      `/api/signal/poll/${bound.id}`,
      { headers: { Authorization: `Bearer ${tokenUserA}` } },
      env,
    );
    const polled = (await poll.json()) as PollResponse;
    expect(polled.signals).toHaveLength(1);
    expect(polled.signals[0]?.payload.sdp).toBe('v=0 offline');
  });
```

Add `vi` to the vitest import at `workers/signaling/test/signal.test.ts:2`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
```

- [ ] **Step 14: Route the three POST routes through `recordSignal` and `pushToAgent`**

In `workers/signaling/src/routes/signal.ts`, add the imports:

```typescript
import { recordSignal } from '../utils/signals';
import { pushToAgent } from './ws';
```

The import is one-way (`signal.ts` → `ws.ts`; `ws.ts` imports neither `signal.ts` nor anything that does), so the graph stays acyclic.

Replace the offer route's insert-and-return block (`:56-87`) with:

```typescript
  const db = getDb(c.env.DB);
  const session = await getOwnedActiveSession(db, body.sessionId, user.id);

  const message: SignalMessage = {
    type: 'offer',
    data: {
      sessionId: body.sessionId,
      sdp: body.sdp,
      capabilities: body.capabilities ?? [],
    },
  };

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  // Fire-and-forget, synchronous, never throws (D9/D25). `session.agentId`
  // comes from the row `getOwnedActiveSession` already fetched, so no extra
  // query (D24).
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

Apply the identical shape to the answer route (`:107-138`):

```typescript
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

and to the ice-candidate route (`:163-195`):

```typescript
  const db = getDb(c.env.DB);
  const session = await getOwnedActiveSession(db, body.sessionId, user.id);

  const message: SignalMessage = {
    type: 'ice-candidate',
    data: {
      sessionId: body.sessionId,
      candidate: body.candidate,
      sdpMid: body.sdpMid ?? null,
      sdpMLineIndex: body.sdpMLineIndex ?? null,
    },
  };

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

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

Then remove what is now unused from the file's imports: `signals` (the table) and `sql`, if nothing else in the file uses them. `sessions` and `and`/`eq` are still used by `getOwnedActiveSession`, and the poll route uses raw SQL. Add the `SignalMessage` type import:

```typescript
import type { SignalMessage } from '@remote/shared';
```

**The `201` body must not change.** `recordSignal` inserts `{sessionId, type, payload, expiresAt}` and the response is rebuilt from the returned row with the same four fields in the same order — the payload is `JSON.stringify(message.data)`, which reproduces the previous key order exactly (`{sessionId, sdp, capabilities}` for an offer, `{sessionId, sdp, approved}` for an answer, `{sessionId, candidate, sdpMid, sdpMLineIndex}` for a candidate). No existing `signal.test.ts` assertion changes (D23).

- [ ] **Step 15: Run the signal tests and confirm they pass**

Run: `pnpm --filter @remote/signaling test signal`
Expected: 19 tests PASS (14 existing + 2 mutants + 1 R31 + 2 push).

- [ ] **Step 16: Run the whole signaling suite**

Run: `pnpm --filter @remote/signaling test`
Expected: 76 tests PASS (60 baseline + 2 mutants + 1 R31 + 3 credential/projection + 2 push + 8 socket).

- [ ] **Step 17: Run the whole gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **159 passing JS tests** (signaling 76, `webrtc-core` 32, `apps/web` 30, `api-client` 11, `crypto` 10).

- [ ] **Step 18: Commit**

```bash
git add packages/shared/src/types/signaling.ts \
        packages/shared/src/types/index.ts \
        workers/signaling/src/routes/ws.ts \
        workers/signaling/src/routes/signal.ts \
        workers/signaling/src/index.ts \
        workers/signaling/test/ws.test.ts \
        workers/signaling/test/signal.test.ts
git commit -m "feat(signaling): add credentialed agent socket, best-effort push, and heartbeat"
```

---

### Task 5: Session State Machine and Read-Time Online Determination

Three transitions, one shared persistence helper, one read-time predicate. This is the task that makes the week's E2E criterion observable from the browser: the session the agent answered must read `active` with a `started_at`, and a browser whose session was just terminated by a socket close must still be able to poll its final rows.

**Files:**
- Modify: `workers/signaling/src/utils/signals.ts` (`recordSignal` gains the transition)
- Create: `workers/signaling/src/utils/agent.ts` (add `isAgentOnline`; `toPublicAgent` gains a second parameter)
- Modify: `workers/signaling/src/routes/ws.ts` (close handler terminates sessions; inbound refusal for terminated)
- Modify: `workers/signaling/src/routes/sessions.ts:134-141` (the `datetime('now')` convergence)
- Modify: `workers/signaling/src/routes/agents.ts` (pass `socketPresent` into `toPublicAgent`)
- Test: `workers/signaling/test/ws.test.ts` (append three tests)
- Test: `workers/signaling/test/resources.test.ts` (append one test: `started_at`/`ended_at` format)
- Test: `workers/signaling/test/db.test.ts` (the migration assertions landed in Task 3)

**Interfaces:**
- Consumes: `NOW_SQL` (`src/utils/signals.ts`), `agentConnections` (`src/routes/ws.ts`), `sessions`/`agents` (`src/db/schema.ts`).
- Produces:
  ```typescript
  // workers/signaling/src/utils/agent.ts
  export const ONLINE_WINDOW_SECONDS = 90;
  /**
   * The only definition of "online" in the codebase.
   *
   * `socketPresent` is the caller's view of `agentConnections` — the projection
   * cannot read the map itself without a circular import (`ws.ts` imports
   * `utils/agent.ts`).
   */
  export function isAgentOnline(
    agent: { isOnline: boolean; lastPingAt: string | null },
    socketPresent: boolean,
    nowMs?: number,
  ): boolean;
  export function toPublicAgent(
    agent: AgentSelect,
    socketPresent: boolean,
  ): PublicAgent;

  // workers/signaling/src/utils/signals.ts
  export function recordSignal(
    db: Database,
    message: SignalMessage,
  ): Promise<SignalSelect | null>;   // now also applies pending -> active
  ```

- **`isAgentOnline` — the real implementation (spec D-5).** §6.3's printed version compares `agent.lastPingAt` (a `string`) to ``sql`datetime('now', '-90 seconds')``` (a drizzle `SQL` object). That is not valid TypeScript, and it cannot work: the comparison happens in JavaScript, where the SQL is never evaluated. Two conditions are needed and both are cheap:

  ```typescript
  export const ONLINE_WINDOW_SECONDS = 90;

  /**
   * `YYYY-MM-DD HH:MM:SS` in UTC — the exact shape `datetime('now')` writes.
   *
   * Deliberately not `toISOString()`: the `T` separator sorts after the space,
   * so an ISO string in this column is lexicographically greater than every
   * SQLite timestamp. See the `NOW_SQL` doc comment in `utils/signals.ts`.
   */
  function sqliteNow(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');
  }

  export function isAgentOnline(
    agent: { isOnline: boolean; lastPingAt: string | null },
    socketPresent: boolean,
    nowMs: number = Date.now(),
  ): boolean {
    if (!socketPresent || agent.isOnline !== true || !agent.lastPingAt) {
      return false;
    }

    // Both strings are space-separated UTC, so a lexicographic compare is a
    // chronological one. `Date.parse` is not used: it would read a
    // space-separated string as local time in Node and UTC in workerd.
    const cutoff = sqliteNow(nowMs - ONLINE_WINDOW_SECONDS * 1000);
    return agent.lastPingAt > cutoff;
  }
  ```

  `nowMs` is injectable so the window is testable without faking timers (D39). The `sqliteNow` slice-and-replace is the whole trick: `toISOString()` gives `2026-09-26T02:32:51.000Z`, the slice takes `2026-09-26T02:32:51`, and the replace swaps the `T` for the space `datetime('now')` uses. That is why the comparison is a plain `>` on two strings.

- **The `DELETE /api/sessions/:id` convergence (spec D-6).** `sessions.ts:138-139` writes `new Date().toISOString()` into `ended_at` and `updated_at`, which contradicts §6.4's claim that those columns already hold `datetime('now')` values. It is a real bug, not a documentation slip: an ISO `ended_at` compares lexicographically greater than every SQLite timestamp, so any `ended_at > …` filter would match it regardless of when it happened. No existing test asserts `endedAt` (`resources.test.ts`'s Sessions suite reads only `status`), so converging the write is assertion-safe. This step also adds the assertion that was missing.

- [ ] **Step 1: Write the failing test for the `pending → active` transition**

Append to `workers/signaling/test/ws.test.ts` (inside the `describe`, before its closing `});`):

```typescript
  it('advances the session to active with a started_at when an answer is persisted', async () => {
    // §6.1: the transition keys on the signal type, and it is guarded by
    // `WHERE status IN ('pending','active')` so a second answer cannot reset
    // started_at.
    const { credential, sessionId } = await seed();

    const before = await env.DB.prepare(
      `SELECT status, started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ status: string; started_at: string | null }>();
    expect(before?.status).toBe('pending');
    expect(before?.started_at).toBeNull();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    const sendAnswer = (sdp: string) =>
      ws?.send(
        JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: { sessionId, sdp, approved: true },
          },
        }),
      );

    sendAnswer('first answer');
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status, started_at FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string; started_at: string | null }>();
      expect(row?.status).toBe('active');
    });

    const afterFirst = await env.DB.prepare(
      `SELECT started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ started_at: string }>();
    // W10: the column must carry the SQLite shape, not ISO-8601.
    expect(afterFirst?.started_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(afterFirst?.started_at).not.toContain('T');

    // A second answer is still persisted, but must not move started_at.
    sendAnswer('second answer');
    await vi.waitFor(async () => {
      const rows = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
      )
        .bind(sessionId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(2);
    });

    const afterSecond = await env.DB.prepare(
      `SELECT started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ started_at: string }>();
    expect(afterSecond?.started_at).toBe(afterFirst?.started_at);

    ws?.close();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @remote/signaling test ws`
Expected: FAIL — `status` stays `'pending'` (nothing advances it yet).

- [ ] **Step 3: Add the transition to `recordSignal`**

In `workers/signaling/src/utils/signals.ts`, replace the `recordSignal` body with:

```typescript
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

  // `pending -> active` lives here rather than in either caller, because the
  // REST routes and the agent socket must not grow two copies of "insert the
  // signal, then maybe advance the session" (D16).
  //
  // The guard is `= 'pending'`, NOT `IN ('pending','active')`. §6.1's guard
  // paragraph states the blanket `IN` form for both transitions, but applied
  // here it also matches an already-`active` session and overwrites
  // `started_at` on every duplicate answer — the opposite of what §6.1
  // promises two paragraphs later ("when `type === 'answer'` and the session is
  // `pending`"). The `terminated` transition in `ws.ts` keeps the `IN` form,
  // where it is correct: there it is what stops a socket close from moving
  // `ended_at` after an explicit browser `DELETE`. See D-8.
  //
  // The transition keys on the signal *type*, not on which peer sent it: at the
  // database level the browser and the agent of one user are the same principal
  // for REST. In practice the browser is the offerer and never sends an
  // `answer`, so "an answer was persisted" and "the agent answered" coincide.
  if (message.type === 'answer') {
    await db
      .update(sessions)
      .set({ status: 'active', startedAt: NOW_SQL, updatedAt: NOW_SQL })
      .where(
        and(
          eq(sessions.id, message.data.sessionId),
          eq(sessions.status, 'pending'),
        ),
      );
  }

  return inserted ?? null;
}
```

Add to that file's imports:

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { sessions, signals } from '../db/schema';
```

Merge into the lines Task 3 already wrote rather than duplicating. `inArray` is not needed — the guard is a single `eq`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm --filter @remote/signaling test ws`
Expected: 9 tests PASS (8 from Task 4 + this one). The two Task 4 inbound tests now also transition their sessions, which no assertion in them contradicts.

- [ ] **Step 5: Write the failing test for the socket-close termination**

Append to `workers/signaling/test/ws.test.ts`:

```typescript
  it('terminates the session when the agent socket closes, and does not overwrite ended_at', async () => {
    // §6.1 + W11: the close handler is the only thing that ends a session the
    // browser did not end. The guard is what keeps a second close from moving
    // `ended_at` forward.
    const { credential, sessionId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    // Advance it to `active` first, so the transition under test is
    // `active -> terminated` rather than `pending -> terminated`.
    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 active', approved: true },
        },
      }),
    );
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string }>();
      expect(row?.status).toBe('active');
    });

    ws?.close();

    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status, ended_at FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string; ended_at: string | null }>();
      expect(row?.status).toBe('terminated');
    });

    const terminated = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();
    expect(terminated?.ended_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );

    // A second close (a superseded socket, or a duplicate event) must not move
    // `ended_at`. The guard is `WHERE status IN ('pending','active')`.
    await env.DB.prepare(
      `UPDATE sessions SET ended_at = datetime('now', '+1 hour') WHERE id = ?`,
    )
      .bind(sessionId)
      .run();
    const marker = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();

    const second = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws2 = second.webSocket;
    ws2?.accept();
    ws2?.close();

    await vi.waitFor(() =>
      expect(agentConnections.size).toBe(0),
    );
    const after = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();
    expect(after?.ended_at).toBe(marker?.ended_at);
  });
```

- [ ] **Step 6: Write the failing test for the terminated-session refusal**

Append to `workers/signaling/test/ws.test.ts`:

```typescript
  it('refuses an answer for a terminated session with SESSION_NOT_ACTIVE and writes nothing', async () => {
    // Review Focus #3: a late answer that reopens a dead session leaves the
    // browser waiting on a peer that is gone.
    const { credential, sessionId, token } = await seed();

    // Terminate over REST first.
    await app.request(
      `/api/sessions/${sessionId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 too late', approved: true },
        },
      }),
    );

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
      type: string;
      code: string;
    };
    expect(reply).toEqual({ type: 'error', code: 'SESSION_NOT_ACTIVE' });

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    const row = await env.DB.prepare(
      `SELECT status FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ status: string }>();
    expect(row?.status).toBe('terminated');

    ws?.close();
  });
```

- [ ] **Step 7: Run them and confirm they fail**

Run: `pnpm --filter @remote/signaling test ws`
Expected: FAIL on both — the close handler does not terminate sessions, and `handleInbound` has no status check.

- [ ] **Step 8: Terminate sessions on socket close**

In `workers/signaling/src/routes/ws.ts`, replace the `close` listener with:

```typescript
  server.addEventListener('close', () => {
    // D8/W8: a superseded socket may still fire close after a newer socket has
    // replaced it. Without this guard the stale close evicts the live socket
    // and clears `is_online` for a connected agent.
    const current = agentConnections.get(agentId);
    if (current?.socket !== server) return;

    agentConnections.delete(agentId);

    void db
      .update(agents)
      .set({ isOnline: false })
      .where(eq(agents.id, agentId))
      .run();

    // §6.1: the socket closing ends the sessions bound to this agent. The
    // status guard makes this idempotent — a browser `DELETE` that already ran
    // cannot have its `ended_at` moved forward by a later socket close.
    //
    // Over-broad by design for now: with one agent and one session in scope
    // this is exact; with concurrent sessions it would end sessions that were
    // not signaling on this socket (§6.5, Week 6 work).
    void db
      .update(sessions)
      .set({ status: 'terminated', endedAt: NOW_SQL, updatedAt: NOW_SQL })
      .where(
        and(
          eq(sessions.agentId, agentId),
          inArray(sessions.status, ['pending', 'active']),
        ),
      )
      .run();
  });
```

Add to that file's imports:

```typescript
import { and, eq, inArray } from 'drizzle-orm';
import { NOW_SQL, parseSignalMessage, recordSignal } from '../utils/signals';
```

and add `NOW_SQL` to the `../utils/signals` import. (There is no local `NOW_SQL` to delete — Task 4 Step 6 deliberately imports it from `utils/signals.ts` rather than defining a second copy. If you left one behind, delete it here.) `sql` stays in the drizzle import: Step 12 uses it in `routes/sessions.ts`, and this file's own `NOW_SQL` reference comes from the signals import.

- [ ] **Step 9: Refuse a signal for a terminated session in `handleInbound`**

In `handleInbound`, the session lookup currently selects `{ id, userId, agentId }`. Add `status` and check it after the tenancy predicate:

```typescript
  const session = await ctx.db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      agentId: sessions.agentId,
      status: sessions.status,
    })
    .from(sessions)
    .where(eq(sessions.id, message.data.sessionId))
    .get();

  // Tenancy is BOTH halves. `session.agentId` is nullable, so the `!==`
  // comparison against a non-null id rejects an agentless session too — an
  // `if (session.agentId && …)` guard would let it through. Every rejection
  // returns the same NOT_FOUND, so the socket cannot enumerate sessions.
  if (
    !session ||
    session.userId !== ctx.userId ||
    session.agentId !== ctx.agentId
  ) {
    socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
    return;
  }

  // Review Focus #3: a session that has already ended is not reopened. This is
  // the WS mirror of the REST `409 SESSION_NOT_ACTIVE` in
  // `getOwnedActiveSession`; without it a late answer would resurrect a dead
  // session and the browser would wait on a peer that is gone.
  if (session.status !== 'pending' && session.status !== 'active') {
    socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_ACTIVE' }));
    return;
  }
```

- [ ] **Step 10: Run the ws tests and confirm they pass**

Run: `pnpm --filter @remote/signaling test ws`
Expected: 11 tests PASS (9 after Step 4 + the close and refusal tests).

- [ ] **Step 11: Write the failing test for the `datetime('now')` convergence**

Append to `workers/signaling/test/resources.test.ts` (inside `describe('Sessions API (/api/sessions)')`, before its closing `});`):

```typescript
  it('writes ended_at in the same space-separated UTC format as created_at', async () => {
    // D-6: the route wrote `new Date().toISOString()` here, contradicting
    // §6.4's stated convention. An ISO value compares lexicographically greater
    // than every SQLite timestamp, so any `ended_at > …` filter would match it
    // regardless of when it happened. No prior test asserted this field.
    const createRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const created = (await createRes.json()) as { id: string };

    await app.request(
      `/api/sessions/${created.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    const row = await env.DB.prepare(
      `SELECT created_at, ended_at, updated_at, status FROM sessions WHERE id = ?`,
    )
      .bind(created.id)
      .first<{
        created_at: string;
        ended_at: string;
        updated_at: string;
        status: string;
      }>();

    expect(row?.status).toBe('terminated');
    const sqliteShape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    expect(row?.ended_at).toMatch(sqliteShape);
    expect(row?.updated_at).toMatch(sqliteShape);
    expect(row?.ended_at).not.toContain('T');

    // The column is now comparable to the others with a plain SQL comparison.
    const ordered = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND ended_at >= created_at`,
    )
      .bind(created.id)
      .first<{ n: number }>();
    expect(ordered?.n).toBe(1);
  });
```

If this suite's `beforeEach` does not already expose a `token` variable, use whichever variable it names for the authenticated user — read the top of `resources.test.ts` and match it. If it registers the user inline per test rather than in a `beforeEach`, mirror the pattern the neighbouring Sessions tests use.

- [ ] **Step 12: Converge the `DELETE` handler onto `datetime('now')`**

In `workers/signaling/src/routes/sessions.ts`, replace the update at `:134-141` with:

```typescript
  await db
    .update(sessions)
    .set({
      status: 'terminated',
      // D-6: `datetime('now')`, not `new Date().toISOString()`. These columns
      // hold space-separated UTC everywhere else (`created_at` defaults to it),
      // and an ISO string sorts after every SQLite timestamp — the `'T'` is
      // greater than the `' '` — so mixing the two makes every `datetime()`
      // comparison over this column wrong for half the rows.
      endedAt: sql`datetime('now')`,
      updatedAt: sql`datetime('now')`,
    })
    .where(eq(sessions.id, sessionId));
```

Add `sql` to that file's drizzle import if it is not already there.

- [ ] **Step 13: Run it and confirm it passes**

Run: `pnpm --filter @remote/signaling test resources`
Expected: 17 tests PASS (16 from Task 3 + the convergence test).

- [ ] **Step 14: Write the failing test for the read-time online window**

Append to `workers/signaling/test/resources.test.ts`:

```typescript
  it('reports isOnline false when is_online is 1 but the ping is outside the 90s window', async () => {
    // §6.3/W9: `is_online` in D1 is a hint; the 90s window is the truth. A row
    // can read is_online = 1 while the agent has been dark for two minutes,
    // because nothing clears it. The list must not report that as online.
    await app.request(
      '/api/agents',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: 'agent_stale', publicKey: 'pk_stale' }),
      },
      env,
    );

    // A stale hint: online flag set, ping two minutes old, no socket.
    await env.DB.prepare(
      `UPDATE agents SET is_online = 1, last_ping_at = datetime('now', '-2 minutes') WHERE id = 'agent_stale'`,
    ).run();

    const listRes = await app.request(
      '/api/agents',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const list = (await listRes.json()) as AgentResponse[];
    const stale = list.find((a) => a.id === 'agent_stale');

    expect(stale?.isOnline).toBe(false);
    expect(stale?.lastHeartbeat).not.toBeNull();

    // A fresh ping with the same flag reads online only if a socket is present
    // in this isolate. With no socket, the window alone is not sufficient —
    // both conditions are required (§6.3 consequence 1).
    await env.DB.prepare(
      `UPDATE agents SET last_ping_at = datetime('now') WHERE id = 'agent_stale'`,
    ).run();

    const freshRes = await app.request(
      '/api/agents',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const fresh = (await freshRes.json()) as AgentResponse[];
    expect(fresh.find((a) => a.id === 'agent_stale')?.isOnline).toBe(false);
  });
```

- [ ] **Step 15: Run it and confirm it fails**

Run: `pnpm --filter @remote/signaling test resources`
Expected: FAIL — `isOnline` currently mirrors the column, so the stale row reads `true`.

- [ ] **Step 16: Implement `isAgentOnline` and thread it through the projection**

In `workers/signaling/src/utils/agent.ts`, add:

```typescript
/**
 * How long a `last_ping_at` stays credible. The agent pings every 30s, so this
 * is three missed pings.
 */
export const ONLINE_WINDOW_SECONDS = 90;

/**
 * `YYYY-MM-DD HH:MM:SS` in UTC — the exact shape `datetime('now')` writes.
 *
 * Deliberately not `toISOString()`: the `T` separator sorts after the space, so
 * an ISO string is lexicographically greater than every SQLite timestamp. The
 * slice drops the milliseconds and the `Z`; the replace swaps in the space.
 */
function sqliteNow(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The only definition of "online" in the codebase.
 *
 * Two conditions, not one. A live socket in the in-memory map is not sufficient
 * — a half-open TCP connection keeps the entry while the agent is gone. A fresh
 * `last_ping_at` is not sufficient either — the socket is what a push needs.
 *
 * `socketPresent` is passed in rather than read here because `ws.ts` imports
 * this module; reading `agentConnections` from here would close the cycle.
 * `nowMs` is injectable so the window is testable without faking timers.
 *
 * `is_online` in D1 is only a hint: nothing clears it when an agent goes dark,
 * so every consumer must come through this function and never read the column
 * alone.
 */
export function isAgentOnline(
  agent: { isOnline: boolean; lastPingAt: string | null },
  socketPresent: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (!socketPresent || agent.isOnline !== true || !agent.lastPingAt) {
    return false;
  }

  // Both operands are space-separated UTC, so a lexicographic compare is a
  // chronological one. `Date.parse` is avoided: it reads a space-separated
  // string as local time in Node and as UTC in workerd.
  return agent.lastPingAt > sqliteNow(nowMs - ONLINE_WINDOW_SECONDS * 1000);
}
```

and change the projection signature:

```typescript
export function toPublicAgent(
  agent: AgentSelect,
  socketPresent: boolean,
): PublicAgent {
  return {
    id: agent.id,
    userId: agent.userId,
    hostname: agent.hostname,
    platform: agent.platform,
    osVersion: agent.osVersion,
    agentVersion: agent.agentVersion,
    publicKey: agent.publicKey,
    isOnline: isAgentOnline(agent, socketPresent),
    lastHeartbeat: agent.lastPingAt,
    capabilities: parseCapabilities(agent.capabilities),
    createdAt: agent.createdAt,
  };
}
```

- [ ] **Step 17: Update the three call sites in `routes/agents.ts`**

The projection now needs the caller's view of the map:

```typescript
import { agentConnections } from './ws';
import { generateAgentCredential, toPublicAgent } from '../utils/agent';
```

In `GET /`:

```typescript
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(list.map((agent) => toPublicAgent(agent, agentConnections.has(agent.id))));
```

In `GET /:id`:

```typescript
  return c.json(toPublicAgent(agent, agentConnections.has(agent.id)));
```

In `POST /`:

```typescript
  // A freshly registered agent has no socket yet, so this is always false — but
  // it goes through the same predicate so the projection has one definition.
  return c.json({ agent: toPublicAgent(created, false), credential }, 201);
```

- [ ] **Step 18: Run the resources and ws tests**

Run: `pnpm --filter @remote/signaling test resources ws`
Expected: resources 18 PASS (16 from Task 3 + the two this task adds), ws 11 PASS (8 from Task 4 + the three this task adds).

- [ ] **Step 19: Run the whole gate**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **164 passing JS tests** (signaling 81, `webrtc-core` 32, `apps/web` 30, `api-client` 11, `crypto` 10).

- [ ] **Step 20: Commit**

```bash
git add workers/signaling/src/utils/signals.ts \
        workers/signaling/src/utils/agent.ts \
        workers/signaling/src/routes/ws.ts \
        workers/signaling/src/routes/sessions.ts \
        workers/signaling/src/routes/agents.ts \
        workers/signaling/test/ws.test.ts \
        workers/signaling/test/resources.test.ts
git commit -m "feat(signaling): session state machine, read-time online window, datetime convergence"
```

---

### Task 6: The Rust Agent — `apps/agent`

Four flat modules, no `lib.rs`, no `config.rs`, no `webrtc/` subdirectory (D-7). The crate is `remote-agent`, a binary. Its only contract with the rest of the repository is the wire shape of `SignalMessage` and `DataChannelMessage<T>`, which it mirrors from `packages/shared` by hand.

**Everything in this task is new code in a language this repository has never compiled.** §5.2.1 of the spec records that explicitly, and Step 1 exists to turn the spec's version table from a *claim* into a resolved lock file before any of it is written.

**Files:**
- Create: `apps/agent/Cargo.toml`
- Create: `apps/agent/Cargo.lock` (**committed** — not gitignored; ADR-08)
- Create: `apps/agent/rust-toolchain.toml`
- Create: `apps/agent/.env.example`
- Create: `apps/agent/src/main.rs`
- Create: `apps/agent/src/signal.rs`
- Create: `apps/agent/src/rtc.rs`
- Create: `apps/agent/src/pty.rs`
- Modify: `apps/agent/package.json` (the `lint`/`typecheck`/`test` stubs become `cargo` calls; Task 8 adds `build`)

**Interfaces:**
- Consumes: `SignalMessage` and `DataChannelMessage<T>` from `packages/shared` (mirrored by hand, not imported — there is no Rust binding generator in this repo), and the WS route from Task 4.
- Produces:
  ```rust
  // src/signal.rs
  pub enum SignalMessage { Offer(SignalOffer), Answer(SignalAnswer), IceCandidate(IceCandidateSignal) }
  pub struct SignalOffer { pub session_id: String, pub sdp: String, pub capabilities: Vec<String> }
  pub struct SignalAnswer { pub session_id: String, pub sdp: String, pub approved: bool }
  pub struct IceCandidateSignal { pub session_id: String, pub candidate: String, pub sdp_mid: Option<String>, pub sdp_mline_index: Option<i32> }
  pub struct SignalClient;
  impl SignalClient {
      pub async fn connect(url: &str, credential: &str, agent_id: &str)
          -> Result<(Self, mpsc::Receiver<SignalMessage>, mpsc::Sender<SignalMessage>)>;
      pub async fn run(self) -> Result<()>;
  }
  pub fn parse_inbound(raw: &str) -> Result<Option<SignalMessage>>;
  pub fn next_backoff(current: Duration) -> Duration;
  pub const PING_INTERVAL: Duration;         // 30s
  pub const IDLE_TIMEOUT: Duration;          // 90s
  pub const BACKOFF_INITIAL: Duration;       // 200ms
  pub const BACKOFF_MAX: Duration;           // 2000ms
  pub const BACKOFF_FACTOR: f64;             // 1.5
  pub const MAX_INBOUND_FRAME_BYTES: usize;  // 256 * 1024

  // src/rtc.rs
  pub const TERMINAL_LABEL: &str;            // "terminal"
  pub async fn build_peer(stun_url: &str) -> Result<Arc<RTCPeerConnection>>;
  pub async fn answer_offer(peer: &Arc<RTCPeerConnection>, offer: &SignalOffer, outbound: &mpsc::Sender<SignalMessage>) -> Result<()>;
  pub async fn refuse_offer(peer: &Arc<RTCPeerConnection>, offer: &SignalOffer, outbound: &mpsc::Sender<SignalMessage>) -> Result<()>;
  pub fn forward_candidates(peer: &Arc<RTCPeerConnection>, session_id: String, outbound: mpsc::Sender<SignalMessage>);
  pub async fn apply_candidate(peer: &Arc<RTCPeerConnection>, pending: &mut Vec<RTCIceCandidateInit>, signal: IceCandidateSignal) -> Result<bool>;
  pub fn narrow_mline_index(raw: Option<i32>) -> Result<Option<u16>>;
  pub async fn flush_pending_candidates(peer: &Arc<RTCPeerConnection>, pending: &mut Vec<RTCIceCandidateInit>) -> Result<()>;
  pub fn candidate_to_wire(session_id: &str, init: RTCIceCandidateInit) -> Result<IceCandidateSignal>;

  // src/pty.rs
  pub const MAX_PTY_CHUNK: usize;            // 16 * 1024
  pub const MAX_FRAME_BYTES: usize;          // 64 * 1024
  pub struct PtySession;
  impl PtySession {
      /// `input` is caller-owned: the sending half must exist before the
      /// browser's channel reports `open`, or the first keystrokes are lost.
      pub fn spawn(shell: &str, cols: u16, rows: u16, input: mpsc::Receiver<Vec<u8>>) -> Result<Self>;
      pub fn start_reader(&self, terminal_id: String) -> Result<mpsc::Receiver<String>>;
      pub async fn close(self) -> Result<()>;
  }
  pub struct TerminalDataMessage { pub terminal_id: String, pub data: String }
  pub struct DataChannelMessage<T> { pub r#type: String, pub channel: String, pub payload: T, pub timestamp: i64 }
  pub fn frame_pty_output(terminal_id: &str, bytes: &[u8], timestamp_ms: i64) -> String;
  pub fn decode_pty_input(raw: &str) -> Result<Option<Vec<u8>>>;
  pub fn now_ms() -> i64;

  // src/main.rs
  fn resolve_credential(cli: &Cli) -> Result<String>;
  fn resolve_shell(cli: &Cli) -> Result<String>;
  async fn shutdown_signal();
  async fn run_with_reconnect(cli: &Cli, credential: &str, shell: &str) -> Result<()>;
  async fn supervise_sessions(inbound: mpsc::Receiver<SignalMessage>, outbound: mpsc::Sender<SignalMessage>, cli: &Cli, shell: &str) -> Result<()>;
  async fn run_one_session(offer: &SignalOffer, inbound: &mut mpsc::Receiver<SignalMessage>, outbound: &mpsc::Sender<SignalMessage>, cli: &Cli, shell: &str) -> Result<()>;
  ```

  Every signature above is the one the step that defines it actually writes. This
  block is the contract Task 7's E2E harness and Task 8's CI build against, so it
  is kept in step with the code blocks rather than transcribed from the spec.

- **No `hello` frame (D-2).** §5.5.1 prints a `ClientFrame::Hello` and §5.5.2 says "the first frame sent is `ClientFrame::Hello`", but §4.5's `handleInbound` — which Task 4 implemented — has no arm for it and would answer `VALIDATION_ERROR`. Identity comes from the credential in the handshake header (ADR-13), which is strictly stronger than a self-declared id. **This task therefore defines no `ClientFrame` at all**, and §5.5.5's "reconnects and re-sends `hello`" becomes "reconnects and re-sends nothing". Recorded as D-2 and re-stated in Task 9's docs sync.

- **The path is `/api/ws/agent`, not `/ws/agent`.** The spec contradicts itself: §4.4, §4.13 and §8.1 mount the router at `/api/ws` (so the route is `/api/ws/agent`), while §5.8.1's clap default, §5.9.3 and §5.11.5's `.env.example` all say `/ws/agent`. Task 4 mounted `/api/ws`. **Follow Task 4** — it is the Worker half that actually exists, and every other Worker route in this repository is under `/api`. Recorded as D-10.

- [ ] **Step 1: Resolve the dependency versions against a live registry and pin them**

Do **not** hand-write `Cargo.toml` from the spec's table. §5.4.3's versions are "a starting point verified against crates.io on the spec date, not a build result", and `webrtc = "0.13"` is seven minor versions behind upstream — a semver range resolves to whatever exists *today*, which is the point of resolving rather than copying.

```bash
cd apps/agent
cargo init --name remote-agent --vcs none .
cargo add tokio --features full
cargo add webrtc@0.13
cargo add tokio-tungstenite --features rustls-tls-webpki-roots
cargo add futures-util --no-default-features --features sink,std
cargo add portable-pty@0.9
cargo add serde --features derive
cargo add serde_json
cargo add clap --features derive,env
cargo add tracing
cargo add tracing-subscriber --features env-filter
cargo add base64@0.23
cargo add anyhow
```

Then record what resolved:

```bash
cargo tree --depth 1
git diff apps/agent/Cargo.toml
```

Expected: `Cargo.toml` lists each crate with a caret range, and `Cargo.lock` is created. **Commit `Cargo.lock`** — it is not gitignored (`.gitignore:8` is `target/`, which matches the build directory only) and ADR-08 makes it authoritative. Confirm with `git check-ignore -v apps/agent/Cargo.lock` → no output (exit 1).

Add the three fields the spec fixes and that `cargo init` does not set:

```toml
[package]
name = "remote-agent"
version = "0.1.0"
edition = "2021"
rust-version = "1.85"          # clap 4.6.7's MSRV is the highest in the set (spec R24)
```

**Do not add `bytes`.** `Message::Ping` and `DataChannelMessage.data` both use `bytes::Bytes`, which `tungstenite` re-exports (spec R14) — reach it as `tokio_tungstenite::tungstenite::Bytes`. A direct dependency risks a version split for no benefit.

`cargo init` writes a placeholder `src/main.rs` and, because there is no git repo at that path, no `.gitignore`. Verify the generated file is replaced in Step 4 and that no `apps/agent/.gitignore` was created.

- [ ] **Step 2: Pin the toolchain**

Create `apps/agent/rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.98.1"
components = ["rustfmt", "clippy"]
```

This matches CI (Task 8's `dtolnay/rust-toolchain` step) and the local toolchain the spec verified. A contributor with a different default toolchain gets 1.98.1 here automatically; bumping it is a deliberate change, not an accident.

- [ ] **Step 3: Create `.env.example`**

Create `apps/agent/.env.example`:

```env
# apps/agent/.env.example — copy to .env (gitignored) and fill in.
#
# The credential is issued ONCE by POST /api/agents and cannot be recovered;
# only its SHA-256 is stored. Prefer this file (or your secret manager) over
# --credential on the command line: argv is world-readable via `ps` (ADR-13).
AGENT_CREDENTIAL=ag_replace_me

# Note the /api prefix: the Worker mounts the router at /api/ws (spec D-10).
# Use wss:// in production.
AGENT_SERVER=ws://localhost:8787/api/ws/agent

AGENT_ID=my-laptop
# AGENT_SHELL=/bin/bash
```

`.env.example` is not matched by `.gitignore` (verified: only `target/` and the usual Node entries), so this file is safe to commit. **`.env` itself must never be committed** — confirm with `git check-ignore -v apps/agent/.env` → it must report a match. If it does not, add `.env` to `apps/agent/.gitignore` and re-check before continuing.

- [ ] **Step 4: Write `src/signal.rs` — the wire types**

Replace the `cargo init` placeholder in `src/main.rs` with a module declaration and write `src/signal.rs`:

```rust
//! WebSocket signaling client: handshake, inbound queue, outbound channel,
//! 30 s ping, and reconnect backoff.
//!
//! The types below mirror `packages/shared/src/types/signaling.ts` by hand.
//! They are the interop contract, so the serde attributes are load-bearing and
//! a round-trip test pins them (`offer_round_trip`, Step 8).

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// Mirrors the `SignalMessage` union in `packages/shared/src/types/signaling.ts`.
///
/// `#[serde(tag = "type", content = "data")]` is the whole interop contract: it
/// is byte-for-byte what `RESTPollingTransport.parseSignalItem` produces and
/// consumes (`packages/webrtc-core/src/transport.ts:182-218`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum SignalMessage {
    Offer(SignalOffer),
    Answer(SignalAnswer),
    #[serde(rename = "ice-candidate")]
    IceCandidate(IceCandidateSignal),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalOffer {
    pub session_id: String,
    pub sdp: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalAnswer {
    pub session_id: String,
    pub sdp: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidateSignal {
    pub session_id: String,
    pub candidate: String,
    pub sdp_mid: Option<String>,
    /// Wire type is `number | null`; narrowed to `u16` at the `rtc.rs` boundary
    /// (spec R7). `i32` here because a hostile peer can send `-1` or `70000`
    /// and serde must be able to *parse* it in order for the narrowing check to
    /// reject it with a useful error rather than a deserialize failure.
    pub sdp_mline_index: Option<i32>,
}

/// The outermost WS envelope. A signal frame nests `{ type, data }` inside
/// `{ type: 'signal', data }`: the outer `type` is the transport discriminator
/// (matching `AgentSocketMessage` in `packages/shared`), the inner one is the
/// signal discriminator. `ping`/`pong`/`error` are transport frames.
///
/// `hello` is deliberately absent — see D-2 in the Week 5 plan. The Worker's
/// `handleInbound` has no arm for it and would answer `VALIDATION_ERROR`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum InboundFrame {
    Signal { data: SignalMessage },
    Pong,
    Error { code: String },
}

/// The liveness and backoff constants, mirrored from
/// `packages/webrtc-core/src/transport.ts:45-46` (`initialIntervalMs`,
/// `maxIntervalMs`) and the `* 1.5` / `Math.min(.., maxIntervalMs)` at
/// `:140-143`, `:165-168`, `:171-174`.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90); // 3 missed pings
pub const BACKOFF_INITIAL: Duration = Duration::from_millis(200);
pub const BACKOFF_MAX: Duration = Duration::from_millis(2000);
pub const BACKOFF_FACTOR: f64 = 1.5;

/// The next reconnect delay: `min(delay * 1.5, BACKOFF_MAX)`.
///
/// The accumulator is `f64` and the result is rounded, because the TypeScript
/// sequence is `200, 300, 450, 675, 1012.5, …` and `Duration::from_millis`
/// takes an integer. The parity test asserts the factor, the initial value, the
/// cap and the reset rule — **not** the fractional milliseconds, which would be
/// a brittle cross-language assertion (spec §5.5.4).
pub fn next_backoff(current: Duration) -> Duration {
    let scaled = (current.as_secs_f64() * BACKOFF_FACTOR) * 1000.0;
    let capped = scaled.min(BACKOFF_MAX.as_millis() as f64);
    Duration::from_millis(capped.round() as u64)
}

/// Parse one inbound text frame.
///
/// Returns `Ok(None)` for a frame this client has no use for (a `pong`, an
/// error frame, or a control frame it does not implement) and `Err` for a frame
/// it cannot decode. The caller logs and drops an `Err` rather than panicking:
/// the body is attacker-influenced JSON, and a dropped malformed frame is
/// strictly better than a dead agent — the same rule as Week 4's
/// `parseSignalItem` guard.
pub fn parse_inbound(raw: &str) -> Result<Option<SignalMessage>> {
    if raw.len() > MAX_INBOUND_FRAME_BYTES {
        bail!("inbound frame exceeds {MAX_INBOUND_FRAME_BYTES} bytes");
    }
    match serde_json::from_str::<InboundFrame>(raw) {
        Ok(InboundFrame::Signal { data }) => Ok(Some(data)),
        Ok(InboundFrame::Pong) => Ok(None),
        Ok(InboundFrame::Error { code }) => {
            tracing::warn!(code = %code, "server sent an error frame");
            Ok(None)
        }
        Err(e) => Err(e).context("malformed inbound frame"),
    }
}

/// Inbound frame cap, matching the Worker's `MAX_INBOUND_FRAME_BYTES`
/// (Task 4). Checked before `serde_json` so a hostile peer cannot make the
/// agent allocate an object graph proportional to the frame.
pub const MAX_INBOUND_FRAME_BYTES: usize = 256 * 1024;
```

- [ ] **Step 5: Add the client to `src/signal.rs`**

Append the connection, the split, and the read/write/ping loops:

```rust
/// The outbound envelope, mirroring `AgentSocketMessage` in `packages/shared`.
///
/// `#[serde(tag = "type")]` on a struct variant with one field produces
/// `{"type":"signal","data":{...}}` — the same shape Task 4's `pushToAgent`
/// sends, so the Rust client needs one arm for a push and an echo.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Envelope<'a> {
    Signal { data: &'a SignalMessage },
}

/// A connected agent socket.
pub struct SignalClient {
    sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    inbound_tx: mpsc::Sender<SignalMessage>,
    /// Taken by `run(self)` — hence `Option`. `connect` fills it; nothing else
    /// reads it, and a second `run` fails loudly rather than silently dropping
    /// every outbound frame.
    outbound_rx: Option<mpsc::Receiver<SignalMessage>>,
}

impl SignalClient {
    /// Connect and authenticate. The credential travels in the
    /// `Authorization` header and **never** in the query string: a URL is
    /// logged by every proxy and by Cloudflare's own request log, and the
    /// credential is the one secret that must never appear in one (ADR-13).
    pub async fn connect(
        url: &str,
        credential: &str,
        _agent_id: &str,
    ) -> Result<(Self, mpsc::Receiver<SignalMessage>, mpsc::Sender<SignalMessage>)> {
        let mut request = url
            .into_client_request()
            .context("invalid signaling URL")?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {credential}"))
                .context("credential is not a valid header value")?,
        );

        let (ws, _response) = tokio_tungstenite::connect_async(request)
            .await
            .context("websocket handshake failed")?;

        let (sink, stream) = ws.split();

        // Inbound: socket -> mpsc -> rtc task. The read loop never awaits RTC
        // work, so a slow SDP parse cannot stall the socket and trip the peer's
        // ICE timeout.
        let (inbound_tx, inbound_rx) = mpsc::channel::<SignalMessage>(32);

        // Outbound: rtc task -> mpsc -> write loop. One owner of `sink`, so no
        // locking.
        let (outbound_tx, outbound_rx) = mpsc::channel::<SignalMessage>(32);

        let client = Self {
            sink,
            stream,
            inbound_tx,
            outbound_rx: Some(outbound_rx),
        };
        Ok((client, inbound_rx, outbound_tx))
    }

    /// Read + write + ping loop. Returns `Ok(())` on a clean close and `Err` on
    /// a fatal condition; the supervisor in `main.rs` decides whether that is a
    /// reconnect or an exit.
    pub async fn run(mut self) -> Result<()> {
        let mut outbound_rx = self
            .outbound_rx
            .take()
            .context("run() called twice on one client")?;

        let mut ping = tokio::time::interval(PING_INTERVAL);
        // Skip the immediate first tick: connecting already wrote `is_online`,
        // and a ping at t=0 is noise.
        ping.tick().await;

        loop {
            tokio::select! {
                // Outbound signal from rtc.rs.
                Some(message) = outbound_rx.recv() => {
                    let text = serde_json::to_string(&Envelope::Signal { data: message })?;
                    // `.into()`: tungstenite 0.26's `Message::Text` holds a
                    // `Utf8Bytes`, not a `String`.
                    self.sink.send(Message::Text(text.into())).await
                        .context("outbound send failed")?;
                }

                // Keepalive. The flush is NOT optional: tungstenite queues the
                // automatic pong reply to an inbound ping but does not flush it
                // (spec R15), so without a periodic flush the pong sits in the
                // buffer and the peer sees a dead socket.
                _ = ping.tick() => {
                    self.sink.send(Message::Ping(Bytes::new())).await
                        .context("ping failed")?;
                    self.sink.flush().await.context("flush failed")?;
                }

                // Inbound. `IDLE_TIMEOUT` is a real liveness check, not a
                // constant kept for the docs: the server treats a ping older
                // than 90 s as a dead socket, so a socket that has been silent
                // for 90 s is one the server has already forgotten. Returning
                // `Err` hands it to the reconnect loop in `main.rs` instead of
                // sitting on a connection that can never deliver anything.
                frame = tokio::time::timeout(IDLE_TIMEOUT, self.stream.next()) => {
                    let frame = match frame {
                        Ok(frame) => frame,
                        Err(_) => bail!("no frame from the server in {IDLE_TIMEOUT:?}"),
                    };
                    let Some(frame) = frame else { return Ok(()) };  // clean close
                    match frame.context("inbound read failed")? {
                        Message::Text(text) => {
                            match parse_inbound(&text) {
                                Ok(Some(message)) => {
                                    // A full inbound queue means the RTC task is
                                    // wedged; dropping is correct (the Worker's
                                    // D1 row is the delivery guarantee).
                                    let _ = self.inbound_tx.try_send(message);
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    // Never log the body: an SDP is
                                    // session-identifying.
                                    tracing::warn!(
                                        error = %e,
                                        bytes = text.len(),
                                        "dropping malformed inbound frame",
                                    );
                                }
                            }
                        }
                        // The protocol is text-only. A binary frame is ignored
                        // without a reply.
                        Message::Binary(_) => {}
                        Message::Ping(payload) => {
                            self.sink.send(Message::Pong(payload)).await
                                .context("pong failed")?;
                        }
                        Message::Pong(_) => {}
                        Message::Close(_) => return Ok(()),
                        // `Frame` is feature-gated in tungstenite, so a
                        // catch-all keeps this exhaustive either way.
                        _ => {}
                    }
                }
            }
        }
    }
}
```

`outbound_rx` is an `Option` because `run(self)` consumes the struct and must move the receiver out of it. `Envelope` is the outbound counterpart of `InboundFrame`; it borrows the message so a push costs no clone.

- [ ] **Step 6: Write `src/rtc.rs` — the answerer**

```rust
//! WebRTC answerer. Owns one `RTCPeerConnection` for one session.

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::signal::{IceCandidateSignal, SignalAnswer, SignalMessage, SignalOffer};

/// The one channel label this agent accepts. ADR-09: exact label, nothing else.
pub const TERMINAL_LABEL: &str = "terminal";

/// Build the peer connection.
///
/// mDNS is disabled: headless hosts and containers frequently have no mDNS
/// responder, and leaving it on produces unresolvable `.local` candidates.
/// Loopback needs no ICE server at all (Week 4 F4); `stun_url` is configuration
/// with a public default, and an empty string is the loopback/air-gapped path.
pub async fn build_peer(stun_url: &str) -> Result<Arc<RTCPeerConnection>> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("register_default_codecs")?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .context("register_default_interceptors")?;

    let mut setting = SettingEngine::default();
    setting.set_ice_multicast_dns_mode(
        webrtc::ice::mdns::MulticastDnsMode::Disabled,
    );

    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting)
        .build();

    let ice_servers = if stun_url.is_empty() {
        Vec::new()
    } else {
        vec![RTCIceServer {
            urls: vec![stun_url.to_string()],
            ..Default::default()
        }]
    };

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    api.new_peer_connection(config)
        .await
        .context("new_peer_connection")
}

/// Narrow a wire `sdpMLineIndex` to the `u16` the crate uses.
///
/// Spec R7: a value outside `0..=65535` is rejected at the boundary rather than
/// truncated, because a truncated index makes the peer associate the candidate
/// with the wrong media section.
pub fn narrow_mline_index(raw: Option<i32>) -> Result<Option<u16>> {
    match raw {
        None => Ok(None),
        Some(v) if (0..=65535).contains(&v) => Ok(Some(v as u16)),
        Some(v) => anyhow::bail!("sdpMLineIndex {v} is outside 0..=65535"),
    }
}

/// Apply every buffered candidate, in arrival order, after the remote
/// description exists.
///
/// The buffering itself is the Week 4 F1 twin (spec R3): `add_ice_candidate`
/// returns `ErrNoRemoteDescription` when it is called too early, so a naive
/// implementation **loses** candidates and the connection fails with an
/// unhelpful error. Both peers must buffer or neither connects.
///
/// Called by `run_one_session` once `answer_offer` has set the remote
/// description; the buffer is filled by `apply_candidate`.
pub async fn flush_pending_candidates(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
) -> Result<()> {
    for cand in pending.drain(..) {
        // Sequential, in arrival order.
        peer.add_ice_candidate(cand)
            .await
            .context("add_ice_candidate (flushed)")?;
    }
    Ok(())
}

/// Answer one offer: set the remote description, create the answer, send it.
///
/// **Candidate buffering is the caller's job, not this function's.** The
/// candidates that need buffering arrive on the inbound channel, and only
/// `run_one_session` reads that — so `answer_offer` deliberately takes no
/// buffer. It returns as soon as the answer is on the wire, and the caller
/// applies whatever arrived in the meantime via `flush_pending_candidates`.
///
/// `approved` is a policy check, not a prompt (§5.6.4): true when the offer's
/// capabilities contain `"terminal"`, false otherwise.
///
/// **A refusal still carries a real SDP.** `POST /api/signal/answer` rejects an
/// empty `sdp` with `400 VALIDATION_ERROR` (spec R19), so the refusal path calls
/// `create_answer` first and sends the real SDP with `approved: false`. A
/// refusal is therefore indistinguishable from a success at the transport layer
/// and visible only in the flag — honest, because the Worker does not act on the
/// flag today (`routes/signal.ts` stores `approved: body.approved !== false` and
/// nothing enforces it).
pub async fn answer_offer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);
    send_answer(peer, offer, approved, outbound).await
}

/// Decline an offer while another session is live (ADR-14).
///
/// Still answers with a real SDP and `approved: false` — the browser's only
/// signal that the agent declined. `POST /api/signal/answer` rejects an empty
/// `sdp` (spec R19), so "refuse" cannot mean "send nothing".
pub async fn refuse_offer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, false, outbound).await
}

/// Set the remote description, produce an answer, send it with `approved`.
///
/// Shared by `answer_offer` and `refuse_offer` so the two cannot drift into
/// different SDP handling — the refusal path is the one that is never exercised
/// by the happy-path tests, and duplicated code there is how a refusal ends up
/// sending something the Worker rejects.
async fn send_answer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    approved: bool,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    peer.set_remote_description(RTCSessionDescription::offer(offer.sdp.clone())?)
        .await
        .context("set_remote_description(offer)")?;

    let answer = peer.create_answer(None).await.context("create_answer")?;
    peer.set_local_description(answer.clone())
        .await
        .context("set_local_description")?;

    outbound
        .send(SignalMessage::Answer(SignalAnswer {
            session_id: offer.session_id.clone(),
            sdp: answer.sdp,
            approved,
        }))
        .await
        .context("send answer")?;

    Ok(())
}

/// Register the outbound candidate forwarder.
///
/// **This is what makes the connection work at all.** ICE needs a candidate
/// pair: the browser's candidates alone are not enough, and an agent that never
/// sends its own reaches `checking` and stops. Register it *before*
/// `answer_offer` — gathering starts when the local description is set, and a
/// handler registered afterwards misses the host candidates emitted in that
/// same tick.
///
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4): not an
/// error, and nothing to forward.
pub fn forward_candidates(
    peer: &Arc<RTCPeerConnection>,
    session_id: String,
    outbound: mpsc::Sender<SignalMessage>,
) {
    peer.on_ice_candidate(Box::new(move |candidate| {
        let outbound = outbound.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return; // gathering complete
            };
            match candidate_to_wire(&session_id, candidate) {
                Ok(signal) => {
                    // Best-effort, like the Worker's push: a candidate that
                    // cannot be sent is a lost candidate, not a dead session —
                    // ICE retries and one lost candidate is rarely fatal.
                    if outbound.send(SignalMessage::IceCandidate(signal)).await.is_err() {
                        tracing::debug!("outbound closed while sending a candidate");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "dropping an unmappable candidate"),
            }
        })
    }));
}

/// Apply one inbound candidate, buffering it if the remote description is not
/// set yet.
///
/// Returns `true` when the candidate was applied and `false` when it was
/// buffered. Buffering is not an optimisation: the browser trickles as soon as
/// it has the answer, so its first candidates routinely arrive before this side
/// has processed the offer, and `add_ice_candidate` fails outright with
/// `ErrNoRemoteDescription` (spec R3).
pub async fn apply_candidate(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
    signal: IceCandidateSignal,
) -> Result<bool> {
    let index = narrow_mline_index(signal.sdp_mline_index)?;
    let init = RTCIceCandidateInit {
        candidate: signal.candidate,
        sdp_mid: signal.sdp_mid,
        sdp_mline_index: index.map(i32::from),
        ..Default::default()
    };

    if peer.remote_description().await.is_none() {
        pending.push(init);
        return Ok(false);
    }

    peer.add_ice_candidate(init)
        .await
        .context("add_ice_candidate")?;
    Ok(true)
}

/// Convert an outbound crate candidate into the wire type.
///
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4) — not an
/// error, and not something to forward. Because the agent trickles,
/// `gathering_complete_promise()` is **not** used; that helper is for
/// non-trickle (blocking) gathering.
pub fn candidate_to_wire(
    session_id: &str,
    init: RTCIceCandidateInit,
) -> Result<IceCandidateSignal> {
    Ok(IceCandidateSignal {
        session_id: session_id.to_string(),
        candidate: init.candidate,
        sdp_mid: init.sdp_mid,
        sdp_mline_index: init.sdp_mline_index.map(i32::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_index_narrowing() {
        // Spec R7: out-of-range is rejected at the boundary, not truncated —
        // a truncated index associates the candidate with the wrong media
        // section, which surfaces as an ICE failure with no useful error.
        assert!(narrow_mline_index(Some(-1)).is_err());
        assert!(narrow_mline_index(Some(70000)).is_err());
        assert_eq!(narrow_mline_index(Some(0)).unwrap(), Some(0));
        assert_eq!(narrow_mline_index(Some(65535)).unwrap(), Some(65535));
        assert_eq!(narrow_mline_index(None).unwrap(), None);
    }

    #[test]
    fn candidate_wire_round_trip() {
        // `candidate_to_wire` is the outbound half of the interop contract, so
        // the field names are what the browser parses: `sdpMid`/`sdpMLineIndex`
        // in camelCase, `candidate` verbatim.
        let signal = candidate_to_wire(
            "s1",
            RTCIceCandidateInit {
                candidate: "candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host".to_string(),
                sdp_mid: Some("0".to_string()),
                sdp_mline_index: Some(0),
                ..Default::default()
            },
        )
        .unwrap();

        let json = serde_json::to_value(&SignalMessage::IceCandidate(signal)).unwrap();
        assert_eq!(json["type"], "ice-candidate");
        assert_eq!(json["data"]["sessionId"], "s1");
        assert_eq!(json["data"]["sdpMid"], "0");
        assert_eq!(json["data"]["sdpMLineIndex"], 0);
        assert!(json["data"].get("sdp_mid").is_none(), "must be camelCase");
    }
}
```

- [ ] **Step 7: Write `src/pty.rs` — the PTY bridge**

```rust
//! PTY bridge: spawn a shell, pump bytes both ways, frame them as base64.
//!
//! **No UTF-8 assumption anywhere.** Bytes move as `Vec<u8>` and are
//! base64-encoded, so a multi-byte sequence split across two `read()` calls is
//! harmless (ADR-10). This is the single most important property of the pump: a
//! "looks fine on my machine" implementation passes every unit test and
//! corrupts output in production.

use std::io::{Read, Write};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// 16 KiB raw becomes ~21 848 base64 characters, plus the JSON envelope
/// (~120 bytes) — comfortably under the browser DataChannel's default
/// `maxMessageSize` (64 KiB in Chromium) and under the SCTP limit.
pub const MAX_PTY_CHUNK: usize = 16 * 1024;

/// Inbound guard, checked **before** `serde_json` parses, so a hostile peer
/// cannot make the agent allocate arbitrarily.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// `data` is standard base64 of the raw bytes — the shape
/// `packages/shared/src/types/terminal.ts:16-19` declares.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataMessage {
    pub terminal_id: String,
    pub data: String,
}

/// The envelope from `packages/shared/src/types/webrtc.ts:9-14`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataChannelMessage<T> {
    pub r#type: String,
    pub channel: String,
    pub payload: T,
    pub timestamp: i64,
}

/// Encode raw PTY bytes as a `terminal-data` frame.
///
/// `timestamp` is passed in rather than read from the clock here so the framing
/// function stays pure and testable.
pub fn frame_pty_output(terminal_id: &str, bytes: &[u8], timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-data".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalDataMessage {
            terminal_id: terminal_id.to_string(),
            data: STANDARD.encode(bytes),
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of strings cannot fail to serialize")
}

/// Decode an inbound `terminal-data` frame.
///
/// Returns `Ok(None)` when the frame is not a `terminal-data` frame on the
/// `terminal` channel (the agent ignores any other channel, per ADR-09) and
/// `Err` when it is but cannot be decoded. Strict, padded standard alphabet
/// (spec R16): a lenient decode would silently accept a frame the browser
/// never meant to send.
pub fn decode_pty_input(raw: &str) -> Result<Option<Vec<u8>>> {
    if raw.len() > MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {MAX_FRAME_BYTES} bytes");
    }

    let envelope: DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "terminal" || envelope.r#type != "terminal-data" {
        return Ok(None);
    }

    let payload: TerminalDataMessage =
        serde_json::from_value(envelope.payload).context("payload is not a TerminalDataMessage")?;

    let bytes = STANDARD
        .decode(payload.data.as_bytes())
        .context("payload.data is not valid base64")?;

    Ok(Some(bytes))
}

/// A spawned shell on a PTY.
pub struct PtySession {
    /// Held for its lifetime, never read: `try_clone_reader()` borrows it, so
    /// dropping it would close the PTY. `dead_code` is expected here.
    #[allow(dead_code)]
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    /// Spawn the shell and start both pump directions.
    ///
    /// **`input` is created by the caller, not here.** The browser can send a
    /// keystroke the instant its data channel reports `open`, which is before
    /// this function runs — so a sender created inside `spawn` would not exist
    /// yet and those first bytes would be silently dropped. Taking the receiver
    /// as a parameter lets the caller install the sending half in the
    /// `on_data_channel` callback first, which removes the race by construction
    /// rather than by hoping the handshake is slow.
    ///
    /// `try_clone_reader()` and `take_writer()` are **blocking** `std::io`
    /// objects (spec R10), so each direction gets a dedicated `spawn_blocking`
    /// thread bridged to async by a bounded channel (ADR-11).
    pub fn spawn(
        shell: &str,
        cols: u16,
        rows: u16,
        mut input: mpsc::Receiver<Vec<u8>>,
    ) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color"); // the browser terminal is xterm.js (Week 6)
        cmd.env("LANG", "C.UTF-8");
        let child = pair.slave.spawn_command(cmd).context("spawn_command")?;

        // NOT optional: holding the slave end open keeps the PTY from reporting
        // EOF when the child exits, and the reader loop then never terminates.
        drop(pair.slave);

        // browser -> PTY
        let mut writer = pair.master.take_writer().context("take_writer")?;
        tokio::task::spawn_blocking(move || {
            let mut writer = writer;
            while let Some(bytes) = input.blocking_recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            // Dropping `writer` here sends EOF to the slave end (spec R10).
        });

        Ok(Self {
            master: pair.master,
            child,
        })
    }

    /// Start the PTY -> caller direction and return the frame receiver.
    ///
    /// **Frames are delivered in read order.** The reader thread is
    /// single-threaded and the converter `await`s on its send, so ordering is
    /// structural rather than incidental — a terminal whose output is reordered
    /// is a corrupted terminal. Returning a receiver rather than taking a
    /// callback is what makes that guarantee expressible: a callback that
    /// spawned a task per frame would let the runtime reorder them.
    ///
    /// Backpressure is the bounded queue (ADR-11): a slow consumer fills it,
    /// `blocking_send` blocks the reader thread, the kernel PTY buffer fills,
    /// and the child blocks on write. There is no unbounded queue anywhere in
    /// this path.
    pub fn start_reader(&self, terminal_id: String) -> Result<mpsc::Receiver<String>> {
        let mut reader = self.master.try_clone_reader().context("try_clone_reader")?;
        let (raw_tx, mut raw_rx) = mpsc::channel::<Vec<u8>>(64);

        tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; MAX_PTY_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // child exited, slave closed
                    Ok(n) => {
                        if raw_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break; // consumer gone
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "pty read failed");
                        break;
                    }
                }
            }
        });

        let (frame_tx, frame_rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            while let Some(bytes) = raw_rx.recv().await {
                let frame = frame_pty_output(&terminal_id, &bytes, now_ms());
                if frame_tx.send(frame).await.is_err() {
                    break; // caller dropped the receiver
                }
            }
        });

        Ok(frame_rx)
    }

    /// Drop the writer, signal, then wait **with a timeout**.
    ///
    /// `Child::wait` is blocking (spec R10) and a wedged child must not hang the
    /// agent's exit path. On timeout the failure is logged and the process exits
    /// regardless.
    pub async fn close(mut self) -> Result<()> {
        // The caller drops its input sender when the session ends; that drains
        // the writer thread, which drops `writer` and sends EOF to the slave.
        // The `kill` below is the belt-and-braces path for a shell that ignores
        // EOF (a job-control shell with a background child, for instance).
        let _ = self.child.kill(); // SIGHUP on unix, TerminateProcess on windows
        let child = self.child;

        if tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || child.wait()),
        )
        .await
        .is_err()
        {
            tracing::warn!("pty child did not exit within 2s; abandoning it");
        }

        Ok(())
    }
}

/// Epoch milliseconds. Kept in one place so the framing function stays pure.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

`master` is a field rather than a local because `try_clone_reader()` borrows it; keeping it alive for the session's lifetime is what lets `start_reader` be called after `spawn` returns. If `clippy` reports `master` as never read, that is expected — it is held for its lifetime, and `#[allow(dead_code)]` on the field with a comment saying so is the correct fix, not deleting it.

- [ ] **Step 8: Write the unit tests in `src/signal.rs` and `src/pty.rs`**

Append to `src/signal.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offer_round_trip() {
        // The wire shape is the interop contract: `type`/`data` at the top,
        // camelCase inside. Re-serializing must reproduce both.
        let raw = r#"{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":["terminal"]}}"#;
        let parsed = serde_json::from_str::<SignalMessage>(raw).unwrap();
        let SignalMessage::Offer(offer) = &parsed else {
            panic!("expected an offer, got {parsed:?}");
        };
        assert_eq!(offer.session_id, "s1");
        assert_eq!(offer.capabilities, vec!["terminal".to_string()]);

        let re = serde_json::to_string(&parsed).unwrap();
        let value: serde_json::Value = serde_json::from_str(&re).unwrap();
        assert_eq!(value["type"], "offer");
        assert_eq!(value["data"]["sessionId"], "s1");
        assert!(value["data"].get("session_id").is_none(), "must be camelCase");
    }

    #[test]
    fn rejects_malformed() {
        // Every one of these must be an Err, never a panic: the body is
        // attacker-influenced JSON.
        for raw in [
            r#"{"type":"unknown","data":{}}"#,
            r#"{"type":"signal"}"#,
            r#"{"type":"offer","data":{"sessionId":"s1"}}"#,
            r#"null"#,
            r#"[]"#,
            r#"not json at all"#,
        ] {
            assert!(parse_inbound(raw).is_err(), "should reject {raw}");
        }
    }

    #[test]
    fn backoff_sequence() {
        // Mirrors the TS sequence's factor, initial value, cap and reset rule —
        // not the fractional milliseconds (spec §5.5.4).
        let mut d = BACKOFF_INITIAL;
        let mut seen = vec![d.as_millis() as u64];
        for _ in 0..8 {
            d = next_backoff(d);
            seen.push(d.as_millis() as u64);
        }
        assert_eq!(&seen[..4], &[200, 300, 450, 675]);
        assert_eq!(*seen.last().unwrap(), 2000, "must cap at BACKOFF_MAX");

        // Reset-on-activity: the supervisor reassigns BACKOFF_INITIAL, so the
        // rule under test is that the constant is the floor.
        assert_eq!(BACKOFF_INITIAL.as_millis() as u64, 200);
    }

    #[test]
    fn keepalive_window_is_three_missed_pings() {
        // The two constants are one decision: the server treats a ping older
        // than 90 s as a dead socket (Task 5's `ONLINE_WINDOW_SECONDS`), so a
        // 30 s interval tolerates exactly two dropped pings before the agent
        // reads as offline. Pinning the ratio means changing either value
        // without the other fails here rather than in production.
        assert_eq!(PING_INTERVAL.as_secs() * 3, IDLE_TIMEOUT.as_secs());
        assert_eq!(IDLE_TIMEOUT.as_secs(), 90);
    }

    #[test]
    fn oversize_frame_is_rejected_before_parsing() {
        let huge = "x".repeat(MAX_INBOUND_FRAME_BYTES + 1);
        assert!(parse_inbound(&huge).is_err());
    }
}
```

Append to `src/pty.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_preserves_arbitrary_bytes() {
        // ADR-10: the payload is bytes, not text. 0x00, 0xFF and a truncated
        // UTF-8 sequence must all survive.
        let cases: Vec<Vec<u8>> = vec![
            b"hello".to_vec(),
            vec![0x00],
            vec![0xFF, 0xFE],
            vec![0xE2, 0x82],             // first two bytes of a 3-byte char
            vec![0x00, 0xFF, 0x80, 0x7F],
        ];

        for bytes in cases {
            let frame = frame_pty_output("t1", &bytes, 1_700_000_000_000);
            let decoded = decode_pty_input(&frame).unwrap().unwrap();
            assert_eq!(decoded, bytes, "round trip changed the bytes");
        }
    }

    #[test]
    fn chunk_boundaries() {
        // Empty, exactly the chunk, and one over (two frames from the reader).
        for len in [0usize, MAX_PTY_CHUNK, MAX_PTY_CHUNK + 1] {
            let bytes = vec![0x41u8; len];
            let frame = frame_pty_output("t1", &bytes, 0);
            assert_eq!(decode_pty_input(&frame).unwrap().unwrap().len(), len);
        }

        // A frame above MAX_FRAME_BYTES is rejected before parsing.
        let oversize = "x".repeat(MAX_FRAME_BYTES + 1);
        assert!(decode_pty_input(&oversize).is_err());
    }

    #[test]
    fn ignores_a_foreign_channel() {
        let frame = serde_json::json!({
            "type": "terminal-data",
            "channel": "desktop",
            "payload": { "terminalId": "t1", "data": "" },
            "timestamp": 0,
        })
        .to_string();
        assert_eq!(decode_pty_input(&frame).unwrap(), None);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pty_echo_round_trip() {
        // The Week 5 roadmap line "Tích hợp portable-pty" verified end to end:
        // a real shell, a real PTY, real output.
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(64);
        let session = PtySession::spawn("sh", 80, 24, input_rx).unwrap();

        // `echo hello` then exit. The reader sees EOF when the child exits and
        // the slave is closed — which is exactly why `drop(pair.slave)` matters.
        let mut cmd_bytes = b"echo hello\n".to_vec();
        cmd_bytes.extend_from_slice(b"exit\n");
        // `.send().await`, NOT `blocking_send`: tokio's `blocking_send` panics
        // when called from inside a runtime, and a `#[tokio::test]` body is one.
        input_tx.send(cmd_bytes).await.expect("writer thread");

        let mut frames = session.start_reader("t1".to_string()).unwrap();

        // A 10 s watchdog: a regression in `drop(pair.slave)` hangs the reader
        // forever, and a hung test must fail with a message, not block CI. Do
        // not replace this with an unbounded `recv()`.
        let collected = tokio::time::timeout(Duration::from_secs(10), async {
            let mut out: Vec<u8> = Vec::new();
            while let Some(frame) = frames.recv().await {
                if let Ok(Some(bytes)) = decode_pty_input(&frame) {
                    out.extend_from_slice(&bytes);
                    if String::from_utf8_lossy(&out).contains("hello") {
                        return out;
                    }
                }
            }
            out
        })
        .await
        .expect("PTY echo did not arrive within 10s");

        // `from_utf8_lossy` on the assertion only: the pump never assumes
        // UTF-8, but `echo hello` is ASCII and the assertion should be readable.
        assert!(
            String::from_utf8_lossy(&collected).contains("hello"),
            "expected echo output, got {:?}",
            String::from_utf8_lossy(&collected),
        );
    }
}
```

The `10 s` deadline in `pty_echo_round_trip` is the watchdog spec §5.10.4 requires: a regression in `drop(pair.slave)` hangs the reader forever, and a hung test must fail with a message rather than block CI. Do not replace it with an unbounded `recv()`.

- [ ] **Step 9: Write `src/main.rs` — CLI, pipeline, teardown**

```rust
//! `remote-agent` — CLI, startup pipeline, Ctrl-C/SIGTERM teardown.
//!
//! Four flat modules, no `lib.rs`: this is a binary crate, and the unit tests
//! live in `#[cfg(test)] mod tests` inside each module. A `lib.rs` would exist
//! only to let integration tests import the modules, and the PTY echo test
//! needs the real binary path anyway (spec §5.4.1).

mod pty;
mod rtc;
mod signal;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::Parser;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::RTCPeerConnection;

use crate::signal::SignalClient;

#[derive(Parser, Debug)]
#[command(name = "remote-agent", version, about = "Ponta remote desktop agent")]
struct Cli {
    /// Agent id registered with the signaling service.
    #[arg(long, env = "AGENT_ID")]
    agent_id: String,

    /// Signaling WebSocket URL.
    #[arg(long, env = "AGENT_SERVER", default_value = "ws://localhost:8787/api/ws/agent")]
    server: String,

    /// Shell to spawn. Defaults to $SHELL (unix) or cmd.exe (windows).
    #[arg(long, env = "AGENT_SHELL")]
    shell: Option<String>,

    /// Agent credential (ag_...). Prefer AGENT_CREDENTIAL: argv is visible via
    /// ps (ADR-13).
    #[arg(long, env = "AGENT_CREDENTIAL")]
    credential: Option<String>,

    /// STUN server; an empty string disables ICE servers entirely (loopback).
    #[arg(long, env = "STUN_SERVER", default_value = "stun:stun.l.google.com:19302")]
    stun: String,

    /// Terminal size for the initial PTY.
    #[arg(long, default_value_t = 80)]
    cols: u16,
    #[arg(long, default_value_t = 24)]
    rows: u16,
}

/// `--credential-or-env` in the roadmap is realised as clap's
/// `env = "AGENT_CREDENTIAL"` on `--credential`: clap resolves flag -> env ->
/// default in that order, which is exactly ADR-13's rule, with one struct field
/// instead of two.
///
/// If neither is present the process exits non-zero with a message naming both
/// sources — **never a default**. A default credential would be a credential
/// that authenticates nothing and a failure that reads as a server problem.
fn resolve_credential(cli: &Cli) -> Result<String> {
    match &cli.credential {
        Some(c) if !c.trim().is_empty() => Ok(c.clone()),
        _ => bail!(
            "no agent credential: pass --credential or set AGENT_CREDENTIAL \
             (the value is issued once by POST /api/agents and cannot be recovered)"
        ),
    }
}

/// `--shell` -> `AGENT_SHELL` -> platform default.
///
/// The path is passed through to `CommandBuilder::new` unmodified — no shell
/// interpolation of user input, because the value is the executable, not a
/// command line.
fn resolve_shell(cli: &Cli) -> Result<String> {
    if let Some(s) = &cli.shell {
        return Ok(s.clone());
    }
    #[cfg(unix)]
    {
        Ok(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
    #[cfg(windows)]
    {
        Ok("cmd.exe".into())
    }
}

/// `Ctrl-C` **and** `SIGTERM`.
///
/// `SIGTERM` matters as much as `Ctrl-C`: a systemd unit or a container stop
/// sends `SIGTERM`, and an agent that ignores it leaves a shell running on the
/// host after the service is "stopped" (§5.8.3).
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("ctrl-c handler")
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let credential = resolve_credential(&cli)?;
    let shell = resolve_shell(&cli)?;

    tracing::info!(server = %cli.server, shell = %shell, "starting remote-agent");

    run_with_reconnect(&cli, &credential, &shell).await
}

/// Connect, serve, and reconnect with exponential backoff until told to stop.
///
/// The agent is a long-lived daemon, so a dropped socket is an ordinary event:
/// a laptop that slept, a Worker isolate recycled, a flaky link. Exiting on the
/// first disconnect would mean a user has to re-run the agent by hand after
/// every hiccup, which is the behaviour §5.5.5 exists to prevent.
///
/// The backoff resets on a successful connect rather than on a successful
/// session, because the failure being backed off from is the handshake itself —
/// a server that is down would otherwise be hammered at the maximum rate.
async fn run_with_reconnect(cli: &Cli, credential: &str, shell: &str) -> Result<()> {
    let mut delay = signal::BACKOFF_INITIAL;

    loop {
        match SignalClient::connect(&cli.server, credential, &cli.agent_id).await {
            Ok((client, inbound_rx, outbound_tx)) => {
                tracing::info!("connected to the signaling server");
                delay = signal::BACKOFF_INITIAL;

                let sessions = supervise_sessions(inbound_rx, outbound_tx, cli, shell);
                tokio::select! {
                    // The socket ended. A clean close and a fatal error both
                    // mean "reconnect"; only the log line differs.
                    result = client.run() => {
                        if let Err(e) = result {
                            tracing::warn!(error = %e, "signaling socket ended with an error");
                        }
                    }
                    // The supervisor only returns on a fatal internal error.
                    result = sessions => result?,
                    _ = shutdown_signal() => {
                        tracing::info!("shutdown signal received");
                        return Ok(());                              // ADR-12 teardown
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not connect to the signaling server"),
        }

        tracing::info!(delay_ms = delay.as_millis() as u64, "reconnecting");
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown_signal() => {
                tracing::info!("shutdown signal received while backing off");
                return Ok(());
            }
        }
        delay = signal::next_backoff(delay);
    }
}

/// One inbound event, as `supervise_sessions` sees it.
///
/// The split matters: a candidate for the live session must reach the live
/// session, and a candidate for anything else must not. Routing by
/// `session_id` is what makes that a property of the type rather than of a
/// match arm someone can forget to write.
enum Inbound {
    Offer(signal::SignalOffer),
    Candidate(signal::IceCandidateSignal),
    /// An answer or a candidate for a session this agent is not running.
    /// Dropped, but counted: with one session per agent (ADR-14) a steady
    /// stream of these is the signature of a misconfigured client.
    Foreign,
}

fn classify(message: signal::SignalMessage) -> Inbound {
    use signal::SignalMessage;
    match message {
        SignalMessage::Offer(offer) => Inbound::Offer(offer),
        SignalMessage::IceCandidate(candidate) => Inbound::Candidate(candidate),
        SignalMessage::Answer(_) => Inbound::Foreign,
    }
}

/// The ADR-14 loop: take an `offer`; if a session is active, answer
/// `approved: false` and drop it; otherwise run one session to completion.
///
/// **Candidates are routed here, not in `run_one_session`.** The channel is a
/// single stream, so exactly one task can own it. `run_one_session` therefore
/// receives a fresh per-session channel that this loop forwards into, which
/// also means the loop can drop a candidate addressed to a session that is not
/// live without the session ever seeing it.
async fn supervise_sessions(
    mut inbound: tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: tokio::sync::mpsc::Sender<signal::SignalMessage>,
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let mut active: Option<String> = None;

    // A `loop`/`let ... else`, NOT `while let Some(..) = inbound.recv().await`.
    // In edition 2021 the scrutinee's temporaries live for the whole `while let`
    // body, so the `&mut inbound` the future borrows would still be held when
    // `run_one_session` asks for it again — a borrow error, not a warning.
    loop {
        let Some(message) = inbound.recv().await else {
            // The socket closed. Nothing to supervise any more.
            return Ok(());
        };

        match classify(message) {
            Inbound::Foreign => {
                tracing::debug!("ignoring an inbound frame for an inactive session");
            }

            Inbound::Candidate(candidate) => {
                // Reached only while no session is running: `run_one_session`
                // borrows `inbound` for the whole session, so a live session
                // drains its own candidates. A candidate here belongs to a
                // session that has ended, and applying it to whatever
                // connection exists next is how a stale peer poisons a fresh
                // one. Dropped, and counted.
                tracing::debug!(
                    session_id = %candidate.session_id,
                    "dropping a candidate for an inactive session",
                );
            }

            Inbound::Offer(offer) => {
                if active.is_some() {
                    // ADR-14: refuse, but with a real SDP — `POST
                    // /api/signal/answer` rejects an empty one (spec R19).
                    tracing::warn!(
                        session_id = %offer.session_id,
                        "refusing a second concurrent session (ADR-14)",
                    );
                    let peer = rtc::build_peer(&cli.stun).await?;
                    rtc::refuse_offer(&peer, &offer, &outbound).await?;
                    let _ = peer.close().await;
                    continue;
                }

                active = Some(offer.session_id.clone());
                tracing::info!(session_id = %offer.session_id, "session starting");

                if let Err(e) = run_one_session(&offer, &mut inbound, &outbound, cli, shell).await {
                    tracing::warn!(
                        error = %e,
                        session_id = %offer.session_id,
                        "session ended with an error",
                    );
                }

                active = None;
                tracing::info!(session_id = %offer.session_id, "session ended");
            }
        }
    }
}

/// One session: answer, wait for the `terminal` channel, spawn the PTY, pump.
///
/// Borrows `inbound` for the session's whole lifetime, so every candidate the
/// peer trickles lands here rather than in the idle loop above. That is the
/// point: the buffer below must be the same object that receives them.
async fn run_one_session(
    offer: &signal::SignalOffer,
    inbound: &mut tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: &tokio::sync::mpsc::Sender<signal::SignalMessage>,
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let peer = rtc::build_peer(&cli.stun).await?;

    // Register the outbound forwarder BEFORE the local description exists:
    // gathering starts the moment `set_local_description` runs, and a handler
    // registered after it misses the host candidates emitted in that tick.
    // Without this the agent never sends a candidate and ICE never completes —
    // the browser alone cannot form a pair.
    rtc::forward_candidates(&peer, offer.session_id.clone(), outbound.clone());

    // Candidates that arrive before the remote description is set (spec R3).
    let mut pending: Vec<RTCIceCandidateInit> = Vec::new();

    rtc::answer_offer(&peer, offer, outbound).await?;

    // Apply whatever the browser trickled while the answer was being built.
    // `answer_offer` returns as soon as the answer is on the wire, and the
    // browser starts trickling the moment it reads it, so this is a real race
    // rather than a theoretical one.
    rtc::flush_pending_candidates(&peer, &mut pending).await?;

    if !offer.capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) {
        tracing::warn!(session_id = %offer.session_id, "refused: no terminal capability");
        let _ = peer.close().await;
        return Ok(());
    }

    // The input channel is created HERE, before the callback that will fill it.
    // A keystroke can arrive the instant the browser's channel reports `open` —
    // which is before `PtySession::spawn` runs — so the sending half must
    // already exist and be reachable from the callback. Creating it inside
    // `spawn` instead is a silent first-keystroke loss, not a visible error.
    let (pty_in_tx, pty_in_rx) = mpsc::channel::<Vec<u8>>(64);

    let channel: Arc<OnceLock<Arc<RTCDataChannel>>> = Arc::new(OnceLock::new());
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(std::sync::Mutex::new(Some(open_tx)));

    let channel_for_cb = channel.clone();
    let pty_in_for_cb = pty_in_tx.clone();
    let open_tx_for_cb = open_tx.clone();

    peer.on_data_channel(Box::new(move |dc| {
        let channel = channel_for_cb.clone();
        let pty_in = pty_in_for_cb.clone();
        let open_tx = open_tx_for_cb.clone();

        Box::pin(async move {
            // ADR-09: the exact label, and nothing else. An unexpected channel
            // is closed rather than ignored — leaving it half-open would let a
            // peer keep a second channel alive past its welcome.
            if dc.label() != rtc::TERMINAL_LABEL {
                tracing::warn!(label = dc.label(), "refusing unexpected channel");
                let _ = dc.close().await;
                return;
            }

            // browser -> PTY. `decode_pty_input` rejects an oversize frame
            // before parsing. A decode failure is logged and dropped, never
            // fatal: the terminal stream has no retransmission, and one corrupt
            // frame must not kill the session.
            let pty_in_msg = pty_in.clone();
            dc.on_message(Box::new(move |msg| {
                let pty_in = pty_in_msg.clone();
                Box::pin(async move {
                    let Ok(text) = std::str::from_utf8(&msg.data) else {
                        tracing::debug!("ignoring a non-UTF-8 frame");
                        return;
                    };
                    match pty::decode_pty_input(text) {
                        Ok(Some(bytes)) => {
                            // Bounded send: the writer thread's queue is what
                            // applies backpressure to a peer that types faster
                            // than the shell can read.
                            if pty_in.send(bytes).await.is_err() {
                                tracing::debug!("pty writer is gone");
                            }
                        }
                        Ok(None) => {} // not a terminal-data frame on `terminal`
                        Err(e) => tracing::debug!(error = %e, "dropping malformed frame"),
                    }
                })
            }));

            // `on_open` is `FnOnce` (spec R8), so the sender is taken out of the
            // `Mutex` exactly once — which is right, because ADR-09 allows one
            // channel.
            let channel_open = channel.clone();
            dc.on_open(Box::new(move || {
                let _ = channel_open.set(dc.clone());
                if let Some(tx) = open_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                Box::pin(async {})
            }));
        })
    }));

    // The handshake: wait for the channel to open, draining candidates the
    // whole time. Candidates must keep flowing here — a peer that trickles
    // slowly would otherwise stall behind this wait, because nothing else is
    // reading `inbound` while it runs.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::select! {
            // Candidates first: they are what the handshake is waiting on, and
            // `biased` keeps the order deterministic rather than random.
            biased;

            candidate = inbound.recv() => {
                match candidate {
                    Some(message) => apply_if_candidate(&peer, &mut pending, message).await?,
                    None => anyhow::bail!(
                        "the signaling socket closed before the terminal channel opened"
                    ),
                }
            }

            result = &mut open_rx => {
                result.context("the terminal channel was closed before it opened")?;
                break;
            }

            _ = tokio::time::sleep_until(deadline) => {
                anyhow::bail!("the terminal channel did not open within 20s");
            }
        }
    }

    let session = pty::PtySession::spawn(shell, cli.cols, cli.rows, pty_in_rx)?;
    let mut frames = session.start_reader(offer.session_id.clone())?;

    let dc = channel
        .get()
        .context("the terminal channel vanished after opening")?
        .clone();

    // PTY -> browser. One sequential loop, not a task per frame: the order of a
    // terminal's output is part of its meaning, and a task per frame lets the
    // runtime reorder it. `send_text` is the only send method used — the frame
    // is JSON text carrying base64, never a binary frame (ADR-10).
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if let Err(e) = dc.send_text(frame).await {
                // A closed channel is an ordinary end-of-session condition, not
                // an error worth tearing the process down for.
                tracing::debug!(error = %e, "data channel send failed");
                break;
            }
        }
    });

    // The pump ending means the child exited and the slave closed — the normal
    // terminator. Candidates keep being applied until then, which is what lets
    // a relay candidate arrive late and still be used. The 1 h cap exists
    // because a session whose peer vanished silently would otherwise linger
    // until the process is killed.
    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            _ = &mut pump => break "the pty pump ended",
            message = inbound.recv() => {
                match message {
                    Some(message) => apply_if_candidate(&peer, &mut pending, message).await?,
                    None => break "the signaling socket closed",
                }
            }
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "session loop finished");

    // Dropping the input sender is what ends the writer thread (and with it the
    // shell's stdin), so it must happen before `close` waits on the child.
    drop(pty_in_tx);
    session.close().await?;
    let _ = peer.close().await;
    Ok(())
}

/// Apply an inbound message if it is a candidate; ignore anything else.
///
/// An `offer` here would be a second offer for the session already running —
/// ADR-14 refuses those at the supervisor, and reaching this point with one
/// would mean the routing above is wrong, so it is logged rather than silently
/// dropped.
async fn apply_if_candidate(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
    message: signal::SignalMessage,
) -> Result<()> {
    match message {
        signal::SignalMessage::IceCandidate(candidate) => {
            let applied = rtc::apply_candidate(peer, pending, candidate).await?;
            tracing::trace!(applied, "inbound candidate");
        }
        other => tracing::debug!(?other, "ignoring a non-candidate frame during a session"),
    }
    Ok(())
}
```

The imports `run_one_session` needs beyond what Step 9's header already lists: `std::sync::{Arc, OnceLock}`, `std::time::Duration`, `webrtc::data_channel::RTCDataChannel` and `webrtc::ice_transport::ice_candidate::RTCIceCandidateInit`. They are already in Step 9's `main.rs` header above — `Arc<OnceLock<Arc<RTCDataChannel>>>` is unreadable with fully-qualified paths inline.

**Why the handshake is a `select!` loop rather than a bare `timeout`.** The first version of this step awaited the channel with nothing reading `inbound`, so a browser that trickled its candidates during the DTLS handshake would have had them queue until the channel opened — and a candidate sent before the answer is read would arrive at a connection that had already stopped checking. Draining candidates in the same loop that waits for the channel removes the ordering assumption entirely.

- [ ] **Step 10: Run the Rust suite**

Run: `cd apps/agent && cargo test`
Expected: **11 test functions** across the three modules, covering the five R1-R5 cases the spec names — `rtc.rs` (2): `candidate_index_narrowing`, `candidate_wire_round_trip`; `signal.rs` (5): `offer_round_trip`, `rejects_malformed`, `backoff_sequence`, `keepalive_window_is_three_missed_pings`, `oversize_frame_is_rejected_before_parsing`; `pty.rs` (4): `frame_round_trip_preserves_arbitrary_bytes`, `chunk_boundaries`, `ignores_a_foreign_channel`, `pty_echo_round_trip`. The spec's "~5" is a case count, not a function count — `frame_round_trip_preserves_arbitrary_bytes` alone covers four of §5.10.1's byte-level cases.

**On Windows you will see `10 passed, 1 filtered out`, and that is correct.** `pty_echo_round_trip` carries `#[cfg(unix)]` because it spawns a real `sh` through a real PTY — it compiles and runs on Linux and macOS, and is compiled out entirely on Windows. CI is `ubuntu-latest`, so the `rust` job sees all 11. If you are iterating locally on Windows, `cargo test -- --list` shows 11 names and the run reports 10; do not read the gap as a missing test or "fix" it by removing the gate. The other three `pty.rs` tests are pure byte-level and platform-independent.

**This step is not covered by the JS gate.** `pnpm test` reaches `cargo test` through `apps/agent`'s `test` script (Step 12), but the plan's 164 JS tests are counted by Vitest and say nothing about the Rust suite — a green `pnpm test` with a failing `cargo test` is possible if Turbo skips the uncached task. Run `cargo test` directly here, and again in Step 13.

If `pty_echo_round_trip` fails with empty output, check `drop(pair.slave)` first — that is the single most common cause and the reason the spec calls it out.

- [ ] **Step 11: Lint and format**

Run:
```bash
cd apps/agent && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```
Expected: exit 0. Fix every warning rather than allowing it; `-D warnings` is the agent's equivalent of ESLint's `recommended` set, and warnings that are allowed accumulate.

The one expected exception is the `master` field in `PtySession` (held for its lifetime, never read). Add `#[allow(dead_code)]` on that field with a comment naming the reason — do not delete the field, which would drop the PTY master and break `try_clone_reader`.

- [ ] **Step 12: Update `apps/agent/package.json`**

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

`cargo check` is the typecheck step (it type-checks without codegen), which keeps the second of the three passes cheap. Effect to state plainly: `turbo run test` — and therefore `pnpm test` — now also invokes the Rust suite, so the JS total and the Rust total are reported by different runners in the same gate. The JS counts in this plan are unaffected.

- [ ] **Step 13: Verify the repository gate still passes**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected: exit 0 with **164 passing JS tests** and the Rust suite green. Prettier does not parse `.rs` and does not error on it, `eslint` inside `apps/agent` matches no `.ts`/`.vue` files and lints nothing, and `target/` is already in both `.gitignore` and `.prettierignore` — so the Rust sources add no ignore churn (spec R21, verified there rather than assumed).

If `pnpm format:check` fails, the cause is almost certainly the generated `Cargo.lock` or a `Cargo.toml` Prettier wants to reflow — check `git status` for which file, and re-run with `pnpm format`.

- [ ] **Step 14: Commit**

```bash
git add apps/agent/Cargo.toml apps/agent/Cargo.lock apps/agent/rust-toolchain.toml \
        apps/agent/.env.example apps/agent/package.json apps/agent/src/main.rs \
        apps/agent/src/signal.rs apps/agent/src/rtc.rs apps/agent/src/pty.rs
git commit -m "feat(agent): add Rust remote-agent with WS signaling, WebRTC answerer, and PTY bridge"
```

Confirm `Cargo.lock` is in the commit (`git show --stat HEAD | grep Cargo.lock`) and that `target/` is not (`git show --stat HEAD | grep -c target` → 0).

---

### Task 7: The Cross-Language E2E Harness

Task 6 shipped a Rust binary that compiles and whose unit tests pass. This task is the week's done-criterion (spec §7.3): the same wire contract, implemented twice by two languages, meeting at a real DTLS/SCTP connection with real PTY bytes crossing it. A contract that only one side implements is a contract that is only *assumed* to work — this is where that assumption is tested.

**Files:**
- Create: `packages/webrtc-core/vitest.e2e.config.ts`
- Create: `packages/webrtc-core/test/e2e/terminal.e2e.test.ts`
- Modify: `packages/webrtc-core/vitest.config.ts` (add `exclude`)
- Modify: `packages/webrtc-core/package.json` (add `test:e2e`)
- Modify: `docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md` (the deviation rows and the count in Step 1)

**Interfaces:**
- Consumes: `PeerConnection` (`packages/webrtc-core/src/connection.ts:17`), `WeriftAdapter` (`src/adapters/werift.ts:67`), `RESTPollingTransport` (`src/transport.ts:26`), `DataChannelManager` (`src/data-channel.ts:4`); `DataChannelMessage<T>`/`TerminalDataMessage` from `@remote/shared`; the Worker's REST surface (`/api/auth/register`, `/api/agents`, `/api/sessions`, `/api/signal/*`) and its WS route (`/api/ws/agent`, Task 4); the `remote-agent` binary (Task 6).
- Produces: `vitest.e2e.config.ts` (the Layer-3 runner Task 8's `e2e` job invokes) and a `test:e2e` script.

**Three spec statements this task corrects.** All three are recorded as deviation rows in Step 1, because a reader following §7.3 verbatim would write a harness that cannot work:

- **§7.3 step 2 says `POST /api/agents` is used "to obtain `credential = ag_<secret>`".** After Task 3 that route returns `{ agent, credential }` — the credential is nested, and `agent` is a `PublicAgent` with `credentialHash` absent. A harness that reads `body.credential` off a bare-agent shape gets `undefined` and then sends `Bearer undefined`, which the Worker answers `401`. (Verified against the running Worker: today's route returns a bare agent with no `credential` key at all, so the pre-Task-3 shape the spec describes is exactly the shape a naive harness would assume.)
- **§7.3 step 3 passes `--server ws://127.0.0.1:8787`.** That is an origin, not the route. Task 4 mounts the socket at `app.route('/api/ws', ws)` and the route is `router.get('/agent')`, so the reachable URL is `ws://127.0.0.1:8787/api/ws/agent` (deviation D-10). The spec's value 404s at the handshake.
- **§7.3 step 9 says teardown kills "the agent child process".** The agent *is* the process. There is no child of it to kill: `remote-agent` is spawned by the harness and torn down with `SIGKILL` on the handle the harness itself holds. "The agent child process" presumes a wrapper script this repository does not have.

- [ ] **Step 1: Confirm the three deviation rows are recorded**

D-11, D-12 and D-13 are already in the deviations table at the top of this plan, and the sentence above it reads "Fifteen places". This step is the checkpoint that they are there before the code below depends on them — the three rows are this task's justification for the three places it departs from §7.3, and a reader who finds the harness doing something §7.3 does not should be able to find the reason in one jump:

```bash
grep -c '^| D-1[123] ' docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
```

Expected: `3`.

The table's Layer-3 row already reads **2** (`vitest.e2e.config.ts`), which is the count this task's two tests deliver, and line 30 already states that the E2E total is reported separately from the 164 JS tests. Neither needs editing; this step verifies rather than writes.

- [ ] **Step 2: Exclude `test/e2e/**` from the default config**

`packages/webrtc-core/vitest.config.ts` currently reads:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

Replace it with:

```typescript
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The E2E harness needs a running Worker and a built Rust binary, so it
    // must not run in the default suite: `pnpm test` has neither, and a
    // failure here would be reported as a `webrtc-core` regression. It runs
    // under `vitest.e2e.config.ts` (Task 8's `e2e` job).
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
});
```

Both `configDefaults` and `defineConfig` are exported from `vitest/config` in 5.0.1 (verified in `vitest@5.0.1/dist/config.d.ts`). Spread `configDefaults.exclude` rather than writing `['test/e2e/**']`: the default is `["**/node_modules/**", "**/.git/**"]` (verified in `vitest@5.0.1/dist/chunks/defaults.D2ip7f-X.js`), and replacing it wholesale would make the default suite try to collect `node_modules`.

- [ ] **Step 3: Write `vitest.e2e.config.ts`**

Create `packages/webrtc-core/vitest.e2e.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

/**
 * Layer 3 — the cross-language E2E suite.
 *
 * Deliberately a SEPARATE config rather than an `include` glob in the default
 * one: this suite spawns a Worker and a Rust binary, so it needs ~30 s of
 * setup the unit suite must not pay, and a failure here is a different
 * diagnosis than a failure there. `pnpm test` never runs it; Task 8's `e2e`
 * CI job does.
 *
 * `testTimeout` is generous because the harness waits on a real DTLS
 * handshake. Every individual wait inside the test is separately bounded, so a
 * hang fails with a specific message rather than this global number.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file, one Worker, one agent. `fileParallelism` stops two files from
    // racing over port 8787 and the shared local D1 file; `sequence.concurrent`
    // is the separate knob that stops two tests within a file from doing the
    // same. Both are set because they are not the same option — with one file
    // today, only the second is load-bearing, and the first is here so adding
    // a second file later cannot silently reintroduce a port collision.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
```

- [ ] **Step 4: Add the `test:e2e` script**

In `packages/webrtc-core/package.json`, add to `scripts`:

```json
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
```

The full `scripts` block after this step:

```json
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
  },
```

`--passWithNoTests` is deliberately **not** carried over: the E2E config has a real `include`, and a suite that collects zero tests is a harness that silently stopped testing. If `test/e2e/` is empty, `pnpm test:e2e` must fail, not pass.

- [ ] **Step 5: Write the harness scaffolding**

Create `packages/webrtc-core/test/e2e/terminal.e2e.test.ts`. Start with the imports, constants and the process helpers:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type { DataChannelMessage, TerminalDataMessage } from '@remote/shared';

/**
 * Layer 3: the whole week in one file — a Rust agent, a TypeScript offerer, a
 * real Worker, and real PTY bytes over a real DTLS/SCTP connection.
 *
 * Linux-only. The Rust binary is built for the host, the Worker binds a local
 * port, and `iceServers: []` means loopback host candidates must be enough. On
 * any other platform the suite is SKIPPED, not failed (spec §7.3).
 */
const isLinux = process.platform === 'linux';

/**
 * `import.meta.dirname` is Node >= 20.11 and typed by `@types/node` 24.13.6
 * (`module.d.ts`), which is what `tsc --noEmit` uses here. `__dirname` also
 * resolves at runtime under vitest 5 (both were checked), but the file is ESM
 * and this is the form that does not depend on the transform injecting a CJS
 * shim.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const AGENT_BIN = join(REPO_ROOT, 'apps', 'agent', 'target', 'debug', 'remote-agent');
const SIGNALING_DIR = join(REPO_ROOT, 'workers', 'signaling');
const PORT = 8787;

/**
 * `127.0.0.1`, not `localhost`. `wrangler dev` binds loopback IPv4 and prints
 * `Ready on http://127.0.0.1:8787`; on a host where `localhost` resolves to
 * `::1` first, the name-based URL costs a failed connect attempt per request.
 */
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/ws/agent`;

/** Bounded wait for the Worker to answer `GET /health`. */
async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `wrangler dev did not answer GET /health within ${timeoutMs}ms (last: ${lastError})`,
  );
}

/**
 * Spawn a child and buffer its output.
 *
 * `stdin` is `'ignore'` on purpose, and that is load-bearing for the migration
 * child: `wrangler d1 migrations apply` prompts "About to apply N migration(s)
 * … continue?" and only skips the prompt when stdin is not a terminal. An
 * ignored stdin makes it non-interactive, so the prompt auto-confirms. A piped
 * stdin that is never written would hang the harness.
 *
 * Both output streams are buffered rather than inherited: a failing test must
 * be able to print why the child died, and inheriting would interleave it with
 * the reporter.
 */
function spawnLogged(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): { child: ChildProcess; output: () => string } {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];
  child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
  child.stderr?.on('data', (c: Buffer) => chunks.push(c.toString()));
  return { child, output: () => chunks.join('') };
}

/** Kill a child and wait for it to actually exit, so no process leaks. */
async function killAndWait(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
    // A child that exited between the guard above and this listener would
    // otherwise leave the promise pending forever — turning a passing test into
    // a hung run.
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
  });
}
```

- [ ] **Step 6: Add the setup, teardown and seeding helpers**

Continue the same file:

```typescript
let wrangler: ChildProcess | null = null;
let wranglerOutput: () => string = () => '';
let tempDir = '';

/**
 * Every agent process this file starts, killed in `afterAll`.
 *
 * A test-local `finally` would be the tighter scope, but the agents outlive
 * their test's assertions by design (the PTY keeps running until the socket
 * closes), and a list here means a test that throws before its `finally` is
 * still cleaned up.
 */
const agents: Array<{ child: ChildProcess; output: () => string }> = [];

/** The shape `POST /api/agents` returns after Task 3 (deviation D-11). */
interface AgentCreated {
  agent: { id: string; isOnline: boolean };
  credential: string;
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} -> HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

describe.skipIf(!isLinux)('cross-language terminal E2E', () => {
  beforeAll(async () => {
    // 1. A private persistence dir, so the harness never reads or writes the
    //    developer's own `.wrangler/state` and two runs cannot collide.
    //    `--persist-to` is resolved with `path.resolve(cwd, persistTo)`, so an
    //    absolute path is what makes this independent of where vitest ran.
    tempDir = mkdtempSync(join(tmpdir(), 'ponta-e2e-'));

    // 2. Migrate the SAME sqlite file `wrangler dev` will read. `wrangler dev`
    //    does not apply migrations, and both commands resolve their persistence
    //    path through the same helper, so passing the identical `--persist-to`
    //    to each is what keeps them pointed at one file.
    const migrate = spawnLogged(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'migrations',
        'apply',
        'remote-access',
        '--local',
        '--persist-to',
        tempDir,
      ],
      { cwd: SIGNALING_DIR },
    );
    const migrateExit = await new Promise<number | null>((r) =>
      migrate.child.once('exit', r),
    );
    if (migrateExit !== 0) {
      throw new Error(`migrations apply exited ${migrateExit}:\n${migrate.output()}`);
    }

    // 3. Start the Worker on a fixed port. A fixed port rather than a probed
    //    free one, because Task 6's `AGENT_SERVER` default and the harness's
    //    `--server` flag have to agree on the same number.
    const dev = spawnLogged(
      'pnpm',
      ['exec', 'wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', tempDir],
      { cwd: SIGNALING_DIR },
    );
    wrangler = dev.child;
    wranglerOutput = dev.output;

    // Readiness is polled rather than read from the log. `wrangler dev` does
    // print `[wrangler:info] Ready on http://127.0.0.1:8787`, but that line's
    // format is wrangler's to change and it says the HTTP listener is up, not
    // that the Worker's routes answer. A 200 from `/health` says both.
    await waitForHealth();
  }, 120_000);

  afterAll(async () => {
    // Order matters: the agents first, so their socket closes do not race the
    // Worker's shutdown, then the Worker, then the temp dir.
    for (const entry of agents) {
      await killAndWait(entry.child);
    }
    agents.length = 0;
    await killAndWait(wrangler);
    wrangler = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  }, 60_000);

  /** Register a user, an agent and a session; return everything a test needs. */
  async function seed(): Promise<{
    token: string;
    agentId: string;
    credential: string;
    sessionId: string;
  }> {
    // A unique suffix, not a fixed name: the local D1 file is not wiped between
    // runs and `users.username` is UNIQUE, so a constant name makes the second
    // `pnpm test:e2e` fail with `USERNAME_EXISTS`. Readable prefix included so a
    // failed run is diagnosable.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const auth = await postJson<{ token: string }>('/api/auth/register', {
      username: `e2e_${suffix}`,
      password: 'Password123!',
      publicKey: `pk_e2e_${suffix}`,
    });

    // `capabilities: ['terminal']` is what the agent's offer later has to match
    // (Task 6 refuses an offer that does not name `terminal`).
    const created = await postJson<AgentCreated>(
      '/api/agents',
      {
        id: `agent_e2e_${suffix}`,
        publicKey: `pk_agent_${suffix}`,
        capabilities: ['terminal'],
      },
      auth.token,
    );

    const session = await postJson<{ id: string }>(
      '/api/sessions',
      { agentId: created.agent.id },
      auth.token,
    );

    return {
      token: auth.token,
      agentId: created.agent.id,
      credential: created.credential,
      sessionId: session.id,
    };
  }

  /** Spawn the real binary (Task 6) and register it for teardown. */
  function spawnAgent(agentId: string, credential: string): void {
    const spawned = spawnLogged(
      AGENT_BIN,
      [
        '--agent-id',
        agentId,
        // The full route path (D-12). `--stun ''` disables ICE servers so the
        // only candidates are loopback host candidates — the harness must not
        // reach the network beyond 127.0.0.1, and Task 6's default is a public
        // STUN server.
        '--server',
        WS_URL,
        '--credential',
        credential,
        '--stun',
        '',
      ],
      { cwd: REPO_ROOT, env: { RUST_LOG: 'info' } },
    );
    agents.push(spawned);
  }

  /** Poll `GET /api/agents` until the agent's socket has registered. */
  async function waitForAgentOnline(
    token: string,
    agentId: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = 'never fetched';
    while (Date.now() < deadline) {
      const res = await fetch(`${BASE_URL}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const list = (await res.json()) as Array<{ id: string; isOnline: boolean }>;
        const found = list.find((a) => a.id === agentId);
        lastSeen = found ? `isOnline=${found.isOnline}` : 'agent absent';
        if (found?.isOnline) return;
      }
      await delay(250);
    }
    const output = agents.map((a) => a.output()).join('\n');
    throw new Error(
      `agent ${agentId} never reported online (${lastSeen}).\n` +
        `--- agent output ---\n${output}`,
    );
  }

  /**
   * Connect an offerer and wait for the `terminal` channel.
   *
   * The timeout is passed explicitly: `waitForChannel`'s default is 10000 ms
   * (`connection.ts:93`), and a real DTLS handshake against a binary that has
   * just started is worth more than that on a loaded CI runner.
   */
  async function connectTerminal(
    sessionId: string,
    token: string,
  ): Promise<{ offerer: PeerConnection; frames: Array<DataChannelMessage<TerminalDataMessage>> }> {
    const offerer = new PeerConnection(
      new WeriftAdapter({ iceServers: [] }),
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
      { role: 'offerer', channelLabels: ['terminal'] },
    );

    // The listener is attached BEFORE `start()`, so a frame that arrives while
    // the channel is still opening has somewhere to go.
    const frames: Array<DataChannelMessage<TerminalDataMessage>> = [];
    offerer.dataChannels.onMessage<TerminalDataMessage>('terminal', (msg) => {
      frames.push(msg);
    });

    await offerer.start();
    const channel = await offerer.waitForChannel('terminal', 20_000);
    expect(channel.readyState).toBe('open');

    return { offerer, frames };
  }

  /** Decode a frame's `payload.data` back to raw bytes. */
  function frameBytes(frame: DataChannelMessage<TerminalDataMessage>): Buffer {
    return Buffer.from(frame.payload.data, 'base64');
  }

  /** Send one `terminal-data` frame carrying `text` as UTF-8. */
  function sendKeystrokes(
    offerer: PeerConnection,
    sessionId: string,
    text: string,
  ): void {
    offerer.dataChannels.sendJson<TerminalDataMessage>('terminal', 'terminal-data', {
      terminalId: sessionId,
      data: Buffer.from(text, 'utf8').toString('base64'),
    });
  }
```

- [ ] **Step 7: Write the first test — the handshake and a PTY round trip**

Add inside the `describe` block:

```typescript
  it('runs real PTY output over a real DTLS/SCTP connection', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);

    // Ordered, not raced (spec §7.3 step 5): the offer must not be posted until
    // the socket is registered, or the push lands on an empty map and the
    // agent never sees it.
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      // `sh` echoes the command back and then runs it, so "hello" appears in
      // the output either way; both arrive as separate frames.
      sendKeystrokes(offerer, sessionId, 'echo hello\n');

      const deadline = Date.now() + 20_000;
      let decoded = '';
      while (Date.now() < deadline) {
        decoded = frames.map((f) => frameBytes(f).toString('utf8')).join('');
        if (decoded.includes('hello')) break;
        await delay(100);
      }

      expect(
        decoded,
        `no "hello" in PTY output after 20s (${frames.length} frames)\n` +
          `--- decoded ---\n${JSON.stringify(decoded)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toContain('hello');

      // The envelope is the contract, not the JavaScript type of the raw
      // message. Week 4's 5b8ed86 proved that wrapping a string in a Buffer
      // silently downgrades a frame to WEBRTC_BINARY, so asserting on `typeof`
      // would pin an accident. These assertions come AFTER the byte assertion
      // on purpose: a failure should name the missing byte before it names a
      // shape mismatch, and with zero frames `frames[0]` would be undefined.
      expect(frames.length).toBeGreaterThan(0);
      const first = frames[0];
      expect(first).toBeDefined();
      expect(first?.channel).toBe('terminal');
      expect(first?.type).toBe('terminal-data');
      expect(typeof first?.payload.data).toBe('string');
      expect(first?.payload.terminalId).toBe(sessionId);
    } finally {
      await offerer.close();
    }
  }, 90_000);
```

- [ ] **Step 8: Write the second test — the `0xFF` byte assertion**

Add the second `it` inside the same `describe` block. It seeds its own agent and session rather than sharing the first test's: after the first test's answer is recorded, that session is `active`, and a second offer on it is refused by Task 5's guard.

```typescript
  // Review Focus #5, the second half: Task 6's Rust test proves the framing
  // round-trips 0xFF inside one process; this proves no layer between two
  // languages — Rust base64, the DTLS/SCTP data channel, the werift adapter,
  // the JS decode — turns it into U+FFFD.
  it('preserves a non-UTF-8 byte (0xFF) end to end', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      // `printf '\377'` is the POSIX way to emit the single byte 0xFF with no
      // trailing newline; `\377` is octal for 255.
      sendKeystrokes(offerer, sessionId, "printf '\\377'\n");

      // The shell echoes the command line back, so the FIRST frame is the
      // literal text `printf '\377'` — which contains no 0xFF. The byte arrives
      // in a later frame as the command's own output. Scan every frame's bytes
      // rather than the concatenated string: a lossy UTF-8 conversion anywhere
      // in the chain turns 0xFF into U+FFFD, and concatenating first would hide
      // that behind a valid-looking string.
      const deadline = Date.now() + 20_000;
      let sawFF = false;
      while (Date.now() < deadline && !sawFF) {
        sawFF = frames.some((f) => frameBytes(f).includes(0xff));
        if (!sawFF) await delay(100);
      }

      expect(
        sawFF,
        `no 0xFF byte in any of ${frames.length} frames\n` +
          `--- frames (hex) ---\n` +
          frames.map((f) => frameBytes(f).toString('hex')).join('\n') +
          `\n--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 90_000);
```

**Why this is not redundant with Task 6's `frame_round_trip_preserves_arbitrary_bytes`.** That test proves the *Rust* framing functions are byte-exact. This one proves the *whole chain* is: Rust `STANDARD.encode` → JSON text frame → webrtc-rs SCTP → DTLS → werift → `WeriftDataChannel.onMessage` → the test's `Buffer.from(base64)`. A lossy conversion in any of those five hops corrupts the byte, and only this test crosses all five. `0xFF` is the canonical invalid-UTF-8 lead byte: any path that decodes bytes as UTF-8 and re-encodes them turns it into `EF BF BD` (U+FFFD).

**Why `Buffer.prototype.includes(0xff)` rather than a string search.** `includes` on a number searches for that byte value. Converting to a string first and searching for `'\u00ff'` would search for the *encoded* form and pass even when the wire bytes had been mangled — exactly the failure this assertion exists to catch.

- [ ] **Step 9: Run the E2E suite**

Build the binary first. The harness spawns `target/debug/remote-agent`, and Task 6's `cargo test` builds a *test* binary — not the binary the harness needs:

```bash
cd apps/agent && cargo build
```

Then run:

```bash
pnpm --filter @remote/webrtc-core test:e2e
```

Expected: **2 tests PASS** on Linux. On any other platform: **2 tests SKIPPED**, exit 0.

**The first run takes minutes**, because `cargo build` compiles `webrtc` and its dependency tree. Later runs reuse `target/`.

Two environment notes, both of which the harness depends on:

- The harness spawns `pnpm`, so `pnpm` must be on `PATH`. That holds in CI (`pnpm/action-setup`) and on a normal Linux dev box. On a machine where pnpm is only reachable through Corepack, prefix the invocation: `corepack pnpm --filter @remote/webrtc-core test:e2e`.
- `describe.skipIf` is used rather than `it.skipIf` even though §7.3 says the latter. `it.skipIf` skips the *test* but still runs `beforeAll`, which spawns the Worker and applies migrations — on macOS or Windows that would fail rather than skip, which is the opposite of "skipped, not failed". `describe.skipIf` skips the hooks too. Both forms exist in vitest 5 (`skipIf` on `SuiteAPI` and on `ChainableTestAPI`).

If the suite fails, the failure modes and their causes, in the order they are likely:

- `wrangler dev did not answer GET /health` → port 8787 is already in use. Check with `ss -ltnp | grep 8787`. The harness does not probe for a free port because a fixed port is what Task 6's `AGENT_SERVER` default and the harness's `--server` flag agree on.
- `migrations apply exited 1` → `pnpm exec wrangler` could not resolve its config, or `workers/signaling/db/migrations` is missing. Confirm `SIGNALING_DIR` is `workers/signaling`.
- `agent never reported online` → the WS handshake failed; the agent's own output is in the error. A `401` means the credential did not match — check the harness reads `created.credential` and not `created.agent.credential` (D-11). A `404` means the URL path is wrong (D-12).
- `no "hello" in PTY output` → the connection opened but the PTY did not. Check the agent output for `openpty` errors; a container without `/dev/ptmx` cannot run this test.
- `no 0xFF byte` → the framing is lossy somewhere. The frame hex dump is in the failure message; an `efbfbd` in it is a UTF-8 round trip that should not exist.

- [ ] **Step 10: Confirm the default suite is unchanged**

Run:

```bash
pnpm --filter @remote/webrtc-core test
```

Expected: **32 passing** — the Task 1/2 additions, unchanged by this task. If the count is 34, the `exclude` from Step 2 is not taking effect and the E2E file is being collected by the default runner.

- [ ] **Step 11: Verify the repository gate**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```

Expected: exit 0, **164 passing JS tests**. `tsc --noEmit` type-checks `test/e2e/terminal.e2e.test.ts` because `packages/webrtc-core/tsconfig.json` includes `test/**/*.ts` — so a type error in the harness fails `pnpm typecheck` even though the file never runs under `pnpm test`.

- [ ] **Step 12: Commit**

```bash
git add packages/webrtc-core/vitest.config.ts \
        packages/webrtc-core/vitest.e2e.config.ts \
        packages/webrtc-core/test/e2e/terminal.e2e.test.ts \
        packages/webrtc-core/package.json \
        docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
git commit -m "test(e2e): add cross-language terminal harness with real PTY bytes over DTLS"
```

Confirm the E2E file is tracked (`git show --stat HEAD | grep terminal.e2e`) and that the default config's `exclude` landed (`git show HEAD -- packages/webrtc-core/vitest.config.ts | grep -c configDefaults` → 1).

---

### Task 8: CI — the `rust` and `e2e` Jobs

Two jobs, and one of them is the week's done-criterion. `verify` is not touched.

**Files:**
- Modify: `.github/workflows/ci.yml` (append two jobs)
- Modify: `apps/agent/package.json` (add `build`; Task 6 already replaced the `echo ok` stubs)

**Interfaces:**
- Consumes: `apps/agent/Cargo.toml` + `Cargo.lock` (Task 6), `apps/agent/rust-toolchain.toml` (Task 6), `packages/webrtc-core/vitest.e2e.config.ts` + the `test:e2e` script (Task 7).
- Produces: nothing importable. The deliverable is a green gate.

**One hazard this task exists to close.** Task 6's Step 12 makes `apps/agent/package.json`'s `lint`, `typecheck` and `test` shell out to `cargo`. `turbo run lint|typecheck|test` therefore walks into `@remote/agent` like any other workspace package, so the existing `verify` job — which installs Node and pnpm and nothing else — now needs a Rust toolchain. This was **verified, not assumed**: `turbo run lint --dry=json` lists `@remote/agent:lint` in the task graph today, and `ubuntu-latest` ships Rust 1.98.1, rustup 1.29.1 and clippy preinstalled (the image's `install-rust.sh` runs `rustup component add rustfmt clippy`). So `verify` will pass — but it passes by accident of the runner image, and the version it uses is whatever the image happens to carry rather than the 1.98.1 `rust-toolchain.toml` pins.

The fix is one step: install the pinned toolchain in `verify` too. `rust-toolchain.toml` alone does not guarantee it, because `dtolnay/rust-toolchain` **requires** its `toolchain` input (`action.yml` marks it `required: true`; the action never reads a toolchain file) and the image's `stable` may drift from 1.98.1. Being explicit costs one cache-backed step and removes the drift.

- [ ] **Step 1: Add the `rust` job**

Append to `.github/workflows/ci.yml`, after the `verify` job:

```yaml
  rust:
    name: Rust Agent (fmt, clippy, test)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/agent
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      # `toolchain` is a REQUIRED input and the action does not read
      # rust-toolchain.toml, so this is the only thing that pins the version in
      # CI. The value matches apps/agent/rust-toolchain.toml (1.98.1).
      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@02cb101ec7c40f2c49e1d9714d64511d8e1b74de # v1
        with:
          toolchain: "1.98.1"
          components: rustfmt,clippy

      # Keyed on apps/agent's own Cargo.toml/Cargo.lock/rust-toolchain.toml
      # (the action hashes those by default). `working-directory` is a step
      # default, and the action's own default workspace is `. -> target` — which
      # from the repo root would be the wrong directory, so it is set here.
      - name: Cache cargo registry and target
        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        with:
          workspaces: apps/agent -> apps/agent/target

      - name: Check formatting
        run: cargo fmt --check

      - name: Lint
        run: cargo clippy --all-targets --locked -- -D warnings

      - name: Build
        run: cargo build --locked

      - name: Test
        run: cargo test --locked
```

Notes on each choice:

- **`--locked` on clippy, build and test, but not on `fmt`.** `--locked` makes `Cargo.lock` authoritative, so a dependency bump is a reviewable diff instead of a CI surprise (ADR-08). `cargo fmt` takes no dependency-resolution flag — it formats source text and never touches the registry.
- **`clippy --all-targets`** lints the `#[cfg(test)]` modules too. Without it, `cargo clippy` checks only the library/binary targets and the test modules' warnings would surface at `cargo test` time instead, as errors on a different job.
- **`1.98.1` quoted.** YAML reads a bare `1.98.1` as a string anyway, but quoting it makes the intent explicit and survives a future value like `1.98` being coerced to a number.
- **No system packages.** `portable-pty` and `webrtc-rs` are pure Rust on Linux; nothing needs `apt-get`.

- [ ] **Step 2: Add the `e2e` job**

Append after the `rust` job:

```yaml
  e2e:
    name: Cross-language terminal E2E
    # The week's done-criterion. Gated on both other jobs so a failure here is
    # never the first thing reported about a broken workspace.
    needs: [verify, rust]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - name: Setup pnpm
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
        with:
          version: 12.6.0

      - name: Setup Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@02cb101ec7c40f2c49e1d9714d64511d8e1b74de # v1
        with:
          toolchain: "1.98.1"

      - name: Cache cargo registry and target
        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        with:
          workspaces: apps/agent -> apps/agent/target

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # The harness spawns `apps/agent/target/debug/remote-agent`, and `cargo
      # test` builds a test binary, not that one. Debug, not release: the E2E
      # measures correctness of the wire contract, not throughput.
      - name: Build the agent binary
        run: cargo build --locked
        working-directory: apps/agent

      - name: Run the E2E suite
        run: pnpm --filter @remote/webrtc-core test:e2e
```

Notes:

- **No `rustfmt`/`clippy` components here.** This job builds and runs; the `rust` job already owns formatting and linting. Installing only what it uses keeps the job's setup short.
- **`pnpm install` comes after the toolchains** but the order is not load-bearing — the three setup steps are independent. It is written in the order a reader scans: toolchains, then dependencies, then build, then run.
- **No `--passWithNoTests`.** Task 7's `test:e2e` deliberately omits it, so a run that collects zero tests fails. In CI that is the difference between "the harness ran" and "the harness silently stopped running".
- **The `finally`-based teardown is in the test file, not here** (Task 7's `afterAll` + `killAndWait`). A `wrangler dev` process that leaked past a failing test would still be inside this job's process tree and would be reaped when the runner tears the job down; the test-level teardown is what keeps the *same job's* subsequent steps clean.

- [ ] **Step 3: Install the pinned toolchain in `verify` too**

In the existing `verify` job, insert after the `Setup Node.js` step and before `Install dependencies`:

```yaml
      # `apps/agent`'s scripts shell out to `cargo`, so `turbo run
      # lint|typecheck|test` reaches a Rust toolchain from this job. The runner
      # image happens to ship one, but its version is the image's, not the
      # 1.98.1 apps/agent/rust-toolchain.toml pins — and `dtolnay/rust-toolchain`
      # does not read that file. Pinning here removes the drift.
      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@02cb101ec7c40f2c49e1d9714d64511d8e1b74de # v1
        with:
          toolchain: "1.98.1"
          components: rustfmt,clippy

      - name: Cache cargo registry and target
        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        with:
          workspaces: apps/agent -> apps/agent/target
```

Without this, `verify` still passes on today's `ubuntu-latest` — the image carries Rust 1.98.1 and clippy. It passes for a reason nobody wrote down, and it would start failing the day the image's Rust moves and `Cargo.lock` no longer resolves under it, or the day the image drops clippy. Two steps, cached, is cheaper than that failure mode.

- [ ] **Step 4: Add the `build` script to `apps/agent/package.json`**

After Task 6, `apps/agent/package.json` reads:

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

Add `build`:

```json
{
  "name": "@remote/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "cargo build --locked",
    "lint": "cargo fmt --check && cargo clippy --all-targets -- -D warnings",
    "typecheck": "cargo check --all-targets",
    "test": "cargo test"
  }
}
```

**`build` is added for the developer, not for CI.** Turbo has no `build` task configured (`turbo.json` declares only `lint`, `typecheck` and `test`; `turbo run build --dry=json` fails with `Could not find task 'build' in project`), and this task's `e2e` job calls `cargo build` directly. The script exists so `pnpm --filter @remote/agent build` produces the binary the E2E harness needs, which is the command a contributor will reach for after cloning. Adding a `build` task to `turbo.json` is deliberately **not** done: it would put a multi-minute Rust compile into `pnpm build` for every consumer of the repo, and nothing in the JS pipeline consumes the binary.

- [ ] **Step 5: Validate the workflow file**

`prettier --check` covers `.github/workflows/ci.yml` (it is not in `.prettierignore`), so a formatting slip fails `pnpm format:check` in the `verify` job this file defines:

```bash
pnpm format:check
```

Expected: exit 0. If it fails, run `pnpm format` and inspect the diff — Prettier normalizes YAML indentation and would rewrite the file, so confirm it changed only whitespace.

There is no local YAML linter in this repository and no `actionlint` dependency, so the remaining validation is the CI run itself. The two failure modes worth knowing before pushing:

- **`Invalid workflow file`** → an indentation error, usually from a step inserted at the wrong nesting level. The job keys (`rust:`, `e2e:`) must sit at the same two-space indent as `verify:`.
- **`Unexpected value 'apps/agent -> apps/agent/target'`** → the `workspaces` input is a plain string, not a map. The `path -> target` form goes on one line inside the string; do not write it as YAML key/value.

- [ ] **Step 6: Verify the pinned SHAs still resolve**

Both SHAs are pinned and both were resolved from the live tags when this plan was written. Re-confirm before committing, because a moved tag is the one thing a SHA pin is supposed to make impossible:

```bash
git ls-remote https://github.com/dtolnay/rust-toolchain v1
git ls-remote https://github.com/Swatinem/rust-cache 'refs/tags/v2.9.2^{}'
```

Expected, respectively:

```
02cb101ec7c40f2c49e1d9714d64511d8e1b74de	refs/tags/v1
6323deb102c322ba6fcbdcafc7e3dddab59af2b6	refs/tags/v2.9.2^{}
```

`v1` is a lightweight tag pointing straight at the commit, so one line is the whole answer. `v2.9.2` is an **annotated** tag: the bare `refs/tags/v2.9.2` line gives the tag *object* (`63fed3e2fecf6f7b51dc6f043341b79ef82a9ae7`), and the `^{}` peel is what yields the commit `6323deb…` that belongs in `uses:`. Pinning the tag object instead of the commit would work today and is the wrong thing to write — GitHub dereferences both, but only the commit is immutable in the sense the pin is for.

If either SHA differs, stop and investigate rather than updating the pin: a moved tag on a pinned action is a supply-chain signal, not a version bump.

- [ ] **Step 7: Run the repository gate**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```

Expected: exit 0, **164 passing JS tests**, and the Rust suite green — `pnpm test` reaches `cargo test` through `apps/agent`'s `test` script, so this is the one command that exercises both languages locally. The Rust output is not counted in the 164.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml apps/agent/package.json
git commit -m "ci: add rust and cross-language e2e jobs"
```

Confirm the workflow parses as YAML by checking the job keys landed at the right level:

```bash
grep -n '^  [a-z]*:$' .github/workflows/ci.yml
```

Expected: three lines — `verify:`, `rust:`, `e2e:` — each at two-space indentation.

---

### Task 9: Docs Sync — `docs/ARCHITECTURE.md` and the Week 5 spec's superseded sites

Zero tests. Two documents and one note in this plan.

This task is where three earlier tasks' promises come due. D-2 says §5.9.1's `hello` row "is superseded and recorded in Task 9". D-3 says the spec's error-code list contradicts §4.3.3. D-10 says "Task 9 records the correction at the §5.8.1/§5.11.5 doc sites". All three name *the spec file*, not `ARCHITECTURE.md`. Correcting a reviewed spec is established practice in this repository — `bdcd2ca` did exactly that for Week 4's `getStats` finding, and this plan's own Task 2 Step 16 corrects Week 4's malformed-JSON row with an errata block. Task 9 follows that pattern.

**`ARCHITECTURE.md` is at `docs/ARCHITECTURE.md`, not the repository root.** §3.1's own tree prints `ARCHITECTURE.md  # This file` as a root file at `:523` (not `:522`, which is `.gitlab-ci.yml`) and also lists a `docs/` directory at `:492` — the root entry is stale. Do not create or edit a root-level file.

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§6.2, §6.3, §3.1, §4.2, §8 Tuần 5, §9.3, §9.4)
- Modify: `docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md` (§5.5.1, §5.5.5, §5.8.1, §5.8.2, §5.9.1, §5.9.3, §5.11.5, §5.12, §7.5, ADR-12, ADR-13)
- Modify: `docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md` (Step 11)

**Interfaces:**
- Consumes: `packages/shared/src/types/signaling.ts` (the union + the Task 4 envelope), `apps/agent/Cargo.toml` + `src/{main,signal,rtc,pty}.rs` (Task 6), `workers/signaling/src/routes/ws.ts` (Task 4), `.github/workflows/ci.yml` (Task 8), `packages/webrtc-core/package.json`'s `test:e2e` (Task 7).
- Produces: nothing importable. The deliverable is documentation that describes the shipped code.

**Two new deviation rows this task owns: D-14 and D-15**, both in the table at the top of this plan. D-14 refuses §8.3's instruction to tick the Week 5 roadmap items (the document has never contained a single tick — 0 ticked, 85 unticked, including for the Phase 1 and Week 4 work that shipped — so ticking Week 5 alone would assert the opposite of the same roadmap). D-15 relocates §8.3's last instruction, marking the Week 4 ledger resolved, into this plan, because `.superpowers/` is gitignored and therefore not part of the repository. Step 11 is the checkpoint that both rows and the updated count are in place before the steps below depend on them.

**Five further sites are corrected beyond §8.3's list.** §8.3 names six documentation updates and omits five that are stale and adjacent to the work this week ships.

In `ARCHITECTURE.md`: §9.4 embeds a **four-job** `ci.yml` (`lint`, `test`, `build`, `deploy-workers`; `pnpm/action-setup@v4`; `node-version: '20'`; `version: 9`) that does not exist — the real workflow has been a single `verify` job since Week 4 and Task 8 makes it three — and §9.3 advertises `pnpm test:e2e` and `pnpm test:integration`, neither of which is a root script (`package.json` has `lint`, `typecheck`, `test`, `format:check`, `format`, `deploy:workers`, `db:migrate:prod`, `dev:web`); Task 7 adds `test:e2e` to `packages/webrtc-core` only, invoked as `pnpm --filter`, and no integration suite exists at all. Steps 6 and 7 correct both.

In the spec, three sites outside the eight sections listed above also carry the removed `hello` frame, and D-2's correction is incomplete without them — a reader who follows any of the three lands on a frame the server rejects:

- **ADR-12's Decision** (`:1371`) says the agent "reconnects with the mirrored backoff (§5.5.4) and re-sends `hello`".
- **ADR-13's Consequence** (`:1401`) says "`hello`'s `agentId` is a convenience the server must cross-check (§5.9.1)".
- **§7.5's deliverable table, row 2** (`:2363`) lists the `signal.rs` types as "`SignalMessage`, `ClientFrame`, JSON round-trip and rejection".

Step 10 covers all three. They are corrections of a claim this plan has already resolved (D-2), not new deviations, so they get no table row — the same treatment the two `packages/shared` statements and the two `ARCHITECTURE.md` sites above receive.

---

#### Part A — `docs/ARCHITECTURE.md`

- [ ] **Step 1: Read the §6.2 block before editing it**

Read `docs/ARCHITECTURE.md:929-955`. The code block ends at `:953` with `IceCandidateSignal`'s closing `}` and the fence; `:955` is the `> **Week 4 Security Boundary Note:**` blockquote. Both are replaced below. The three payload interfaces above them (`SignalOffer`, `SignalAnswer`, `IceCandidateSignal`, `:935-952`) are correct and match `packages/shared/src/types/signaling.ts:1-18` — do not touch them.

- [ ] **Step 2: Add the union and the envelope to §6.2 (R26)**

Replace the `IceCandidateSignal` closing `}` and the terminating fence at `:952-953`, so the block ends:

```typescript
export interface IceCandidateSignal {
  sessionId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalMessage =
  | { type: 'offer'; data: SignalOffer }
  | { type: 'answer'; data: SignalAnswer }
  | { type: 'ice-candidate'; data: IceCandidateSignal };

/**
 * The WebSocket transport envelope for the agent socket (`GET /api/ws/agent`).
 *
 * A signal frame nests `{ type, data }` inside `{ type: 'signal', data }`: the
 * outer `type` is the *transport* discriminator, the inner one is the *signal*
 * discriminator. Flattening them would make a transport frame ambiguous with a
 * bare `SignalMessage`.
 *
 * `SignalMessage` above is deliberately unchanged: `webrtc-core`'s
 * `SignalTransport` and the REST bodies keep one definition.
 */
export type AgentErrorCode =
  | 'MALFORMED_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR'
  | 'SESSION_NOT_ACTIVE';

export type AgentSocketMessage =
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage }
  | { type: 'error'; code: AgentErrorCode };
```

This closes **R26**. The Week 4 ledger's ruling was that adding the union is "a docs improvement, not a correction of an error; it belongs with Week 5 documentation, not in a post-review edit" (`progress.md:1119`). This is that documentation.

- [ ] **Step 3: Replace the §6.2 boundary note**

Replace `docs/ARCHITECTURE.md:955` in full:

```markdown
> **Week 5 Agent Credential Boundary.** The Week 4 note is superseded. Agent-scoped credentials now exist: `POST /api/agents` mints `ag_` + 32 lowercase hex characters (16 CSPRNG bytes, 128 bits) exactly once and stores only its SHA-256 hex digest (`agents.credential_hash`, `UNIQUE`), and the agent presents it in the `Authorization: Bearer` header of the WebSocket handshake at `GET /api/ws/agent` — never in a query string, because a URL is logged by every proxy and by Cloudflare's own request log.
>
> The WS path enforces a stricter tenancy predicate than REST: `session.userId == agent.userId` **and** `session.agentId == agent.id`, so an agent cannot speak for a session that is not bound to it even within its own user's account. Inbound failures are answered with `{ type: 'error', code }` using `AgentErrorCode`; the credential check runs *before* the `Upgrade` guard, so an unauthenticated request is `401` and never `426`.
>
> **Residual:** the REST `POST /api/signal/*` routes still authenticate as the owning *user*, not as the agent, so browser/agent separation holds on the WS path only. `agentConnections` is a module-scope `Map` and therefore per-isolate: a push reaches only an agent whose socket landed in the same isolate, and D1 + polling remains the delivery guarantee — the push is a latency optimisation. A second connection presenting a valid credential supersedes the first (one map entry per `agentId`). `is_online` in D1 is a hint; the authoritative online predicate is socket presence combined with a read-time window over `last_ping_at` (90 s).
```

- [ ] **Step 4: Annotate the Week 5 roadmap block (D-14)**

Replace `docs/ARCHITECTURE.md:1193-1198`. The five `- [ ]` lines are kept as `[ ]` and the block gains a status line:

```markdown
#### Tuần 5: Desktop Agent - Terminal

**Trạng thái: đã ship (2026-09-26).** Các mục dưới đây giữ nguyên dạng `[ ]` vì toàn bộ roadmap
trong tài liệu này chưa từng được tick — kể cả Phase 1 và Tuần 4 đã hoàn thành — nên tick riêng
Tuần 5 sẽ khiến tài liệu tự mâu thuẫn. Đánh dấu ở đây thay vì tick.

- [ ] Tạo Rust agent — `apps/agent` (crate `remote-agent`), 4 module phẳng: `main.rs`, `signal.rs`, `rtc.rs`, `pty.rs`
- [ ] Implement WebSocket signaling — `GET /api/ws/agent` trên `workers/signaling`, xác thực bằng credential `ag_<32 hex>`
- [ ] Tích hợp portable-pty — `portable-pty 0.9`, PTY thật, 1 session
- [ ] Xử lý terminal I/O — base64 trong `DataChannelMessage<TerminalDataMessage>`, kênh `terminal`
- [ ] Implement session management — state machine `pending → active → terminated`

> **Kiến trúc hybrid có chủ đích:** signaling dùng **REST polling cho browser** (giữ nguyên từ Tuần 4,
> ADR-03) và **WebSocket chỉ cho agent**. Cụm "Implement WebSocket signaling" ở trên *không* có nghĩa
> là toàn bộ signaling đã chuyển sang WebSocket — `packages/webrtc-core` không có `WebSocketTransport`
> nào, và client WebSocket duy nhất là Rust.
```

- [ ] **Step 5: Mark the §4.2 Cargo sketch stale and correct the §3.1 agent tree**

Insert a staleness banner between the `### 4.2 Desktop Agent (Rust)` heading at `:647` and the `**File:** apps/agent/Cargo.toml` line at `:649`:

```markdown
> **Sketch — không phải nguồn sự thật.** Các phiên bản dưới đây (`webrtc = "0.10"`,
> `tokio-tungstenite = "0.21"`, `portable-pty = "0.8"`) là bản phác thảo viết trước khi crate được
> scaffold và đã lệch so với thực tế. Nguồn sự thật là **`apps/agent/Cargo.toml`**, khoá bởi
> `Cargo.lock` được commit (ADR-08). Dependency thực tế của Tuần 5: `webrtc 0.13`,
> `tokio-tungstenite 0.26`, `portable-pty 0.9`, `base64 0.23`, `clap 4`, `tokio`, `futures-util`,
> `serde`, `serde_json`, `tracing`, `tracing-subscriber`, `anyhow`. Phần còn lại của sketch dưới đây —
> `vt100`, `scrap`, `x264`, `openh264`, `notify`, `walkdir`, `ring`, `rustls`, `bincode`, `sysinfo`,
> `uuid`, `chrono` và các block `[target.'cfg(...)']` — **chưa được dùng ở Tuần 5**; chúng thuộc
> Phase 3-4.
```

Then replace the §3.1 agent subtree at `:348-384` (from `│   └── agent/` through the `│       └── agent.toml` line). The current tree sketches `config.rs`, a `webrtc/` subdirectory, `terminal/`, `capture/`, `files/`, `security/` and `utils/` — roughly twenty files across five phases, of which four exist:

```
│   └── agent/                        # Desktop Agent (Rust) — Tuần 5
│       ├── src/
│       │   ├── main.rs               # CLI, reconnect loop, session supervision
│       │   ├── signal.rs             # WS signaling client (tokio-tungstenite)
│       │   ├── rtc.rs                # WebRTC answerer (webrtc-rs)
│       │   └── pty.rs                # PTY bridge (portable-pty)
│       ├── Cargo.toml                # nguồn sự thật cho dependency (§4.2)
│       ├── Cargo.lock                # commit — ADR-08
│       ├── rust-toolchain.toml       # 1.98.1 + rustfmt, clippy
│       └── .env.example
│
│   # Chưa ship (Phase 3-4): config.rs, webrtc/ subdirectory, terminal/,
│   # capture/, files/, security/, utils/, agent.toml — xem §4.2 và ADR-07.
```

The layout is the four flat modules ADR-07 and spec §5.4.1 fix; `config.rs`, the `webrtc/` subdirectory and `agent.toml` are ADR-04's narration of the tree above, which D-7 resolves against. Keeping them in the tree as "not yet shipped" is accurate; presenting them as the plan is not.

- [ ] **Step 6: Add the WS route to §6.3, replace §9.4's stale embedded workflow, and fix the §3.1 root path**

In §6.3, under the `# Signaling` heading, add the socket after the four REST lines:

```
# Signaling
POST   /api/signal/offer           # Send WebRTC offer
POST   /api/signal/answer          # Send WebRTC answer
POST   /api/signal/ice-candidate   # Send ICE candidate
GET    /api/signal/poll/:sessionId # Poll for signals
GET    /api/ws/agent               # Agent WebSocket relay (Upgrade; Bearer ag_…, not a JWT)
```

It is listed here because this block is the document's only route inventory, and an agent author reading it would otherwise not find the endpoint the credential is for. The `# Signaling` heading is not strictly REST, which is why the line is labelled.

Then replace the embedded YAML in §9.4, `docs/ARCHITECTURE.md:1382-1445` (from the opening fence through the closing one), with a summary and a pointer rather than a second copy of a file that will drift again:

```markdown
**File:** `.github/workflows/ci.yml`

The workflow is the source of truth; it is not reproduced here, because a copy in this document
drifted once already (this section described four jobs — `lint`, `test`, `build`, `deploy-workers`,
on `node-version: '20'` with `pnpm/action-setup@v4` — while the real file had been a single `verify`
job since Week 4).

Three jobs, all on `ubuntu-latest`, all pinned to a full commit SHA with the version in a trailing
comment (the convention the repository settled on in Week 4):

| Job | Runs | Purpose |
|---|---|---|
| `verify` | Node 24 + pnpm 12.6.0 + Rust 1.98.1 | `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test` |
| `rust` | Rust 1.98.1 (`apps/agent` as the working directory) | `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo build --locked`, `cargo test --locked` |
| `e2e` | Node 24 + pnpm + Rust, `needs: [verify, rust]` | builds `apps/agent/target/debug/remote-agent`, then `pnpm --filter @remote/webrtc-core test:e2e` |

The `e2e` job is Week 5's done-criterion: the same wire contract implemented twice, meeting at a real
DTLS/SCTP connection with real PTY bytes crossing it. It is Linux-only by construction (`iceServers:
[]`, no STUN, no TURN, loopback only), so it never reaches the network.
```

The stale `deploy-workers` job is not reinstated: deployment is `pnpm deploy:workers` → `wrangler deploy` with `CLOUDFLARE_API_TOKEN` set as a repository secret, and the root `package.json` already owns that path.

While you are in this file, correct one unrelated line the task header already identified: §3.1's root tree prints

```
├── ARCHITECTURE.md                   # This file
```

at `:523` (not `:522` — that line is `.gitlab-ci.yml`), but the document lives at `docs/ARCHITECTURE.md`, and the same tree lists a `docs/` directory at `:492`. Change that line to point at the real path:

```
├── docs/ARCHITECTURE.md              # This file
```

It is a one-line fix and it is in this task's scope because this task's own step list cites it — leaving a known-wrong path in the document that the credential note and the route inventory both live in would undercut the point of the sync.

- [ ] **Step 7: Correct §9.3's two advertised commands**

Replace the `### 9.3 Testing Strategy` code block at `docs/ARCHITECTURE.md:1364-1377` (the fence opens at `:1364` and closes at `:1377`, immediately before the blank line and `### 9.4` at `:1379`):

```bash
# Unit tests (all workspaces, via turbo)
pnpm test

# Specific package tests
pnpm --filter @remote/shared test
pnpm --filter @remote/api-client test

# Cross-language terminal E2E — Linux only; spawns wrangler dev and the Rust agent
# on 127.0.0.1:8787. Build the agent first: `pnpm --filter @remote/agent build`.
pnpm --filter @remote/webrtc-core test:e2e
```

Two corrections, both verified against the repository: `pnpm test:e2e` is not a root script (the root `package.json` has `lint`, `typecheck`, `test`, `format:check`, `format`, `deploy:workers`, `db:migrate:prod`, `dev:web`), and `pnpm test:integration` has no script anywhere and no suite behind it. The E2E script lives in `packages/webrtc-core`, which is also how Task 8's `e2e` job invokes it.

---

#### Part B — the Week 5 spec's superseded sites

Each edit is an errata block plus a targeted correction, matching Task 2 Step 16's pattern for Week 4. The spec stays readable as the design record; the errata state what shipped and why.

- [ ] **Step 8: §5.5.1 — remove the `ClientFrame` enum (D-2, D-4)**

In `docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md`, replace the two-line lead-in at `:1571-1572` and the `ClientFrame` code block at `:1574-1580` together, so no dangling "…so a malformed control frame cannot be mistaken for a signal:" is left pointing at nothing.

The lead-in reads:

```markdown
Control frames are a **separate** enum, never merged into `SignalMessage`, so a malformed control
frame cannot be mistaken for a signal:
```

The block reads:

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientFrame {
    Hello { agent_id: String, version: String, platform: String },
}
```

with:

```markdown
> **Errata (2026-09-26, Week 5 plan Task 9).** There is no `ClientFrame`. §4.5's `handleInbound` — the
> authoritative worker contract — has no `hello` arm, so a `hello` would be answered
> `{ "type": "error", "code": "VALIDATION_ERROR" }`, a frame no conforming client can send. Identity
> comes from the credential in the handshake header (ADR-13), which is strictly stronger than a
> self-declared agent id, so nothing is lost. The original enum also carried
> `rename_all = "kebab-case"` on the *enum*, which renames variants, not fields — its payload would
> have serialized `agent_id`, not `agentId` (D-4). The enum is moot either way.
>
> `signal.rs` defines no control frame. It has two enums instead: an inbound `InboundFrame`
> (`Signal { data }`, `Pong`, `Error { code }`) and a single-variant outbound `Envelope::Signal`, both
> `#[serde(tag = "type")]` so the wire shape matches `AgentSocketMessage` in `packages/shared`. The
> `offer`/`answer`/`ice-candidate` rows below are the contract.
```

- [ ] **Step 9: §5.9.1 — correct the wire contract table (D-2, D-3)**

Three edits in `:2089-2103`.

**(a)** Delete the `hello` row at `:2091`:

```
| agent → server | `hello` | `{ "type": "hello", "agentId": "…", "version": "0.1.0", "platform": "linux" }` — **first frame**, within 5 s of the handshake or the server closes |
```

**(b)** Replace the `error` row at `:2095`:

```
| server → agent | `error` | `{ "type": "error", "code": "UNAUTHORIZED" \| "BAD_FRAME" \| "SESSION_NOT_FOUND", "message": "…" }` — control frame, not a `SignalMessage` |
```

with:

```
| server → agent | `error` | `{ "type": "error", "code": AgentErrorCode }` — control frame, not a `SignalMessage`. Codes: `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`, `SESSION_NOT_ACTIVE`. There is no `message` field. |
```

**(c)** Replace the `Identity:` bullet at `:2102-2103` with:

```markdown
- **Identity:** the server derives the agent from the credential presented on the handshake. There is
  no `hello` and therefore no `hello.agentId` to cross-check: `--agent-id` is a display label, never an
  authorization input (ADR-13).
```

Then insert the errata immediately after the bullet list that ends at `:2103`:

```markdown
> **Errata (2026-09-26, Week 5 plan Task 9).** The `hello` row is removed: §4.5's `handleInbound` has
> no arm for it, so the frame it specifies is one the server rejects (D-2). The `Identity` bullet that
> followed is rewritten for the same reason — there is no `hello.agentId` to cross-check. The `error`
> row's code list (`UNAUTHORIZED | BAD_FRAME | SESSION_NOT_FOUND`) is replaced by §4.3.3's: §4.3.3 is
> authoritative for error codes, and its set is the one the worker actually emits (D-3). The
> `"message"` field never existed in any frame the worker sends; `UNAUTHORIZED` and `UPGRADE_REQUIRED`
> are HTTP responses on the handshake, not frames. `SESSION_NOT_ACTIVE` is the terminated-session
> refusal added in Week 5's session state machine. The observable contract is pinned by
> `workers/signaling/test/ws.test.ts`.
```

- [ ] **Step 10: §5.8.1, §5.9.3, §5.11.5, and the `hello`-reconnect narrative — the `/api` path (D-10) and D-2's tail**

**(a) §5.8.1's clap default (`:1978-1979`).** The comment and default value:

```rust
    /// Signaling WebSocket URL, e.g. wss://host/ws/agent
    #[arg(long, env = "AGENT_SERVER", default_value = "ws://localhost:8787/ws/agent")]
```

become:

```rust
    /// Signaling WebSocket URL, e.g. wss://host/api/ws/agent
    #[arg(long, env = "AGENT_SERVER", default_value = "ws://localhost:8787/api/ws/agent")]
```

**(b) §5.9.3's item 1 (`:2123`).** `A WebSocket route (`/ws/agent`) with `Upgrade` handling` → `A WebSocket route (`/api/ws/agent`) with `Upgrade` handling`.

**(c) §5.11.5's `.env.example` (`:2298`).** `AGENT_SERVER=ws://localhost:8787/ws/agent` → `AGENT_SERVER=ws://localhost:8787/api/ws/agent`.

**(d)** Insert the shared errata after §5.11.5's `.env.example` fence, covering both D-10 and the `hello`-reconnect narrative:

```markdown
> **Errata (2026-09-26, Week 5 plan Task 9).** The path is `/api/ws/agent`, not `/ws/agent` (D-10).
> This document spells it both ways: §4.4, §4.13 and §8.1 mount the router at `/api/ws`, while the
> three sites corrected above said `/ws/agent`. The worker is authoritative — it mounts
> `app.route('/api/ws', ws)` with a `/agent` route, and every other route in the worker is under
> `/api`. An agent built from the uncorrected spellings gets a 404 at the handshake.
>
> Separately, every narrative mention of the agent sending `hello` on connect or on reconnect is
> superseded along with the row in §5.9.1: §5.5.2 (`:1599`, "the first frame sent is
> `ClientFrame::Hello`"), §5.5.5 (`:1658`, "reconnects and re-sends `hello`"), §5.8.2's pipeline
> diagram (`:2022`, "connect WS … send hello … wait for offer"), and §5.12's security bullet
> (`:2318`, "rejects a `hello` mismatch" — note this is §5.12, not §5.11.4; §5.11.4 is the CI file).
> The agent sends nothing on connect; the socket is authenticated by the handshake header, and the
> first frame on the wire is the server's `offer`. On an unexpected close it reconnects with the
> mirrored backoff and re-sends nothing — the peer connection and PTY are still torn down, which is
> the part of §5.5.5 that holds.
```

Do not delete those four narrative lines. They are the design record of a decision that was reversed, and the errata names them so a reader who finds one lands on the correction in one jump. The `hello`-mismatch bullet is the only one of the four that lives outside §5.5 and §5.8 — it is the last bullet of §5.12's `**Security**` list, which is why the errata cites `:2318` rather than a section number a reader would guess.

**(e) Three sites outside the eight sections above.** They carry the same removed `hello` frame, and leaving them would strand a reader who arrives through the ADR index or the deliverable table rather than through §5. Correct each in place — a one-line rewrite, no errata block, because in each case the sentence's *other* content still holds:

**ADR-12's Decision (`:1371`).** Replace:

```markdown
and re-sends `hello`. The **peer connection and PTY session are torn down** at that point; the agent
```

with:

```markdown
and reconnects. The **peer connection and PTY session are torn down** at that point; the agent
```

The rest of the ADR — mirrored backoff, no session resumption, ICE restart as a follow-up — is unchanged and still accurate. Only the frame is gone.

**ADR-13's Consequence (`:1401`).** Replace:

```markdown
the token, and `hello`'s `agentId` is a convenience the server must cross-check (§5.9.1).
```

with:

```markdown
the token, and `--agent-id` is a display label the server does not consult (§5.9.1).
```

**§7.5's deliverable table, row 2 (`:2363`).** Replace the `signal.rs` types cell:

```markdown
| 2 | **`signal.rs` types + framing** | `SignalMessage`, `ClientFrame`, JSON round-trip and rejection | 12 |
```

with:

```markdown
| 2 | **`signal.rs` types + framing** | `SignalMessage`, `InboundFrame`, `Envelope`, JSON round-trip and rejection | 12 |
```

The `12` is untouched: it is §7.5's own estimate for this row and this plan does not re-count it (Task 6's actual function count is the authoritative one, and the plan's test-baseline bullet states the reconciliation).

---

#### Part C — verify and commit

- [ ] **Step 11: Record the residual closure in this plan (D-15)**

Append to this plan's Global Constraints, after the test-baseline bullet at the top of the file:

```markdown
- **Week 4 ledger residual — closed by Tasks 1, 2 and 9.** §8.3 names eight residual tests across four rulings, all now covered. `R24` (six reachable branches whose deletion left the suite green) is closed by Task 1's six tests. `R30` (the two `transport.ts` error paths spec §4.7 promises by name) and `R32` (the unbounded candidate buffer, and the flush that drops its tail when one candidate rejects) are closed by Task 2. `R31` (the unreachable `MALFORMED_JSON` path) is closed by Task 2, which pins the contract as `VALIDATION_ERROR` for a non-JSON body and corrects the Week 4 spec's row. `R26` (the `SignalMessage` union missing from `ARCHITECTURE.md` §6.2) is closed by Task 9 Step 2, which is the Week 5 documentation the ledger's own ruling deferred it to. The ledger itself is `.superpowers/sdd/2026-09-25-phase2-week4-webrtc-core/progress.md`, which is gitignored (`.gitignore:38`) and therefore not reviewable in a diff — this line, not a ledger edit, is the durable record (D-15).
```

Also write the D-14 and D-15 rows into the deviations table and change "Thirteen places" to "Fifteen places" (both the sentence at the top of the table and the self-check quoted in Task 7 Step 1). Both were already done when this plan was written — verify rather than redo:

```bash
grep -c '^| D-' docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
grep -c 'line by line. Fifteen place[s]' docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
grep -c 'sentence above it reads "Fifteen place[s]"' docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
```

Expected: `15`, `1`, `1`. The first is the row count the sentence claims. The other two prove the wording was updated at both sites where the sentence appears — the table's lead sentence and Task 7's self-check.

Both prose patterns carry a bracket class and are anchored on the words *around* the phrase, for two different reasons:

- **The bracket class stops the command matching its own line.** The command text contains the literal `place[s]`, which the regex `place[s]` does not match (it matches `places`), so neither grep counts itself.
- **The surrounding words stop it matching this paragraph.** A bare `Fifteen place[s]` would also hit the explanatory prose below, which quotes the phrase.

Together those are why the expected counts are `1` and `1` rather than the drifting four or five a loose pattern returns. If you do want a single unanchored count, count rows — that is the claim "Fifteen places" actually makes, and it cannot self-match:

```bash
grep -o 'D-1[0-5]' docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md | sort -u | wc -l
```

Expected: `6` — the six newest rows are present and unique. Together with the `15` above, that is the whole assertion: fifteen rows exist and the six this task added are among them.

- [ ] **Step 12: Verify `ARCHITECTURE.md` is coherent**

```bash
grep -n 'AgentSocketMessage\|credential_hash\|/api/ws/agent' docs/ARCHITECTURE.md
```

Expected: hits in §6.2 (the envelope), §6.2's boundary note (the credential and the path), §6.3 (the route), and the §9.4 summary table. Before this task none of the three strings appeared anywhere in the file.

```bash
grep -c '^- \[x\]' docs/ARCHITECTURE.md
```

Expected: `0` — unchanged. This is the check that Step 4 annotated rather than ticked (D-14).

```bash
grep -n "^  deploy-workers:\|node-version: '20'\|^          version: 9$" docs/ARCHITECTURE.md
```

Expected: no output — the stale embedded workflow is gone. The patterns are anchored deliberately. A bare `grep -n 'deploy-workers'` returns **three unrelated hits** that must stay: `:256` (the `deploy-workers.yml` line in the §3.1 tree), `:509` (`scripts/deploy-workers.sh`), and `:556` (`"deploy:workers"` in a `package.json` sketch). Only `:1430`'s two-space-indented job key belongs to the block this step deletes. Likewise `node-version` appears once, at `:1401`, inside that block; and `version: 9` at `:1398`.

- [ ] **Step 13: Verify the spec's superseded sites are all named**

```bash
grep -c 'Errata (2026-09-26, Week 5 plan Task 9)' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
```

Expected: `3` — Step 8's §5.5.1 `ClientFrame` block, Step 9's §5.9.1 table block, Step 10's §5.11.5 path-and-`hello` block. If the count is lower, a block was not inserted; if higher, one was duplicated.

```bash
grep -n 'ws://localhost:8787/ws/agent' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
grep -n '(`/ws/agent`)' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
```

Expected: the first returns **nothing** — both normative sites (`:1979`'s clap default and `:2298`'s `.env.example` value) were rewritten to the `/api` form in Step 10, and neither errata block quotes the bare URL, so a remaining hit means a site was missed. The second also returns nothing: `:2123`'s parenthesised spelling was rewritten. Both patterns are written so they do not match this plan's own command lines.

Then confirm Step 10(e)'s three sites were rewritten. Each pattern is anchored on the *surrounding* words rather than on `hello` alone, because the errata blocks deliberately quote `hello` several times and a bare `grep -c hello` would count them:

```bash
grep -c 're-sends `hello`. The \*\*peer connection' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
grep -c "\`hello\`'s \`agentId\`" docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
grep -c '`SignalMessage`, `ClientFrame`' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
```

Expected: `0`, `0`, `0`. Before Step 10(e) each returns `1` — ADR-12's old phrasing, ADR-13's old phrasing, and §7.5 row 2's types cell respectively. A non-zero count after the edit means an in-place rewrite did not land.

Two quoting notes, because both patterns are easy to get wrong:

- The first pattern must include `. The **peer connection` to disambiguate it from §5.5.5's `:1658`, which says "reconnects and re-sends `hello`" and is **deliberately preserved** by Step 10's errata. A pattern of just `and re-sends \`hello\`` matches both sites and returns `2`, which looks like a failure but is not.
- The second pattern uses double quotes so the shell passes the backticks through literally; inside single quotes they are literal too, but the `'` in `hello's` would terminate a single-quoted string. Do not "simplify" it to single quotes.

Do **not** try to verify this by enumerating every `grep -n 'hello'` hit. Before the edit the file has 16 such lines, and afterwards the count is neither 16 nor predictable: the errata blocks Step 8, 9 and 10 insert quote the word several times, while Step 10(e)'s rewrites remove it from ADR-12 and ADR-13. A word that appears in both the correction and the text being corrected cannot be counted. The three anchored greps above are the decisive check — each targets one specific site and must go to zero.

`ClientFrame` is a code token rather than a common word, so there the check is decisive — but only if it targets the *code*, not the identifier. Three `ClientFrame` hits survive this task **by design**, and all three are prose that names the frame to explain that it is gone:

1. Step 8's §5.5.1 errata — "There is no `ClientFrame`".
2. §5.5.2's bullet at `:1599`, which Step 10(d)'s errata deliberately preserves as the design record of the reversed decision.
3. Step 10(d)'s errata itself, which quotes that bullet.

So a bare count of 3 is correct, and a count of 0 would mean the errata was lost. The check that catches a *missed site* is narrower — the two places where `ClientFrame` appeared as a **type**, not as a mention:

```bash
grep -n 'pub enum ClientFrame' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
grep -n '`SignalMessage`, `ClientFrame`' docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md
```

Expected: nothing from either. The first is the §5.5.1 enum definition (`:1577` before the edit), the second is §7.5's table cell (`:2363`). Both must be gone; neither is quoted by any errata, so neither pattern can match the correction text.

- [ ] **Step 14: Confirm no code was touched**

```bash
git status --short
```

Expected: exactly three files — `docs/ARCHITECTURE.md`, the spec, and this plan. If a source file appears, this task has overstepped: every change here is prose.

- [ ] **Step 15: Run the repository gate**

```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```

Expected: exit 0, **164 passing JS tests**, Rust suite green. `docs` and `.superpowers` are both in `.prettierignore` (lines 7 and 10), so `format:check` does not read either document — this gate confirms that the plan file's own Step 11 edit disturbed nothing and that no code was accidentally touched.

- [ ] **Step 16: Commit**

```bash
git add docs/ARCHITECTURE.md docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md
git commit -m "docs: sync architecture and Week 5 spec with the shipped agent contract"
```

Then confirm the union landed, the roadmap is still unticked, and the spec carries its errata:

```bash
git show HEAD --stat
git show HEAD -- docs/ARCHITECTURE.md | grep -c '^+.*AgentSocketMessage'
git show HEAD -- docs/ARCHITECTURE.md | grep -c '^+.*- \[x\]'
git show HEAD -- docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md | grep -c '^+.*Errata'
```

Expected: three files changed; a non-zero `AgentSocketMessage` count; `0` for ticked boxes; `3` for errata blocks.
