# Phase 6b: Low-latency Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver low-latency interaction for the remote desktop: a streamed cursor layer (position, shape, local echo, view-only extrapolation), browser playout tuning (`jitterBufferTarget` / `playoutDelayHint`), four-tier latency instrumentation (capture/encode rolling stats, browser present-time health, input-echo round-trip, glass-to-glass test pattern), and a spike-gated WebCodecs render path.

**Architecture:** Layered execution (**L0** Probes P1/P2/P3 → **L1** Measurement → **L2** Playout tuning → **L3** Cursor layer → **L4** WebCodecs [P2-gated] → **L5** Docs/Demo). Wire additions are additive and plaintext. Playout tuning operates DOM-free via an optional receiver seam on `RTCPeerConnectionLike`. X11 cursor uses `x11rb` + XFixes with dirty-checked shape serial and PNG compression via `image`; Windows is compile-checked; macOS marks `cursorInFrame: true`.

**Tech Stack:** Rust (agent: `x11rb 0.13.2` with `xfixes`, `image 0.25.10` png, `tokio`, `webrtc-rs`, `enigo`), TypeScript/Vue 3 (`@ponter/shared`, `@ponter/desktop-core`, `@ponter/webrtc-core`, `apps/web` with Pinia, Vitest, Playwright spike).

**Spec:** `docs/superpowers/specs/2026-10-07-phase6b-low-latency-design.md`

---

## Plan amendments

**Amendment 1 (2026-10-07, after probe P1 returned ADOPT — spike commit `943aae3`):**

- **Task 18B added** (between Tasks 18 and 19, below): the ADR-49 adopt branch requires a Playwright smoke spec in CI; this plan was written P1-pending, so the smoke was not yet a task.
- **Ruling PM-3 (smoke location + packaging):** the smoke lives at `packages/webrtc-core/test/e2e/browser-smoke.pw.ts` with `packages/webrtc-core/playwright.config.ts`; `@playwright/test` becomes a devDependency of `@ponter/webrtc-core`; the browser is **pinned via `playwright install chromium --with-deps`** in `ci-e2e.yml` (never a runner's or dev machine's system Chrome); new script `test:browser`. The vitest e2e include (`test/e2e/**/*.e2e.test.ts`) does not match `*.pw.ts`, so the two runners stay separate.
- **P1 findings folded into Task 18B:** Xvfb `:99` is needed only for the input-echo assertion (the video path is display-independent — proven with `DISPLAY` unset); register through the UI so the IndexedDB signing keys exist (ADR-41 fail-closed); reuse `harness.ts` server/agent spawn helpers; serve the web client with the Vite dev server and allow its origin (`CORS_ORIGIN`).
- **Probe evidence carried:** throwaway probe scripts at `.superpowers/sdd/2026-10-07-phase6b-low-latency/p1-probe-artifacts/` (`p1-probe.mjs`, `p1-echo.mjs`) are the reference recipe for Task 18B.

---

## Global Constraints

- **Language rules:** Dialogue/explanations in Vietnamese. Source code, variable names, CLI commands, commit messages, PR descriptions, and technical specifications strictly in English.
- **UI rule (absolute):** Never modify files under `apps/web/src/components/ui/` (shadcn-vue generated; byte-identical registry `reka-vega`; in `.prettierignore`). All custom chrome and canvas overlays live in `DesktopView.vue` outside `ui/`.
- **Git & commit discipline:** No bare `git stash`. Never use `git add .` or commit untracked files. Commits must be path-limited (`git commit -m "..." -- <paths>`).
- **Push rule:** Push spec/plan commits to origin BEFORE opening a PR to prevent diverge on squash-merge.
- **Verification standards:** Local verification must pass `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm -r test`, `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, and `cargo test --locked`.
- **E2E exclusivity:** E2E runs on exclusive port 8787, fresh agent binary (`cargo build --locked` in `apps/agent`), `DISPLAY=:99` (Xvfb), and `fileParallelism: false`.
- **Sonar discipline:** Clean new-code duplication. Dedup helper functions and parameterize test cases across Rust and TypeScript.
- **Cursor frame posture:** `desktop-cursor` is plaintext agent→browser metadata (same posture as `desktop-sources` and `desktop-stats`).
- **Playout default:** `DesktopClientOptions.playoutDelayMs` defaults to `100` (ms), with `null` explicitly disabling tuning.
- **Governance:** PM orchestrates and verifies; tasks are executed via role sessions and subagents with mandatory multi-step independent review chains.

---

## Review Focus

The five input classes or failure modes the spec implies that are most critical to pin with tests:

1. **Cursor shape payload exceeds size cap (32 KiB).** Expected: Omit the `shape` field from `desktop-cursor`, keep streaming position `(x, y, visible, seq)`, and do not drop the frame. *Test: Task 10.*
2. **Cursor moves outside streamed monitor bounds.** Expected: Agent clamps coordinates and emits `visible: false`; browser overlay immediately hides the cursor. *Test: Task 10 & Task 14.*
3. **Playout receiver seam called on non-browser adapter (mock or werift peer).** Expected: `getVideoReceiver()` returns `undefined`, tuning gracefully no-ops without error, connection proceeds normally. *Test: Task 8 & Task 9.*
4. **Input echo returns unknown or out-of-order sequence number (`lastInputSeq`).** Expected: Browser bounds echo-tracking map, ignores unrecognized sequence numbers without throwing, keeps tracking active inputs. *Test: Task 16.*
5. **WebCodecs configuration or decoder throws runtime error.** Expected: Automatic fallback immediately reattaches `<video>` `srcObject`, tears down worker cleanly, and logs warning without dropping the stream. *Test: Task 17.*

---

## File Map

| File | Responsibility | Layer / Task |
|------|----------------|--------------|
| `docs/spikes/2026-10-07-p1-playwright-smoke.md` | P1 Playwright spike report & adoption decision | L0 / Task 1 |
| `docs/spikes/2026-10-07-p2-webcodecs-probe.md` | P2 WebCodecs probe report & H.264 format findings | L0 / Task 2 |
| `docs/spikes/2026-10-07-p3-adr25-hardware-codec.md` | P3 Hardware-codec investigation report | L0 / Task 3 |
| `packages/shared/src/types/desktop.ts` | Shared wire types: `DesktopCursorPayload`, `DesktopShape`, stats timing fields, input `seq` | L1 / Task 4 |
| `packages/shared/test/desktop-types.test.ts` | Wire type instantiation and exhaustiveness tests | L1 / Task 4 |
| `apps/agent/src/desktop.rs` | `RawFrame.seq`, 32-sample timing ring, rolling p50 calculation, stats serialization | L1 / Task 5, 6 |
| `apps/agent/src/input.rs` | Input wire `seq` decoding and `apply_if_allowed` returning `Option<u64>` echo | L1 / Task 7 |
| `apps/agent/src/main.rs` | Wire seq into control loop, echo tracking, cursor poller integration | L1 / Task 7, L3 / Task 12 |
| `packages/webrtc-core/src/types.ts` | `RTCPeerConnectionLike.getVideoReceiver?(): unknown` seam | L2 / Task 8 |
| `packages/webrtc-core/src/adapters/browser.ts` | `BrowserAdapter.getVideoReceiver()` implementation | L2 / Task 8 |
| `packages/desktop-core/src/types.ts` | `DesktopClientOptions.playoutDelayMs` option | L2 / Task 9 |
| `packages/desktop-core/src/client.ts` | Apply playout tuning at track resolution; cursor control dispatch | L2 / Task 9, L3 / Task 13 |
| `packages/desktop-core/test/client.test.ts` | Playout tuning unit tests & cursor dispatch tests | L2 / Task 9, L3 / Task 13 |
| `apps/agent/Cargo.toml` | Add direct `x11rb` (`xfixes`) & `image` (`png`) dependencies for non-musl | L3 / Task 10 |
| `apps/agent/src/cursor.rs` | 60Hz poller, X11 XFixes cursor fetch, dirty check, PNG encoding, Windows stub | L3 / Task 10, 11 |
| `apps/web/src/lib/desktop-input.ts` | `contentBox()` shared geometry, `toClient()` inverse, extrapolation function | L3 / Task 14 |
| `apps/web/src/test/desktop-input.test.ts` | Unit tests for letterbox mapping, bounds clamping, and extrapolation | L3 / Task 14 |
| `apps/web/src/components/desktop/DesktopView.vue` | Overlay canvas, local echo when controlling, latency footer telemetry | L3 / Task 15 |
| `apps/web/src/stores/terminal.ts` | Pinia tab cursor state, `desktopEchoMs` tracking with bounded map | L3 / Task 16 |
| `apps/web/src/__tests__/DesktopView.test.ts` | Overlay rendering, `cursor: none`, footer latency display tests | L3 / Task 15, 16 |
| `apps/web/src/lib/webcodecs/` | Worker script, WebCodecs controller, fallback state machine (if P2 passes) | L4 / Task 17 |
| `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` | E2E cursor round-trip, view-only stream, stats timing, echo summary | L5 / Task 18 |
| `packages/webrtc-core/test/e2e/browser-smoke.pw.ts` | Playwright smoke (ADR-49 adopt): connect → track → sources → echo → playout knob → g2g | L5 / Task 18B |
| `packages/webrtc-core/playwright.config.ts` | Playwright config (chromium, no Xvfb needed for video path) | L5 / Task 18B |
| `docs/ARCHITECTURE.md` | Phase 6b architecture updates and §11 performance table | L5 / Task 19 |
| `docs/demos/2026-10-07-phase6b-low-latency-demo.md` | Phase 6b verification report, benchmarks at 100/50/0ms, security notes | L5 / Task 19 |

---

## Tasks

### Layer 0: Probes & Investigations (L0)

### Task 1: Probe P1 — Playwright Smoke Spike (ADR-49)

**Files:**
- Create: `docs/spikes/2026-10-07-p1-playwright-smoke.md`
- Scratch: `packages/webrtc-core/test/spikes/playwright-smoke.spike.ts` (throwaway or adopted)

**Interfaces:**
- Consumes: Agent binary under Xvfb, Server port 8787, Web client dev server
- Produces: Written finding on whether Playwright headless Chrome can reliably connect and assert WebRTC desktop stream in CI.

- [ ] **Step 1: Write spike probe script**
Set up a standalone Playwright probe to launch headless Chromium, navigate to desktop session, connect via WebRTC, and check if `getVideoReceiver()` / `playoutDelayHint` are observable.

- [ ] **Step 2: Run spike against local Xvfb**
Run probe with `DISPLAY=:99`. Record whether WebRTC connects, ICE completes, and video frame presents.

- [ ] **Step 3: Document findings and decision**
Write `docs/spikes/2026-10-07-p1-playwright-smoke.md`: Record connect reliability, execution duration, and adopt-vs-document decision. If CI headless WebRTC is flaky, document manual fallback procedure per ADR-49.

- [ ] **Step 4: Commit probe findings**
```bash
git add docs/spikes/2026-10-07-p1-playwright-smoke.md
git commit -m "docs(spike): P1 Playwright headless WebRTC smoke findings" -- docs/spikes/2026-10-07-p1-playwright-smoke.md
```

---

### Task 2: Probe P2 — WebCodecs Transform & Decode Spike (ADR-48)

**Files:**
- Create: `docs/spikes/2026-10-07-p2-webcodecs-probe.md`
- Scratch: `apps/web/test/spikes/webcodecs.spike.html` (throwaway probe)

**Interfaces:**
- Consumes: Inbound `RTCEncodedVideoFrame` from openh264 agent stream
- Produces: Evidence on Annex-B vs AVCC format, `VideoDecoder.configure({codec: 'avc1...'})` requirements, and whether decode succeeds without renegotiation. Gating decision for Layer 4.

- [ ] **Step 1: Create standalone WebCodecs probe harness**
Inspect incoming `RTCEncodedVideoFrame.data` from the agent WebRTC stream to check NAL unit start codes (`0x00000001` Annex-B vs 4-byte length AVCC) and SPS/PPS presence.

- [ ] **Step 2: Run decode probe in target Chromium**
Test if `VideoDecoder` accepts the stream chunks and outputs `VideoFrame` without requiring out-of-band `description` bytes.

- [ ] **Step 3: Record probe outcome**
Document in `docs/spikes/2026-10-07-p2-webcodecs-probe.md`:
  - Result: PASS (proceed to Layer 4) or FAIL (execute descope branch: keep `<video>` + playout tuning).
  - Format details: NAL format, SPS/PPS in-band status, decoder error rate.

- [ ] **Step 4: Commit probe report**
```bash
git add docs/spikes/2026-10-07-p2-webcodecs-probe.md
git commit -m "docs(spike): P2 WebCodecs H.264 decode probe findings" -- docs/spikes/2026-10-07-p2-webcodecs-probe.md
```

---

### Task 3: Probe P3 — ADR-25 Hardware-Codec Investigation

**Files:**
- Create: `docs/spikes/2026-10-07-p3-hardware-codec.md`

**Interfaces:**
- Consumes: Current `openh264` software pipeline in `apps/agent/src/desktop.rs`
- Produces: Written evaluation of NVENC / VAAPI / MediaCodec / VideoToolbox integration effort, licensing, and latency potential. Non-gating.

- [ ] **Step 1: Survey hardware-codec crates and OS APIs**
Evaluate candidate Rust crates for VAAPI (Linux), NVENC (cross-platform NVIDIA), VideoToolbox (macOS), and WGC/MediaFoundation (Windows).

- [ ] **Step 2: Write investigation report**
Write `docs/spikes/2026-10-07-p3-hardware-codec.md` covering library maturity, cross-compilation complexity, dynamic linking vs fallback, and concrete recommendations for future phases.

- [ ] **Step 3: Commit investigation report**
```bash
git add docs/spikes/2026-10-07-p3-hardware-codec.md
git commit -m "docs(spike): P3 hardware-codec investigation report (ADR-25)" -- docs/spikes/2026-10-07-p3-hardware-codec.md
```

---

### Layer 1: Measurement & Timing Instrumentation (L1)

### Task 4: Shared Wire Types & Tests (ADR-45 & ADR-47)

**Files:**
- Modify: `packages/shared/src/types/desktop.ts`
- Modify: `packages/shared/test/desktop-types.test.ts`

**Interfaces:**
- Consumes: Existing `DesktopInput`, `DesktopStats`, `DesktopSourcesPayload`
- Produces:
  - `DesktopCursorPayload`: `{ x: number, y: number, visible: boolean, seq: number, lastInputSeq?: number, shape?: DesktopShape }`
  - `DesktopShape`: `{ png: string, hotspotX: number, hotspotY: number, serial: number }`
  - Extended `DesktopSourcesPayload`: adds `cursorInFrame?: boolean`
  - Extended `DesktopStats`: adds `frameSeq?: number, captureMsP50?: number, encodeMsP50?: number, frameSamples?: Array<{ seq: number, captureEpochMs: number, encodeMs: number }>`
  - Extended pointer variants in `DesktopInput`: adds optional `seq?: number`

- [ ] **Step 1: Write failing type tests**
Add test cases in `packages/shared/test/desktop-types.test.ts`:
```ts
it('instantiates a valid DesktopCursorPayload with optional shape and lastInputSeq', () => {
  const cursor: DesktopCursorPayload = {
    x: 0.5,
    y: 0.25,
    visible: true,
    seq: 42,
    lastInputSeq: 10,
    shape: {
      png: 'iVBORw0KGgo...',
      hotspotX: 0,
      hotspotY: 0,
      serial: 1,
    },
  };
  expect(cursor.visible).toBe(true);
  expect(cursor.shape?.serial).toBe(1);
});

it('supports DesktopStats with latency timing fields and sample ring', () => {
  const stats: DesktopStats = {
    width: 1920,
    height: 1080,
    fps: 60,
    targetBitrateBps: 6_000_000,
    frameSeq: 120,
    captureMsP50: 3.5,
    encodeMsP50: 4.2,
    frameSamples: [{ seq: 120, captureEpochMs: 1700000000000, encodeMs: 4 }],
  };
  expect(stats.captureMsP50).toBe(3.5);
  expect(stats.frameSamples).toHaveLength(1);
});

it('allows optional seq on pointer DesktopInput variants', () => {
  const move: DesktopInput = { kind: 'pointer-move', x: 0.1, y: 0.2, seq: 99 };
  if (move.kind === 'pointer-move') {
    expect(move.seq).toBe(99);
  }
});
```

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/shared test`
Expected: FAIL due to missing type definitions.

- [ ] **Step 3: Implement wire types in desktop.ts**
Update `packages/shared/src/types/desktop.ts` with the new types and field extensions as defined in the spec §5.

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/shared test && pnpm --filter @ponter/shared typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(shared): add cursor, latency stats, and input seq wire types" -- packages/shared/src/types/desktop.ts packages/shared/test/desktop-types.test.ts
```

---

### Task 5: Agent RawFrame.seq & Frame Timing Ring (ADR-47)

**Files:**
- Modify: `apps/agent/src/desktop.rs`

**Interfaces:**
- Consumes: `RawFrame` struct in `apps/agent/src/desktop.rs`
- Produces: `RawFrame.seq: u64` and `FrameTimingRing` recording `(seq, captureEpochMs, encodeMs)` for rolling p50 calculations.

- [ ] **Step 1: Write unit tests for FrameTimingRing**
In `apps/agent/src/desktop.rs` test module, add tests for a 32-sample rolling ring buffer:
```rust
#[test]
fn test_frame_timing_ring_p50_calculation() {
    let mut ring = FrameTimingRing::new(32);
    for i in 1..=10 {
        ring.record(i, 1000 + i, (i * 2) as f32);
    }
    assert_eq!(ring.encode_ms_p50(), 11.0); // median of 2, 4, ..., 20
    assert_eq!(ring.samples().len(), 10);
}
```

- [ ] **Step 2: Run cargo test to verify failure**
Run: `cargo test --manifest-path apps/agent/Cargo.toml test_frame_timing_ring --locked`
Expected: FAIL (`FrameTimingRing` not found).

- [ ] **Step 3: Implement RawFrame.seq and FrameTimingRing**
- Add `pub seq: u64` to `RawFrame`.
- Update all 7 construction sites of `RawFrame` in `desktop.rs`:
  - `downscale` (:100-104)
  - `crop_to_even` (:124-128)
  - `TestPatternSource::render` (:190-194)
  - `ScreenSource::next_frame` (:429-433)
  - `WindowSource::next_frame` (:723)
  - Test helper `solid()` (:1515-1519)
  - Test helper `patterned()` (:1535-1539)
- Implement `FrameTimingRing` with fixed capacity 32, computing p50 using a sorted copy of recent values.

- [ ] **Step 4: Run cargo test**
Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(agent): add RawFrame.seq and rolling frame timing ring" -- apps/agent/src/desktop.rs
```

---

### Task 6: Agent DesktopStats Latency Export & Serialization (ADR-47)

**Files:**
- Modify: `apps/agent/src/desktop.rs`

**Interfaces:**
- Consumes: `FrameTimingRing`, `DesktopStats` struct in `apps/agent/src/desktop.rs`
- Produces: Updated `DesktopStats` with `frame_seq`, `capture_ms_p50`, `encode_ms_p50`, and `frame_samples` serialized to camelCase JSON.

- [ ] **Step 1: Update serialization tests in desktop.rs**
Update existing tests around line 2302 (`frame_desktop_stats_uses_the_camel_case_wire_shape`) and line 2322 (`frame_desktop_stats_omits_an_absent_status`):
Assert that optional timing fields serialize when present and are omitted when `None`.

- [ ] **Step 2: Run cargo test to verify failure**
Run: `cargo test --manifest-path apps/agent/Cargo.toml frame_desktop_stats --locked`
Expected: FAIL.

- [ ] **Step 3: Implement DesktopStats timing fields and run_stream publishing**
- Add optional fields to `DesktopStats`:
  ```rust
  #[serde(skip_serializing_if = "Option::is_none")]
  pub frame_seq: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub capture_ms_p50: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub encode_ms_p50: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub frame_samples: Option<Vec<FrameSample>>,
  ```
- In `run_stream`: update `send_stats` closure to read from `FrameTimingRing` and attach timing data.

- [ ] **Step 4: Run cargo test and clippy**
Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(agent): export capture and encode latency metrics in desktop-stats" -- apps/agent/src/desktop.rs
```

---

### Task 7: Agent Input Sequence Echo Tracking (ADR-47)

**Files:**
- Modify: `apps/agent/src/input.rs`
- Modify: `apps/agent/src/main.rs`

**Interfaces:**
- Consumes: Inbound `DesktopInput` with `seq: Option<u64>`
- Produces: `apply_if_allowed` returning `Option<u64>`, cached in agent state as `last_input_seq` for cursor frame echoes.

- [ ] **Step 1: Write unit tests in input.rs for seq decoding**
In `apps/agent/src/input.rs` test module:
```rust
#[test]
fn decode_preserves_optional_input_seq() {
    let raw = r#"{"type":"desktop-input","channel":"control","payload":{"kind":"pointer-move","x":0.5,"y":0.25,"seq":123},"timestamp":100}"#;
    let decoded = decode_desktop_input(raw).unwrap().unwrap();
    assert_eq!(decoded.seq, Some(123));
}

#[test]
fn apply_returns_applied_input_seq() {
    let raw = r#"{"type":"desktop-input","channel":"control","payload":{"kind":"pointer-move","x":0.5,"y":0.25,"seq":456},"timestamp":100}"#;
    let mut fake = FakeInjector::default();
    let src = source();
    let echoed = apply_if_allowed(true, raw, &src, Some(&mut fake), 100);
    assert_eq!(echoed, Some(456));
}
```

- [ ] **Step 2: Run cargo test to verify failure**
Run: `cargo test --manifest-path apps/agent/Cargo.toml test_decode_preserves_optional_input_seq --locked`
Expected: FAIL.

- [ ] **Step 3: Implement seq decoding and return in input.rs**
- Update `DesktopInputWire` pointer variants to include `#[serde(default)] pub seq: Option<u64>`.
- Update `DecodedDesktopInput` to carry `pub seq: Option<u64>`.
- Change return type of `apply_if_allowed` from `bool` to `Option<u64>`. Return `decoded.seq` on successful injection; `None` on gate-closed or failure.
- In `apps/agent/src/main.rs`: track `last_input_seq: Arc<AtomicU64>` (0 = none), updated whenever `apply_if_allowed` returns `Some(seq)`.

- [ ] **Step 4: Run cargo test & clippy**
Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(agent): track and echo applied input sequence numbers" -- apps/agent/src/input.rs apps/agent/src/main.rs
```

---

### Layer 2: Playout Tuning (L2)

### Task 8: WebRTC-Core Media Receiver Seam (ADR-46)

**Files:**
- Modify: `packages/webrtc-core/src/types.ts`
- Modify: `packages/webrtc-core/src/adapters/browser.ts`

**Interfaces:**
- Consumes: `RTCPeerConnectionLike` in `packages/webrtc-core/src/types.ts`
- Produces: `getVideoReceiver?(): unknown` optional method on `RTCPeerConnectionLike`.

- [ ] **Step 1: Write unit test for BrowserAdapter getVideoReceiver**
Create or update `packages/webrtc-core/test/browser-adapter.test.ts`:
Verify `adapter.getVideoReceiver()` returns the video transceiver receiver from `this.pc.getReceivers()`, or `undefined` if no video receiver exists.

- [ ] **Step 2: Run test to verify failure**
Run: `pnpm --filter @ponter/webrtc-core test`
Expected: FAIL (`getVideoReceiver` does not exist).

- [ ] **Step 3: Implement getVideoReceiver seam**
- In `packages/webrtc-core/src/types.ts`:
  ```ts
  export interface RTCPeerConnectionLike {
    // ... existing methods ...
    getVideoReceiver?(): unknown;
  }
  ```
- In `packages/webrtc-core/src/adapters/browser.ts`:
  ```ts
  getVideoReceiver(): RTCRtpReceiver | undefined {
    return this.pc.getReceivers().find((r) => r.track?.kind === 'video');
  }
  ```

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/webrtc-core test && pnpm --filter @ponter/webrtc-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(webrtc-core): add getVideoReceiver seam to RTCPeerConnectionLike" -- packages/webrtc-core/src/types.ts packages/webrtc-core/src/adapters/browser.ts
```

---

### Task 9: DesktopClient Playout Delay Tuning (ADR-46)

**Files:**
- Modify: `packages/desktop-core/src/types.ts`
- Modify: `packages/desktop-core/src/client.ts`
- Modify: `packages/desktop-core/test/client.test.ts`

**Interfaces:**
- Consumes: `DesktopClientOptions.playoutDelayMs?: number | null`, `getVideoReceiver?(): unknown`
- Produces: Automatic tuning of `jitterBufferTarget` (ms) or `playoutDelayHint` (seconds) on remote track resolution.

- [ ] **Step 1: Write unit tests in desktop-core client.test.ts**
Add tests asserting:
1. When receiver has `jitterBufferTarget`, it is set to `100` (or configured value).
2. When receiver lacks `jitterBufferTarget` but has `playoutDelayHint`, it is set to `0.1` (`100 / 1000`).
3. When `playoutDelayMs` is `null`, receiver properties are not modified.
4. When `getVideoReceiver` returns undefined (werift / mocks), client starts cleanly with no error.

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/desktop-core test`
Expected: FAIL.

- [ ] **Step 3: Implement playout delay tuning in DesktopClient**
- In `packages/desktop-core/src/types.ts`: add `playoutDelayMs?: number | null` to `DesktopClientOptions`.
- In `packages/desktop-core/src/client.ts`:
  - Store `playoutDelayMs = options?.playoutDelayMs !== undefined ? options.playoutDelayMs : 100`.
  - In `start()` right after `trackPromise` resolves:
    ```ts
    this.applyPlayoutTuning();
    ```
  - Implement `applyPlayoutTuning()`:
    ```ts
    private applyPlayoutTuning(): void {
      if (this.playoutDelayMs === null) return;
      const peerAny = this.peer as unknown as { peer?: { getVideoReceiver?: () => unknown } };
      const receiver = peerAny.peer?.getVideoReceiver?.() as Record<string, unknown> | undefined;
      if (!receiver) return;
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = Math.min(4000, Math.max(0, this.playoutDelayMs));
      } else if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = Math.max(0, this.playoutDelayMs) / 1000;
      }
    }
    ```

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/desktop-core test && pnpm --filter @ponter/desktop-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(desktop-core): apply jitterBufferTarget and playoutDelayHint tuning" -- packages/desktop-core/src/types.ts packages/desktop-core/src/client.ts packages/desktop-core/test/client.test.ts
```

---

### Layer 3: Cursor Streaming & Client Overlay (L3)

### Task 10: Agent Cursor Poller & X11 Implementation (ADR-45)

**Files:**
- Modify: `apps/agent/Cargo.toml`
- Create: `apps/agent/src/cursor.rs`
- Modify: `apps/agent/src/lib.rs` (or `main.rs`)

**Interfaces:**
- Consumes: `x11rb 0.13.2` with `xfixes` feature, `image 0.25.10` png
- Produces: `CursorPoller` generating `DesktopCursorPayload` at 60Hz on change.

- [ ] **Step 1: Add dependencies to Cargo.toml**
Add direct dependencies under `[target.'cfg(not(target_env = "musl"))'.dependencies]`:
```toml
x11rb = { version = "0.13", features = ["xfixes"] }
image = { version = "0.25", default-features = false, features = ["png"] }
```

- [ ] **Step 2: Write unit tests for cursor encoding and capping**
In `apps/agent/src/cursor.rs`:
```rust
#[test]
fn test_cursor_png_size_cap_omits_shape() {
    let huge_rgba = vec![255u8; 200 * 200 * 4]; // large icon
    let shape = encode_cursor_shape(&huge_rgba, 200, 200, 0, 0, 1);
    // If over 32 KiB, shape should be None
    if shape.as_ref().map_or(0, |s| s.png.len()) > 32768 {
        assert!(filter_shape_by_cap(shape).is_none());
    }
}

#[test]
fn test_cursor_outside_source_is_invisible() {
    let source = DesktopSourceInfo { x: 100, y: 100, width: 800, height: 600, ..Default::default() };
    let sample = map_cursor_to_source(50, 50, &source);
    assert!(!sample.visible);
}
```

- [ ] **Step 3: Implement cursor.rs with X11 backend**
- Implement `X11CursorSampler` using `x11rb::protocol::xproto::query_pointer` for root coordinates and `x11rb::protocol::xfixes::get_cursor_image` for cursor image.
- Dirty-check shape by `cursor_serial`.
- Convert `cursor_image` (`Vec<u32>` ARGB) to RGBA bytes and encode to PNG using `image::codecs::png::PngEncoder`.
- Enforce 32 KiB cap on base64 PNG string.

- [ ] **Step 4: Run cargo test & clippy**
Run: `cargo test --manifest-path apps/agent/Cargo.toml test_cursor --locked && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(agent): implement X11 cursor poller with XFixes and PNG compression" -- apps/agent/Cargo.toml apps/agent/src/cursor.rs
```

---

### Task 11: Agent Windows Cursor Stub & cursorInFrame Flag (ADR-45)

**Files:**
- Modify: `apps/agent/src/cursor.rs`
- Modify: `apps/agent/src/desktop.rs`

**Interfaces:**
- Consumes: Target platform cfgs (`target_os = "windows"`, `target_os = "macos"`)
- Produces: Compile-checked Windows cursor poller; `cursorInFrame: true` on macOS; updated `frame_desktop_sources`.

- [ ] **Step 1: Write test for frame_desktop_sources with cursorInFrame**
In `apps/agent/src/desktop.rs`:
Update `frame_desktop_sources` signature to accept `cursor_in_frame: bool` and assert wire payload contains `"cursorInFrame": true/false`.

- [ ] **Step 2: Run cargo test to verify failure**
Run: `cargo test --manifest-path apps/agent/Cargo.toml frame_desktop_sources --locked`
Expected: FAIL.

- [ ] **Step 3: Implement cursorInFrame and Windows cursor stub**
- In `desktop.rs`: add `cursor_in_frame: bool` parameter to `frame_desktop_sources` and update call site in `apps/agent/src/main.rs:1938`.
- Set `cursor_in_frame = cfg!(target_os = "macos")`.
- In `cursor.rs`: add `#[cfg(target_os = "windows")]` best-effort stub using `GetCursorPos` and compile-checked types so `x86_64-pc-windows-msvc` builds clean in CI.

- [ ] **Step 4: Run cargo test & check Windows compilation**
Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(agent): add cursorInFrame flag and Windows cursor sampler stub" -- apps/agent/src/cursor.rs apps/agent/src/desktop.rs apps/agent/src/main.rs
```

---

### Task 12: Agent Control Task Cursor Loop Integration (ADR-45)

**Files:**
- Modify: `apps/agent/src/main.rs`
- Modify: `apps/agent/src/desktop.rs`

**Interfaces:**
- Consumes: `CursorPoller`, `last_input_seq: Arc<AtomicU64>`, control data channel
- Produces: 60Hz `desktop-cursor` messages sent on control channel whenever position or shape changes.

- [ ] **Step 1: Implement frame_desktop_cursor builder**
In `apps/agent/src/desktop.rs`:
```rust
pub fn frame_desktop_cursor(cursor: &DesktopCursorPayload, timestamp_ms: u64) -> String {
    serde_json::to_string(&serde_json::json!({
        "type": "desktop-cursor",
        "channel": "control",
        "payload": cursor,
        "timestamp": timestamp_ms,
    })).expect("desktop-cursor serialization")
}
```

- [ ] **Step 2: Add cursor polling task in main.rs**
In `apps/agent/src/main.rs`:
- Spawn `cursor_task` alongside `control_task` when streaming desktop on Linux/Windows.
- Poll sampler at 60 Hz interval.
- If cursor position or shape changed: build `DesktopCursorPayload` with `last_input_seq` load, format via `frame_desktop_cursor`, and send via data channel `dc.send_text()`.
- Ensure clean cancellation on session teardown.

- [ ] **Step 3: Run cargo test and clippy**
Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS.

- [ ] **Step 4: Commit changes**
```bash
git commit -m "feat(agent): integrate cursor poller into control channel loop" -- apps/agent/src/desktop.rs apps/agent/src/main.rs
```

---

### Task 13: Desktop-Core Cursor Dispatch & Normalization (ADR-45)

**Files:**
- Modify: `packages/desktop-core/src/client.ts`
- Modify: `packages/desktop-core/src/types.ts`
- Modify: `packages/desktop-core/test/client.test.ts`

**Interfaces:**
- Consumes: Inbound `desktop-cursor` control messages
- Produces: `client.onCursor((cursor: DesktopCursorPayload) => void)` subscription, `DesktopSourcesPayload.cursorInFrame` normalization.

- [ ] **Step 1: Write failing unit tests in client.test.ts**
Add tests verifying:
1. `client.onCursor` receives dispatched `desktop-cursor` payload.
2. `DesktopSourcesPayload` normalizes missing `cursorInFrame` to `false`.
3. `sendInput` stamps monotonic `seq` on `pointer-move`, `pointer-button`, and `wheel` events.

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/desktop-core test`
Expected: FAIL.

- [ ] **Step 3: Implement cursor handling and input seq stamping in client.ts**
- Add `cursorListeners` array and `onCursor` subscription method.
- In `dispatchControl`: handle `desktop-cursor` case and fan out to listeners.
- Normalize `cursorInFrame: payload?.cursorInFrame === true` in `desktop-sources`.
- Add private `inputSeq = 0` counter; stamp `event.seq = ++this.inputSeq` in `sendInput` for pointer events.

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/desktop-core test && pnpm --filter @ponter/desktop-core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(desktop-core): dispatch desktop-cursor frames and stamp input sequence numbers" -- packages/desktop-core/src/client.ts packages/desktop-core/test/client.test.ts
```

---

### Task 14: Web Coordinate Math & Cursor Extrapolation (ADR-45)

**Files:**
- Modify: `apps/web/src/lib/desktop-input.ts`
- Create: `apps/web/src/test/desktop-input.test.ts`

**Interfaces:**
- Consumes: `contentBox()` letterbox rectangle calculation
- Produces:
  - `contentBox(rect, videoWidth, videoHeight)`
  - `toClient(nx, ny, rect, videoWidth, videoHeight)`
  - `extrapolateCursor(p0, p1, targetTimeMs, maxDeltaMs)` pure function

- [ ] **Step 1: Write failing unit tests in desktop-input.test.ts**
Assert:
1. `contentBox` computes correct pillarbox and letterbox offsets.
2. `toClient(toNormalized(x, y))` round-trips within 1 pixel.
3. `extrapolateCursor` predicts linear trajectory up to 100ms and clamps at 100ms without overshoot.

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/web test src/test/desktop-input.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement geometry and extrapolation functions**
In `apps/web/src/lib/desktop-input.ts`:
- Refactor `toNormalized` to use shared `contentBox()`.
- Export `contentBox()` and `toClient()`.
- Implement `extrapolateCursor`: compute velocity from last two samples `(p0, p1)`, apply velocity for `min(now - p1.time, 100ms)`, clamp result to `0..1`.

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/web test src/test/desktop-input.test.ts && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(web): add contentBox geometry and cursor extrapolation pure function" -- apps/web/src/lib/desktop-input.ts apps/web/src/test/desktop-input.test.ts
```

---

### Task 15: Web DesktopView Cursor Overlay Canvas (ADR-45 & ADR-47)

**Files:**
- Modify: `apps/web/src/components/desktop/DesktopView.vue`
- Modify: `apps/web/src/__tests__/DesktopView.test.ts`

**Interfaces:**
- Consumes: `tab.desktopCursor`, `tab.desktopCursorInFrame`, `inputOn` state
- Produces: Canvas overlay positioned over video rendering local pointer when controlling, extrapolated pointer when view-only, and hiding when `cursorInFrame: true` or `visible: false`.

- [ ] **Step 1: Write failing component tests in DesktopView.test.ts**
Assert:
1. Video element has `cursor-none` class when `inputOn` is true.
2. Overlay canvas is rendered with identical geometry to video content box.
3. When `desktopCursorInFrame` is true, overlay canvas is hidden.
4. Latency footer surfaces `echoMs` when available.

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/web test src/__tests__/DesktopView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement overlay canvas and footer metrics in DesktopView.vue**
- In `DesktopView.vue`:
  - Add `<canvas ref="cursorCanvas" class="pointer-events-none absolute inset-0" :class="{ hidden: tab.desktopCursorInFrame }">`.
  - Set `:class="{ 'cursor-none': inputOn }"` on video container.
  - In `requestAnimationFrame` loop: render remote cursor image / arrow at coordinates.
  - When controlling: draw at local client mouse position.
  - When view-only: draw at extrapolated remote position.
  - In footer telemetry bar: display `echo: {{ tab.desktopEchoMs }}ms` alongside bitrate/fps.

- [ ] **Step 4: Run tests, lint, and typecheck**
Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(web): add cursor overlay canvas and latency telemetry to DesktopView" -- apps/web/src/components/desktop/DesktopView.vue apps/web/src/__tests__/DesktopView.test.ts
```

---

### Task 16: Pinia Store Cursor State & Echo Round-Trip (ADR-45 & ADR-47)

**Files:**
- Modify: `apps/web/src/stores/terminal.ts`
- Modify: `apps/web/src/__tests__/terminal-store.test.ts`

**Interfaces:**
- Consumes: `client.onCursor`, `client.onSources`, `sendInput`
- Produces: `tab.desktopCursor`, `tab.desktopCursorInFrame`, `tab.desktopEchoMs` calculated via bounded `seq -> sentAtMs` map.

- [ ] **Step 1: Write store unit tests in terminal-store.test.ts**
Assert:
1. `onCursor` updates `tab.desktopCursor`.
2. When cursor carries `lastInputSeq`, `tab.desktopEchoMs` computes `receiveMs - sentAtMs`.
3. Bounded map purges entries older than 5 seconds or over 100 items so memory cannot leak.

- [ ] **Step 2: Run tests to verify failure**
Run: `pnpm --filter @ponter/web test src/__tests__/terminal-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement cursor state and echo calculation in terminal.ts**
- In `TabItem`: add `desktopCursor?: DesktopCursorPayload`, `desktopCursorInFrame?: boolean`, `desktopEchoMs?: number`.
- In `openDesktopTab`:
  - Pass `{ playoutDelayMs: 100 }` to `new DesktopClient`.
  - Maintain bounded `Map<number, number>` for `inputSentTimes`.
  - On `client.onCursor`:
    ```ts
    tab.desktopCursor = cursor;
    if (cursor.lastInputSeq && inputSentTimes.has(cursor.lastInputSeq)) {
      tab.desktopEchoMs = Math.max(0, Date.now() - inputSentTimes.get(cursor.lastInputSeq)!);
      inputSentTimes.delete(cursor.lastInputSeq);
    }
    ```
  - On `client.onSources`: update `tab.desktopCursorInFrame = payload.cursorInFrame === true`.

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(web): manage cursor state and input-echo latency in terminal store" -- apps/web/src/stores/terminal.ts apps/web/src/__tests__/terminal-store.test.ts
```

---

### Layer 4: WebCodecs Render Path (L4, P2-Gated)

### Task 17: WebCodecs Transform Worker & Fallback Controller (ADR-48)

**Files:**
- Create/Modify: `apps/web/src/lib/webcodecs/` (or doc note if P2 fails)
- Test: `apps/web/src/test/webcodecs-controller.test.ts`

**Interfaces:**
- Consumes: Probe P2 findings, `RTCRtpScriptTransform`, `VideoDecoder`
- Produces: WebCodecs render pipeline with automatic fallback to `<video>` `srcObject` on any error.

- [ ] **Step 1: Check P2 probe outcome**
Verify `docs/spikes/2026-10-07-p2-webcodecs-probe.md`:
- If P2 **PASSED**: Implement worker transform + VideoDecoder drawing to OffscreenCanvas.
- If P2 **FAILED**: Execute descope branch: document descope rationale, verify `<video>` pipeline remains primary, satisfy gate 4 without code changes.

- [ ] **Step 2: (If P2 Passed) Write unit tests for fallback controller**
Assert:
1. Absence of `VideoDecoder` falls back to `<video>`.
2. Decoder configure error terminates worker and reattaches `srcObject`.
3. Session teardown closes worker and decoder cleanly.

- [ ] **Step 3: (If P2 Passed) Implement worker and controller**
Implement transform worker and controller adhering strictly to spec §ADR-48.

- [ ] **Step 4: Run tests and typecheck**
Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit changes**
```bash
git commit -m "feat(web): add WebCodecs render pipeline with automatic fallback" -- apps/web/src/
```

---

### Layer 5: Verification, Benchmarks & Documentation (L5)

### Task 18: Cross-Language E2E Cursor & Latency Verification (ADR-45, 47)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`

**Interfaces:**
- Consumes: Agent under Xvfb, Server port 8787, werift peer in E2E harness
- Produces: Automated E2E verification of cursor round-trip, view-only cursor streaming, stats timing fields, and printed echo latency summary.

- [ ] **Step 1: Add cursor E2E test cases**
In `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`:
```ts
it('streams cursor position and echoes input sequence number under Xvfb', async () => {
  const { offerer, controlFrames } = await openTestDesktopStream();
  // Wait for initial cursor frames
  await waitFor(() => controlFrames.some((f) => f.type === 'desktop-cursor'), 5000);
  
  // Send pointer-move with seq 777
  sendPointerMove(offerer, 0.4, 0.4, 777);
  
  // Verify cursor frame arrives with lastInputSeq == 777
  await waitFor(() => {
    const cursor = controlFrames.findLast((f) => f.type === 'desktop-cursor')?.payload as DesktopCursorPayload;
    return cursor?.lastInputSeq === 777;
  }, 5000);
});

it('continues streaming cursor in view-only mode with input gate closed', async () => {
  const { controlFrames } = await openTestDesktopStream({ allowInput: false });
  await waitFor(() => controlFrames.some((f) => f.type === 'desktop-cursor'), 5000);
  const cursor = controlFrames.findLast((f) => f.type === 'desktop-cursor')?.payload as DesktopCursorPayload;
  expect(cursor.visible).toBeDefined();
});

it('publishes rolling frame latency timing in desktop-stats', async () => {
  const { stats } = await openTestDesktopStream();
  await waitFor(() => stats().some((s) => s.captureMsP50 !== undefined), 5000);
  const sample = stats().findLast((s) => s.captureMsP50 !== undefined)!;
  expect(sample.captureMsP50).toBeGreaterThanOrEqual(0);
  expect(sample.encodeMsP50).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Add echo latency summary report**
Compute and print echo round-trip statistics across test runs:
`console.log(`[6b echo] n=${count} min=${min}ms median=${median}ms max=${max}ms`);`

- [ ] **Step 3: Run E2E test suite locally**
Run: `pnpm --filter @ponter/webrtc-core test:e2e` with `DISPLAY=:99` and fresh agent binary.
Expected: PASS (all 16+ tests green).

- [ ] **Step 4: Commit E2E test additions**
```bash
git commit -m "test(e2e): verify cursor round-trip, view-only streaming, and latency echo" -- packages/webrtc-core/test/e2e/desktop.e2e.test.ts
```

---

### Task 18B: Playwright Browser Smoke (ADR-49 adopt branch)

**Files:**
- Create: `packages/webrtc-core/playwright.config.ts`
- Create: `packages/webrtc-core/test/e2e/browser-smoke.pw.ts`
- Modify: `packages/webrtc-core/package.json` (devDependency `@playwright/test`, script `test:browser`)
- Modify: `.github/workflows/ci-e2e.yml` (install pinned browser + run `test:browser`)

**Interfaces:**
- Consumes: `harness.ts` helpers (`setupE2E`, `seed`, `spawnAgent`, `waitForAgentOnline`, `waitForAgentSigningKey`), fresh agent binary, server port 8787, Vite dev server on 5173, `CORS_ORIGIN` allowing the web origin
- Produces: one CI smoke spec proving the ADR-49 proof list under a real browser; the ADR-47 g2g protocol prints `[6b g2g] n=<count> min=<ms> median=<ms> max=<ms>`

- [ ] **Step 1: Add Playwright to `@ponter/webrtc-core`**
Add `@playwright/test` as a devDependency and a `test:browser` script (`playwright test`). Run `pnpm install` and commit the lockfile change path-limited.

- [ ] **Step 2: Write `playwright.config.ts`**
Chromium project only; `testDir: 'test/e2e'`, `testMatch: '**/*.pw.ts'`; `workers: 1`, `fullyParallel: false`; generous `timeout: 120_000`. No `webServer` entry — the spec spawns server + Vite itself via `harness.ts` (same discipline as the vitest e2e).

- [ ] **Step 3: Write the smoke spec**
`test/e2e/browser-smoke.pw.ts`:
1. `setupE2E()`; `seed({ capabilities: ['desktop'] })`; `spawnAgent(..., ['--desktop-source', 'test'])`; wait online + signing key.
2. Start the web client: Vite dev server `--host 127.0.0.1 --port 5173` with `VITE_API_URL=http://127.0.0.1:8787`; server env `CORS_ORIGIN` allows `http://127.0.0.1:5173`.
3. `page.goto` → register **through the UI** (`/register`) so IndexedDB holds the ECDH + Ed25519 keys (ADR-41 fail-closed otherwise).
4. Create agent + session via REST; click `[data-test="connect-desktop-<id>"]`.
5. Assert the ADR-49 proof list: `connectionState === 'connected'`; remote video track present (`<video>.srcObject`); `[data-test="desktop-stats"]` visible; with `--allow-input`, one pointer move over the video → agent log shows `desktop-input applied` and the toggle shows `Controlling`; `page.evaluate` on the app's real `RTCPeerConnection` receiver shows the applied knob (`jitterBufferTarget === 100` and/or `playoutDelayHint === 0.1`).
6. Carry the ADR-47 g2g protocol (test-pattern bar decode, §ADR-47 item 4) and print `[6b g2g] n=<count> min=<ms> median=<ms> max=<ms>`.
7. Input-echo assertion runs under Xvfb (`DISPLAY=:99`); the video-only assertions must pass with `DISPLAY` unset (P1 finding — assert nothing display-dependent before the input step).

- [ ] **Step 4: Wire CI**
In `ci-e2e.yml`: install the pinned browser (`pnpm --filter @ponter/webrtc-core exec playwright install chromium --with-deps`) and run `pnpm --filter @ponter/webrtc-core test:browser` in the same job discipline as the vitest e2e (fresh binary, exclusive 8787, Xvfb `:99`).

- [ ] **Step 5: Run the smoke locally and commit**
Run: `pnpm --filter @ponter/webrtc-core test:browser` (fresh binary, Xvfb :99). Expected: PASS, g2g line printed.
```bash
git commit -m "test(e2e): add Playwright browser smoke (ADR-49 adopt)" -- packages/webrtc-core/playwright.config.ts packages/webrtc-core/test/e2e/browser-smoke.pw.ts packages/webrtc-core/package.json pnpm-lock.yaml .github/workflows/ci-e2e.yml
```

---

### Task 19: Architecture Spec Update & Demo Documentation (ADR-47)

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/demos/2026-10-07-phase6b-low-latency-demo.md`

**Interfaces:**
- Consumes: Measured latency numbers, probe outcomes, cursor platform matrix
- Produces: Reconciled repo architecture documentation and comprehensive Phase 6b demo artifact.

- [ ] **Step 1: Update ARCHITECTURE.md**
- §8 (heading `## 8. Lộ trình Triển khai`, line ~871): replace the stale Phase 6 blockquote (~line 1001) — remove "6b chưa thiết kế / sẽ có spec riêng" — with 6b complete + ADR-45..49 delivered + links to the 6b spec and demo doc. Do not touch Phase 7 (~1003) or `## 9.` (~1009).
- §8 Phase 5 checkboxes (~lines 993–997): flip `- [ ]` → `- [x]` for WS1–WS5 (Phase 5 shipped; PM-2 ruling).
- §11 (heading `## 11. Performance Targets`, line ~1122; table 3 cols `Metric | Target | Method`): add measured desktop-latency rows — capture→encode, input-echo round-trip, glass-to-glass @ 100/50/0 ms — each with provenance in the Method column (protocol, sample count, test name), phrased as *measured*, not as a promise. Keep the hardware row (~1128) as "chưa chốt" and link the P3 finding only (adoption not committed).
- Record cursor platform matrix honestly (X11 full, Windows compile-checked, macOS in-frame, Wayland uncommitted).

- [ ] **Step 2: Write demo document**
Create `docs/demos/2026-10-07-phase6b-low-latency-demo.md` covering:
- Executive summary & verification evidence.
- Measured latency table (components, input-echo, glass-to-glass protocol).
- Cursor visual checks and extrapolation verification.
- Probes P1, P2, P3 outcomes.
- Security posture (plaintext cursor frames rationale).

- [ ] **Step 3: Commit documentation updates**
```bash
git commit -m "docs: reconcile ARCHITECTURE.md and record Phase 6b demo report" -- docs/ARCHITECTURE.md docs/demos/2026-10-07-phase6b-low-latency-demo.md
```

---

## Final Verification Checklist

- [ ] `cargo fmt --check --manifest-path apps/agent/Cargo.toml`
- [ ] `cargo clippy --all-targets --locked --manifest-path apps/agent/Cargo.toml -- -D warnings`
- [ ] `cargo test --locked --manifest-path apps/agent/Cargo.toml`
- [ ] `pnpm format:check`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm --filter @ponter/webrtc-core test:e2e` (fresh binary, DISPLAY=:99, exclusive port 8787)
- [ ] Sonar new-code duplication check clean
- [ ] Push plan commits to origin before PR creation
