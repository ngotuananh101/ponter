# Phase 3 Week 7 — Desktop Streaming Design Specification

**Status:** Draft — Ready for review  
**Date:** 2026-10-01  
**Author:** Ngo Tuan Anh & Claude  
**Target:** Phase 3 Week 7 of `docs/ARCHITECTURE.md` (Section 8: "Desktop Streaming"). Week 7 is the end-to-end thin slice; Weeks 8–9 (quality, input, hardening) are out of scope here.

---

## 1. Overview & Objectives

Week 7 opens **Phase 3 (Desktop Streaming)**. Phase 2 (Weeks 4–6) delivered the WebRTC core, the Rust terminal agent, and the terminal workspace UI — all over one `"terminal"` data channel. Week 7 adds the first **media** path: a live video track from the agent host to the browser, over SRTP, rendered in a `<video>` element inside the existing workspace.

The scope was deliberately chosen as a *thin end-to-end slice* rather than a quality milestone: prove capture → encode → WebRTC → render works across the real stack (Rust agent, real server, browser), with a low quality bar ("proof thấp, xem được" — ~720p, 10–20 fps, software H.264). Input control is **not** included; the stream is view-only.

### 1.1 Core Goals

1. **Browser receives a live H.264 track (thin slice).** A browser offer with capability `"desktop"` is answered by the agent with a real media track; the browser renders it in a `<video>` element. Verified by automated E2E (werift as the offerer) plus a manual real-Chrome demo.
2. **`packages/webrtc-core` gains a media path.** `media-channel.ts` is created (fulfilling ADR-06 from Week 4), the `RTCPeerConnectionLike` seam gains optional `addTransceiver`/`onTrack`, and `PeerConnection` gains `media` + `capabilities` options and `onRemoteTrack`.
3. **`packages/desktop-core` is created now.** A small, DOM-free client mirroring `packages/terminal-core`: `DesktopClient.start()` resolves with the first remote video track; the web app consumes it.
4. **Rust agent desktop mode.** `apps/agent` gains a capture → downscale → software H.264 encode → RTP pipeline (`xcap` + `openh264` + `webrtc` 0.21), selectable via `--desktop-source <screen|test>`, and the offer handling is restructured so a `"desktop"` offer is answered with a sending track.
5. **Desktop UI as a workspace tab.** A new tab kind renders the stream (view-only `<video>`); the sidebar shows a Monitor affordance for agents whose registered capabilities include `"desktop"`.
6. **Automated + manual verification.** Rust unit tests for the encode pipeline, TS unit tests for `media-channel`/`DesktopClient`/store, a new Linux E2E suite (`desktop.e2e.test.ts`) using the deterministic `test` source, and a recorded manual Chrome demo against a real screen.

### 1.2 Non-Goals (Explicitly Deferred)

- **Input control (mouse/keyboard).** Week 7 is view-only; a future week owns input. No input handling exists anywhere in the Week 7 code.
- **H.265/HEVC and hardware encoding.** Deferred: Chrome/Firefox cannot decode H.265 in WebRTC; the ARCHITECTURE perf table's "60fps Hardware H.265" target is reconciled in §11, not implemented.
- **WebCodecs rendering.** `<video>` + `srcObject` only; low-latency WebCodecs pipelines are a later quality concern.
- **macOS/Windows runtime capture.** Those targets must **compile and pass unit tests**; runtime capture verification is deferred (no CI hardware).
- **Multi-monitor / region selection.** The agent captures monitor 0 (or the primary monitor).
- **PLI-on-demand (keyframe request from browser).** Deferred; Week 7 relies on a periodic IDR (`intra_frame_period`).
- **Server-side changes.** No new endpoints, no schema changes, no `@ponter/shared` changes (`WebRTCChannelType` already includes `'desktop'`).
- **File transfer, audio, clipboard.** Owned by later phases.

---

## 2. Wire Protocol & Contract Specifications

### 2.1 Session creation and offer capabilities

Nothing changes server-side: the browser still calls `POST /api/sessions { agentId }`, and all signaling (offer / answer / ice-candidate) flows through the existing routes and transports. The only protocol change is **what the offer says**:

| Flow | `channelLabels` | `capabilities` | `media` |
|---|---|---|---|
| Terminal (existing) | `['terminal']` | omitted → falls back to `channelLabels` | omitted |
| Desktop (new) | `[]` (no data channel) | `['desktop']` | `{ video: true }` |

- `capabilities` is sent in the offer signal (`createOfferSignal(sessionId, sdp, capabilities)`, `packages/webrtc-core/src/signal-handler.ts:31`) and is **attacker-controlled**; the agent only compares strings for equality with known labels.
- The desktop offer contains **no data channel** (SCTP is not used). Media flows as RTP over the established SRTP/DTLS transport.

### 2.2 SDP and media shape

- **Offer:** one video m-line, `recvonly` (browser created it via `addTransceiver('video', { direction: 'recvonly' })` before `createOffer`). Browser codecs come from the browser's own MediaEngine; Chrome offers H.264 among others.
- **Answer:** the agent's `MediaEngine` is `MediaEngine::default()` + `register_default_codecs()`, which registers H.264 at **PT 102** (`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`), plus alternates 127/125/108 and RTX. The answer m-line is `sendonly` with one H.264 codec; the negotiated payload type is read back from the sender (not assumed).
- **RTP:** H.264 NAL units in Annex-B form, packetized by webrtc-rs's `H264Payloader` (single NALU ≤ MTU; FU-A otherwise; SPS/PPS via STAP-A or their own NALs). The encoder output is already Annex-B (§3.2) — no manual start-code insertion.
- The answer's `approved` flag is `true` iff the offer's capabilities matched the mode the agent actually served (`"terminal"` or `"desktop"`); otherwise the existing refusal path applies (`approved: false` with a real SDP, unchanged from Week 5).

### 2.3 Terminal flow — unchanged

Terminal sessions keep the exact Week 6 contract: capabilities fall back to `channelLabels` (`['terminal']`), one `"terminal"` data channel, `terminal-*` frames, PTY multiplexing. The fallback rule (`options.capabilities ?? options.channelLabels`) is what makes this change backward-compatible: existing terminal call sites pass no `capabilities` and behave identically.

### 2.4 No `@ponter/shared` changes

`WebRTCChannelType` already includes `'desktop'` (`packages/shared/src/types/webrtc.ts:7`). Desktop streaming uses no `DataChannelMessage` frames at all, so no new message schemas are added.

---

## 3. Verified Findings

All API facts below were verified against crate sources on disk (cargo registry) or by spike, not from memory. Where a fact is load-bearing for the design, the exact location is cited.

### 3.1 `webrtc` / `rtc` 0.21.0 (answerer with a media track)

- **Two crates are needed as direct dependencies.** The async facade `webrtc 0.21.0` (module paths: `webrtc::peer_connection::{PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState, RTCPeerConnectionState}`, `webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample`, `webrtc::media_stream::track_local::TrackLocal`, `webrtc::rtp_transceiver::RtpSender`, `webrtc::runtime::Runtime`) and the sans-IO core `rtc 0.21.0`, from which the facade does *not* re-export `MediaEngine`, `RTCConfigurationBuilder`, `Registry`, `register_default_interceptors`, `RTCIceServer`, `MediaStreamTrack`, `RTCRtpEncodingParameters`, or `Sample` — the shipped examples import those from `rtc::…` (verified in `webrtc-0.21.0/examples/play-from-disk-h26x/play-from-disk-h26x.rs` and `examples/data-channels-offer-answer/data-channels-answer.rs`).
- **Builder requires `with_udp_addrs`.** `PeerConnectionBuilder::new().with_configuration(..).with_media_engine(..).with_interceptor_registry(..).with_handler(..).with_runtime(..).with_udp_addrs(vec![format!("{}:0", local_ip)]).build().await` (`webrtc-0.21.0/src/peer_connection/mod.rs:275` — `with_udp_addrs`). Omitting it leaves the connection with no ICE sockets.
- **Event handling moved to a handler trait.** `PeerConnectionEventHandler` (`mod.rs:148`) with async methods `on_ice_candidate`, `on_data_channel`, `on_track`, `on_connection_state_change`, `on_ice_gathering_state_change` — callbacks are no longer registered on the peer. The existing agent's `on_ice_candidate`/`on_data_channel` call sites must be reworked onto this trait (part of the 0.21 upgrade; this spec assumes it has landed).
- **Answerer media flow (exact order).** From `play-from-disk-h26x`:
  1. Build track: `TrackLocalStaticSample::new(Instant::now(), MediaStreamTrack::new(stream_id, track_id, label, RtpCodecKind::Video, vec![RTCRtpEncodingParameters { rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() }, codec: video_codec.rtp_codec.clone(), ..Default::default() }]))?` — returns `Result`.
  2. `peer.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>).await?` — **before** `set_remote_description`.
  3. `set_remote_description(offer)` → `create_answer(None)` → `set_local_description(answer)`.
  4. Wait for `RTCPeerConnectionState::Connected`.
  5. `payload_type = sender.get_parameters().await?.rtp_parameters.codecs.first().map(|c| c.payload_type)` (negotiated, not assumed).
  6. `ssrc = *track.ssrcs().await.first()`.
  7. Per frame: `track.sample_writer(ssrc, payload_type).write_sample(&Sample { data, duration: H26X_FRAME_DURATION, ..Sample::new(Instant::now()) }).await?`, driven by a `ticker` (`interval(...)`) rather than sleep.
- **Packetization is automatic.** `write_sample` routes through the payloader factory (`rtc-0.21.0/src/rtp_transceiver/rtp_sender/rtp_codec.rs:96`): `MIME_TYPE_H264` → `H264Payloader::default()`, which splits Annex-B NAL units (start codes `00 00 00 01`), skips AUD/FILLER, caches SPS into STAP-A, and emits single NALU or FU-A per MTU.
- **Default H.264 codec is sufficient.** `MediaEngine::default()` has empty codec lists and must call `register_default_codecs()` (`rtc-0.21.0/src/peer_connection/configuration/media_engine/mod.rs:350`), which registers H.264 PT 102/127/125/108 + RTX. No custom `register_codec` call is needed for Week 7.
- **PLI is not delivered to the application** by the default interceptor chain. On-demand keyframes would require a custom interceptor + `Attribute::DeliverToApplication`; deferred (§1.2), replaced by periodic IDR.

### 3.2 `openh264` 0.9.8 (encoder) — spike-proven

- Configuration API (builder methods on `EncoderConfig`, all verified in `openh264-0.9.8/src/encoder.rs`): `.bitrate(BitRate::from_bps(..))`, `.max_frame_rate(FrameRate::from_hz(..))`, `.usage_type(UsageType::ScreenContentRealTime)`, `.rate_control_mode(RateControlMode::Bitrate)`, `.complexity(Complexity::Low)`, `.intra_frame_period(IntraFramePeriod::from_num_frames(..))`, `.num_threads(..)`, `.vui(VuiConfig::bt709())`.
- Encoder construction: `Encoder::with_api_config(OpenH264API::from_source(), config)` (the `source` feature is on by default; it builds the vendored Cisco source — **no network access at build time**, unlike the old "auto-download" behavior).
- Input conversion: `YUVBuffer::from_rgba8_source(rgba)` where `rgba` is an `RgbaSliceU8`. **`RgbaSliceU8::new(&rgba, (w, h))` panics** (`assert` at `formats/rgb.rs:170-173`) if `data.len() != w*h*4` **or if `w`/`h` is odd** — the downscale/crop path must guarantee even dimensions.
- Output: `encode(&YUVBuffer) -> EncodedBitStream` with `frame_type()`, `num_layers()`, `layer(i) -> Layer` (`nal_count()`, `nal_unit(i) -> &[u8]`), `to_vec()`.
- **Spike record** (throwaway binary, 2026-10-01): one 64×64 frame encoded with default config produced `frame_type=IDR`, layer 0 = 2 NALs `[00 00 00 01 67]` (SPS, type 7) and `[00 00 00 01 68]` (PPS, type 8), layer 1 = 1 NAL `[00 00 00 01 65]` (IDR slice, type 5); `annexb_start_codes_in_frame=3`. **NAL units already carry Annex-B start codes — nothing is prepended.** NASM is optional; without it the build logs "Failed to compile NASM files, not using any assembly." and continues.
- License: BSD-2-Clause.

### 3.3 `xcap` 0.9.8 (capture)

- Registry-only dependencies (no git deps). API: `Monitor::all()`, `monitor.video_recorder() -> XCapResult<(VideoRecorder, Receiver<Frame>)>`, `VideoRecorder::start()/stop()`, `Frame { width, height, raw: Vec<u8> }` in RGBA8.
- Linux backends: X11 and PipeWire (Wayland via the portal ScreenCast permission dialog). Build requires system dev packages: `libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev` (apt names; Fedora equivalents in §10.4). **No musl support** → the dependency is cfg-gated to `not(target_env = "musl")`.
- macOS/Windows backends exist in-crate; Week 7 verifies compile + unit tests only.

### 3.4 `werift` 0.24.4 (E2E offerer)

- `pc.onTrack: Event<[MediaStreamTrack]>` and DOM-style `pc.ontrack: CallbackWithValue<RTCTrackEvent>` both fire; `RTCTrackEvent { track, streams: MediaStream[], transceiver, receiver }` (`lib/webrtc/src/peerConnection.d.ts:287`).
- `pc.addTransceiver(trackOrKind: Kind | MediaStreamTrack, options?: Partial<TransceiverOptions>)` with `TransceiverOptions { direction: MediaDirection; ... }` and `MediaDirection` including `'recvonly'` (`lib/webrtc/src/media/rtpTransceiver.d.ts:55-62`).
- `MediaStreamTrack.onReceiveRtp: Event<[RtpPacket, ...]>` (`lib/webrtc/src/media/track.d.ts:21`) — used by the E2E to count RTP packets and inspect payload types/NALs.
- werift's track event carries no `streams` array in the `onTrack` path — the adapter passes `[]` and the E2E/`DesktopClient` must not require `streams`.

### 3.5 MSRV and toolchain

- `openh264-sys2 0.9.8` (the version openh264 0.9.8 resolves to) declares `rust-version = "1.85"`; `xcap 0.9.8` is edition 2024 (rustc ≥ 1.85). The agent already declares `rust-version = "1.85"` → **no bump**. CI/dev toolchain is 1.98.1.

### 3.6 What cannot be verified from this repository

- Real Wayland portal dialog behavior for `xcap` capture (permission prompt) — manual demo only.
- Real Chrome rendering of the negotiated stream (werift proves the RTP path, not the browser) — manual demo only.
- macOS/Windows capture at runtime — compile + unit tests only.
- Absolute CPU cost of software H.264 at 720p15 on the dev machine — measured informally in the manual demo, not gated.

---

## 4. Architectural Decision Records

### ADR-15: Desktop is a session *mode* decided before the answer, not a data-channel flow

**Context.** The Week 5/6 flow answers first and checks capabilities after (`main.rs`: capability check runs after `answer_offer`). Desktop needs the opposite: a `TrackLocalStaticSample` must be attached **before** `set_remote_description`, so the mode must be known before the answer is built. Desktop also has no data channel, so the existing "wait for the terminal channel to open" handshake cannot apply.

**Decision.** `run_one_session` classifies the offer from `offer.capabilities` *before* answering:

- contains `"terminal"` → existing terminal flow, unchanged;
- else contains `"desktop"` → desktop flow: create the source, build the track, `add_track`, then `set_remote_description` → `create_answer` → `set_local_description`;
- neither, or desktop unavailable on this build (musl / source creation failed) → refuse with `approved: false` and a real SDP (existing `refuse_offer` contract).

The answer's `approved` flag reflects the mode actually served.

**Rationale.** One session type per peer connection, selected by the same capability mechanism the protocol already carries. Keeping the terminal path byte-identical avoids regressing Week 6 while adding the media path.

**Consequence.** `answer_offer` is split into terminal/desktop answer paths sharing one `send_answer`-style core; the capability check moves earlier. A musl build or a headless host without a display refuses desktop offers explicitly (log + `approved: false`) instead of failing silently.

### ADR-16: Reuse the default H.264 PT 102; periodic IDR instead of PLI

**Context.** The default `MediaEngine` already advertises H.264 PT 102 with `packetization-mode=1` and the exact `profile-level-id` the encoder produces. PLI delivery to the application requires custom interceptor work.

**Decision.** Register no custom codec; use `register_default_codecs()`. Set `intra_frame_period` to 60 frames (~4 s at 15 fps) so a late-joining decoder recovers without PLI.

**Rationale.** Fewer moving parts for the thin slice; PT is read from the sender at runtime so nothing depends on the constant. Periodic IDR costs ~a few hundred ms of extra bitrate every 4 s — acceptable at 2 Mbps.

**Consequence.** On-demand keyframes (browser `PLI`) are a documented Week 8–9 improvement; the encoder already emits SPS/PPS with every IDR, so no separate parameter-set retransmission is needed.

### ADR-17: `--desktop-source test` — a deterministic frame source for headless E2E

**Context.** CI has no display server; capture-based E2E would be flaky or impossible. Yet the thin slice must be proven end to end in CI.

**Decision.** `desktop.rs` defines a `FrameSource` trait with two implementations: `ScreenSource` (xcap, cfg-gated to non-musl) and `TestPatternSource` (deterministic moving pattern, no OS dependencies). CLI: `--desktop-source <screen|test>`, default `screen`. E2E spawns the agent with `--desktop-source test`.

**Rationale.** The E2E must exercise the real encode → packetize → SRTP → decode-side path; only the *pixels* are synthetic. A deterministic source also makes "an IDR was produced" and "RTP kept flowing" reliable assertions.

**Consequence.** A test-mode agent streams a pattern instead of the screen — acceptable because it is opt-in and logged. The manual demo covers the real-screen path.

### ADR-18: View-only desktop in Week 7

**Context.** Input control (mouse/keyboard over a data channel) is a large surface: coordinate mapping, capture of input, security review of remote input.

**Decision.** Week 7 accepts no input. The `<video>` element has no controls and no event forwarding; the agent's desktop branch registers no inbound frame handling.

**Rationale.** The thin slice proves the media pipeline; input builds on it later without rework. Keeps the security surface at "watch only".

**Consequence.** The desktop tab is explicitly a viewer. A future week adds an input channel and the corresponding ADR.

> **Superseded by ADR-26 (Week 9 spec, `docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md`).** The desktop view is no longer *unconditionally* view-only: it is view-only **unless the input gate is open** (ADR-29). Input rides the existing `control` channel; no separate channel was added.

### ADR-19: Desktop tab is client-side exclusive per agent (mirrors ADR-14)

**Context.** The agent refuses a second concurrent session (ADR-14). Without a client-side guard, opening a desktop tab while a terminal tab is open would end in a ~20 s timeout with no explanation.

**Decision.** The store enforces, before connecting: `openDesktopTab` refuses when the agent has **any** open tab (terminal or desktop); `openTab` (terminal) refuses when the agent has an open **desktop** tab (terminal tabs continue to multiplex over one connection as today). Refusals create an error tab with a clear message, no network attempt.

**Rationale.** Mirrors the server/agent invariant at the UI, where it can be explained; avoids a silent 20 s failure.

**Consequence.** One desktop session per agent at a time. Multi-desktop (and desktop+terminal concurrently) would require agent multi-session support — deferred.

### ADR-20: `media-channel.ts` and `packages/desktop-core` are created now (closes ADR-06)

**Context.** Week 4's ADR-06 deferred `media-channel.ts` "until Phase 3 has content". The web-side media plumbing also needs a home: the store should not grow raw `addTransceiver`/`ontrack` handling.

**Decision.** Create `packages/webrtc-core/src/media-channel.ts` with `configureReceiveMedia` and `subscribeRemoteTracks`, wired into `PeerConnection.start()`/`onRemoteTrack`. Create `packages/desktop-core` (mirroring `terminal-core`) holding `DesktopClient`/`DesktopStream`.

**Rationale.** Keeps `PeerConnection` the single signaling lifecycle owner, keeps the adapter seam narrow (two optional members), and gives the web app a DOM-free, unit-testable session object instead of inline store logic.

**Consequence.** ADR-06 is fulfilled; the `RTCPeerConnectionLike` interface grows two *optional* members (`addTransceiver?`, `onTrack?`) so mocks and the current adapters keep typechecking, with a fail-fast check when `media.video` is requested from an adapter that lacks them.

---

## 5. Package Design: `packages/webrtc-core` & `packages/desktop-core`

### 5.1 File map

```
packages/webrtc-core/src/
├── types.ts            # + MediaStreamTrackLike, MediaStreamLike, optional seam members
├── media-channel.ts    # NEW — closes ADR-06
├── connection.ts       # + configureReceiveMedia in start(), + onRemoteTrack()
├── adapters/browser.ts # + addTransceiver, onTrack
├── adapters/werift.ts  # + addTransceiver, onTrack
└── index.ts            # export media-channel

packages/desktop-core/  # NEW package, mirrors terminal-core
├── package.json        # @ponter/desktop-core, deps: shared, webrtc-core
├── tsconfig.json       # lib ES2024+DOM, types node (same as terminal-core)
├── vitest.config.ts    # node environment
├── src/
│   ├── types.ts        # DesktopStream, DesktopClientOptions
│   ├── client.ts       # DesktopClient
│   └── index.ts
└── test/
    └── client.test.ts  # mock-peer unit tests
```

### 5.2 `types.ts` — the seam grows two *optional* members

```typescript
export interface MediaStreamTrackLike {
  readonly kind: string;
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

export interface RTCPeerConnectionLike {
  // ...existing members unchanged...
  addTransceiver?(kind: string, options?: { direction?: string }): unknown;
  onTrack?(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void;
}

export interface PeerConnectionOptions {
  iceServers?: IceServerConfig[];
  role: 'offerer' | 'answerer';
  channelLabels: string[];
  connectTimeoutMs?: number;
  /** Capabilities sent in the offer. Falls back to `channelLabels`. */
  capabilities?: string[];
  /** Request receive-side media setup before the offer is created. */
  media?: { video?: boolean };
}
```

Both new seam members are **optional** so every existing mock and `OrderRecorder` in the unit suites keeps typechecking. `media-channel.ts` fail-fasts if `media.video` is requested from an adapter that lacks them — an adapter that silently ignored the request would produce an offer the browser cannot render, which is worse than a loud error.

### 5.3 `media-channel.ts` (closes ADR-06)

```typescript
/** Add the receive-only transceivers the offer must contain. Call BEFORE createOffer. */
export function configureReceiveMedia(
  peer: RTCPeerConnectionLike,
  media: { video?: boolean } | undefined,
): void;

/** Forward remote tracks to `handler`. Returns an unsubscribe function. */
export function subscribeRemoteTracks(
  peer: RTCPeerConnectionLike,
  handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
): () => void;
```

- `configureReceiveMedia` is a no-op when `media?.video` is falsy; otherwise it calls `peer.addTransceiver('video', { direction: 'recvonly' })` and throws a descriptive `Error` if the adapter lacks `addTransceiver`.
- `subscribeRemoteTracks` throws the same way if `onTrack` is missing; otherwise it registers and returns an unsubscriber.

### 5.4 `connection.ts` changes

1. **Constructor** — `if (this.peer.onTrack) subscribeRemoteTracks(this.peer, cb)` where `cb` fans out to internal `trackListeners` (same pattern as `stateListeners`). The guard is what keeps every existing mock (which has no `onTrack`) working untouched.
2. **`start()`** — before `createOffer()`: when `options.media?.video` is set, fail fast with a descriptive `Error` if the adapter lacks `addTransceiver` **or** `onTrack` (an adapter that cannot deliver tracks would otherwise produce a stream that silently never arrives), then call `configureReceiveMedia(this.peer, this.options.media)`. The offer's capabilities become `this.options.capabilities ?? this.options.channelLabels` (previously always `channelLabels`). With `channelLabels: []` the pre-create loop creates no data channels — the desktop offer is pure media.
3. **New** `onRemoteTrack(cb: (track, streams) => void): () => void` — push to `trackListeners`, return the remover.

Terminal call sites are untouched and keep identical behavior via the fallback.

### 5.5 Adapters

- **`browser.ts`**: the constructor subscribes `this.pc.addEventListener('track', …)` and fans out to a `trackHandlers` array (the same pattern as `iceHandlers`); `onTrack(handler)` pushes into it. `addTransceiver(kind, options)` → `this.pc.addTransceiver(kind as 'video', options as RTCRtpTransceiverInit)`.
- **`werift.ts`**: the constructor subscribes `this.pc.onTrack.subscribe(track => …)` and fans out to `trackHandlers`; `onTrack(handler)` pushes. `addTransceiver(kind, options)` → `this.pc.addTransceiver(kind as 'video', options as Partial<TransceiverOptions>)`.

  werift fires both `onTrack` and the DOM-style `ontrack` for the same track; subscribing to exactly one of them avoids double delivery. werift's `onTrack` event carries no `streams`, so it passes `[]` — `DesktopClient` and the E2E must treat `streams` as possibly empty and build a `MediaStream` from the track when needed (§7.2).

### 5.6 `packages/desktop-core`

```typescript
// types.ts
export interface DesktopStream {
  track: MediaStreamTrackLike;
  streams: MediaStreamLike[];
}

export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
}

// client.ts
export class DesktopClient {
  constructor(agentId: string, peer: PeerConnection, options?: DesktopClientOptions);
  /** peer.start(), then resolve with the first remote track (or reject). */
  start(): Promise<DesktopStream>;
  onConnectionStateChange(handler: (state: string) => void): () => void;
  onError(handler: (message: string) => void): () => void;
  close(): void;
}
```

`start()` semantics (exact):

1. Subscribe `peer.onRemoteTrack` **before** calling `peer.start()` — a track arriving in the first negotiation tick must not be missed.
2. Call `peer.start()` (offer posted). Await the first track with a `trackTimeoutMs` race.
3. Reject with a descriptive error on: timeout, `peer` connection state `failed`/`closed` before a track, or `start()` itself throwing. Timeout is cleared on every exit path.
4. `close()` unsubscribes and closes the underlying peer; idempotent.

`DesktopClient` never touches the DOM and never creates a data channel — it is the desktop twin of `TerminalClient`, and the same object the E2E suite drives.

### 5.7 `webrtc-core` / `desktop-core` unit tests

- `media-channel.test.ts`: no-op without `media.video`; calls `addTransceiver('video', {direction:'recvonly'})` exactly once; throws on adapters missing `addTransceiver`/`onTrack`; unsubscribe stops delivery.
- `connection.test.ts` additions (existing suite): offer capabilities prefer `options.capabilities` over `channelLabels`; `channelLabels: []` creates no channels; `configureReceiveMedia` runs before `createOffer` (order asserted with the existing `OrderRecorder`).
- `desktop-core/test/client.test.ts` (mock peer): resolves with the first track; a second track does not re-resolve; timeout rejects with `trackTimeoutMs` override (e.g. 50 ms); `failed` state rejects before timeout; `close()` during wait rejects; `close()` is idempotent.

---

## 6. Application Design: Rust Desktop Agent (`apps/agent`)

This section assumes the 0.21 upgrade (separate `chore/deps-upgrade` PR) has landed: `webrtc = "=0.21.0"`, `rtc = "=0.21.0"` direct, `PeerConnectionBuilder` + `PeerConnectionEventHandler` flow, edition 2021 retained.

### 6.1 `Cargo.toml`

```toml
[dependencies]
# ...existing dependencies unchanged...
webrtc = "=0.21.0"
rtc = "=0.21.0"        # MediaEngine, RTCConfigurationBuilder, MediaStreamTrack,
                       # RTCRtpEncodingParameters, RtpCodecKind, Sample, Registry
openh264 = "0.9.8"     # vendored Cisco source; no network at build time

[target.'cfg(not(target_env = "musl"))'.dependencies]
xcap = "0.9.8"         # screen capture; Linux needs system dev packages (CI §8.5)
```

- `rust-version = "1.85"` stays — verified sufficient for `openh264-sys2 0.9.8` and `xcap 0.9.8`.
- musl builds get **no capture dependency at all**; desktop offers are refused at runtime (ADR-15). This keeps the fully-static terminal-only artifact working.
- No custom H.264 registration: `register_default_codecs()` already provides PT 102 (§3.1, ADR-16).

### 6.2 `desktop.rs` — capture → downscale → encode → samples

```
apps/agent/src/desktop.rs   (NEW)
├── FrameSource trait      next_frame() -> Result<Option<RawFrame>>; stop()
├── ScreenSource           xcap VideoRecorder (cfg: not(musl))
├── TestPatternSource      deterministic pattern, all platforms
├── downscale()            box filter to ≤1280×720, preserve aspect, never upscale
├── crop_to_even()         odd width/height → crop right/bottom by 1 px
├── Encoder wrapper        EncoderConfig (see below) + encode → Annex-B bytes
└── run_stream()           15 fps ticker: take latest frame → encode → write_sample
```

**`RawFrame`** — `{ width: u32, height: u32, rgba: Vec<u8> }` (RGBA8, `width * height * 4` bytes).

**`FrameSource`:**

- `ScreenSource::new()` — `Monitor::all()` → primary monitor (`Monitor::from_point(0, 0)` fallback: first monitor) → `video_recorder()` → `start()`. `next_frame()` calls `drain_latest(&receiver)`: drain the recorder's `std::sync::mpsc::Receiver` fully and return the **newest** frame (drop-oldest — the ticker loop must never encode a backlog). `stop()` calls `recorder.stop()`.
- `TestPatternSource::new(width, height)` — generates a deterministic frame per call: a moving bar whose position is a pure function of the frame counter, plus corner markers. Same counter → same bytes, on every platform. Used by the E2E (ADR-17).

**Downscale** (`downscale`): target box = fit `(w, h)` inside `1280×720` preserving aspect ratio, floor to even dimensions; if the source already fits, the frame is passed through untouched (no upscaling — a 800×600 screen stays 800×600). Box filter: each destination pixel is the average of its source block (integer arithmetic). Then `crop_to_even` guarantees the `RgbaSliceU8` precondition (even width/height, exact byte length — §3.2).

**Encoder configuration** (all builder calls verified against `openh264 0.9.8`):

```rust
let config = EncoderConfig::new()
    .bitrate(BitRate::from_bps(2_000_000))          // 2 Mbps — "xem được"
    .max_frame_rate(FrameRate::from_hz(15.0))
    .usage_type(UsageType::ScreenContentRealTime)   // screen content tuning
    .rate_control_mode(RateControlMode::Bitrate)
    .complexity(Complexity::Low)                    // proof-of-concept CPU budget
    .intra_frame_period(IntraFramePeriod::from_num_frames(60)) // IDR ≈ every 4 s
    .vui(VuiConfig::bt709());
let mut encoder = Encoder::with_api_config(OpenH264API::from_source(), config)?;
```

Per tick: `YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&rgba, (w, h)))` → `encoder.encode(&yuv)` → `bitstream.to_vec()`. **The NAL units already carry Annex-B start codes** (spike, §3.2) — the concatenated bytes are written as one sample, and `H264Payloader` splits them (§3.1). No start code is ever prepended.

**Streaming loop** (`run_stream`) — one task:

```
ticker = interval(FRAME_DURATION)        // 66.67 ms ≈ 15 fps
loop:
    select stop-signal / ticker:
        frame = source.next_frame()?     // None → skip tick, count it (debug log)
        data  = encode(frame)
        track.sample_writer(ssrc, pt)
             .write_sample(&Sample { data: Bytes::from(data),
                                     duration: FRAME_DURATION,
                                     ..Sample::new(Instant::now()) }).await?
```

- `ssrc` and `pt` are resolved **once** after Connected: `ssrc = *track.ssrcs().await.first()`, `pt = sender.get_parameters().await?.rtp_parameters.codecs.first().payload_type` (§3.1 step 5–6). Neither is hardcoded.
- Stop signal: `tokio::sync::watch::channel(false)` — a cancellation token without adding the `tokio-util` dependency. On stop: `source.stop()` then task returns; the session loop awaits the task with a short timeout before `peer.close()`.
- The loop runs strictly at tick cadence: `ticker.tick().await` at the top of each iteration; a tick with no new frame (recorder lagging) is skipped and counted (debug log). There is no unbounded queue anywhere in the path — `drain_latest` discards superseded frames at the source, which is the drop-oldest policy.
- A `write_sample` error ends the loop with the error logged (the task returns `Err`, which the session loop observes as "stream task finished" and tears the session down).

### 6.3 `rtc.rs` — desktop answer path

```rust
pub const DESKTOP_LABEL: &str = "desktop";

pub struct DesktopMedia {
    pub track: Arc<TrackLocalStaticSample>,
    pub sender: Arc<dyn RtpSender>,
}

/// Build the sending track and attach it BEFORE the remote description exists.
pub async fn attach_desktop_track(
    peer: &Arc<dyn PeerConnection>,   // the 0.21 handle type; `build()` returns `impl PeerConnection`
) -> Result<DesktopMedia>;
```

`attach_desktop_track`:

1. `ssrc = rand` — no new dependency: the SSRC is derived from the process start time (`SystemTime::now().duration_since(UNIX_EPOCH)` nanos truncated to `u32`), XOR-ed with a per-session counter so two sessions in one process never collide. The SSRC value is not security-relevant.
2. Build the codec parameters mirroring the default PT 102 entry (mime `video/H264`, clock rate 90000, `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`).
3. `TrackLocalStaticSample::new(Instant::now(), MediaStreamTrack::new(stream_id, track_id, label, RtpCodecKind::Video, vec![RTCRtpEncodingParameters { rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() }, codec: rtp_codec.clone(), ..Default::default() }]))?`
4. `peer.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>).await?`

Then the shared `send_answer`-style core runs: `set_remote_description(offer)` → `create_answer(None)` → `set_local_description(answer)` → send `SignalAnswer { approved: true }`.

The desktop session then waits for `RTCPeerConnectionState::Connected` (bounded, 20 s) via the event handler's channel before resolving `ssrc`/`pt` and spawning `desktop::run_stream`. A `Failed`/`Disconnected`-for-the-whole-timeout state ends the session with a logged error and `peer.close()`.

**Terminal path is untouched**: `answer_offer` keeps its existing behavior; the only change is that `main.rs` no longer performs a post-answer capability check (classification moved before the answer — ADR-15). `refuse_offer` is reused verbatim for the "no matching capability" and "desktop unavailable" refusals.

### 6.4 `main.rs` — mode classification and CLI

CLI addition:

```rust
#[derive(clap::ValueEnum, Clone, Copy)]
enum DesktopSource { Screen, Test }

#[arg(long, env = "AGENT_DESKTOP_SOURCE", value_enum, default_value_t = DesktopSource::Screen)]
desktop_source: DesktopSource,
```

`run_one_session` changes (before any answer):

- Classification is a pure helper (`classify_offer(&offer.capabilities) -> SessionMode { Terminal, Desktop, None }`) so it is unit-testable without a peer.
- The post-answer capability check currently at `main.rs:438` is **removed** — it is replaced by the pre-answer classification, and the refusal path calls `refuse_offer` before any answer is sent.
- Desktop flow: create the source (`Screen` → `ScreenSource::new()` — always `Err` on musl since `xcap` is not compiled in; `Test` → `TestPatternSource::new(1280, 720)`), on error `warn!` + `refuse_offer` + `close`; on success `attach_desktop_track` → `send_answer(approved: true)` → wait Connected (20 s bound) → resolve `ssrc`/`pt` → spawn `desktop::run_stream`.
- Terminal flow: byte-identical to Week 6 (same `answer_offer` → flush → `PtyManager` → data-channel handshake).

Desktop session loop — same shape as the terminal one minus the data channel:

- `select!`: inbound candidate (apply via the existing buffer), stream task finished, **connection state `Closed`/`Failed`** (delivered by the `PeerConnectionEventHandler` channel — this is the desktop equivalent of "the data channel closed": when the browser closes the peer or the transport dies, the loop must end), 1 h session cap, shutdown signal. `Disconnected` alone is transient and does not end the loop.
- Teardown: send stop signal → `source.stop()` (via the task) → await stream task (bounded) → `peer.close()`.

The supervisor (`supervise_sessions`) and its ADR-14 second-offer refusal are unchanged. The 20 s "terminal channel opened" handshake does not apply to desktop; its equivalent is the bounded Connected-wait.

### 6.5 Rust unit tests

| Test | Asserts |
|---|---|
| `downscale` cases | 1920×1080 → 1280×720; 2560×1080 → 1280×540; 800×600 → unchanged; aspect preserved; output dims even |
| `crop_to_even` | odd 1281×721 → 1280×720; byte length == w·h·4 after crop |
| `TestPatternSource` | deterministic: frame N bytes identical across two instances; consecutive frames differ |
| frame drain | `drain_latest` on a receiver with 3 queued frames yields the newest; on an empty receiver yields None |
| encoder smoke | one encoded frame: every NAL starts `00 00 00 01`; IDR contains NAL types 7 (SPS), 8 (PPS), 5 (IDR slice) |
| classification | `["terminal"]` → Terminal; `["desktop"]` → Desktop; `[]`/unknown → None; desktop + musl build → refuse |
| `ScreenSource` smoke | `#[ignore]` — needs a live display; run manually on the dev machine |

---

## 7. Application Design: Web (`apps/web`)

### 7.1 Store changes — `stores/terminal.ts`

`TabItem` gains a discriminator (the store file keeps its name; renaming it would churn every import for no behavior change):

```typescript
export interface TabItem {
  id: string;
  agentId: string;
  kind: 'terminal' | 'desktop';   // NEW
  terminalId: string;             // '' for desktop tabs
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  error?: string;
  session?: TerminalSessionType;  // optional now; desktop tabs have none
  desktopStream?: DesktopStream;  // desktop tabs: the track to render
}
```

`kind` is set to `'terminal'` in `openTab`/`recordFailedTab` — the one required mechanical edit at existing construction sites. The desktop tab carries only the *stream* (render data); the client/peer pair lives in the store's `desktopConnections` map so lifecycle stays in one place.

**`openDesktopTab(agentId: string, title?: string): Promise<string>`** (new):

1. **Exclusivity check (ADR-19).** If any tab for `agentId` is open → create an error tab (`status: 'error'`, message "This agent already has an open session tab (one session per agent). Close it first.") and return; no network attempt. Same guard in reverse inside `openTab`: if the agent has an open `kind === 'desktop'` tab, fail with "Close the desktop stream before opening a terminal."
2. Create session via `apiClient.sessions.create({ agentId })`, transport (WS/REST selection identical to `getOrConnectAgent` — extracted into a shared helper so the two flows cannot drift), ICE servers, `createBrowserAdapter`.
3. `new PeerConnection(rtcPeer, transport, { role: 'offerer', channelLabels: [], capabilities: ['desktop'], media: { video: true } })` — no data channel, media requested.
4. Register the same `SESSION_TERMINATED` / `onConnectionStateChange('failed')` handlers as the terminal flow, marking all tabs for the agent as errored.
5. `const stream = await client.start()` (the `DesktopClient` from §5.6) → on success set `tab.desktopStream = stream`, `status: 'active'`; on failure → `status: 'error'` with the client's message.
6. Desktop connections are stored in a separate `desktopConnections: Map<string, { peer, client }>` so a desktop client is never handed to the terminal flow and vice versa. The tab holds only `desktopStream` (render data); lifecycle stays in the map.

**`closeTab`** — when `removed.kind === 'desktop'`: `client.close()` (unsubscribes + closes the peer), delete from `desktopConnections`, and the existing "last tab for agent closes the connection" logic is bypassed for desktop (its connection is per-tab by construction).

**`retryTab`** — dispatches on `failed.kind`: desktop → drop any half-built `desktopConnections` entry, `openDesktopTab(failed.agentId, failed.title)`; terminal → existing path.

### 7.2 Components

**`components/desktop/DesktopView.vue`** (new):

- Props: `tab` (a `TabItem` with `kind: 'desktop'`).
- `<video autoplay muted playsinline>` — **no `controls` attribute** (view-only, ADR-18); `object-fit: contain`; dark (`bg-[#090d16]`) letterbox background.
- Source: `videoEl.srcObject = stream.streams[0] ?? new MediaStream([stream.track as MediaStreamTrack])` — the fallback exists because the werift path reports no streams (§5.5); in a real browser `streams[0]` is present. Setting `srcObject` is wrapped so a detached element cannot throw during teardown.
- Overlays: `status === 'connecting'` → "Negotiating stream…" spinner; `status === 'error'` → message + Retry button wired to `store.retryTab(tab.id)`.
- On unmount: `videoEl.srcObject = null` (releases the decoder without touching the store's client lifecycle).

**`WorkspaceView.vue`** — the body becomes kind-dispatched:

```html
<XtermTerminal v-if="activeTab.kind === 'terminal'" ... />
<DesktopView  v-else :tab="activeTab" />
```

The error overlay and Retry path stay shared (they already read `tab.error`/`tab.status`). The empty-state hotkey cheatsheet is unchanged. The footer telemetry bar: for desktop tabs, replace "Channel: terminal (64 KiB buffer)" with "Media: H.264 · view-only" — same slot, no layout change.

**`TerminalTabBar.vue`** — tab entries gain an icon by kind: `Terminal` (existing) vs `Monitor` (desktop), rendered before the title; the title keeps `font-mono`. Props type widens from `{ id; title; status }` to include `kind`.

**`WorkspaceSidebar.vue`** — per-row affordance: the existing Terminal icon button becomes two buttons when `a.capabilities.includes('desktop')`: the terminal icon (`@click.stop → connectAgent` as today) and a `Monitor` icon button (`@click.stop → $emit('connectDesktop', a)`), both hidden until row hover on desktop viewports. When the agent does not advertise `desktop`, only the terminal button renders — unchanged behavior. Row click keeps opening a terminal (least surprise).

**`WorkspaceView.vue`** wires `@connect-desktop="handleConnectDesktop"` → `terminalStore.openDesktopTab(agent.id, agent.hostname || …)`.

### 7.3 Registration dialog

`RegisterAgentDialog.vue` sends `capabilities: ['terminal', 'desktop']` instead of `['terminal']`. There is no schema or server change — `capabilities` is already an opaque `string[]` (`Agent.capabilities`). Existing agents keep `['terminal']` and simply show no Monitor affordance; the E2E seeds `['desktop']` explicitly.

### 7.4 Web tests

- `terminal-store` additions: `openDesktopTab` creates a `kind: 'desktop'` tab and reaches `active` on a mock `DesktopClient`; exclusivity: desktop while terminal open → error tab, no `sessions.create` call; terminal while desktop open → error tab; `closeTab` on desktop calls `client.close()`; `retryTab` on a failed desktop tab re-runs `openDesktopTab` with the same title.
- `DesktopView.test.ts` (happy-dom): renders `<video>` without `controls`; assigns `srcObject` when `stream` present; shows error overlay + Retry for `status: 'error'`; clears `srcObject` on unmount.
- `WorkspaceView.test.ts` additions: `kind === 'desktop'` renders `DesktopView` and not `XtermTerminal`.
- `WorkspaceSidebar` additions: Monitor button appears only for agents with the `desktop` capability; its click emits `connectDesktop` and does not emit `connectAgent`.
- `RegisterAgentDialog.test.ts`: asserted payload now `['terminal', 'desktop']`.

All mocks are local to each test file; no new test infrastructure.

---

## 8. Testing & QA Plan

### 8.1 Layer 1 — Rust unit tests

Per §6.5. Run by `cargo test --locked` in the `rust` CI job and locally. The `#[ignore]`d `ScreenSource` smoke test runs manually on the dev machine (Wayland/X11) during the demo.

### 8.2 Layer 2 — TypeScript unit tests

Per §5.7 and §7.4. Run by `pnpm test` in the `verify` CI job (`@ponter/desktop-core` is added to the workspace so turbo picks it up; `pnpm lint`/`typecheck`/`format:check` cover it automatically once the package exists with its scripts).

### 8.3 Layer 3 — cross-language E2E: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (new file)

Harness extensions (both backward-compatible):

- `spawnAgent(agentId, credential, extraArgs: string[] = [])` — appends args; desktop tests pass `['--desktop-source', 'test']`.
- `seed()` gains an options param `seed({ capabilities = ['terminal'] } = {})` — desktop tests pass `['desktop']`.

Both suites share port 8787 and the SQLite file, and `fileParallelism: false` already serializes files (the config comment anticipates exactly this second file).

**Test 1 — a real H.264 track arrives and RTP flows (Linux only, `describe.skipIf(!isLinux)`):**

1. `seed({ capabilities: ['desktop'] })`, `spawnAgent(..., ['--desktop-source', 'test'])`, `waitForAgentOnline`.
2. Offerer: `new PeerConnection(new WeriftAdapter({ iceServers: [] }), new RESTPollingTransport(...), { role: 'offerer', channelLabels: [], capabilities: ['desktop'], media: { video: true } })`.
3. Subscribe `offerer.onRemoteTrack(...)`; `await offerer.start()`.
4. Assert: a track arrives within 20 s; `track.kind === 'video'`.
5. Subscribe `track.onReceiveRtp`; collect packets for 15 s.
6. Assert: **≥ 30 RTP packets** (~2/s minimum — 15 fps at 2 Mbps will far exceed this; the floor tolerates CI jitter); `track.codec.mimeType === 'video/H264'` and every collected packet's payload type equals `track.codec.payloadType` (the PT actually negotiated — the agent answers with the PT from the offer it accepted, so asserting the literal 102 would pin an assumption; the answer SDP is the source of truth and werift exposes it on the track); at least one **IDR** is present — parse the RTP payloads (strip the 12-byte RTP header; a single NALU's first content byte `& 0x1F == 5`, or an FU-A start whose payload byte `& 0x1F == 5`, or a STAP-A containing type 7/8) and require NAL type 5 (IDR).
7. Teardown: `await offerer.close()`.

**Test 2 — teardown is clean and the agent serves the next offer (regression guard):**

1. Same setup as Test 1; wait for the first RTP packet (stream is live).
2. `await offerer.close()`.
3. Assert within 20 s: the agent process is still alive (`child.exitCode === null`), and its output contains the session-ended log line for the desktop session — proving the session loop exited via the peer-closed path rather than hanging. This is the desktop twin of the `fix/agent-session-dead-peer` bug class: a dead peer must not leave the session registered.
4. Create a **second session for the same agent** (`postJson('/api/sessions', { agentId }, token)` — the harness helper is already exported) and connect a fresh offerer to it; assert a video track arrives again within 20 s. This proves the dead peer did not swallow the next offer (ADR-14's "ready for the next offer" invariant).
5. Teardown: close both offerers.

**Test 3 — terminal flow unaffected by desktop mode:**

1. `seed()` (default `['terminal']`), spawn the agent **with** `--desktop-source test`, `waitForAgentOnline`.
2. Run the standard terminal path: `connectTerminal`, `sendKeystrokes('echo hello\n')`, `waitForTerminalOutput(frames, 'hello')`.
3. Assert the frame contract still holds (`channel: 'terminal'`, `type: 'terminal-data'`). Desktop mode must not have altered the terminal answer path.

(The inverse — a desktop offer refused on a musl build — cannot run in CI (CI builds glibc); it is covered by the Rust classification unit test in §6.5.)

### 8.4 Manual demo (recorded) — real Chrome, real screen

Checklist (recorded as the Week 7 demo artifact):

1. Fedora dev machine, Wayland session. `sudo dnf install pipewire-devel libspa-devel mesa-libgbm-devel libdrm-devel mesa-libEGL-devel nasm` (build deps; nasm optional — a warning without it is fine).
2. `cargo build` the agent; run `AGENT_CREDENTIAL=… ponter-agent --desktop-source screen`.
3. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; log in; register an agent in the dialog (now `['terminal', 'desktop']`).
4. Workspace: click the Monitor icon on the agent row → desktop tab opens → Chrome shows the live screen at ~720p, visibly ~15 fps; interacting with the host changes the stream (proves it is the real screen, not the pattern).
5. Close the tab → reopen → stream returns. Open a terminal tab while desktop is open → clear refusal message (ADR-19).
6. Wayland note: if the portal dialog appears on first capture, accept it on camera — that is the documented PipeWire ScreenCast path.

### 8.5 CI changes

`ci.yml`:

- **`rust` job**: add a step before the cache/build steps:
  ```yaml
  - name: Install system dependencies (capture stack)
    run: sudo apt-get update && sudo apt-get install -y libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev
  ```
- **`e2e` job**: same apt step before `cargo build` (the E2E job compiles the agent with capture support).

`build-agent.yml`:

- **`verify` job**: same apt step (ubuntu-latest, glibc) so `cargo build/test` covers `xcap`.
- **`build` matrix**: the apt step for the two **linux-gnu** targets (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` — the latter builds on `ubuntu-24.04-arm`, same apt names). The **musl** target needs nothing: `xcap` is absent by cfg. macOS/Windows targets need nothing new — `xcap` compiles against system frameworks.

No changes to `docker.yml`/server workflows. The server Docker image does not contain the agent.

### 8.6 What is verified where

| Claim | Verified by |
|---|---|
| Capture→encode→RTP→receive works end to end | E2E Test 1 (pattern source) |
| Real screen capture works | Manual demo (recorded) |
| Browser renders the track | Manual demo (recorded) — werift proves RTP, not rendering |
| Session teardown + next session | E2E Test 2 |
| Terminal flow unaffected | Existing terminal E2E suite + Test 3 |
| macOS/Windows compile | build-agent matrix |
| 720p/15fps "xem được" | Manual demo observation (informal, not gated) |

---

## 9. Security & Error Handling

- **Capability strings are attacker-controlled.** The agent compares `offer.capabilities` elements for exact equality against `"terminal"`/`"desktop"` only — no parsing, no prefix matching, no logging of arbitrary capability values beyond `tracing` fields.
- **View-only surface.** The desktop path registers no inbound message handling and creates no data channel; there is nothing for a remote peer to inject beyond ICE candidates (already validated by the existing `narrow_mline_index`/`apply_candidate` paths).
- **Refusals carry real SDP.** The desktop-unavailable (musl/headless) and unknown-capability paths reuse `refuse_offer` — `approved: false` with a valid answer, because `POST /api/signal/answer` rejects an empty `sdp` (Week 5 R19). Honest at the transport layer; enforcement remains a server-side gap tracked by the E2EE audit (WS3), unchanged by this week.
- **No new secrets.** TURN credentials continue to come from the existing server push; the desktop flow uses the same `build_peer`.
- **Resource bounds.** One session per agent (ADR-14, ADR-19); frame slot ≤ 2 frames with drop-oldest; encoder is single-instance per session; the stream task stops via watch signal on every teardown path (close, failure, 1 h cap, shutdown). A capture failure mid-stream ends the session with a logged error and `peer.close()` rather than a silent black screen.
- **Error surfacing.** `DesktopClient.start()` rejects with a specific message for timeout / failed / closed / `start()` failure; the store maps it to the tab's error overlay with Retry. Refusals and failures never surface as unhandled rejections (the client's `start()` is always awaited in a `try`).
- **Known limitation carried forward.** The agent's `--desktop-source test` streams a pattern; it is a debug flag, documented, and never a default.

---

## 10. Deliverables & Acceptance Criteria

### 10.1 Deliverables

| # | Artifact | Type |
|---|---|---|
| D1 | `packages/webrtc-core`: `media-channel.ts`, `types.ts`/`connection.ts`/adapters updates | Code |
| D2 | `packages/desktop-core` (new package: client, types, tests) | Code |
| D3 | `apps/agent`: `desktop.rs` (new), `rtc.rs` desktop answer path, `main.rs` classification + `--desktop-source`, `Cargo.toml` deps | Code |
| D4 | `apps/web`: store `openDesktopTab` + exclusivity, `DesktopView.vue`, tab-bar icon, sidebar Monitor affordance, dialog capabilities | Code |
| D5 | `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` + harness extensions | Test |
| D6 | CI updates (`ci.yml`, `build-agent.yml` apt steps) | Infra |
| D7 | Recorded manual Chrome demo | Artifact |
| D8 | `docs/ARCHITECTURE.md` reconciliation: Phase 3 roadmap entry (Weeks 7–9), perf table row for desktop streaming (720p15 software H.264 as the Week 7 proof; H.265/hardware as Phase 3 target) | Docs |

### 10.2 Acceptance criteria

1. `cargo test --locked` passes with the new unit tests on Linux; `cargo build --locked` succeeds for musl (no capture deps) — verified by CI.
2. `pnpm lint && pnpm typecheck && pnpm test` pass across the workspace including the two new test surfaces.
3. E2E `desktop.e2e.test.ts` passes in CI: a video track arrives, ≥ 30 RTP packets in 15 s at the negotiated H.264 payload type, at least one IDR observed; teardown leaves the agent alive and able to serve a second session.
4. The existing terminal E2E suite still passes unchanged (terminal regression gate).
5. The recorded manual demo shows a live real-screen stream in Chrome at ~720p/15 fps, plus the refusal path and reopen path.
6. `ARCHITECTURE.md` no longer claims "60fps Hardware H.265" as an achieved target; the Week 7 scope (720p15 software H.264, view-only) is recorded and the Phase 3 roadmap section exists (it currently jumps from Phase 2 to Phase 5).

### 10.3 Delivery sequence (single PR, `feat/phase3-week7-desktop-streaming`)

Per repo convention: `docs(spec)` → `docs(plan)` → `feat`/`test` commits → `docs(architecture)` sync in the same PR. Order of implementation once the plan lands:

1. `packages/webrtc-core` seam + `media-channel.ts` + tests.
2. `packages/desktop-core` + tests.
3. Agent `desktop.rs` + `rtc.rs`/`main.rs` + Rust tests.
4. Web store + components + tests.
5. E2E file + harness extensions + CI apt steps.
6. ARCHITECTURE.md reconciliation + demo recording.
7. PR to `main` (coordinated: one PR in flight at a time; rebased onto `main` after the bugfix and deps-upgrade PRs merge).

### 10.4 Review focus

- **Order of operations** in the desktop answer: `add_track` strictly before `set_remote_description` (ADR-15) — a swapped order produces an answer without the sendonly m-line.
- **Annex-B handling**: no manual start-code prepending anywhere (the spike-proven invariant, §3.2).
- **Even-dimension guard**: every path into `RgbaSliceU8::new` goes through `crop_to_even` (§6.2) — the panic is unreachable from production frames.
- **Backward compatibility**: terminal offer/answer bytes unchanged; `capabilities ?? channelLabels` fallback keeps every existing call site identical.
- **Leak check**: `closeTab`, teardown, and the failure paths all stop the stream task and close the peer; no orphaned capture (recorder `stop()`) or encoder task survives a session.
- **ADR-19 enforcement**: no network call happens when the exclusivity guard rejects.

---

## 11. Documentation Reconciliation (`docs/ARCHITECTURE.md`)

Two known drifts are fixed in the same PR (D8):

1. **Roadmap §8** currently ends Phase 2 at Week 6 and jumps to "Phase 5: E2EE & Security & Polish (Tuần 12-14)" — Phases 3 and 4 have no section. Add a "Phase 3: Desktop Streaming (Tuần 7-9)" section with Week 7 checked as the thin slice (view-only, 720p15 software H.264), and note Weeks 8–9 (quality, input, hardening) as upcoming. Leave Phase 4's absence untouched (out of scope) unless a one-line stub is preferred — decision at implementation time, noted here so it is not forgotten.
2. **Perf table (§11)** row `Desktop FPS | 60fps | Hardware H.265` is aspirational and now contradicted by shipped scope. Split it into two rows: `Desktop stream (Week 7) | ~720p @ 15fps, view-only | Software H.264 (openh264)` and `Desktop stream (Phase 3 target) | 60fps | Hardware H.265` — the ambition is preserved but labeled as a target, not a status.

The Week 4 ADR-06 note ("Phase 3 will add the module when it has content") gets a one-line follow-up in the Week 7 spec only — ADRs are historical records and are not edited retroactively.

