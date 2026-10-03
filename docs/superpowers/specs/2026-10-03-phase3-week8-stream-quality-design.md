# Phase 3 Week 8 — Desktop Stream Quality & Source Selection Design Specification

**Status:** Draft — Ready for review
**Date:** 2026-10-03
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 3 Week 8 of `docs/ARCHITECTURE.md` (Section 8, "Tuần 8-9: Chất lượng & tương tác"). Week 8 covers **stream quality (resolution/frame-rate/bitrate), adaptive bitrate, and capture-source selection**. Input forwarding (mouse/keyboard) is Week 9 and is out of scope here.

---

## 1. Overview & Objectives

Week 7 shipped the desktop thin slice: a view-only, ~720p @ 15 fps, software H.264 stream over SRTP, with the encoder hardcoded (`1280×720`, 15 fps, 2 Mbps) and the capture source fixed to the primary monitor. Week 8 turns that proof into a usable stream: it raises the quality bar, makes quality adjustable, and lets the user choose *what* to stream.

The roadmap item is "Tăng chất lượng/khung hình, adaptive bitrate" and "Chọn màn hình/cửa sổ, codec phần cứng" (`ARCHITECTURE.md:942-944`). This spec delivers the first two; hardware codec is investigated by a timeboxed spike but is **not** committed (§1.2, ADR-25).

Two constraints shape the design:

- **Software H.264 headroom is real but thin.** A measured benchmark (§3.1) puts 1080p30 at ~28 ms/frame against a 33.3 ms budget — 1.2× headroom, and 1080p60 is infeasible. Quality is therefore a *conditional* target with an explicit safe floor, not a promise (ADR-24).
- **openh264 0.9.8 cannot reconfigure at runtime through its public API.** `Encoder::reinit` and the config it reads are private (§3.2), so a runtime bitrate change is only reachable through the `unsafe` raw API. This made adaptive bitrate **spike-gated** (ADR-23) — and the spike has now **passed** (§3.7): the `unsafe` path retargets cleanly, no rebuild and no blip, so auto-ABR ships.

### 1.1 Core Goals

1. **A runtime quality profile replaces the Week 7 constants.** `StreamProfile { max_width, max_height, fps, bitrate_bps }` is resolved at session start; `downscale`'s box, the ticker cadence, and the encoder are all built from it. Default **1080p30**, safe floor **720p30** (ADR-21, ADR-24).
2. **Manual bitrate control from the browser.** A desktop control channel carries a `desktop-bitrate` frame; the browser exposes a small bitrate control. The agent applies a new target **in place** via `raw_api().set_option(ENCODER_OPTION_BITRATE, …)` — no rebuild, no keyframe blip (§3.7, ADR-23). This is the guaranteed half of the ABR work and ships regardless of the spike outcome (ADR-23).
3. **Screen/window picker.** The agent enumerates monitors and windows via `xcap` (already available — §3.4) and sends a `desktop-sources` list over the control channel; the browser shows a picker. The agent streams the default source immediately; a `desktop-select` for a **different** source switches the live stream (one IDR blip, ADR-22).
4. **Adaptive bitrate (spike resolved PASS).** The half-day spike confirmed `unsafe raw_api()` `SetOption` retargets the encoder at runtime with no visible glitch (§3.7), so **GCC-driven auto-ABR ships this week** (using webrtc-rs's built-in estimator, §3.3), alongside manual control. It remains a **goal, not an acceptance criterion** (ADR-23, §10.2).
5. **A timeboxed hardware-codec spike.** A half-day investigation of AV1 / H.264 hardware encode on the agent, to inform a *later* decision. It is a prerequisite for nothing and gates no acceptance criterion (ADR-25).
6. **Automated + manual verification.** Rust unit tests for the profile/geometry/encoder path, TS unit tests for the control client and picker, E2E coverage of the control channel and source selection, and a manual demo showing 1080p30 (or the documented fallback) in real Chrome.

### 1.2 Non-Goals (Explicitly Deferred)

- **Input forwarding (mouse/keyboard).** Owned by Week 9; no input handling is added here. The desktop offer stays media + control only.
- **Hardware codec (H.265/HEVC, AV1, H.264 hardware).** **H.265 is not viable in WebRTC in any browser today** — MDN lists Chrome, Edge, Firefox, Opera and Safari all as **"No"** for HEVC in WebRTC (§3.5). A timeboxed spike explores alternatives but commits nothing (ADR-25).
- **Software 1080p60.** Measured at 0.6× realtime (§3.1) — infeasible with software H.264; deferred to a hardware path.
- **Auto-ABR if the spike fails.** Conditional by construction (ADR-23); the spec carries both branches so a failed spike shrinks scope without an edit. **Note: the spike PASSED (§3.7) ⇒ this branch does not apply; auto-ABR ships.**
- **Automatic mid-session source re-selection.** A user-initiated `desktop-select` switch ships (ADR-22), but there is no automatic re-selection (e.g. following the focused window). Selection is explicit.
- **Multi-monitor coordinate mapping / input.** The picker exposes geometry, but mapping browser input to source coordinates is Week 9 (input forwarding) and is out of scope here.
- **File transfer.** Owned by Phase 4 (Tuần 10-11), which remains a stub (`ARCHITECTURE.md:946-948`) and is not touched.
- **WebCodecs rendering.** `<video>` + `srcObject` remains the render path; low-latency WebCodecs is a later concern.
- **macOS/Windows runtime capture verification.** Those targets must compile and pass unit tests; runtime capture stays unverified (no CI hardware).
- **Server-side changes.** No new endpoints, no schema changes; the control channel is peer-to-peer over the existing DTLS/SCTP transport.

---

## 2. Wire Protocol & Contract Specifications

### 2.1 The desktop offer gains a control channel

Week 7's desktop offer had **no data channel** (`channelLabels: []`). Week 8 adds one — the reserved `'control'` label (`WebRTCChannelType` already includes it, `packages/shared/src/types/webrtc.ts:7`) — to carry the source list, the source selection, and bitrate control. Media still flows as RTP.

| Flow | `channelLabels` | `capabilities` | `media` |
|---|---|---|---|
| Terminal (existing) | `['terminal']` | omitted → falls back to `channelLabels` | omitted |
| Desktop (Week 7) | `[]` | `['desktop']` | `{ video: true }` |
| Desktop (Week 8) | `['control']` | `['desktop']` | `{ video: true }` |

The agent's desktop branch now accepts exactly one inbound data channel, labeled `'control'`, and rejects any other label. `capabilities` remains attacker-controlled and is still compared by exact string equality only.

### 2.2 Control-channel frames

Frames reuse the existing envelope `DataChannelMessage<T>` (`packages/shared/src/types/webrtc.ts:8-14`): `{ type: string, channel: 'control', payload: T, timestamp: number }`. New payload types live in a new module `packages/shared/src/types/desktop.ts`, mirrored by a Rust decoder in the agent (the same shape as `pty.rs`'s `decode_pty_input`).

| `type` | Direction | `payload` | Purpose |
|---|---|---|---|
| `desktop-sources` | agent → browser | `{ sources: DesktopSourceInfo[] }` | Enumerate capture sources after connect; the streaming one is flagged `default` |
| `desktop-select` | browser → agent | `{ sourceId: string }` | Switch to a different source (only sent when it differs from the streaming one) |
| `desktop-bitrate` | browser → agent | `{ bitrateBps: number }` | Manual bitrate target |
| `desktop-stats` | agent → browser | `{ width, height, fps, targetBitrateBps, status? }` | Telemetry for the UI (best-effort); `status` carries an optional agent→browser note (a refused selection, a quality downgrade) |

```typescript
export interface DesktopSourceInfo {
  id: string;                       // stable per enumeration, e.g. "monitor:1" / "window:0x4a00007"
  kind: 'monitor' | 'window';
  name: string;                     // Monitor::name()/friendly_name(), Window::title()
  width: number;
  height: number;
  x: number;                        // source geometry — needed by Week 9 input mapping
  y: number;
  scaleFactor: number;
  rotation: number;
  isPrimary: boolean;
  default: boolean;                 // the entry the agent is streaming right now
}

export interface DesktopStats {
  width: number;
  height: number;
  fps: number;
  targetBitrateBps: number;
  /** Optional agent→browser note; absent on ordinary telemetry. */
  status?: { kind: 'select-refused' | 'quality-downgraded'; detail: string };
}
```

**Error path (the only one):** there is **no** dedicated error frame type — the four types above are the whole vocabulary. When the agent cannot honour a request it stays silent on the request itself and, where a browser-visible outcome exists, appends a `status` to the next `desktop-stats`:

- **Unknown `desktop-select` id** → the agent logs it, leaves the current stream running, and sends a `desktop-stats` with `status.kind = 'select-refused'` (the UI keeps showing the old source and can surface the note). No `desktop-select` ack exists; the stream continuing on the previous source is the observable truth.
- **Sustain downgrade** (ADR-24) → the agent emits a `desktop-stats` whose `width`/`height` reflect the new (720p) size with `status.kind = 'quality-downgraded'`.

An unknown `type` or a frame on the wrong channel is dropped and logged, never answered.

### 2.3 Session sequence (desktop, Week 8)

1. Browser offers `capabilities: ['desktop']`, `channelLabels: ['control']`, `media: { video: true }` — unchanged from Week 7 apart from the control label.
2. The agent creates the source for its **default** source (primary monitor; the test pattern under `--desktop-source test`) **before** the answer — preserving the Week 7 invariant that a capture failure is a clean `approved: false` refusal (`main.rs:1000-1014`), not a black video element. It answers `approved: true`, attaches the sending track (before `set_remote_description`, ADR-15), and starts `run_stream` on the default source. **The stream starts immediately — a passive viewer sees video with no extra delay versus Week 7.**
3. On the control channel opening, the agent sends `desktop-sources` (its enumeration, with the currently-streaming entry flagged `default: true`).
4. The browser shows the picker. If the user picks a source **different from the one streaming**, it sends `desktop-select`; the agent builds that source + encoder and swaps it in (a `run_stream` restart — one IDR blip, ADR-22). Picking the current source, or never opening the picker, sends nothing and leaves the stream untouched.
5. The test-pattern source (`--desktop-source test`) enumerates exactly one entry and is flagged `default: true`; the browser auto-selects it with no user interaction, so E2E never blocks on a picker (ADR-22, §8.3).
6. The browser may send `desktop-bitrate` at any time; the agent applies it per ADR-23 and echoes the effective value in `desktop-stats`.

### 2.4 Terminal flow — unchanged

Terminal sessions keep the Week 6/7 contract byte-for-byte: `channelLabels: ['terminal']`, one `'terminal'` channel, `terminal-*` frames. The new `'control'` label is desktop-only; the terminal path never sees it.

---

## 3. Verified Findings

All facts below were verified against crate sources on disk, by measurement, or against vendor documentation — not from memory. Measurements name their method so QA can reproduce them.

### 3.1 `openh264` 0.9.8 — software throughput (measured)

A standalone benchmark (throwaway binary, 2026-10-03) built the encoder with the agent config's core settings — `UsageType::ScreenContentRealTime`, `Complexity::Low`, `RateControlMode::Bitrate`, `intra_frame_period = 60`, `VuiConfig::bt709()` (the bench additionally sets `adaptive_quantization(false)`/`background_detection(false)`, both library defaults the agent leaves unset) — and timed **only** the `encode()` call over 200 pre-generated frames per case.

| Case (moving-block content) | ms/frame | Budget | Headroom | Verdict |
|---|---|---|---|---|
| 720p30 (1280×720, 4 Mbps) | 11.3 | 33.3 ms | **2.9×** | comfortable |
| 1080p30 (1920×1080, 6 Mbps) | 28.1 | 33.3 ms | **1.2×** | marginal |
| 1080p60 (1920×1080, 8 Mbps) | 28.2 | 16.7 ms | **0.6×** | infeasible |

- **Methodology / caveat.** Host: Intel i5-14400 (16 threads), a single encoder instance, release profile. openh264's `num_threads` (tested at 1, 4, 8) made **no measurable difference** — slice-level threading does not help this workload. Cost scales ~linearly with pixel count (1080p ≈ 2.25× the pixels of 720p → ≈ 2.49× the time, measured 28.1 / 11.3 ms). Content was synthetic ("mostly-static gradient + a moving block"), which approximates a desktop but is **not** a real screen; a weaker host, or contention with the capture thread and the WebRTC stack, will be worse.
- **Consequence.** 1080p30 is achievable but with only ~5 ms/frame of slack; 1080p60 with software H.264 is out. This drives ADR-24 (conditional 1080p30 + 720p30 floor).

### 3.2 `openh264` 0.9.8 — runtime reconfiguration

- `Encoder::reinit(width, height)` is **private** (`openh264-0.9.8/src/encoder.rs:950`) and reads `self.config.target_bitrate` / `self.config.max_frame_rate` (lines 972, 974); `self.config` is private. `reinit` is only reached automatically when the frame **dimensions change** (`encode_at`, lines 909/913), and it re-applies the *same* config — so a dimension change does not help change the bitrate.
- There is **no public API** to change bitrate at runtime. Two paths exist:
  1. `pub const unsafe fn raw_api(&mut self) -> &mut EncoderRawAPI` (`encoder.rs:1062`) exposes `set_option` (wired at `encoder.rs:60`). Two options apply here: `ENCODER_OPTION_SVC_ENCODE_PARAM_EXT` (pushes a modified `SEncParamExt`) and `ENCODER_OPTION_BITRATE` (takes `SBitrateInfo { iLayer, iBitrate }`). The spike (§3.7) confirmed the latter — **verified to retarget in place with no visible glitch**.
  2. Rebuild the `Encoder` with a new `EncoderConfig` — guaranteed to work, but emits a fresh SPS/PPS + IDR (a visible keyframe blip) on every change.
- **Consequence.** Runtime bitrate change is possible in place (path 1, confirmed by §3.7 — the shipped design) or with a glitch (path 2, the fallback). ADR-23 records the choice.

### 3.3 `webrtc` / `rtc` 0.21.0 — congestion control is built in

- Send-side congestion control exists and is not something we must implement: `ReportingEstimator::new(Gcc::new(INITIAL, MIN, MAX))` + `configure_congestion_control(registry, estimator, CongestionFeedback::Twcc, &mut media_engine)` — the shipped example `webrtc-0.21.0/examples/bandwidth-estimation-from-disk/bandwidth-estimation-from-disk.rs` builds exactly this.
- The estimator drives `Attribute::TargetBitrateChanged` into the interceptor chain (`rtc-0.21.0/src/peer_connection/handler/interceptor.rs:782`), and the value surfaces in outbound-rtp `target_bitrate` stats.
- `RtpSender::set_parameters(RTCRtpSendParameters, Option<RTCSetParameterOptions>)` (`rtc-0.21.0/src/rtp_transceiver/rtp_sender/mod.rs:307`) updates encoding parameters (max bitrate, frame rate) at runtime; `RTCRtpEncodingParameters.max_bitrate` is the field.
- **Consequence.** The *transport* half of ABR is available. The encoder half is applying a target to openh264 (§3.2) — settled by the spike (§3.7, PASS).

### 3.4 `xcap` 0.9.8 — enumeration and geometry already exist

- The vendored `xcap` (`apps/agent/vendor/xcap`) exposes `Monitor::all()`, `Monitor::from_point(x, y)`, and per-monitor `id()`, `name()`, `friendly_name()`, `x()`, `y()`, `width()`, `height()`, `rotation()`, `scale_factor()`, `is_primary()`, `is_builtin()`, plus `capture_image()`/`capture_region()`/`video_recorder()`. `Window::all()` similarly exposes `id()`, `app_name()`, `title()`, `x()/y()/width()/height()`, `is_minimized()`/`is_maximized()`/`is_focused()`.
- Today the agent uses **only** `primary_recorder()` (`apps/agent/src/desktop.rs:404-421`) and discards every other field. The picker is therefore additive: no new capture dependency, only new plumbing to surface what xcap already returns.
- **Consequence.** `DesktopSourceInfo` (§2.2) is a direct projection of existing xcap accessors; `capture_region()` also makes window/region capture feasible without new crates.

### 3.5 H.265/HEVC in WebRTC — not viable

- MDN's video-codec guide lists HEVC/H.265 WebRTC support as **"No" for Chrome, Edge, Firefox, Opera and Safari** — even where `<video>` playback is partially supported. `caniuse` agrees: only Safari has full HEVC support, and that is for playback, not WebRTC.
- **Consequence.** H.265 is a Non-Goal (§1.2, ADR-25). Any future quality push must use H.264 (hardware, if available) or AV1, not H.265.

### 3.6 What cannot be verified from this repository

(The ADR-23 runtime-retarget question was on this list; the spike has since **verified it — §3.7**.)

- Real-screen encode cost at 1080p30 (the §3.1 number is synthetic) — manual demo only.
- Whether a weaker-than-i5 host sustains 1080p30 — the fallback (§ADR-24) covers it; not gated.
- AV1 / H.264 hardware availability on real agents — the spike (ADR-25) investigates, does not commit.
- macOS/Windows runtime capture — compile + unit tests only.

### 3.7 ADR-23 runtime bitrate retarget — measured (spike PASSED)

The ADR-23 spike ran as a standalone binary (2026-10-03), reproducing the openh264 call path the agent would use. Environment: Docker `rust:1.98-bookworm`, `openh264` 0.9.8, **320×240 @ 30 fps**, `RateControlMode::Bitrate`, 120 frames, retarget applied at **frame 60**. The method and results are embedded here rather than pointed at a scratch directory, so they are reproducible from the spec alone.

| Case | Retarget | avg bytes/frame before → after | ratio | rc | `GetOption` after | blip |
|---|---|---|---|---|---|---|
| CONTROL | none | 4093 → 4093 | 1.00× | 0 | 1_000_000 | 0 |
| A | 1.0 M → 0.25 M | 4020 → 1044 | **0.26×** | 0 | 250_000 | 0 |
| B | 1.0 M → 2.0 M | 4020 → 8351 | **2.08×** | 0 | 2_000_000 | 0 |
| C | 1.0 M → 0.25 M via `SVC_ENCODE_PARAM_EXT` | 4020 → 1044 | **0.26×** | 0 | 250_000 | 0 |

- **The measured frame-size ratio matches the bitrate ratio** (0.25× target → 0.26× bytes; 2.0× target → 2.08× bytes), so the retarget is proven by real encoded bytes, not merely by `GetOption` echoing the value back. `rc = 0` on every `set_option` call.
- **Blip detector.** The encoder is configured with `uiIntraPeriod = 1_000_000` and `scene_change_detect = false`, so the only IDR is frame 0; the harness counts NAL types 7 (SPS) / 8 (PPS) / 5 (IDR) **after** frame 0. CONTROL reports **0** ⇒ the detector does not false-positive, so the 0 counts for A/B/C are meaningful: **no SPS/PPS/IDR is emitted on a retarget**, on either path.
- **Honest caveats.** (i) 115/120 frames decoded in **every** case including CONTROL — 5 frames skipped by openh264's `bEnableFrameSkip` at this small resolution; **0 decode errors**. (ii) The `ScreenContentRealTime` usage type forces scene-change detection on, which emits an IDR *every* frame and would mask the detector; the spike therefore used `CameraVideoRealTime` so the intra period above actually holds. **Watch item:** the agent's own encoder uses `ScreenContentRealTime` (§3.1, §6.1), so whether that interaction forces an IDR per frame in the production config must be re-checked at implementation time — this spike does not settle it, and it bears on the ADR-24 fallback's IDR assumptions.
- **Consequence.** ADR-23's PASS branch is the shipped design: the agent retargets via `raw_api().set_option`, no encoder rebuild, no keyframe blip. §3.6's "cannot be verified" item is now closed.

---

## 4. Architectural Decision Records

### ADR-21: Quality is a resolved session profile, not hardcoded constants

**Context.** Week 7 hardcodes the quality in two places: `downscale(&frame, MAX_WIDTH, MAX_HEIGHT)` with `MAX_WIDTH=1280`/`MAX_HEIGHT=720` and a fixed `FRAME_INTERVAL` (`desktop.rs:27-28, 481`), and `DesktopEncoder::new()` with a fixed `BitRate::from_bps(2_000_000)` / `FrameRate::from_hz(15.0)` (`desktop.rs:597-598`). Nothing can raise or lower quality without editing constants.

**Decision.** Introduce `StreamProfile { max_width: u32, max_height: u32, fps: f32, bitrate_bps: u32 }`. It is resolved once at session start from agent-side defaults (CLI/env, default **1080p30**), passed into `run_stream`, and used to build the downscale box, the ticker interval, and the `EncoderConfig`. `bitrate_bps` is the only member adjustable after start (ADR-23).

**Rationale.** One value expresses quality; the fixed bump and the later ABR both read from it, so adaptive work does not refactor the pipeline a second time.

**Consequence.** The Week 7 constants become the profile's *default*, and the `#[ignore]`d tests that assert 1280×720 downscale behavior are re-pointed at an explicit profile. The E2E `test` source keeps a fixed small profile for CI stability.

### ADR-22: Stream the default source immediately; the picker *switches*, it does not gate

**Context.** The picker lets the user choose a monitor or window. Two designs are possible: (a) the agent waits for a `desktop-select` before streaming, falling back to the primary monitor after a bounded window; or (b) the agent streams the default source immediately and a `desktop-select` *switches* the live stream.

Design (a) was the first proposal, but it has three problems found while reading the Week 7 code:

1. **It regresses the clean-refusal invariant.** Week 7 creates the source *before* the answer so a capture failure refuses with `approved: false` instead of a black video element (`main.rs:1000-1014`). Under (a) the source is created *after* the answer, so a capture failure becomes a post-answer failure on a live session.
2. **It slows every passive viewer.** Week 7 shows video immediately; (a) makes a non-interacting viewer wait the full fallback window (the 5 s proposal) before the first frame.
3. **It blocks E2E on a picker step.** CI uses `--desktop-source test`; (a) requires the harness to send `desktop-select` (or wait out the window), adding a new failure mode to a currently-stable suite.

**Decision.** Design (b). The agent creates the **default** source (primary monitor, or the test pattern under `--desktop-source test`) before the answer and streams it at once — Week 7's timing and refusal semantics are preserved exactly. `desktop-sources` reports the enumeration with the streaming entry flagged `default: true`. The browser sends `desktop-select` **only when the user picks a different source**; the agent then builds the new source + encoder and restarts `run_stream` (one IDR blip). Selecting the current source, or never opening the picker, changes nothing.

Two constants are named and configurable (env/CLI), not inline magic numbers:

- `DESKTOP_DEFAULT_SOURCE` (env `AGENT_DESKTOP_DEFAULT_SOURCE`, default `primary`) — which source streams before any selection.
- `DESKTOP_SELECT_APPLY_TIMEOUT` (env `AGENT_DESKTOP_SELECT_TIMEOUT_MS`, default `5000`) — the bounded window to apply a requested switch before giving up and keeping the current source (logged), so a source that fails to start cannot stall the session.

**Rationale.** Streaming the default immediately is strictly better than waiting: no added latency for passive viewers, no regression of the pre-answer capture-failure refusal, and no new E2E dependency on a picker step. "Switch on demand" is a smaller change than "wait then start" because the capture lifecycle stays "create source → attach → stream" — only *which* source is created changes.

**Consequence.** A source switch mid-session **is** supported (contrary to the initial "fixed for the session" wording), because streaming already started and switching is just a `run_stream` restart. This is a deliberate, bounded capability: one switch at a time, driven by explicit user action, not an automatic mid-stream re-selection. The picker's cost is one IDR blip on switch, acceptable for a user-initiated action. The test-pattern source enumerates one `default: true` entry so E2E auto-selects with no interaction (§8.3).

### ADR-23: Adaptive bitrate retargets in place; manual bitrate control ships unconditionally

**Context.** The transport half of ABR exists in webrtc-rs 0.21 (§3.3), but the encoder half does not: openh264 0.9.8 cannot change bitrate through its public API (§3.2). Applying a new target needs either `unsafe raw_api()` `SetOption` (unproven at decision time — **since proven, §3.7**) or an encoder rebuild (visible keyframe blip).

**Decision.** A **half-day spike, before any ABR commit**, tests whether `unsafe raw_api()` `SetOption` retargets the encoder at runtime **without a visible glitch**, judged by: (a) the call returns success, (b) the next frames use the new target, (c) no SPS/PPS/IDR blip is observed on the decoder side.

**Outcome — spike PASSED** (§3.7): all three criteria met (rc = 0, measured frame-size ratio matches the bitrate ratio, zero SPS/PPS/IDR after frame 0). The PASS branch below is therefore the shipped design; the FAIL branch is retained only as the design's other half.

- **Spike PASS (taken)** → ship **GCC-driven auto-ABR**: `ReportingEstimator::new(Gcc::new(...))` + `configure_congestion_control(..., CongestionFeedback::Twcc, ...)`, feeding `RtpSender::set_parameters` and the encoder target. The runtime retarget uses **`ENCODER_OPTION_BITRATE` (option 5)** through `raw_api().set_option`, which takes `SBitrateInfo { iLayer, iBitrate }` and only rescales the bitrate — cleaner than `SVC_ENCODE_PARAM_EXT` because it does not run `ParamTranscode`/`WelsEncoderParamAdjust`. This is a **goal** of the week, not a criterion (§10.2).
- **Spike FAIL** → auto-ABR is a **Non-Goal with recorded evidence**; only **manual bitrate control** ships (a `desktop-bitrate` frame that the agent applies by rebuild, accepting the one-time blip on an explicit user action).

Manual bitrate control and the fixed-quality profile (ADR-21) ship **regardless of the spike**.

**Rationale.** The spike is a prerequisite, not a deliverable: making acceptance depend on an unrun experiment would let an unknown silently change scope. Both branches are written here so a FAIL shrinks scope without editing this spec.

**Consequence.** §10.2 acceptance criteria do not reference the spike (it stays a goal, not a gate, even now that it passed). With the PASS branch taken, both manual control and auto-ABR retarget **in place, with no rebuild and no keyframe blip** — the "one IDR blip" cost mentioned for manual control in §1.1/§6.4 applies only to the (unshipped) FAIL path. Two implementation traps, both measured in the spike, are recorded so the implementer does not rediscover them:

- **Raising** the bitrate needs **two** calls in order: `set_option(ENCODER_OPTION_MAX_BITRATE, SPATIAL_LAYER_0, target)` **first**, then `set_option(ENCODER_OPTION_BITRATE, SPATIAL_LAYER_ALL, target)`. Setting only the top-level `iMaxBitrate` leaves `sSpatialLayers[0].iMaxSpatialBitrate` unset → `WelsBitRateVerification` fails with rc = 1. **Lowering** the bitrate does not need the extra step.
- Neither path forces an IDR/SPS/PPS.

### ADR-24: 1080p30 is a conditional target with a 720p30 safe floor; software 1080p60 is a Non-Goal

**Context.** The measured benchmark (§3.1) puts 1080p30 at 1.2× realtime headroom on an i5-14400 — enough on that host, thin enough that a weaker host or CPU contention will drop frames. 1080p60 measured 0.6× (infeasible in software).

**Decision.** Default profile is **1080p30**; the agent monitors encode time per frame and, when it cannot sustain the profile's budget, **falls back to 720p30** and reports it via `desktop-stats`. 720p30 is the guaranteed floor. Software 1080p60 is a Non-Goal.

**Rationale.** States the real headroom instead of promising a number the hardware may not hold. The fallback keeps the stream smooth rather than janky on weaker hosts.

**Consequence.** The fallback is a resolution change → an encoder rebuild (openh264 cannot resize without it, §3.2) → a one-time IDR blip; this coupling is why the fallback is exercised by the same spike mechanism as ADR-23. (ADR-23's spike passed — §3.7 — so the fallback is not dropped; a fixed 720p30 default remains the alternative only on a host that cannot sustain 1080p30 at all.)

### ADR-25: Hardware codec is investigated by a timeboxed spike, not committed

**Context.** The roadmap lists "codec phần cứng". H.265/HEVC is unusable in WebRTC in every browser today (§3.5); AV1 and H.264 hardware encode are the plausible alternatives, but their availability on real agents is unknown.

**Decision.** A half-day spike investigates AV1 / H.264 hardware encode on the agent (library support, availability, licensing, effort). It gates nothing and produces a short written finding; any adoption is a later phase.

**Rationale.** "Don't promise what you can't verify" — the spike converts an open question into evidence without putting an unverified capability into scope.

**Consequence.** Weeks 8-9 ship software H.264 only. The ARCHITECTURE perf table's aspirational "Hardware H.265" row is reconciled in §11 to name the viable alternatives.

---

## 5. Package Design: `packages/webrtc-core` & `packages/desktop-core`

### 5.1 `packages/shared/src/types/desktop.ts` (new)

The wire types of §2.2, re-exported from `types/index.ts`. No change to `WebRTCChannelType` — `'control'` already exists (`packages/shared/src/types/webrtc.ts:7`), so this is the only shared change.

```typescript
export interface DesktopSourceInfo {
  id: string;
  kind: 'monitor' | 'window';
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor: number;
  rotation: number;
  isPrimary: boolean;
  default: boolean;
}

export interface DesktopStats {
  width: number;
  height: number;
  fps: number;
  targetBitrateBps: number;
  status?: { kind: 'select-refused' | 'quality-downgraded'; detail: string };
}
```

### 5.2 `packages/webrtc-core` — no new seam; the control channel rides the existing manager

The control channel needs **no new code in `webrtc-core`**. `PeerConnection` already:

- pre-creates one data channel per entry of `options.channelLabels` before the offer (`connection.ts:133-138`), and
- auto-registers any inbound channel (`connection.ts:111-113`),

and `DataChannelManager` (`data-channel.ts`) already exposes `sendJson(label, type, payload)`, `onMessage(label, handler)`, `onStateChange(label, handler)`. The desktop offer passes `channelLabels: ['control']` (§7.1) and everything else is the terminal path's proven machinery. `media-channel.ts` is untouched.

### 5.3 `packages/desktop-core` — `DesktopClient` gains a control surface

`DesktopClient` keeps owning the media track and now also *uses* the control channel (it still never *creates* one — `PeerConnection` does). `types.ts` gains the option; `client.ts` gains methods.

```typescript
export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
  /** How long to wait for the control channel to open after the track. Default 5_000. */
  controlTimeoutMs?: number;
}

export class DesktopClient {
  // ...unchanged: constructor(agentId, peer, options), start(), onConnectionStateChange(), onError(), close()
  /** Capture-source enumeration pushed by the agent (once, after connect). */
  onSources(handler: (sources: DesktopSourceInfo[]) => void): () => void;
  /** Telemetry (resolution/fps/effective bitrate), best-effort. */
  onStats(handler: (stats: DesktopStats) => void): () => void;
  /** Ask the agent to switch to `sourceId`. No-op (warn) if the control channel is not open. */
  selectSource(sourceId: string): void;
  /** Set the target bitrate. No-op (warn) if the control channel is not open. */
  setBitrate(bitrateBps: number): void;
}
```

Semantics:

1. `start()` is unchanged — it still resolves with the first track.
2. After the track resolves, the client subscribes `peer.dataChannels.onMessage('control', …)` and dispatches `desktop-sources` → `onSources`, `desktop-stats` → `onStats`. Unknown `type`s are ignored (forward-compatible).
3. `selectSource`/`setBitrate` call `peer.dataChannels.sendJson('control', …)`. Because `DataChannelManager.sendJson` **throws** when the label is not registered (`data-channel.ts:75-77`), both are guarded: if the channel is not yet open they log a warning and return instead of throwing — the UI only enables these controls after `onSources` fires, so this is a defensive path, not the normal one.
4. `close()` is unchanged (closing the peer closes every channel).

### 5.4 Unit tests (`packages/desktop-core/test/client.test.ts`)

- `onSources` fires with the parsed list when a `desktop-sources` frame arrives; a second frame re-fires; unsubscribe stops delivery.
- `onStats` fires on `desktop-stats`.
- `selectSource` sends `{ type: 'desktop-select', payload: { sourceId } }` on the `'control'` channel when open; when the channel is absent it warns and does **not** throw.
- `setBitrate` sends `{ type: 'desktop-bitrate', payload: { bitrateBps } }`; same guard.
- Unknown control `type`s are ignored without error.

---

## 6. Application Design: Rust Desktop Agent (`apps/agent`)

### 6.1 `StreamProfile` — the resolved quality (ADR-21)

```rust
#[derive(Clone, Copy, Debug)]
pub struct StreamProfile {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: f32,
    pub bitrate_bps: u32,
}

impl StreamProfile {
    pub const DEFAULT_1080P30: Self = Self { max_width: 1920, max_height: 1080, fps: 30.0, bitrate_bps: 6_000_000 };
    pub const SAFE_720P30:    Self = Self { max_width: 1280, max_height: 720,  fps: 30.0, bitrate_bps: 4_000_000 };
}
```

- Resolved once at session start from CLI/env: `--desktop-profile <1080p30|720p30>` (env `AGENT_DESKTOP_PROFILE`), default `1080p30`. A named `const` and a parsed enum — no inline literals in the pipeline.
- `run_stream` takes `profile: StreamProfile`; the downscale box is `(profile.max_width, profile.max_height)`, the ticker interval is `Duration::from_secs_f32(1.0 / profile.fps)`, and the encoder is built from it. The Week 7 constants `MAX_WIDTH`/`MAX_HEIGHT`/`FRAME_INTERVAL` (`desktop.rs:27-28, 481`) become `DEFAULT_1080P30`'s members.
- `DesktopEncoder::new(profile)` replaces `DesktopEncoder::new()`; the config is unchanged apart from `.bitrate(..)`/`.max_frame_rate(..)` reading the profile.

### 6.2 Source enumeration and the source factory (ADR-22)

```
apps/agent/src/desktop.rs   (additions)
├── DesktopSourceInfo        { id, kind, name, geometry, is_primary }  (mirrors §5.1)
├── enumerate_sources()      -> Result<Vec<DesktopSourceInfo>>         (Monitor::all() + Window::all())
├── source_for(id, profile)  -> Result<Box<dyn FrameSource>>           (monitor id -> ScreenSource, window id -> WindowSource)
├── ScreenSource::for_monitor(m)                                       (generalises the Week 7 primary-only pick)
└── WindowSource             (NEW: xcap Window::capture_image on the tick)
```

- `enumerate_sources()` projects the accessors xcap already exposes (§3.4) — no new dependency. `id` is `monitor:<id>` / `window:<id>` using `Monitor::id()`/`Window::id()`.
- The default source (streamed before any selection) is chosen by `DESKTOP_DEFAULT_SOURCE` (default `primary`) using the existing `primary_recorder()` logic (`desktop.rs:404-421`), now returning the chosen monitor's geometry too.
- `WindowSource` captures a window's pixels on the tick. Window capture may include occluding windows depending on the platform backend; this is stated, not hidden (the picker labels window entries accordingly).

### 6.3 The control channel in the agent

`SessionHandler::on_data_channel` (`rtc.rs:492-518`) currently accepts only `TERMINAL_LABEL` and closes everything else. It gains a desktop branch:

- The desktop peer is built with `media_only = true` today (`main.rs:621`, `build_peer(…, mode == SessionMode::Desktop)`), which shortens ICE timeouts. With a control channel the peer should use the **terminal-shaped** ICE defaults; `build_peer`'s `media_only` flag is split into `media_only` (no data channel) vs `has_control` so a desktop peer with a control channel is not given the shortened timeouts.
- `on_data_channel`: accept exactly one `'control'` channel for a desktop session (reject a second, mirroring the terminal single-channel rule); publish it to the session loop exactly as the terminal channel is published (`Arc<OnceLock<..>>` + `open_tx`).

`run_desktop_session` (`main.rs:986`) changes:

1. Create the **default** source before the answer (unchanged ordering — keeps the clean-refusal invariant, `main.rs:1000-1014`).
2. `attach_desktop_track` → `send_desktop_answer` → flush candidates → wait Connected (unchanged).
3. Resolve `ssrc`/`pt` (unchanged) and spawn `run_stream` with the profile **and a control receiver**.
4. Spawn a control dispatcher (mirroring the terminal dispatcher at `main.rs:678-808`) that, on the control channel:
   - sends `desktop-sources` once the channel opens (with the streaming entry flagged `default: true`);
   - decodes `desktop-select` → forwards a `SourceSwap(id)` on the control channel to `run_stream`;
   - decodes `desktop-bitrate` → forwards a `SetBitrate(bps)`;
   - ignores and logs any other `type`; a frame with `channel != "control"` is dropped.

### 6.4 `run_stream` changes

```rust
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    profile: StreamProfile,
    mut control: mpsc::Receiver<StreamControl>,   // NEW
    mut stop: watch::Receiver<bool>,
) -> Result<()>
```

```
ticker = interval(1.0 / profile.fps)
loop select stop / control / ticker:
    control:
        SetBitrate(bps)  -> apply_bitrate(&mut encoder, bps)        // ADR-23 branch below
        SourceSwap(id)   -> swap source + rebuild encoder (bounded by DESKTOP_SELECT_APPLY_TIMEOUT)
    ticker:
        frame = source.next_frame()? ; if None { skip tick }
        frame = crop_to_even(downscale(&frame, profile.max_width, profile.max_height))
        t0 = Instant::now(); data = encoder.encode(&frame)?; dt = t0.elapsed()
        sustain-check: if dt > budget for N consecutive frames -> fall back to SAFE_720P30 (ADR-24)
        write_sample(...)
```

- **`apply_bitrate`** uses the spike's confirmed mechanism (ADR-23, §3.7): `unsafe { encoder.raw_api() }` + `set_option(ENCODER_OPTION_BITRATE, SPATIAL_LAYER_ALL, SBitrateInfo { iBitrate: bps })` — **no rebuild, no blip**. When **raising** the target, set `ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` **first** (otherwise `WelsBitRateVerification` fails rc = 1); lowering needs only the single call. The value is reflected in the next `desktop-stats`. (The rebuild-and-force-IDR path in ADR-23's FAIL branch is not shipped.)
- **Source swap**: stop the old `FrameSource`, `source_for(id, profile)`, build a new encoder (dimensions may differ), swap both. Bounded by `DESKTOP_SELECT_APPLY_TIMEOUT`; a source that fails to start leaves the current stream running and logs.
- **Sustain fallback** (ADR-24): count consecutive frames whose encode time exceeds the frame budget; at a threshold (default 30 frames ≈ 1 s) rebuild at `SAFE_720P30`, emit a `desktop-stats` with `status.kind = 'quality-downgraded'` (its `width`/`height` already reflect the new size), and do not oscillate (a hysteresis: only downgrade once per session unless the user raises bitrate manually).

### 6.5 Rust unit tests

| Test | Asserts |
|---|---|
| `StreamProfile` parsing | `1080p30`/`720p30` map to the right constants; unknown → error; default is 1080p30 |
| `enumerate_sources` | returns ≥ 1 monitor on a display host (`#[ignore]`); `id` is stable across two calls |
| `source_for` | unknown id → `Err`; a monitor id → `ScreenSource`; a window id → `WindowSource` |
| `downscale` with profile | 1920×1080 → 1280×720 under `SAFE_720P30`; → 1920×1080 (passthrough) under `DEFAULT_1080P30` |
| control decode | `desktop-select`/`desktop-bitrate` frames decode to `SourceSwap`/`SetBitrate`; `channel != "control"` dropped; unknown `type` ignored |
| `apply_bitrate` | sets the encoder target in place (spike PASS path, §3.7); the next encoded frame is emitted with the new target; the raise case performs the MAX_BITRATE-first ordering |
| sustain fallback | a synthetic slow-encode sequence downgrades once to `SAFE_720P30` and does not oscillate |

---

## 7. Application Design: Web (`apps/web`)

### 7.1 Store changes — `stores/terminal.ts`

- **`openDesktopTab`** (`:484`): change the peer options from `channelLabels: []` to `channelLabels: ['control']` (`:532`). Everything else is unchanged.
- `TabItem` gains `desktopSources?: DesktopSourceInfo[]`, `desktopStats?: DesktopStats`, `desktopSourceId?: string`.
- New actions:
  - `selectDesktopSource(tabId, sourceId)` → `desktopConnections.get(agentId).client.selectSource(sourceId)`, then set `tab.desktopSourceId`.
  - `setDesktopBitrate(tabId, bps)` → `client.setBitrate(bps)`.
- After `client.start()` resolves, subscribe `client.onSources(s => tab.desktopSources = s; tab.desktopSourceId = s.find(x => x.default)?.id)` and `client.onStats(s => tab.desktopStats = s)`. Unsubscribers are stored beside the existing ones in `desktopConnections` and called on `closeTab`/`retryTab`.

### 7.2 Components

**`components/desktop/DesktopView.vue`** — the Week 7 view-only element gains control *chrome* (not input handling, which is Week 9):

- A **source picker** in the overlay area: a dropdown listing `tab.desktopSources`, the `default`/current entry marked, changing it calls `store.selectDesktopSource`. Hidden until `desktopSources` is non-empty. For the test source this is a single auto-selected entry, so E2E never interacts with it.
- A **bitrate control** (small slider/number) calling `store.setDesktopBitrate`, initialised from `tab.desktopStats?.targetBitrateBps`.
- A **stats line** (`1920×1080 · 30 fps · 6 Mbps`) from `tab.desktopStats`. When `desktopStats.status` is present the line appends its `detail` (e.g. "720p (quality downgraded)" or "source switch refused").
- The `<video>` keeps **no `controls`** and **no pointer/keyboard handlers** — input is Week 9. The existing `DesktopView.test.ts` assertion (no `controls`) stays green.

**`WorkspaceView.vue`** footer: for desktop tabs the hardcoded `Media: H.264 · view-only` becomes `Media: H.264 · <stats or "connecting">`.

### 7.3 Web tests

- `terminal-store`: `openDesktopTab` passes `channelLabels: ['control']`; `onSources` populates `desktopSources` and sets `desktopSourceId` to the `default` entry; `selectDesktopSource` calls the client; `setDesktopBitrate` calls the client; unsubscribers are torn down on `closeTab`.
- `DesktopView.test.ts`: picker renders when sources present and is hidden when absent; selecting emits the store call; stats line renders; the `<video>` still has **no `controls`** and no input handlers.
- `WorkspaceView.test.ts`: footer shows the stats-derived media line for a desktop tab.

---

## 8. Testing & QA Plan

### 8.1 Layer 1 — Rust unit tests

Per §6.5, run by `cargo test --locked` (Linux). The `#[ignore]`d display-dependent tests (`enumerate_sources`, `ScreenSource`) run manually on the dev machine.

### 8.2 Layer 2 — TypeScript unit tests

Per §5.4 and §7.3, run by `pnpm test`.

### 8.3 Layer 3 — cross-language E2E

The existing `desktop.e2e.test.ts` (Week 7) is **extended, not replaced**, and must keep passing — this is the explicit regression guard for the added control-channel step. The `--desktop-source test` path enumerates exactly one source flagged `default: true`, so the harness **never has to send `desktop-select` or wait for a picker** (ADR-22): the stream starts on the default exactly as in Week 7.

New tests (Linux only, `describe.skipIf(!isLinux)`):

- **Control channel present.** After the track arrives, `desktop-sources` is received within the control timeout; it has exactly one entry with `default === true` for the test source; the entry carries the expected geometry fields.
- **Manual bitrate.** Send a `desktop-bitrate` frame; a subsequent `desktop-stats` reports the new `targetBitrateBps`. (This asserts the *wire path* and the stats echo — not the encoder internals, which are unit-tested.)
- **Refused selection error path.** Send a `desktop-select` with an id the agent never enumerated; the agent keeps streaming (RTP continues) and emits a `desktop-stats` with `status.kind === 'select-refused'` — pinning the §2.2 error contract.
- **Existing media assertions unchanged.** The Week 7 checks (a video track arrives, ≥ 30 RTP packets in 15 s at the negotiated PT, ≥ 1 IDR, teardown leaves the agent able to serve a second session) still pass.
- **Terminal unaffected.** The terminal E2E suite passes unchanged; the new `'control'` label is desktop-only.

A source *switch* is exercised in the manual demo (a real host has multiple monitors); CI has no display, so it cannot. This is recorded in §8.6, not left implicit.

### 8.4 Manual demo (recorded) — real Chrome, real screen

1. Fedora dev machine; build the agent; run `AGENT_CREDENTIAL=… ponter-agent --desktop-source screen` (default profile 1080p30).
2. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; log in; open a desktop tab.
3. Observe: the stream appears **immediately** (default = primary monitor) at 1080p30; the picker lists monitors/windows.
4. Switch to a second monitor or a window → stream changes with a brief blip; stats update.
5. Move the bitrate control → the stream visibly changes bitrate; `desktop-stats` reflects it.
6. On a weaker host (or by forcing `AGENT_DESKTOP_PROFILE=1080p30` under load), observe the documented **720p30 fallback** and the stats note.
7. Record glass-to-glass latency informally (target < 200 ms on LAN; not gated, as in Week 7's "xem được").

### 8.5 CI changes

No new workflow changes are required beyond Week 7's apt steps: the control channel is SCTP over the existing transport, and the E2E already builds the agent with capture support. The E2E job's `pnpm --filter @ponter/webrtc-core test:e2e` picks up the extended file automatically.

### 8.6 What is verified where

| Claim | Verified by |
|---|---|
| Control channel opens; sources enumerated | E2E (§8.3) |
| Manual bitrate reaches the agent and echoes in stats | E2E (§8.3) |
| Media path unchanged (track, RTP, IDR, teardown) | Existing `desktop.e2e.test.ts` |
| Source **switch** works on a real multi-source host | Manual demo (§8.4) |
| 1080p30 / 720p30 fallback on a real screen | Manual demo (§8.4) |
| 1080p60 software infeasible | Benchmark (§3.1, Appendix A) |
| Runtime bitrate apply (spike) | **Spike §3.7 (PASSED)**; unit test pins the shipped `ENCODER_OPTION_BITRATE` path |
| macOS/Windows compile | `Build Agent / macOS/x64`, `Build Agent / macOS/arm64`, `Build Agent / Windows/x64-msvc` |

---

## 9. Security & Error Handling

- **The control channel is a new inbound surface.** The agent accepts exactly one `'control'` channel for a desktop session and only two actionable frame types (`desktop-select`, `desktop-bitrate`; anything else is dropped). `desktop-select` ids are validated against the agent's own enumeration — an unknown id is refused: the agent logs it, leaves the stream running, and reports `status.kind = 'select-refused'` on the next `desktop-stats` (§2.2); the id is never used to build a source. `desktop-bitrate` is clamped to a sane range (`MIN..MAX_BITRATE_BPS`) so a hostile value cannot drive the encoder to a degenerate config.
- **No new authorization, and that is stated, not hidden.** As in Week 7, the server never sees data-channel bytes (it relays only SDP/ICE), so the **agent** is the only enforcement point. The agent authorizes a session by the `desktop` capability label alone; there is no per-peer identity check. This is the E2EE audit's **H3** (agent does not verify the client), still open, and it is **unchanged by this week**. The audit's **H1** (client-controlled `shell`) is terminal-only and untouched here. The audit's **H2** (enforce `approved`) is browser-fixed/server-open; the audit's **M2** (WS close codes) is open. None of these are introduced by Week 8 — but the picker and bitrate frames do add *inputs* the agent must validate, which is why validation is explicit above. Full reference: `docs/security/2026-10-01-e2ee-zero-trust-audit.md` (WS3).
- **Resource bounds.** One control channel per session (a second is closed); one source at a time (a swap stops the previous `FrameSource`); the encoder is single-instance; the source-swap and bitrate paths are bounded (`DESKTOP_SELECT_APPLY_TIMEOUT`); the sustain fallback cannot oscillate (hysteresis, ADR-24).
- **Error surfacing.** A source that fails to start on selection leaves the current stream running and logs; a capture failure on the default source still refuses the offer *before* the answer (`approved: false`), unchanged. The browser never sees an unhandled rejection — `selectSource`/`setBitrate` are guarded against a closed channel (§5.3).
- **No new secrets.** TURN credentials continue to come from the existing server push.

---

## 10. Deliverables & Acceptance Criteria

### 10.1 Deliverables

| # | Artifact | Type |
|---|---|---|
| D1 | `packages/shared`: `types/desktop.ts` (source/stats types) + re-export | Code |
| D2 | `packages/desktop-core`: `DesktopClient` control surface + tests | Code |
| D3 | `apps/agent`: `StreamProfile`, `enumerate_sources`/`source_for`, `WindowSource`, control channel + dispatcher, `run_stream` profile/control/fallback, GCC auto-ABR + in-place retarget (§3.7), `main.rs` CLI/env | Code |
| D4 | `apps/web`: store (`channelLabels: ['control']`, sources/stats/select/bitrate), `DesktopView` picker + bitrate + stats | Code |
| D5 | `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` extensions (control channel, bitrate, regression) | Test |
| D6 | Benchmark harness — committed under `apps/agent/benches/` **or** recorded verbatim in this spec's Appendix A (decided at implementation time; see Appendix A note) | Infra |
| D7 | Recorded manual Chrome demo (1080p30, picker, switch, bitrate, fallback) | Artifact |
| D8 | `docs/ARCHITECTURE.md` reconciliation (§11) | Docs |

### 10.2 Acceptance criteria

1. `cargo test --locked` passes with the new unit tests on Linux — the `Build Agent / Verify` gate; the musl target (no capture deps) still builds — the `Build Agent / Linux/x64-musl` gate.
2. `pnpm lint && pnpm typecheck && pnpm test` pass across the workspace including the new test surfaces — the `CI (Node) / Lint, Typecheck, Format & Node Tests` gate.
3. E2E `desktop.e2e.test.ts` passes: the control channel opens and `desktop-sources` arrives with one `default: true` entry; a `desktop-bitrate` frame is reflected in a later `desktop-stats`; the Week 7 media assertions (track, ≥ 30 RTP packets in 15 s, ≥ 1 IDR, clean teardown + second session) still pass — the `CI (E2E) / Cross-language terminal E2E` gate.
4. The existing terminal E2E suite still passes unchanged (terminal regression gate, `CI (E2E) / Cross-language terminal E2E`).
5. The recorded manual demo shows a real-screen stream in Chrome at 1080p30 (or the documented 720p30 fallback on a host that cannot sustain it), the source picker listing monitors/windows, a working source switch, and a visible bitrate change — with LAN glass-to-glass latency observed under 200 ms (informal, not gated).
6. `ARCHITECTURE.md` records the Week 8 scope and the perf-table row no longer names H.265 as an achievable target (§11).

**Not** an acceptance criterion: auto-ABR (ADR-23, now confirmed by the passed spike §3.7) and the ADR-25 hardware-codec spike. Both are goals/investigations that shape scope without gating delivery.

### 10.3 Delivery sequence (single PR, `feat/phase3-week8-stream-quality`)

1. `packages/shared` desktop types.
2. `packages/desktop-core` control surface + tests.
3. Agent `StreamProfile` + enumeration + `WindowSource` + Rust tests.
4. Agent control channel + dispatcher + `run_stream` changes (in-place bitrate retarget, swap, fallback) + GCC auto-ABR wiring.
5. Web store + `DesktopView` + tests.
6. E2E extensions + benchmark harness/Appendix.
7. ARCHITECTURE.md reconciliation + demo recording.
8. PR to `main`.

### 10.4 Review focus

- **Default-source ordering** — the source is created *before* the answer (clean-refusal invariant, ADR-22); a swap happens only after, via `run_stream`.
- **Retarget correctness** — `apply_bitrate` uses the spike-confirmed `ENCODER_OPTION_BITRATE` path with the raise-order trap handled (MAX_BITRATE on SPATIAL_LAYER_0 first, §3.7); acceptance does not reference the spike (ADR-23).
- **No input handling** — `DesktopView` gains control chrome only; the `<video>` keeps no `controls` and no pointer/keyboard handlers (Week 9).
- **Validation** — `desktop-select` ids are checked against the enumeration; `desktop-bitrate` is clamped.
- **Backward compatibility** — terminal bytes unchanged; the Week 7 desktop media E2E passes unchanged.
- **Leak check** — a source swap stops the previous `FrameSource`; teardown closes the peer and every channel.

---

## 11. Documentation Reconciliation (`docs/ARCHITECTURE.md`)

Two drifts are reconciled in the same PR (D8):

1. **Roadmap §8** (`ARCHITECTURE.md:941-944`): the "Tuần 8-9: Chất lượng & tương tác (sắp tới)" list gains a Week 8 sub-entry marked done for this week's items — quality profile + manual bitrate + GCC auto-ABR (spike passed, §3.7), source picker — with input forwarding and hardware codec noted as still open (Week 9 / spike). Week 9's input item is left unchecked (owned by Spec B).
2. **Perf table (§11, `ARCHITECTURE.md:1080-1081`)**: the row `Desktop stream (Phase 3 target) | 60fps | Hardware H.265` is corrected — H.265 is not viable in WebRTC (§3.5). Replace with `Desktop stream (Week 8) | 1080p30 (720p30 floor) | Software H.264 (openh264)` and a `Desktop stream (hardware, future) | 60fps | H.264 hardware / AV1 (spike-gated, ADR-25)` row that names the viable alternatives instead of the unusable one.

Phase 4's stub (`ARCHITECTURE.md:946-948`) is **not** touched (Phase 4 is out of scope; §1.2).

---

## Appendix A — Benchmark harness (reproducing §3.1)

The §3.1 numbers come from a standalone binary. **Implementation-time note:** commit it under `apps/agent/benches/` (a Cargo bench target that depends only on `openh264`, so it does **not** pull the capture stack or need `libpipewire`), or, if a bench target is undesirable, record it here verbatim. Either way QA can rebuild it. The exact commands (Docker, matching the dev toolchain, offline against the cargo registry cache):

```bash
mkdir -p /tmp/enc-bench/src   # paste Cargo.toml + src/main.rs below
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/usr/local/cargo -e RUSTUP_HOME=/usr/local/rustup -e HOME=/tmp \
  -v "$HOME/.cargo:/usr/local/cargo" -v /tmp/enc-bench:/work -w /work \
  rust:1.98-bookworm bash -c \
  'export PATH=/usr/local/cargo/bin:/usr/bin:/bin; cargo run --release --offline'
```

`Cargo.toml`:

```toml
[package]
name = "enc-bench"
version = "0.0.0"
edition = "2021"
[dependencies]
openh264 = "0.9.8"
[profile.release]
opt-level = 3
lto = true
codegen-units = 1
```

`src/main.rs` (encode-only timing; frames pre-generated so generation is not measured — the bug the first run had):

```rust
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, RateControlMode,
    UsageType, VuiConfig,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;
use std::time::Instant;

fn block(w: u32, h: u32, n: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h { for x in 0..w {
        let i = ((y * w + x) * 4) as usize;
        rgba[i] = ((x * 255) / w) as u8; rgba[i+1] = ((y * 255) / h) as u8; rgba[i+2] = 96; rgba[i+3] = 255;
    }}
    let bx = (n * 7) % (w - 64); let by = (n * 3) % (h - 64);
    for y in by..by+64 { for x in bx..bx+64 { let i = ((y*w+x)*4) as usize; rgba[i]=250; rgba[i+1]=40; rgba[i+2]=40; }}
    rgba
}

fn encoder(fps: f32, bps: u32, threads: u16) -> Encoder {
    let c = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bps)).max_frame_rate(FrameRate::from_hz(fps))
        .usage_type(UsageType::ScreenContentRealTime)
        .adaptive_quantization(false).background_detection(false)
        .rate_control_mode(RateControlMode::Bitrate).complexity(Complexity::Low)
        .intra_frame_period(IntraFramePeriod::from_num_frames(60)).num_threads(threads)
        .vui(VuiConfig::bt709());
    Encoder::with_api_config(OpenH264API::from_source(), c).unwrap()
}

fn bench(label: &str, w: u32, h: u32, fps: f32, bps: u32, ring: &[Vec<u8>], threads: u16) {
    let mut e = encoder(fps, bps, threads);
    for f in ring.iter().take(5) {
        let _ = e.encode(&YUVBuffer::from_rgba8_source(RgbaSliceU8::new(f, (w as usize, h as usize))));
    }
    let mut bytes = 0usize; let t = Instant::now();
    for f in ring {
        let bs = e.encode(&YUVBuffer::from_rgba8_source(RgbaSliceU8::new(f, (w as usize, h as usize)))).unwrap();
        bytes += bs.to_vec().len();
    }
    let s = t.elapsed().as_secs_f64(); let ms = s * 1000.0 / ring.len() as f64;
    println!("{label:<22} {w}x{h} @{fps:>3.0} | {ms:>6.2} ms/frame | budget {:.2} -> {:.1}x | {} kbps",
        1000.0/fps as f64, (1000.0/fps as f64)/ms, (bytes as f64*8.0/s) as u64/1000);
}

fn main() {
    let n = 200;
    let r1080: Vec<_> = (0..n).map(|i| block(1920,1080,i as u32)).collect();
    let r720:  Vec<_> = (0..n).map(|i| block(1280,720,i as u32)).collect();
    bench("720p30",  1280,720,30.0,4_000_000,&r720,1);
    bench("1080p30", 1920,1080,30.0,6_000_000,&r1080,1);
    bench("1080p60", 1920,1080,60.0,8_000_000,&r1080,1);
    bench("1080p30 t4", 1920,1080,30.0,6_000_000,&r1080,4);
    bench("1080p30 t8", 1920,1080,30.0,6_000_000,&r1080,8);
}
```

Expected output (i5-14400): `1080p30 ≈ 28 ms/frame → 1.2×`; `720p30 ≈ 11 ms → 2.9×`; `1080p60 ≈ 28 ms → 0.6×`; thread counts make no measurable difference.

