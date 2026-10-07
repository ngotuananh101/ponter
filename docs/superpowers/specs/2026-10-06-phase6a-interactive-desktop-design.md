# Phase 6a: Interactive Desktop — Design Spec

- **Date:** 2026-10-06
- **Status:** Design approved by owner (2026-10-06, 5 decisions locked), pending written review
- **Baseline:** `main` @ `db71f65` (PR #48 merged)
- **Schedule:** Tuần 17 — Phase 6 is split in two: **6a Interactivity** (this spec) then **6b Latency** (own spec + plan)
- **Related:** Phase 5 spec `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§3.5, §8); WS1 Rust doc `docs/security/2026-10-08-ws1-e2ee-rust.md` (C1 carry-forward, "Mandatory carry-forward"); Week 9 spec ADR-26..30; `docs/ARCHITECTURE.md` §8 Phase 6 stub

---

## 1. Why Phase 6a, and what "done" means here

Phase 5 closed WS1–WS5 (E2EE, peer identity, session hardening, auth, ops polish) but left one
**hard carry-forward**: C1 — the desktop path never runs `verify_offer_identity`. The WS1 Rust
doc states the ruling verbatim: *"extend the identity verification performed by
`verify_offer_identity` (or an equivalent check) to the desktop path **before Phase 6 opens the
input-forwarding gate**."* Recon at `db71f65` shows the gap is broader than the memory note:
the **files** arm has the same shape (`main.rs:988` returns before the terminal-only verify at
`main.rs:1025`), so an unverified peer can currently open desktop **and** files sessions.

Phase 6a closes C1 for every session mode, opens the ADR-29 input gate behind a **two-gate
model** (operator opt-in AND verified identity), adds an agent-side input rate cap, publishes a
`peerVerified` fact to the UI, and measures the input-latency baseline Phase 6b needs.

**Done means:**

1. An offer without a valid identity proof is refused for **every** mode — desktop, files,
   terminal, and unknown — with no answer of any kind sent, and the E2E suite pins it.
2. Input injection requires **both** gates: the agent-local `--allow-input` flag AND a verified
   peer. Neither is settable by the remote peer. The operator keeps a view-only override.
3. A flooding peer is capped at the agent (120 Hz), independent of the browser's own 60 Hz
   coalescing.
4. The browser learns `peerVerified` on the wire and renders a verified badge plus an explicit
   control-status line.
5. The control-path latency baseline (browser send → agent inject) is measured and recorded for
   6b.

## 2. Current state, re-verified against the tree at `db71f65`

| # | Fact | Evidence |
|---|------|----------|
| 1 | `verify_offer_identity` runs for **terminal only** | called once at `main.rs:1025`; the `Desktop` arm returns at `main.rs:971` and the `Files` arm at `main.rs:988`, both before it; `None` refuses at `main.rs:1007` |
| 2 | The browser **always** signs its offers | `packages/webrtc-core/src/connection.ts:205-216` builds the proof on every offer |
| 3 | Desktop/files E2E harness paths **always** pass identity | `buildPeerIdentity` in every `desktop.e2e.test.ts` / `files.e2e.test.ts` call; `openFilesPeer(transport, sessionId, identity?)` — only `identity.e2e.test.ts` opens a proof-less offer, and only for terminal |
| 4 | ADR-29 gate is agent-local, default OFF | `--allow-input` / `AGENT_ALLOW_INPUT`, `default_value_t = false` (`main.rs:119-129`); dispatcher at `main.rs:2139-2168`; `apply_if_allowed` gate check at `input.rs:191` |
| 5 | **No** agent-side rate limit exists | Week 9 spec §5.3: "a hostile peer that floods frames produces unbounded injector calls … Week 9 deliberately does not" |
| 6 | **No** positive signal on injection | success path logs nothing; only drops log (`debug`). ADR-27: a Wayland no-op returns `Ok` — a silent no-op is indistinguishable from success |
| 7 | `desktop-sources` payload = `{ sources, inputEnabled }` | `desktop.rs:1430-1441`; `packages/shared/src/types/desktop.ts:73-77`; normalized field-by-field in `packages/desktop-core/src/client.ts:253-271` |
| 8 | No latency knobs exist anywhere | WebCodecs, `playoutDelayHint`, jitter buffer, cursor prediction: all greenfield (6b) |

**Owner decisions locked (2026-10-06):** (1) split 6a Interactivity / 6b Latency; (2) two gates —
operator flag + identity; (3) hoist the verify for all three modes; (4) also add rate cap, UI
verified badge + control status, latency baseline; (5) an unverifiable offer refuses the **whole
session** (consistent with the terminal behaviour).

## 3. Architecture decisions (ADR-41 to ADR-44)

### ADR-41: Identity verification is an admission gate for every session mode

Move `verify_offer_identity(offer, &cfg.identity)?` from its terminal-only position
(`main.rs:1025`) to a **single call before the mode dispatch** — placed after `build_peer`
(≈`main.rs:945`, after the `pending` candidate buffer init) and **before the files-root gate**.
The rewritten comment replaces the old terminal-only block.

- **Fail-closed bail.** The `?` propagates out of `run_one_session`; the supervisor's session
  driver logs `tracing::warn!(error = %e, "session ended with an error")` (`main.rs:758-761`)
  with the error text ("offer carries no identity proof", "offer fingerprint does not match the
  SDP", …). **No answer of any kind is sent** — not even `approved: false` — so an
  unverifiable peer learns nothing about the agent.
- **Ordering is security-positive.** Identity first, then the files-root probe: an unverifiable
  peer never causes filesystem work (root resolution / canonicalize).
- **Per-mode behaviour after the hoist:**

  | Mode | Invalid/missing proof | Valid proof |
  |------|----------------------|-------------|
  | Terminal | bail, no answer | unchanged (answer + PTY) |
  | Desktop | bail, no answer | unchanged (answer + capture/encoder) |
  | Files | bail, no answer | unchanged (files-root gate still applies) |
  | None (unknown caps) | **changed:** bail, no answer (was: `approved:false` refusal) | unchanged (`refused: no recognised capability`) |

  The `None` change is deliberate: an unverifiable peer must not receive even a refusal. No test
  or client depends on the old combo (the browser always signs).
- **Non-regression argument.** Every desktop/files E2E path already carries a proof (fact #3);
  the only proof-less producer in the repo is `identity.e2e.test.ts`'s terminal test. The full
  E2E suite is the regression proof, and this phase adds proof-less negative tests for
  desktop/files so the new gate is pinned where it did not exist before.
- **Structural invariant.** `run_desktop_session` and `run_files_session` become reachable only
  post-verify. The `desktop-sources` frame emitted inside `run_desktop_session` can therefore
  assert `peerVerified: true` as a literal (ADR-42 §wire).

### ADR-42: Input requires two gates — operator opt-in AND verified identity

- **Gate A (operator, local):** `--allow-input` / `AGENT_ALLOW_INPUT`, default OFF. Unchanged
  from ADR-29; a remote peer cannot set it.
- **Gate B (identity, structural):** ADR-41 admission. The desktop dispatcher task — and thus
  every path that could inject — exists only inside a session that passed verification.
- Injection is possible iff **A open AND B passed**. Viewing is allowed post-B; the operator
  may leave input off (view-only override retained — the existing UI toggle).
- **Published to the viewer:** the `desktop-sources` payload gains `peerVerified: boolean`, so
  the UI states B explicitly instead of leaving it invisible. The frame is only ever emitted on
  an admitted session, so the agent sends `true` as a literal with a comment pinning the
  invariant; a unit test pins the field in both directions.
- **UI defense-in-depth:** the input toggle renders only when `desktopInputEnabled &&
  desktopPeerVerified` — the UI expresses both gates, not just the operator's.

### ADR-43: Agent-side input rate cap — fixed one-second window, 120 frames, constant

- New `InputRateLimiter` in `apps/agent/src/input.rs`: fixed window, `INPUT_RATE_CAP_HZ = 120`
  (a `const`, not a CLI flag — YAGNI; revisit only if a real workload needs tuning).
- **Why 120:** 2× the browser's 60 Hz coalescing (`client.ts` `inputRateLimitHz`), so a
  well-behaved client is never throttled while a flooding or hostile peer is capped. This is
  the hardening Week 9 §5.3 explicitly deferred.
- **Where:** in the dispatcher's `desktop-input` arm, **after** E2EE decrypt and the Gate-A
  check, **before** decode/inject. Per-session state, a plain local next to `injector`.
- **Observability:** a capped frame logs `tracing::debug!("dropping desktop-input: rate cap
  exceeded")` — same level and shape as every other drop path (`input disabled`, decrypt
  failure), so one convention covers all drops. The E2E flood test runs with `RUST_LOG=debug`.
- **Scope:** desktop input only. Terminal keystrokes ride the PTY path (ADR-26) and are not
  rate-capped in this phase.

### ADR-44: Input latency is observable per frame; 6b's baseline is measured from it

- A successful injection logs at **info**: `tracing::info!(delta_ms = <n>, "desktop-input
  applied")`, where `delta_ms = agent_receive_ms − envelope.timestamp` (the browser stamps
  `Date.now()` in `sendJson`; in E2E both sides share the host clock).
- **Why info, not debug:** today there is *no* positive signal at all (fact #6 — the ADR-27
  Wayland trap), and a production-observable delta is what makes the 6b baseline measurable
  outside CI. Volume is bounded by the ADR-43 cap (≤ 120 lines/s worst case; ~60/s for an
  ordinary drag). If it proves noisy in practice, a later change may demote it — recorded, not
  pre-optimized.
- **Data flow:** `decode_desktop_input` returns a `DecodedDesktopInput { event, timestamp_ms }`
  instead of a bare event, so the envelope timestamp is carried out of the single parse
  (no second parse in the hot path). `apply_if_allowed` logs on success using it.
- **Measurement protocol (E2E):** send 10 pointer-moves 100 ms apart, read the `delta_ms` values
  from the agent log, assert every value ≤ 1000 ms (loose regression guard, CI-safe), and emit
  a `console.log` summary (min/median/p90) that the demo doc records as the 6b baseline.
- **No new frame type.** The envelope `timestamp` field (already on every frame) is the source.

## 4. Scope decisions

### 4.1 Two gates with a view-only override (owner decision 2)

The operator can always watch without granting control: Gate A off ⇒ no toggle, no listeners,
the shipped default build stays inert (the Week 9 gate-closed contract is preserved verbatim).

### 4.2 An unverifiable offer refuses the whole session (owner decision 5)

Consistent with terminal since Week 13: no per-channel partial admission, no "view-only for
unverified peers" mode. Refusal happens at admission, before any resource is built.

### 4.3 Deferred to 6b (own spec): the latency pipeline

WebCodecs low-latency decode, `playoutDelayHint` / jitter-buffer tuning, client-side cursor
prediction, and the ADR-25 hardware-codec spike outcome are **out of scope** here. 6a only
*measures* the baseline those changes will be compared against.

### 4.4 Fixed cap, not adaptive

A constant 120 Hz is testable and sufficient; no config surface, no adaptive logic.

## 5. Wire, store, and UI changes (all additive)

| Layer | Change |
|-------|--------|
| Wire | `desktop-sources` payload gains `peerVerified: boolean` (camelCase). No new frame types. |
| Rust | `frame_desktop_sources(sources, input_enabled, peer_verified, timestamp_ms)`; call site in `run_desktop_session` (`main.rs:1935`) passes `true` with the ADR-42 invariant comment |
| TS types | `DesktopSourcesPayload` gains **required** `peerVerified: boolean` (`packages/shared/src/types/desktop.ts`) |
| Normalization | `packages/desktop-core/src/client.ts` dispatch: `peerVerified: payload?.peerVerified === true` — a pre-6a agent yields `false`, never `undefined` (same pattern as `inputEnabled`) |
| Store | `TabItem.desktopPeerVerified?: boolean`; the `onSources` handler records it (`apps/web/src/stores/terminal.ts`) |
| UI | `DesktopView.vue` footer: (a) a `data-test="desktop-peer-verified"` badge (ShieldCheck icon + "Verified peer", emerald) rendered iff `desktopPeerVerified === true`; (b) a `data-test="desktop-input-status"` line shown with the toggle: "Controlling" when local input is on, "View only" when the gate is open but local input is off; (c) the toggle renders only when `desktopInputEnabled && desktopPeerVerified` (ADR-42) |

No server, DB, or signaling changes. An old agent (no `peerVerified`) degrades to: badge hidden,
toggle hidden — no false claim in either direction.

## 6. Testing strategy

**Rust unit (deterministic math + shapes):**
- `InputRateLimiter`: admits exactly `max_per_sec` in one window; rolls over on the next;
  counts drops; first call never logs a spurious rollover.
- `decode_desktop_input`: returns the envelope timestamp alongside the event; existing decode
  assertions updated with `.map(|d| d.event)` (no semantic change).
- `frame_desktop_sources`: pins `peerVerified` in **both** directions (true and false).
- Existing `verify_offer_identity` unit tests stay as-is (function unchanged).

**E2E (cross-language, the load-bearing proofs):**
- New: desktop offer **without** proof ⇒ rejected (channel never opens) + agent log matches
  `/identity proof/`.
- New: files offer **without** proof (with a valid `--files-root`, to isolate the cause) ⇒
  rejected + agent log matches `/identity proof/`.
- New: flood test — gate open under Xvfb, burst of pointer-moves ⇒ agent log shows ≥ 1
  `desktop-input applied` **and** ≥ 1 `rate cap exceeded` (exact 120/window math lives in the
  unit test; the E2E proves the cap is wired and engages).
- New: latency test — 10 moves ⇒ every `delta_ms ≤ 1000`, summary logged for the demo doc.
- **Non-regression:** every existing suite (all carry proofs) must stay green — that is the
  ADR-41 regression proof.

**Web unit:**
- `packages/desktop-core/test/client.test.ts`: normalization (missing `peerVerified` ⇒ false);
  the `toEqual` payload test gains the field.
- `apps/web/src/__tests__/terminal-store.test.ts`: the sources handler records
  `desktopPeerVerified`.
- `apps/web/src/__tests__/DesktopView.test.ts`: badge renders iff true; status line reads
  "Controlling" / "View only"; toggle hidden without `peerVerified`.
- `packages/shared/test/desktop-types.test.ts`: payload carries both flags.

**Local verification includes `pnpm format:check`** (Week 12 carry-forward: a plan §Verification
that omitted it turned CI red) plus `cargo fmt --check` / `clippy -D warnings` / `cargo test
--locked` and the full Vitest suites.

**Sonar:** new code must stay non-duplicated — parameterize tests, extract helpers (the Week
13/16 new-code duplication gotcha).

## 7. Risks and stop conditions

- **R1 — a hidden proof-less producer regresses a live path.** Recon found none (browser and
  both harnesses always sign). Mitigation: the full E2E suite is the non-regression proof; stop
  if any existing E2E test fails for a reason other than the intended refusals.
- **R2 — info-level log volume** (~60 lines/s while interacting). Bounded by the ADR-43 cap;
  accepted for 6a's baseline measurement; demotion to `debug` is a recorded future option.
- **R3 — CI timing flakiness** on the latency/flood tests. Bounds are loose by design
  (≤ 1000 ms; ≥ 1 each); exact math is pinned in Rust unit tests.
- **R4 — version skew** (pre-6a agent): normalized to `peerVerified: false`; badge and toggle
  hidden; no false claim, no behaviour change to the wire.

## 8. Definition of done — exit gates

1. **ADR-41:** proof-less offers refused for desktop, files, terminal, and unknown modes; E2E
   pins desktop + files; terminal's existing test still passes; full E2E suite green.
2. **ADR-42:** default build injects nothing (Week 9 gate-closed contract); `--allow-input` +
   verified peer injects; the UI toggle requires both flags.
3. **ADR-43:** the flood E2E engages the cap; unit tests pin 120/window exactly.
4. **ADR-44:** `delta_ms` present on every successful injection; baseline numbers recorded in
   the demo doc.
5. **UI:** badge + control status render per the contract; all web unit tests green.
6. **Docs:** `docs/ARCHITECTURE.md` §8 Phase 6a rows updated; the WS1 Rust doc's C1
   carry-forward marked closed by 6a; `docs/guides/agent-setup.md` gains the input-gate section
   (two gates, how to enable, what the peer must prove).
7. **CI 11/11 green** (4 required + Build Agent Verify + 6 platform builds), Sonar new-code
   duplication clean.

## 9. Explicitly out of scope

- 6b: WebCodecs, `playoutDelayHint`/jitter tuning, cursor prediction, ADR-25 codec spike.
- Windows/macOS runtime injection and Wayland injection (recorded limitations, unchanged).
- Multi-session support; terminal-tab verified badge; server/DB changes.
- Phase 5 deferred minors (T6b F6/F7/F8, T7 M1/M2/M3, T5-M6, `requiresApproval` dead export) —
  tracked separately, untouched here.
