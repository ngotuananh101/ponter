# Phase 6a — Interactive Desktop (ADR-41..44) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the C1 carry-forward by making peer-identity verification an admission gate for every session mode (ADR-41), open the input-forwarding gate behind two gates (operator `--allow-input` AND verified identity, ADR-42), cap a flooding peer at the agent (ADR-43), and publish a per-frame latency baseline for Phase 6b (ADR-44).

**Architecture:** One Rust-side hoist moves `verify_offer_identity` from the terminal-only position to a single call before the mode dispatch in `run_one_session`, so Desktop, Files, Terminal, and unknown-capability offers all fail closed with no answer of any kind. On top of that admission gate, the desktop dispatcher gains a fixed-window `InputRateLimiter` (120 frames/s) and a success log carrying `delta_ms = agent_receive_ms − envelope.timestamp`; `decode_desktop_input` returns a `DecodedDesktopInput { event, timestamp_ms }` so the timestamp leaves the single parse. The `desktop-sources` payload gains `peerVerified: boolean` (sent as a structural literal `true`), which the TS client normalizes field-by-field and the web UI renders as a verified badge plus a "Controlling"/"View only" status line. All wire changes are additive; no server, DB, or signaling changes.

**Tech Stack:** Rust (agent: `tokio`, `serde_json`, `tracing`, `enigo`), TypeScript/Vitest (`@ponter/shared`, `@ponter/desktop-core`), Vue 3 + Pinia (web), cross-language Vitest E2E (`werift` + real agent binary under Xvfb).

**Spec:** `docs/superpowers/specs/2026-10-06-phase6a-interactive-desktop-design.md` (§3 ADR-41..44, §5 wire/store/UI table, §6 testing strategy, §8 exit gates)

## Global Constraints

- **Two gates, both required for injection:** Gate A = `--allow-input` / `AGENT_ALLOW_INPUT` (agent-local, default `false`, a remote peer cannot set it); Gate B = identity verified at admission (ADR-41, structural). The shipped default build injects nothing — the Week 9 gate-closed contract is preserved verbatim.
- **All wire changes are additive.** No new frame types; no server, DB, or signaling changes. A pre-6a agent (no `peerVerified`) must degrade to badge hidden + toggle hidden — no false claim in either direction.
- **ADR-43 cap:** `INPUT_RATE_CAP_HZ = 120` as a `const` (no CLI flag), fixed one-second window, checked in the dispatcher's `desktop-input` arm after E2EE decrypt and the Gate-A check, before decode/inject. Desktop input only (terminal keystrokes unchanged).
- **ADR-44 logging:** success logs at `info` with field `delta_ms`; `delta_ms = (now_ms − envelope.timestamp).max(0)` — a zero or future envelope timestamp logs `0`, never a negative delta or a panic.
- **No answer for an unverifiable peer:** ADR-41 bails with `?` — not even `approved: false`. The `SessionMode::None` combination changes deliberately (was `approved:false` refusal; now bail-no-answer). No client depends on the old combo (the browser always signs).
- **Local verification MUST include `pnpm format:check`** (Week 12 carry-forward gotcha: a plan that omitted it turned CI red) plus `cargo fmt --check` / `cargo clippy --all-targets --locked -- -D warnings` / `cargo test --locked`.
- **Sonar new-code duplication gate** (Weeks 13/16 gotcha): parameterize tests, extract helpers — never suppress. Test counts must not drop.
- **UI rule (owner, absolute):** never hand-modify `apps/web/src/components/ui/` (generated shadcn-vue; byte-identity with registry `reka-vega` is the sole anti-drift guard). All new chrome goes in `DesktopView.vue` outside `ui/`.
- **E2E runs are exclusive:** port 8787, one file at a time (`fileParallelism: false`); needs a freshly built agent binary and `DISPLAY=:99` (Xvfb) for the injection tests.
- **Language:** code, identifiers, commit messages, PR text in English; docs follow each file's own convention (`docs/ARCHITECTURE.md` and `docs/guides/agent-setup.md` are Vietnamese; security notes and demo docs are English).
- **Commits are path-limited:** `git commit -m "<msg>" -- <exact paths>`; never `git add .`.

## Review Focus

The five input classes / failure modes most likely to bite a user, each pinned by a test in the owning task:

1. **Version skew — a pre-6a agent omits `peerVerified`.** Expected: the client normalizes to `false`, the badge is hidden, and the input toggle is hidden (no verified claim, no control offer). Tests: Task 5 (normalization), Task 6 (badge/toggle).
2. **Gate A open but the peer unverified.** Expected: no toggle, no status line — the UI expresses both gates, not just the operator's. Test: Task 6.
3. **A flooding peer while the gate is open.** Expected: the cap engages (drops logged) but the session survives — a frame in the next window still injects. Test: Task 8 (post-burst frame).
4. **A zero or future envelope timestamp.** Expected: carried verbatim by the decode; the delta arithmetic saturates (logs `0`, never negative) and never panics. Test: Task 3.
5. **The `peerVerified: true` literal must be structural, not optimistic.** Expected: pinned in both directions by a Rust unit test, and read back off the live agent frame in E2E. Tests: Task 4, Task 8.

## File map

| File | Responsibility | Task |
|------|----------------|------|
| `apps/agent/src/main.rs` | Hoist `verify_offer_identity` (T1); wire `InputRateLimiter` into the dispatcher (T2); update the decode test (T3); pass `true` to `frame_desktop_sources` (T4) | 1-4 |
| `apps/agent/src/input.rs` | `InputRateLimiter` + unit tests (T2); `DecodedDesktopInput` + `info!` success log + decode-test updates (T3) | 2-3 |
| `apps/agent/src/desktop.rs` | `frame_desktop_sources` gains `peer_verified`; unit test pins both directions (T4) | 4 |
| `packages/shared/src/types/desktop.ts` | `DesktopSourcesPayload.peerVerified: boolean` (required) (T5) | 5 |
| `packages/shared/test/desktop-types.test.ts` | Payload carries both flags (T5) | 5 |
| `packages/desktop-core/src/client.ts` | Normalize `peerVerified: payload?.peerVerified === true` (T5) | 5 |
| `packages/desktop-core/test/client.test.ts` | `toEqual` payloads gain the field; normalize-missing test (T5) | 5 |
| `apps/web/src/stores/terminal.ts` | `TabItem.desktopPeerVerified` + `onSources` records it (T6) | 6 |
| `apps/web/src/components/desktop/DesktopView.vue` | Badge + status line; toggle requires both flags (T6) | 6 |
| `apps/web/src/__tests__/terminal-store.test.ts` | Handler type + `emitSources` + `desktopPeerVerified` test (T6) | 6 |
| `apps/web/src/__tests__/DesktopView.test.ts` | Fixtures gain `desktopPeerVerified`; badge/status/gating tests (T6) | 6 |
| `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` | Proof-less refusal (T7); flood cap (T8); latency baseline (T9) | 7-9 |
| `packages/webrtc-core/test/e2e/files.e2e.test.ts` | Proof-less refusal with a valid root (T7) | 7 |
| `docs/ARCHITECTURE.md` | §8 Phase 6 split into 6a (done) / 6b (pending) (T10) | 10 |
| `docs/security/2026-10-08-ws1-e2ee-rust.md` | C1 carry-forward marked closed by ADR-41 (T10) | 10 |
| `docs/guides/agent-setup.md` | `--allow-input` option + `AGENT_ALLOW_INPUT` env + two-gate note (T10) | 10 |
| `docs/demos/2026-10-07-phase6a-interactive-desktop-demo.md` | Demo walkthrough + measured baseline numbers (T10) | 10 |

---

### Task 1: ADR-41 — hoist `verify_offer_identity` to an admission gate for every mode

**Files:**
- Modify: `apps/agent/src/main.rs:945-1025` (move the call; rewrite the comment block)
- Test: `apps/agent/src/main.rs` (existing unit tests must stay green — this task adds no new test; the E2E proof lands in Task 7)

**Interfaces:**
- Consumes: `verify_offer_identity(offer: &signal::SignalOffer, identity: &identity::AgentIdentity) -> Result<()>` (`main.rs:787-817`, unchanged); `cfg.identity: identity::AgentIdentity`; `rtc::refuse_offer` (unchanged, still used by the files-root and `None` paths).
- Produces: the structural invariant every later task relies on — `run_desktop_session` / `run_files_session` / the terminal setup are reachable **only** after a successful verify. Task 4's `peer_verified = true` literal and Task 7's E2E refusals both depend on this placement.

**Current shape (verified at `db7f165`):** the verify sits at `main.rs:1025`, *after* the `match mode` dispatch (`main.rs:964-1014`) whose `Desktop` arm returns at :970, `Files` at :988, and `None` refuses at :1007 — so only `Terminal` ever reaches it.

- [ ] **Step 1: Move the call.** In `apps/agent/src/main.rs`, cut this block (currently at :1016-1025):

```rust
    // H3 security gate (Task 9): verify the user's identity proof on the offer
    // BEFORE the agent sends its answer, so the browser never learns the
    // session was accepted when the proof was missing or tampered. Both PTY
    // spawn sites live in the dispatcher task (below), which is only fed by the
    // poll task spawned after the channel opens; gating the answer itself gates
    // every downstream path: a tampered/missing proof bails before
    // `rtc::answer_offer`, the answer SDP is never sent, the browser aborts the
    // handshake, and no PTY is ever created. Fail-closed: on error we bail out
    // of the session entirely before sending any SDP.
    verify_offer_identity(offer, &cfg.identity)?;

    rtc::answer_offer(&peer, offer, outbound, &cfg.identity).await?;
```

and paste the **call** (with the rewritten ADR-41 comment below) into the gap between the `pending` buffer init (`let mut pending: ...` at ≈:945) and the files-root gate (`let files_root = if mode == SessionMode::Files {` at ≈:949). `rtc::answer_offer(...)` stays exactly where it is today (terminal flow, after the `match mode` block).

- [ ] **Step 2: Write the replacement comment.** The moved call reads:

```rust
    // ADR-41 (Phase 6a): identity verification is an ADMISSION gate for every
    // session mode, not a terminal-only step. It runs here — after the peer is
    // built, before the files-root probe and before the mode dispatch — so an
    // unverifiable offer is refused before any resource (filesystem root
    // resolution, capture pipeline, PTY) is touched. Fail-closed: the `?` bails
    // out of `run_one_session` with NO answer of any kind — not even
    // `approved: false` — so a peer without a valid proof learns nothing. The
    // supervisor logs the error text (main.rs driver loop). Desktop and Files
    // previously returned at :970/:988 before the old terminal-only call at
    // :1025 and were therefore never verified (carry-forward C1, WS1 Rust doc).
    verify_offer_identity(offer, &cfg.identity)?;
```

- [ ] **Step 3: Re-verify ordering by reading the result.** The function body from ≈:938 must read in this order: `build_peer` → `pending` init → **`verify_offer_identity`** → files-root gate → `match mode` (Desktop/Files/None arms unchanged) → `Terminal` fall-through → `rtc::answer_offer`. Run:

```bash
grep -n "verify_offer_identity\|let files_root\|match mode\|answer_offer" apps/agent/src/main.rs | head -20
```

Expected: `verify_offer_identity` appears at the hoisted line (≈946) — the call inside `run_one_session`; the grep also shows the function definition at :787 and the terminal comment line. No second call site.

- [ ] **Step 4: Run the Rust unit tests.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: PASS — in particular the five `verify_offer_identity` unit tests (`main.rs:3125-3222`) are untouched by the move.

- [ ] **Step 5: Check fmt and clippy.**

Run: `cargo fmt --manifest-path apps/agent/Cargo.toml --check && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: both clean.

- [ ] **Step 6: Commit.**

```bash
git commit -m "feat(agent): hoist peer-identity verification to an admission gate (ADR-41)" -- apps/agent/src/main.rs
```

### Task 2: ADR-43 — `InputRateLimiter` in `input.rs` + dispatcher wiring

**Files:**
- Modify: `apps/agent/src/input.rs` (new struct + unit tests at the end of the `tests` module)
- Modify: `apps/agent/src/main.rs:2074-2170` (declare the limiter next to `injector`; check it in the `desktop-input` arm)
- Test: `apps/agent/src/input.rs` (tests module)

**Interfaces:**
- Consumes: nothing new from Task 1 (independent), `crate::pty::now_ms() -> i64` (existing).
- Produces: `pub const INPUT_RATE_CAP_HZ: u32 = 120;` and `pub struct InputRateLimiter { ... }` with `pub fn new(max_per_sec: u32) -> Self` and `pub fn allow(&mut self, now_ms: i64) -> bool`. Task 8's E2E flood test depends on the exact drop log line produced here.

- [ ] **Step 1: Write the failing tests.** Append to the `tests` module in `apps/agent/src/input.rs` (after `injector_error_is_fail_soft`):

```rust
    #[test]
    fn rate_limiter_admits_exactly_the_cap_in_one_window() {
        let mut limiter = super::InputRateLimiter::new(120);
        // A fixed window admits exactly 120 frames, then drops.
        let admitted = (0..120).filter(|_| limiter.allow(1_000)).count();
        assert_eq!(admitted, 120);
        assert!(!limiter.allow(1_000));
    }

    #[test]
    fn rate_limiter_rolls_over_on_the_next_window() {
        let mut limiter = super::InputRateLimiter::new(120);
        for _ in 0..120 {
            assert!(limiter.allow(1_000));
        }
        assert!(!limiter.allow(1_999)); // still window 0
        assert!(limiter.allow(2_000)); // window 1
    }

    #[test]
    fn rate_limiter_first_call_never_logs_a_spurious_rollover() {
        // A limiter starting at now=0 must admit on the very first call — the
        // window-0 initialization must not treat 0 as "rolled over".
        let mut limiter = super::InputRateLimiter::new(1);
        assert!(limiter.allow(0));
        assert!(!limiter.allow(0));
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked input::tests::rate_limiter -- --nocapture`
Expected: FAIL to compile — `InputRateLimiter` not found.

- [ ] **Step 3: Implement.** Add near the top of `apps/agent/src/input.rs` (after the `DesktopInputWire` enum, before `clamp01`):

```rust
/// ADR-43: agent-side cap on accepted `desktop-input` frames per fixed
/// one-second window. 120 = 2× the browser's 60 Hz coalescing
/// (`desktop-core` `inputRateLimitHz`), so a well-behaved client is never
/// throttled while a flooding peer is capped. A `const`, not a CLI flag
/// (YAGNI); revisit only if a real workload needs tuning.
pub const INPUT_RATE_CAP_HZ: u32 = 120;

/// Fixed-window rate limiter for `desktop-input` frames (ADR-43).
///
/// `allow(now_ms)` admits at most `max_per_sec` calls whose `now_ms` falls in
/// the same one-second window (`now_ms / 1000`); the first call of a new
/// window resets the count. Deterministic and clock-injectable, so the exact
/// 120/window math is unit-testable without a display or a real clock.
pub struct InputRateLimiter {
    max_per_sec: u32,
    window_index: i64,
    count: u32,
}

impl InputRateLimiter {
    pub fn new(max_per_sec: u32) -> Self {
        Self {
            max_per_sec,
            window_index: -1, // no window yet: the first call always initializes
            count: 0,
        }
    }

    /// Returns `true` iff the frame is admitted. A `false` means the caller
    /// must drop the frame (the dispatcher logs the drop at `debug`).
    pub fn allow(&mut self, now_ms: i64) -> bool {
        let window = now_ms.div_euclid(1_000);
        if window != self.window_index {
            self.window_index = window;
            self.count = 0;
        }
        if self.count >= self.max_per_sec {
            return false;
        }
        self.count += 1;
        true
    }
}
```

- [ ] **Step 4: Wire the dispatcher.** In `apps/agent/src/main.rs`, next to `let mut injector: Option<Box<dyn input::InputInjector>> = None;` (≈:2076) add:

```rust
        // ADR-43: per-session fixed-window cap on accepted input frames.
        let mut input_limiter = input::InputRateLimiter::new(input::INPUT_RATE_CAP_HZ);
```

and in the `desktop-input` arm, **after** the E2EE decrypt block, make the limiter the **first statement inside the `if allow_input {` block** (ADR-43's order: after decrypt AND after the Gate-A check, before decode/inject — a frame the gate already drops must not spend rate budget):

```rust
                            if allow_input {
                                // ADR-43: cap AFTER decrypt and the Gate-A
                                // check, BEFORE decode/inject. The drop log
                                // matches every other drop path.
                                if !input_limiter.allow(crate::pty::now_ms()) {
                                    tracing::debug!("dropping desktop-input: rate cap exceeded");
                                    continue;
                                }
                                if injector.is_none() {
```

- [ ] **Step 5: Run to verify pass.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked input:: -- --nocapture`
Expected: PASS — the three new limiter tests plus all existing `input::tests`.

- [ ] **Step 6: Check fmt and clippy, then commit.**

Run: `cargo fmt --manifest-path apps/agent/Cargo.toml --check && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`

```bash
git commit -m "feat(agent): cap desktop-input at 120 Hz fixed window (ADR-43)" -- apps/agent/src/input.rs apps/agent/src/main.rs
```

### Task 3: ADR-44 — `DecodedDesktopInput` carries the envelope timestamp; `info!` success log

**Files:**
- Modify: `apps/agent/src/input.rs` (`decode_desktop_input` return type; `apply_if_allowed` signature + success log; all decode test assertions)
- Modify: `apps/agent/src/main.rs:3288-3296` (the E2EE decode test's assertion) and `main.rs:3368` (`apply_if_allowed` call in the gate-closed test)
- Test: `apps/agent/src/input.rs` tests module; `apps/agent/src/main.rs` E2EE test

**Interfaces:**
- Consumes: Task 2's limiter (independent — no interaction), `crate::pty::DataChannelMessage.timestamp: i64` (existing).
- Produces: `pub struct DecodedDesktopInput { pub event: DesktopInput, pub timestamp_ms: i64 }`; `pub fn decode_desktop_input(raw: &str) -> Result<Option<DecodedDesktopInput>>`; `pub fn apply_if_allowed(allow_input: bool, raw: &str, source: &DesktopSourceInfo, injector: &mut dyn InputInjector, now_ms: i64) -> bool`. Task 9's E2E latency test reads the `delta_ms` field this produces.

- [ ] **Step 1: Write the failing tests.** In `apps/agent/src/input.rs` tests, add:

```rust
    #[test]
    fn decode_returns_the_envelope_timestamp_alongside_the_event() {
        // The frame() helper stamps `timestamp: 0`; a dedicated frame pins a
        // non-zero value so a swap of the two fields cannot pass.
        let raw = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "kind": "pointer-move", "x": 0.25, "y": 0.5 },
            "timestamp": 1_726_000_000_123_i64,
        })
        .to_string();
        let decoded = decode_desktop_input(&raw).unwrap().unwrap();
        assert_eq!(decoded.timestamp_ms, 1_726_000_000_123);
        assert_eq!(decoded.event, DesktopInput::PointerMove { x: 0.25, y: 0.5 });
    }

    #[test]
    fn zero_timestamp_is_carried_verbatim() {
        // Envelope timestamps are attacker-influenced; 0 must decode as 0,
        // not as a sentinel or an error.
        let decoded = decode_desktop_input(&frame(
            serde_json::json!({ "kind": "pointer-move", "x": 0.0, "y": 0.0 }),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(decoded.timestamp_ms, 0);
    }

    #[test]
    fn apply_clamps_a_future_timestamp_to_a_zero_delta() {
        // A timestamp in the future (clock skew / hostile peer) would make the
        // delta negative; it must clamp to 0, never go negative or panic.
        let future = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "kind": "pointer-move", "x": 0.5, "y": 0.5 },
            "timestamp": 5_000,
        })
        .to_string();
        let mut injector = CountingInjector::default();
        // now_ms = 1_000 < timestamp 5_000 → the raw delta is -4000.
        let applied = apply_if_allowed(true, &future, &source(), &mut injector, 1_000);
        assert!(applied);
        assert_eq!(
            injector
                .pointer_moves
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked input::tests::decode_returns -- --nocapture`
Expected: FAIL to compile — `DecodedDesktopInput` not found / arity mismatch on `apply_if_allowed`.

- [ ] **Step 3: Implement the type and the return change.** In `apps/agent/src/input.rs`, add after the `DesktopInput` enum:

```rust
/// One decoded input frame: the event plus the envelope's `timestamp`
/// (browser `Date.now()` ms). ADR-44 carries the timestamp out of the single
/// parse so the success path can log `delta_ms` without re-parsing the frame.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedDesktopInput {
    pub event: DesktopInput,
    pub timestamp_ms: i64,
}
```

Change the signature to `pub fn decode_desktop_input(raw: &str) -> Result<Option<DecodedDesktopInput>>`, and wrap the returned event:

```rust
    let event = match wire {
        // ... the existing five arms, unchanged ...
    };
    Ok(Some(DecodedDesktopInput {
        event,
        timestamp_ms: envelope.timestamp,
    }))
```

(concretely: keep the five `DesktopInputWire::*` arms as they are today but bind them to `event` instead of returning directly from the `Ok(Some(match ...))`.)

- [ ] **Step 4: Update `apply_if_allowed`.** New signature and body changes:

```rust
pub fn apply_if_allowed(
    allow_input: bool,
    raw: &str,
    source: &DesktopSourceInfo,
    injector: &mut dyn InputInjector,
    now_ms: i64,
) -> bool {
    if !allow_input {
        tracing::debug!("dropping desktop-input: input disabled");
        return false;
    }
    let decoded = match decode_desktop_input(raw) {
        Ok(Some(decoded)) => decoded,
        Ok(None) => return false,
        Err(e) => {
            tracing::debug!(error = %e, "dropping a malformed desktop-input frame");
            return false;
        }
    };
    let result = match decoded.event {
        // ... the existing five arms, unchanged ...
    };
    match result {
        Ok(()) => {
            // ADR-44: the positive injection signal. `.max(0)` keeps a
            // zero/future envelope timestamp from logging a negative delta
            // (the envelope timestamp is attacker-influenced); `now_ms` is
            // passed in so the caller keeps the clock seam testable.
            tracing::info!(
                delta_ms = (now_ms - decoded.timestamp_ms).max(0),
                "desktop-input applied"
            );
            true
        }
        Err(e) => {
            tracing::debug!(error = %e, "dropping desktop-input after an injector error");
            false
        }
    }
}
```

- [ ] **Step 5: Update every call site and assertion.** In `apps/agent/src/main.rs`:

  - the dispatcher call (≈:2163) gains the clock argument:
    ```rust
    input::apply_if_allowed(
        allow_input, text, &current_source, injector.as_mut(),
        crate::pty::now_ms(),
    );
    ```
  - the E2EE decode test (≈:3288) becomes:
    ```rust
    let decoded = crate::input::decode_desktop_input(&decrypted)
        .expect("decode")
        .expect("event");
    assert!(
        matches!(
            decoded.event,
            crate::input::DesktopInput::PointerMove { x: 0.5, y: 0.25 }
        ),
        "decoded = {decoded:?}"
    );
    ```
  - the gate-closed test (≈:3368) becomes `crate::input::apply_if_allowed(false, &raw, &source, &mut injector, 0)`.

  In `apps/agent/src/input.rs` tests, every existing `decode_desktop_input(...).unwrap().unwrap()` that compares an event becomes `.map(|d| d.event)` or `decoded.event`; e.g. `decodes_every_kind`'s five assertions, `clamps_normalized_coordinates_at_decode`, and the three `apply_if_allowed(...)` calls gain a trailing `0` argument. `ignores_a_foreign_channel_or_type` keeps comparing `unwrap()` to `None` (the `Option` shape is unchanged).

- [ ] **Step 6: Run to verify pass.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: PASS — all of `input::tests`, the E2EE round-trip test, and the gate-closed dispatcher test.

- [ ] **Step 7: Check fmt and clippy, then commit.**

Run: `cargo fmt --manifest-path apps/agent/Cargo.toml --check && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`

```bash
git commit -m "feat(agent): carry the envelope timestamp and log delta_ms per applied input (ADR-44)" -- apps/agent/src/input.rs apps/agent/src/main.rs
```

### Task 4: ADR-42 (wire) — `frame_desktop_sources` gains `peerVerified: true` literal

**Files:**
- Modify: `apps/agent/src/desktop.rs:1430-1441` (`frame_desktop_sources` signature + payload)
- Modify: `apps/agent/src/desktop.rs:2195-2213` (unit test pins both directions)
- Modify: `apps/agent/src/main.rs:1932-1935` (call site passes `true` with the invariant comment)
- Test: `apps/agent/src/desktop.rs` tests module

**Interfaces:**
- Consumes: Task 1's structural invariant (the frame is only ever emitted on a verified session, so `true` is a fact, not an assumption).
- Produces: `pub fn frame_desktop_sources(sources: &[DesktopSourceInfo], input_enabled: bool, peer_verified: bool, timestamp_ms: i64) -> String` emitting payload `{ "sources": ..., "inputEnabled": ..., "peerVerified": ... }` (camelCase). Task 5's TS type and Task 8's E2E read this field.

- [ ] **Step 1: Update the failing unit test first.** Replace `frame_desktop_sources_carries_the_envelope_and_the_default_flag` in `apps/agent/src/desktop.rs` with:

```rust
    #[test]
    fn frame_desktop_sources_carries_the_envelope_and_the_default_flag() {
        let raw = frame_desktop_sources(&[test_source_info()], true, true, 7);
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["type"], "desktop-sources");
        assert_eq!(value["channel"], "control");
        assert_eq!(value["timestamp"], 7);
        assert_eq!(value["payload"]["sources"][0]["id"], "test:0");
        assert_eq!(value["payload"]["sources"][0]["default"], true);
        // The camelCase wire spelling, not the Rust field name.
        assert!(value["payload"]["sources"][0].get("scaleFactor").is_some());
        assert!(value["payload"]["sources"][0].get("scale_factor").is_none());
        // The ADR-29 gate as published to the viewer (§6.3), asserted to track
        // the argument in both directions — the shipped default is `false`, so
        // the frame the viewer actually receives must say so.
        assert_eq!(value["payload"]["inputEnabled"], true);
        let closed: serde_json::Value =
            serde_json::from_str(&frame_desktop_sources(&[test_source_info()], false, true, 7))
                .unwrap();
        assert_eq!(closed["payload"]["inputEnabled"], false);
        // ADR-42: `peerVerified` is pinned in BOTH directions. The production
        // call site passes the literal `true` (ADR-41 makes the frame
        // unreachable otherwise), but the framing function itself must render
        // whatever it is given — a hard-coded `true` inside the function would
        // make the `false` assertion below fail.
        assert_eq!(value["payload"]["peerVerified"], true);
        let unverified: serde_json::Value =
            serde_json::from_str(&frame_desktop_sources(&[test_source_info()], true, false, 7))
                .unwrap();
        assert_eq!(unverified["payload"]["peerVerified"], false);
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked desktop::tests::frame_desktop_sources -- --nocapture`
Expected: FAIL to compile — arity mismatch (3 args given, 4 expected).

- [ ] **Step 3: Implement.** In `apps/agent/src/desktop.rs`:

```rust
/// Frame the enumeration as a `desktop-sources` control message (spec §2.2).
///
/// Pure so the wire shape is unit-testable without a peer connection.
///
/// `input_enabled` is the ADR-29 gate (`cfg.allow_input`) published to the
/// viewer so the UI can say whether input is possible at all (§6.3) — it is
/// **not** what enforces the gate; the agent's own dispatcher is (§9).
///
/// `peer_verified` is ADR-42's Gate B as published to the viewer. The only
/// production call site passes the literal `true`: ADR-41 (Phase 6a) moved
/// `verify_offer_identity` before the mode dispatch, so this frame is
/// unreachable on a session whose peer was not verified. It stays a parameter
/// (not a hard-coded `true`) so the unit test can pin both directions.
pub fn frame_desktop_sources(
    sources: &[DesktopSourceInfo],
    input_enabled: bool,
    peer_verified: bool,
    timestamp_ms: i64,
) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-sources".to_string(),
        channel: "control".to_string(),
        payload: serde_json::json!({
            "sources": sources,
            "inputEnabled": input_enabled,
            "peerVerified": peer_verified,
        }),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of plain data cannot fail to serialize")
}
```

- [ ] **Step 4: Update the call site.** In `apps/agent/src/main.rs` (≈:1932-1935):

```rust
    // ADR-42: `true` is a structural fact, not an assumption — ADR-41 gates
    // admission on `verify_offer_identity`, so `run_desktop_session` (and thus
    // this frame) only runs on a session whose peer identity was verified.
    let sources_frame = desktop::frame_desktop_sources(
        &sources,
        cfg.allow_input,
        true,
        crate::pty::now_ms(),
    );
```

- [ ] **Step 5: Run to verify pass.**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked desktop::tests::frame_desktop_sources -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Full Rust gate, then commit.**

Run: `cargo fmt --manifest-path apps/agent/Cargo.toml --check && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings && cargo test --manifest-path apps/agent/Cargo.toml --locked`

```bash
git commit -m "feat(agent): publish peerVerified on desktop-sources (ADR-42 wire)" -- apps/agent/src/desktop.rs apps/agent/src/main.rs
```

### Task 5: TS wire — shared type + desktop-core normalization

**Files:**
- Modify: `packages/shared/src/types/desktop.ts:73-77`
- Modify: `packages/shared/test/desktop-types.test.ts` (the `carries inputEnabled alongside the Week 8 sources` test)
- Modify: `packages/desktop-core/src/client.ts:253-271`
- Modify: `packages/desktop-core/test/client.test.ts` (emit helper, `toEqual` payloads, new normalize test)
- Test: the two Vitest suites above

**Interfaces:**
- Consumes: Task 4's wire field (camelCase `peerVerified`).
- Produces: `DesktopSourcesPayload.peerVerified: boolean` (required); `DesktopClient.onSources` payloads always carry a boolean `peerVerified` (`false` when the field is absent). Task 6's store and view consume these.

- [ ] **Step 1: Write the failing shared-type test.** In `packages/shared/test/desktop-types.test.ts`, update the payload test:

```ts
  it('carries inputEnabled and peerVerified alongside the Week 8 sources', () => {
    const payload: DesktopSourcesPayload = {
      sources: [
        {
          id: 'monitor:1',
          kind: 'monitor',
          name: 'eDP-1',
          width: 1920,
          height: 1080,
          x: 0,
          y: 0,
          scaleFactor: 1,
          rotation: 0,
          isPrimary: true,
          default: true,
        },
      ],
      inputEnabled: false,
      peerVerified: true,
    };
    expect(payload.inputEnabled).toBe(false);
    expect(payload.peerVerified).toBe(true);
    expect(payload.sources[0]?.default).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @ponter/shared test`
Expected: FAIL to compile — `peerVerified` missing from `DesktopSourcesPayload`.

- [ ] **Step 3: Add the field.** In `packages/shared/src/types/desktop.ts`:

```ts
/**
 * The `desktop-sources` payload (Week 8 + the Week 9 additive `inputEnabled`
 * + the Phase 6a additive `peerVerified`). A pre-6a client that ignores the
 * extra field is unaffected (spec §2.2, Phase 6a ADR-42).
 */
export interface DesktopSourcesPayload {
  sources: DesktopSourceInfo[];
  /** True iff the agent's input gate is open (ADR-29). */
  inputEnabled: boolean;
  /**
   * True iff the agent verified this session's peer identity at admission
   * (Phase 6a ADR-41/42). The agent sends a structural literal `true`; a
   * pre-6a agent omits the field and the client normalizes to `false`.
   */
  peerVerified: boolean;
}
```

- [ ] **Step 4: Normalize in the client.** In `packages/desktop-core/src/client.ts`:

```ts
      case 'desktop-sources': {
        const payload = msg.payload as
          | Partial<DesktopSourcesPayload> | undefined;
        // Normalize to the Week 9 payload shape: a Week 8 agent that omits
        // `inputEnabled` yields `false` (the gate is closed), and a pre-6a
        // agent that omits `peerVerified` yields `false` (unverified) —
        // never `undefined`, so the UI can never render a false claim.
        const next: DesktopSourcesPayload = {
          sources: payload?.sources ?? [],
          inputEnabled: payload?.inputEnabled === true,
          peerVerified: payload?.peerVerified === true,
        };
```

- [ ] **Step 5: Update the desktop-core tests.** In `packages/desktop-core/test/client.test.ts`:

  - `emitSources` gains a third parameter defaulted to `false`:
    ```ts
    function emitSources(
      sources: Array<{ id: string; default: boolean }>,
      inputEnabled: boolean,
      peerVerified = false,
    ): void {
      currentEmitControl?.({
        type: 'desktop-sources',
        channel: 'control',
        payload: { sources, inputEnabled, peerVerified },
        timestamp: 1,
      });
    }
    ```
  - every inline `payload: { sources: ..., inputEnabled: ... }` passed to `emitControl` gains `peerVerified: false` (sites at ≈:264, 309, 315, 335, 374);
  - the two `toEqual` payload assertions (≈:320-321, ≈:381) gain `peerVerified: false`;
  - add one new test after `surfaces inputEnabled from the desktop-sources payload`:
    ```ts
    it('normalizes a missing peerVerified to false (pre-6a agent)', async () => {
      const { client, emitControl } = await connected();
      const seen: boolean[] = [];
      client.onSources((payload) => seen.push(payload.peerVerified));

      // A pre-6a agent: the field is absent entirely.
      emitControl({
        type: 'desktop-sources',
        channel: 'control',
        payload: {
          sources: [{ id: 'monitor:1', default: true }],
          inputEnabled: true,
        },
        timestamp: 1,
      });

      expect(seen).toEqual([false]);
      client.close();
    });
    ```

- [ ] **Step 6: Run to verify pass.**

Run: `pnpm --filter @ponter/shared test && pnpm --filter @ponter/desktop-core test`
Expected: PASS both.

- [ ] **Step 7: Typecheck + format, then commit.**

Run: `pnpm typecheck && pnpm format:check`

```bash
git commit -m "feat(wire): add peerVerified to desktop-sources payload and normalize it (ADR-42)" -- packages/shared/src/types/desktop.ts packages/shared/test/desktop-types.test.ts packages/desktop-core/src/client.ts packages/desktop-core/test/client.test.ts
```

### Task 6: FE — store field + verified badge + control status

**Files:**
- Modify: `apps/web/src/stores/terminal.ts:71-80` (TabItem) and `:863-871` (onSources handler)
- Modify: `apps/web/src/components/desktop/DesktopView.vue` (import `ShieldCheck`; toggle condition; badge; status line)
- Modify: `apps/web/src/__tests__/terminal-store.test.ts` (handler types, `emitSources`, new test)
- Modify: `apps/web/src/__tests__/DesktopView.test.ts` (fixtures + new tests)
- Test: the two web suites above

**Interfaces:**
- Consumes: Task 5's normalized payload (`peerVerified: boolean` always present).
- Produces: `TabItem.desktopPeerVerified?: boolean`; DOM contracts `data-test="desktop-peer-verified"` (badge, rendered iff `desktopPeerVerified === true`), `data-test="desktop-input-status"` (text "Controlling" when the local toggle is on, else "View only", rendered together with the toggle), and the toggle rendered iff `desktopInputEnabled && desktopPeerVerified`.

- [ ] **Step 1: Write the failing store test.** In `apps/web/src/__tests__/terminal-store.test.ts`:

  - widen the handler type at :31-33 and the mock at :52-60 to `{ sources: unknown[]; inputEnabled: boolean; peerVerified: boolean }`;
  - `emitSources` gains a third parameter and forwards it:
    ```ts
    function emitSources(
      sources: Array<{ id: string; default: boolean }>,
      inputEnabled = false,
      peerVerified = false,
    ): void {
      desktopSourcesHandler?.({ sources, inputEnabled, peerVerified });
    }
    ```
  - `openDesktopWithSources` gains a third parameter forwarded to `emitSources`;
  - add after `records desktopInputEnabled from the sources payload`:
    ```ts
    it('records desktopPeerVerified from the sources payload', async () => {
      const { store, tabId } = await openDesktopWithSources(
        [{ id: 'monitor:1', default: true }],
        true,
        true,
      );

      expect(store.tabs.find((t) => t.id === tabId)?.desktopPeerVerified).toBe(
        true,
      );
    });
    ```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @ponter/web test -- terminal-store`
Expected: FAIL — the emitted payload's `peerVerified` is not recorded (field stays `undefined`).

- [ ] **Step 3: Store change.** In `apps/web/src/stores/terminal.ts`:

  - `TabItem` (after `desktopInputEnabled`):
    ```ts
    /** Desktop tabs only: true iff the agent verified the peer identity (Phase 6a ADR-42). */
    desktopPeerVerified?: boolean;
    ```
  - the `onSources` handler gains one line after `tab.desktopInputEnabled = payload.inputEnabled;`:
    ```ts
    tab.desktopPeerVerified = payload.peerVerified;
    ```

- [ ] **Step 4: Write the failing view tests.** In `apps/web/src/__tests__/DesktopView.test.ts`:

  - fixtures that set `desktopInputEnabled: true` in order to assert a toggle must also set `desktopPeerVerified: true` (otherwise the toggle hides — that is the point of the gate);
  - add the new tests:
    ```ts
    it('renders the verified badge only when the peer is verified', () => {
      const verified = mountWithChrome({ desktopPeerVerified: true });
      expect(
        verified.find('[data-test="desktop-peer-verified"]').exists(),
      ).toBe(true);
      expect(
        verified.find('[data-test="desktop-peer-verified"]').text(),
      ).toContain('Verified peer');

      const unverified = mountWithChrome({ desktopPeerVerified: false });
      expect(
        unverified.find('[data-test="desktop-peer-verified"]').exists(),
      ).toBe(false);
      const missing = mountWithChrome();
      expect(
        missing.find('[data-test="desktop-peer-verified"]').exists(),
      ).toBe(false);
    });

    it('hides the input toggle when the peer is unverified even with the gate open', () => {
      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: false,
      });
      expect(wrapper.find('[data-test="desktop-input-toggle"]').exists()).toBe(
        false,
      );
      expect(wrapper.find('[data-test="desktop-input-status"]').exists()).toBe(
        false,
      );
    });

    it('reads View only before enabling input and Controlling after', async () => {
      const wrapper = mountWithChrome({
        desktopInputEnabled: true,
        desktopPeerVerified: true,
      });
      const status = wrapper.find('[data-test="desktop-input-status"]');
      expect(status.exists()).toBe(true);
      expect(status.text()).toBe('View only');

      await wrapper.find('[data-test="desktop-input-toggle"]').setValue(true);
      expect(wrapper.find('[data-test="desktop-input-status"]').text()).toBe(
        'Controlling',
      );
    });
    ```

- [ ] **Step 5: Run to verify failure.**

Run: `pnpm --filter @ponter/web test -- DesktopView`
Expected: FAIL — badge/status not found; toggle still renders for `desktopPeerVerified: false`.

- [ ] **Step 6: Implement the view.** In `apps/web/src/components/desktop/DesktopView.vue`:

  - import: `import { RefreshCw, Settings, ShieldCheck } from '@lucide/vue';`
  - replace the toggle label block (currently `v-if="tab.desktopInputEnabled"`) with the two-gate form plus badge and status line:
    ```vue
        <span
          v-if="tab.desktopInputEnabled && tab.desktopPeerVerified"
          data-test="desktop-peer-verified"
          class="flex items-center gap-1 text-emerald-500"
          title="This session's peer identity was verified by the agent"
        >
          <ShieldCheck class="w-3.5 h-3.5" />
          <span>Verified peer</span>
        </span>

        <label
          v-if="tab.desktopInputEnabled && tab.desktopPeerVerified"
          class="flex items-center gap-1 text-muted-foreground"
        >
          <input
            data-test="desktop-input-toggle"
            type="checkbox"
            :checked="inputOn"
            @change="onToggle"
          />
          <span>Input</span>
        </label>

        <span
          v-if="tab.desktopInputEnabled && tab.desktopPeerVerified"
          data-test="desktop-input-status"
          class="text-muted-foreground"
        >
          {{ inputOn ? 'Controlling' : 'View only' }}
        </span>
    ```

- [ ] **Step 7: Run to verify pass.**

Run: `pnpm --filter @ponter/web test -- DesktopView terminal-store`
Expected: PASS — including the pre-existing gate tests, whose fixtures now carry `desktopPeerVerified: true` where they assert a toggle.

- [ ] **Step 8: Full web gate, then commit.**

Run: `pnpm --filter @ponter/web test && pnpm typecheck && pnpm format:check`

```bash
git commit -m "feat(web): verified-peer badge and control status; toggle requires both gates (ADR-42)" -- apps/web/src/stores/terminal.ts apps/web/src/components/desktop/DesktopView.vue apps/web/src/__tests__/terminal-store.test.ts apps/web/src/__tests__/DesktopView.test.ts
```

### Task 7: E2E — proof-less desktop and files offers are refused (ADR-41 pin)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (new test inside the `describe.skipIf(!isLinux)` block, before the closing `});`)
- Modify: `packages/webrtc-core/test/e2e/files.e2e.test.ts` (new test next to `refuses the offer when the gate is closed`)
- Test: the two files above — run them, they are the proof

**Interfaces:**
- Consumes: Task 1's hoist (this test fails on the pre-hoist tree — the desktop/files arms returned before the verify, so a proof-less offer opened a session).
- Produces: the load-bearing ADR-41 regression pin for the two previously-unverified modes. The terminal proof-less test (`identity.e2e.test.ts:113-130`) stays untouched and remains the terminal pin.

- [ ] **Step 1: Write the desktop test.** Append inside the desktop describe block:

```ts
  // ADR-41 (Phase 6a): before the hoist, the Desktop arm returned at
  // `main.rs:970` — upstream of the terminal-only `verify_offer_identity` at
  // `:1025` — so a proof-less offer opened a desktop session. Now the verify
  // is an admission gate: the agent bails with NO answer, the channel never
  // opens, and the agent log names the missing proof.
  it('refuses a proof-less desktop offer (ADR-41 admission gate)', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);
    await waitForAgentSigningKey(token, agentId);

    // No `identity` argument → no proof on the offer.
    await expect(
      openDesktopPeer(
        sessionId,
        token,
        undefined,
      ),
    ).rejects.toThrow(/refus|declin|timeout/i);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toMatch(/identity proof|no identity proof|refused/i);
  }, 90_000);
```

- [ ] **Step 2: Write the files test.** Append next to the files gate-closed test:

```ts
  // ADR-41 (Phase 6a): the Files arm returned at `main.rs:988`, also upstream
  // of the old terminal-only verify. The root here is VALID (rootDir), so the
  // only possible refusal cause is the missing identity proof — that is what
  // isolates the assertion from the ADR-32 files-root gate.
  it('refuses a proof-less files offer even with a valid root (ADR-41)', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['files'],
    });

    spawnAgent(agentId, credential, ['--files-root', rootDir]);
    await waitForAgentOnline(token, agentId);
    await waitForAgentSigningKey(token, agentId);

    // No `identity` argument → no proof on the offer.
    await expect(
      openFilesPeer(
        new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
        sessionId,
      ),
    ).rejects.toThrow(/refus|declin|timeout/i);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toMatch(/identity proof|no identity proof|refused/i);
    // The refusal must NOT be the files-root gate — that would be a false pin.
    expect(agentLog).not.toContain(
      'refused: files root not configured or unusable',
    );
  }, 90_000);
```

- [ ] **Step 3: Build the agent binary, then run both files.** E2E needs the fresh binary (all four earlier tasks change it):

```bash
cargo build --manifest-path apps/agent/Cargo.toml --locked
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts test/e2e/files.e2e.test.ts
```

Expected: PASS, including every pre-existing test in both files (that is the ADR-41 non-regression proof — all live paths carry proofs). If any pre-existing test fails for a reason other than the intended refusals, STOP: that is risk R1 from the spec — a hidden proof-less producer — and it must be understood before proceeding.

- [ ] **Step 4: Commit.**

```bash
git commit -m "test(e2e): pin proof-less desktop and files refusals (ADR-41)" -- packages/webrtc-core/test/e2e/desktop.e2e.test.ts packages/webrtc-core/test/e2e/files.e2e.test.ts
```

### Task 8: E2E — flood cap engages and the session survives (ADR-43 pin)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (new test after the Xvfb injection test)
- Test: same file

**Interfaces:**
- Consumes: Task 2's limiter + drop log (`dropping desktop-input: rate cap exceeded`), Task 3's success log (`desktop-input applied`), Task 4's `peerVerified` field.
- Produces: proof the cap is wired end-to-end; the exact 120/window math stays in the Rust unit tests (spec §6).

- [ ] **Step 1: Write the test.** Append after `injects a pointer-move when the gate is open under Xvfb`:

```ts
  // ADR-43 (Phase 6a): a flooding peer is capped at the agent. The exact
  // 120/window math is pinned in the Rust unit tests; this test proves the cap
  // is WIRED (drops appear) and the session SURVIVES (a later frame lands).
  it('caps a flooding peer at 120 Hz and keeps the session alive', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99', RUST_LOG: 'debug' },
    );
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      // ADR-42: the live frame carries the verified fact (Task 4's literal).
      const sourcesFrame = controlFrames.findLast(
        (f) => f.type === 'desktop-sources',
      );
      expect(
        (sourcesFrame?.payload as { peerVerified?: boolean } | undefined)
          ?.peerVerified,
      ).toBe(true);
      expect(inputEnabled(controlFrames)).toBe(true);

      // Burst: 300 frames, all within one window (well above the 120 cap).
      for (let i = 0; i < 300; i++) {
        sendPointerMove(offerer, 0.5, 0.5);
      }

      // (a) at least one frame was applied and at least one was capped —
      // which frames landed is timing-dependent, so the assertion is >= 1.
      await waitFor(
        () => agent.output().includes('desktop-input applied'),
        'the agent to apply at least one burst frame',
        15_000,
      );
      await waitFor(
        () => agent.output().includes('rate cap exceeded'),
        'the agent to log at least one capped frame',
        15_000,
      );

      // (b) the session SURVIVES: a frame in the NEXT window still injects
      // (the cap is a per-window counter, not a session kill).
      execFileSync('xdotool', ['mousemove', '0', '0']);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const appliedBefore = agent.output().split('desktop-input applied').length;
      sendPointerMove(offerer, 0.25, 0.25);
      await waitFor(
        () =>
          agent.output().split('desktop-input applied').length >
          appliedBefore,
        'a post-burst frame to be applied in the next window',
        15_000,
      );
      await waitFor(
        () => {
          const out = execFileSync('xdotool', ['getmouselocation']).toString();
          const x = Number(/x:(\d+)/.exec(out)?.[1]);
          const y = Number(/y:(\d+)/.exec(out)?.[1]);
          return Math.abs(x - 320) <= 2 && Math.abs(y - 180) <= 2;
        },
        'the post-burst pointer to land near (320, 180)',
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 2: Run the file.**

```bash
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts
```

Expected: PASS. If `rate cap exceeded` never appears, the burst did not land in one window (slow loopback) — that is an environment flake, not a code bug; re-run once before investigating. If it fails twice, check the limiter's position in the dispatcher (Task 2, Step 4) — it must be inside `if allow_input {`.

- [ ] **Step 3: Commit.**

```bash
git commit -m "test(e2e): prove the 120 Hz input cap engages and the session survives (ADR-43)" -- packages/webrtc-core/test/e2e/desktop.e2e.test.ts
```

### Task 9: E2E — latency baseline measurement (ADR-44)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (new test after the flood test)
- Test: same file; the recorded numbers feed Task 10's demo doc

**Interfaces:**
- Consumes: Task 3's `info!` success log with the `delta_ms` field (default `tracing` fmt renders `desktop-input applied delta_ms=<n>`).
- Produces: the measured baseline (min/median/p90) that Task 10 records in the demo doc, and a loose CI regression guard (every delta ≤ 1000 ms).

- [ ] **Step 1: Write the test.**

```ts
  // ADR-44 (Phase 6a): the control-path latency baseline Phase 6b needs.
  // 10 pointer-moves, 100 ms apart, gate open under Xvfb; every `delta_ms`
  // (agent receive − browser send) must be ≤ 1000 ms — a loose CI guard —
  // and the summary is logged for the demo doc to record.
  it('measures the input-latency baseline (ADR-44)', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99' }, // default RUST_LOG=info: the log is info
    );
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );

      for (let i = 0; i < 10; i++) {
        sendPointerMove(offerer, 0.1 + i * 0.05, 0.5);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The 10 applied lines must be visible before parsing.
      await waitFor(
        () =>
          (agent.output().match(/desktop-input applied/g)?.length ?? 0) >= 10,
        '10 applied input frames in the agent log',
        20_000,
      );

      const deltas = [...agent.output().matchAll(/delta_ms=(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      expect(deltas.length).toBeGreaterThanOrEqual(10);
      for (const delta of deltas) {
        expect(delta).toBeLessThanOrEqual(1000);
      }

      const sorted = [...deltas].sort((a, b) => a - b);
      const min = sorted[0]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
      console.log(
        `[ADR-44 baseline] n=${deltas.length} min=${min}ms median=${median}ms p90=${p90}ms max=${sorted[sorted.length - 1]!}ms`,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 2: Run the file and capture the summary line.**

```bash
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts 2>&1 | tee /tmp/phase6a-latency.log
grep "ADR-44 baseline" /tmp/phase6a-latency.log
```

Expected: PASS; the grep prints one `[ADR-44 baseline] n=10 min=... median=... p90=... max=...` line — **copy it verbatim for Task 10's demo doc.**

- [ ] **Step 3: Commit.**

```bash
git commit -m "test(e2e): measure the input-latency baseline for Phase 6b (ADR-44)" -- packages/webrtc-core/test/e2e/desktop.e2e.test.ts
```

### Task 10: Docs — ARCHITECTURE §8, C1 closure, agent-setup, demo doc

**Files:**
- Modify: `docs/ARCHITECTURE.md:999-1001` (the Phase 6 stub)
- Modify: `docs/security/2026-10-08-ws1-e2ee-rust.md` (the C1 bullet block, ≈:107-111)
- Modify: `docs/guides/agent-setup.md` (§3 options table, §3 security note, §4.3 env block)
- Create: `docs/demos/2026-10-07-phase6a-interactive-desktop-demo.md`
- Test: `pnpm --filter @ponter/web test -- e2ee-claims` (the guard scans the WS1 Rust doc — the new text must not trip the affirmative-claim regex)

**Interfaces:**
- Consumes: the baseline numbers captured in Task 9 Step 2; the final state of ADR-41..44.
- Produces: the docs exit gate (§8 of the spec). No code depends on this task.

- [ ] **Step 1: ARCHITECTURE §8.** Replace the Phase 6 stub with the split (Vietnamese, matching the file's convention):

```markdown
### Phase 6: Low-latency Interaction (Weeks 17-18)

> **6a completed (2026-10-07), 6b not yet designed.** Phase 6 is split: **6a Interactivity** closes carry-forward C1 (ADR-41: `verify_offer_identity` as admission gate for all session modes — terminal, desktop, files, unknown), opens the ADR-29 input gate using a two-gate model (ADR-42: operator `--allow-input` AND peer verified; UI shows "Verified peer" badge + Controlling/View only status), adds a 120 Hz rate cap on the agent (ADR-43), and measures baseline input latency for 6b (ADR-44). **6b Latency** (low-latency WebCodecs, `playoutDelayHint`/jitter buffer, cursor prediction, ADR-25 hardware codec spike findings) will have its own spec. Details: `docs/superpowers/specs/2026-10-06-phase6a-interactive-desktop-design.md`, demo: `docs/demos/2026-10-07-phase6a-interactive-desktop-demo.md`.
```

- [ ] **Step 2: Mark C1 closed in the WS1 Rust doc.** In the `Desktop input: confidentiality-covered, but not identity-bound` block, replace the `**Mandatory carry-forward:**` sentence with:

```markdown
  - **C1 closed (Phase 6a, 2026-10-07):** ADR-41 hoisted `verify_offer_identity` to a single admission gate that runs before the mode dispatch in `run_one_session`, so the desktop and files paths now run the same verification the terminal path always ran; an offer without a valid proof bails with no answer of any kind. The E2E suite pins the desktop and files refusals (`desktop.e2e.test.ts`, `files.e2e.test.ts`). The paragraph above describes the state before that change; see `docs/superpowers/specs/2026-10-06-phase6a-interactive-desktop-design.md` §3 (ADR-41).
```

(The affirmative-claim guard scans this file: keep the wording free of `(implements|provides|enables|is|are) + (e2ee|zero-trust|encryption)`. Run Step 5 to confirm.)

- [ ] **Step 3: agent-setup.md.** Three edits:

  - in the options table (§3), after the `--files-root` row:
    ```
          --allow-input              Enable mouse/keyboard injection from peer (ADR-29/ADR-42 gate). DEFAULT OFF:
                                     only when enabled AND peer identity is verified will input be injected
                                     [env: AGENT_ALLOW_INPUT]
    ```
  - replace the security note under the table with the two-gate statement:
    ```markdown
    > **Security:** input injection requires **two gates** (ADR-42): (A) the `--allow-input` flag enabled locally by the operator — remote peers cannot enable it; and (B) the peer must pass identity verification at admission (ADR-41, Phase 6a). Without both, all input frames are dropped. The agent always allows view-only mode. As of Phase 6a, peers for **all** sessions (including files/desktop) have their identity verified before the agent answers an offer.
    ```
  - in §4.3, after the `AGENT_FILES_ROOT` comment:
    ```env
    # Optional: enable mouse/keyboard injection (DEFAULT OFF — gate A of ADR-42).
    # Only takes effect when peer identity is verified (gate B).
    # AGENT_ALLOW_INPUT=true
    ```

- [ ] **Step 4: Demo doc.** Create `docs/demos/2026-10-07-phase6a-interactive-desktop-demo.md` following the Week 11 demo pattern (English, runnable script, "Not observed manually" note), with these sections:

  - header: date, machine (Fedora Linux X11), agent build command, branch;
  - **Status** — same framing as the Week 11 demo: numbers are cited from the E2E suite, not re-measured;
  - **Security posture** — the two gates; ADR-41 hoist closes C1 for all modes; input default OFF;
  - **Steps:** (1) start the agent with `--allow-input` under Xvfb; (2) open a desktop session from the web UI and observe the "Verified peer" badge and "View only" → enable Input → "Controlling"; (3) run the flood and latency E2E tests with the commands from Tasks 8-9;
  - **Measured baseline (ADR-44)** — paste the `[ADR-44 baseline] ...` line captured in Task 9 Step 2 verbatim, plus the CI command that produced it;
  - **What this demonstrates end-to-end** table: ADR-41 refusal / ADR-42 two gates / ADR-43 cap / ADR-44 baseline, each with its E2E test name;
  - **Non-goals:** 6b items; Windows/macOS/Wayland injection; terminal badge.

- [ ] **Step 5: Run the doc guards and format.**

Run: `pnpm --filter @ponter/web test -- e2ee-claims && pnpm format:check`
Expected: PASS (the WS1 Rust doc wording passes the affirmative-claim regex).

- [ ] **Step 6: Commit.**

```bash
git commit -m "docs: Phase 6a — ADR-41..44, C1 closure, input-gate guide, demo + baseline" -- docs/ARCHITECTURE.md docs/security/2026-10-08-ws1-e2ee-rust.md docs/guides/agent-setup.md docs/demos/2026-10-07-phase6a-interactive-desktop-demo.md
```

---

## Final verification checklist (run before the whole-branch review)

1. `cargo fmt --manifest-path apps/agent/Cargo.toml --check`
2. `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
3. `cargo test --manifest-path apps/agent/Cargo.toml --locked`
4. `pnpm -r test` (all Vitest suites: shared, desktop-core, terminal-core, webrtc-core, crypto, web, server)
5. `pnpm lint && pnpm typecheck`
6. `pnpm format:check` — **required** (Week 12 gotcha; a plan that omitted it turned CI red)
7. Full cross-language E2E (agent binary freshly built first):
   ```bash
   cargo build --manifest-path apps/agent/Cargo.toml --locked
   DISPLAY=:99 pnpm --filter @ponter/webrtc-core test:e2e
   ```
8. `grep -c "APPEND-HERE"` on this plan returns 0 (no unexpanded placeholder survived).
9. CI: all 11 checks green (4 required + Build Agent Verify + 6 platform builds); Sonar new-code duplication clean (Weeks 13/16 gotcha — if the gate goes red, dedup for real: parameterize/extract, never suppress, test counts must not drop).

## Self-review notes (writing-plans checklist)

- **Spec coverage:** §3 ADR-41 → T1/T7; ADR-42 → T4/T5/T6; ADR-43 → T2/T8; ADR-44 → T3/T9; §5 wire/store/UI → T4-T6; §6 testing strategy → each task's tests; §8 docs gates → T10; §9 out-of-scope respected (no server/DB changes; terminal cap untouched).
- **Review Focus coverage:** (1) version skew → T5 Step 5 + T6 Step 4; (2) Gate A open + unverified → T6 Step 4; (3) flooding peer → T8 Step 1 (post-burst frame); (4) zero/future timestamp → T3 Step 1 (`apply_clamps_a_future_timestamp_to_a_zero_delta` + `zero_timestamp_is_carried_verbatim`) + T3 Step 4 (`.max(0)`); (5) `peerVerified` literal structural → T4 Step 1 (both directions) + T8 Step 1 (live frame read).
- **Known deliberate behavior changes:** `SessionMode::None` + invalid proof goes from `approved:false` refusal to bail-no-answer (spec §3 ADR-41 table — no client depends on the old combo); `apply_if_allowed` gains a `now_ms` parameter (all three call sites updated in T3 Step 5).
- **Type consistency:** `DecodedDesktopInput { event, timestamp_ms }` (T3) ↔ test assertions (T3/T9); `frame_desktop_sources(sources, input_enabled, peer_verified, timestamp_ms)` (T4) ↔ TS `peerVerified` (T5) ↔ `TabItem.desktopPeerVerified` (T6) ↔ `data-test="desktop-peer-verified"` (T6) ↔ E2E payload read (T8).


