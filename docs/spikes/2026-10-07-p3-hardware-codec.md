# P3 — ADR-25 Hardware-Codec Investigation (Spike)

Status: **investigation only — non-gating, no commitments.** This is a desk spike that converts the Week 8
carry-forward "is hardware H.264/AV1 encode viable on the agent?" into evidence. It **gates nothing and
commits nothing**; adoption remains a later phase. All findings are current to 2026-10-07.

Authoritative home for the decision this informs: ADR-25
(`docs/superpowers/specs/2026-10-03-phase3-week8-stream-quality-design.md:250-258`)
carries the row that is still open as of this writing:

> `Desktop stream (hardware, tương lai) | 60fps | H.264 hardware / AV1 — spike ADR-25, chưa chốt`

(`docs/ARCHITECTURE.md:1128`, `...-week8-stream-quality.md:4344-4348`).

---

## 0. Baseline: the current software pipeline (fact)

The agent encodes desktop frames in **software H.264** with `openh264 0.9.8` (vendored Cisco source,
no network at build time). The path is:

- Capture: `xcap::VideoRecorder` — `apps/agent/src/desktop.rs:284-291` (the `CaptureRecorder` impl over
  `xcap::VideoRecorder::start`/`stop`). On Windows a WGC backend is selected via the `wgc` feature
  (`apps/agent/Cargo.toml:66-67`); on Linux/macOS the default backend is used. Wayland is captured
  through the same crate (with the repo-local lifetime patch in `vendor/xcap`, `Cargo.toml:72-75`).
- Color conversion: per-frame RGBA8 → YUV 4:2:0 (`YUVBuffer`) inline on the streaming task
  (`desktop.rs:1184-1192` comment, `YUVBuffer::from_rgba8_source` at `desktop.rs:1237-1240`).
- Encode: `DesktopEncoder` (`desktop.rs:1193-1224`) wraps `openh264`'s `Encoder` configured at
  `desktop.rs:1200-1224`:
  - `UsageType::ScreenContentRealTime`
  - `Complexity::Low`
  - `RateControlMode::Bitrate`
  - `intra_frame_period(60)` (≈ 2 s GOP at 30 fps; spec §3.2 Annex-B IDR-every-content-change fact at
    `desktop.rs:2066-2071`)
  - bitrate clamp `250 k–20 M` (`MIN_BITRATE_BPS`/`MAX_BITRATE_BPS`, `desktop.rs:1308-1309`)
  - in-place retarget via raw `ENCODER_OPTION_BITRATE` / `ENCODER_OPTION_MAX_BITRATE`
    (`apply_bitrate`, `desktop.rs:1255-1280`)
- Bitstream: **Annex-B**, each NAL carries its own start code — unit-tested
  (`encoder_emits_annex_b_and_an_idr_first`, `desktop.rs:1632-1667`), asserted against
  `[0,0,0,1]` at `desktop.rs:1641-1644`.
- Transport: `webrtc 0.21` / `rtc 0.21` (pinned in `Cargo.toml:20` and `Cargo.lock`). The desktop track
  advertises **H.264** (`MIME_TYPE_H264`, PT 102,
  `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f` —
  `apps/agent/src/rtc.rs:196-211`). Payload type is selected back from the negotiated sender by matching
  `MIME_TYPE_H264` (`select_h264_payload_type`, `rtc.rs:293-302`). The `MediaEngine` is populated with
  `register_default_codecs` (`rtc.rs:414`), which for the 0.21 line registers H.264 and VP8 only — **AV1
  is not registered** (see §3.3).

Build posture: desktop-only deps (`openh264`, `openh264-sys2`, `xcap`, `enigo`) sit behind
`cfg(not(target_env = "musl"))` (`Cargo.toml:42-55`). The musl artifact is the fully-static
**terminal-only** agent (`Cargo.toml:37-41` comment, ADR-15 posture) — it never encodes video. A
hardware-encode path would have to obey the same gating if it is to be absent from the musl binary.

## 1. Platform survey (encode only)

> Scope note on the brief's Interfaces line: it lists "MediaCodec", which is the **Android** NDK API.
> This agent ships for Linux / Windows / macOS (server + self-hosted, `Cargo.toml` has no Android target
> family). MediaCodec is therefore **out of scope** for *this* agent — one sentence, no padding. The
> brief's "WGC/MediaFoundation" are Windows **capture** APIs: WGC is already the xcap Windows backend
> (`Cargo.toml:66-67`); the question for a hardware codec is the **encode** side, surveyed below.

### 1.1 Linux — VAAPI (primary), NVENC, QSV, AMF

**VAAPI (Video Acceleration API / libva)** is the natural Linux fit and the one with the most mature
Rust story.

- Crate: `va` (the `vaapi` crate) + `vaapi` / `cros-codecs` ecosystem. `va` exposes the VA-API
  interface; encoding is reached through `VAProfile`/`VAEntrypoint`/VAConfig + `VAAPicture`/`VASurface`
  for H.264 (`VAProfileH264Main`, `VAEntrypointEncSlice`). `cros-codecs` already ships a real H.264
  VAAPI encoder with Annex-B output that *matches the current wire expectation* (§2.1).
- Licensing: `libva` is MIT/BSD-style (libva/MPL-2.0); the `va*` crates are MIT/Apache-2.0. No license
  friction with the repo's MIT server.
- Integration effort: medium-high. The encoder produces **VAAPI surfaces** (GPU frames), not CPU
  memory; getting RGBA/RGBA→NV12 into a surface means an extra upload + format conversion path
  (shader or `vaPutImage`), and the current loop feeds `YUVBuffer` CPU memory to openh264
  (`desktop.rs:1237`). The Annex-B NAL stream still needs reassembling per frame. Keyframe/PLI
  (§2.3) would be driven via `VAEncPictureParameterBuffer` / `VAEncSliceParameterBuffer` +
  `VAEncFeedbackBuffer` — a non-trivial mapping onto the existing `IntraFramePeriod`/retarget seam.
- Cross-compilation: the *crate* cross-compiles fine (pure bindings), but **libva must be present on
  the target host at link/runtime** — the agent build is currently a single static-ish binary; adding a
  dynamic `libva` / `libva-drm` dependency changes the deployment contract (see §2.2).
- Dynamic linking vs. fallback: VA-API resolves at runtime via `dlopen`-style `libva.so.2`. If no
  driver (no GPU, headless CI, Wayland-without-DRI) is present, `vaInitialize` fails and the build must
  **fall back to openh264**. The seams to keep: a `dyn`-dispatched `DesktopEncoder` trait so the
  software path is the cold-start default and VAAPI is opt-in per-build or per-host. This is the
  single biggest architectural ask — today `DesktopEncoder` is a concrete struct
  (`desktop.rs:1193`) used directly by `run_stream`.

**NVENC** on Linux via the `nvenc` crate / `cuda-runtime`/`cuvid` bindings:

- Crate: `nvenc` (Rust FFI over the CUDA/NVENC driver API) exists, but maturity is lower than VAAPI and
  it **requires the NVIDIA driver user-mode components present on the host**.
- Licensing: NVENC is a proprietary NVIDIA driver API — no crate-level license issue, but the *runtime*
  depends on a blob the self-hosted server image does not currently ship.
- Integration: NVENC wants CUDA context / `CUcontext`; a non-trivial addition to the agent's startup.
  Output is typically **length-prefixed (AVCC), not Annex-B** — a wire conversion layer is required
  (§2.1).
- Cross-compilation: the crate builds on any host; the driver must match the target's GPU/arch.

**Intel QSV** (libmfx/oneVPL) and **AMD AMF** are Linux-available but have **no maintained Rust crate**
of meaningful maturity; both would be reached via raw `libmfx-gen`/`amf` C FFI wrapped locally — higher
effort and a heavier licensing surface (AMF is AMD's closed runtime) than VAAPI for the same hardware
vendor class. Out of the box: prefer **VAAPI on Linux**; treat NVENC/QSV/AMF as "vendor-specific
overrides only if/when VAAPI is not present."

### 1.2 Windows — Media Foundation MFT / NVENC / QSV / AMF

Windows encode choices are reached through **Media Foundation** `IMFTransform` MFTs (the
MediaFoundation / MediaExtension path), or the vendor SDKs.

- **MF H.264 MFT** (Microsoft DTV-DVD Encoder MFT / Hardware MFT): present on Windows 10+ when a
  WDDM driver exposes a hardware MFT. Rust path: `mf` / `com` crates to drive `IMFTransform`. Licensing
  is OS-provided; integration effort is medium (MF transform lifecycle + IMFMediaBuffer wrapping).
  Output is **H.264 Annex-B or raw bitstream depending on the MFT** — the Microsoft H.264 Video
  Encoder MFT emits Annex-B by default, which *matches* the current wire expectation (§2.1).
- **NVENC / QSV / AMF MFTs**: Windows exposes vendor H.264 encoders as MF transforms too; the same MF
  path above can enumerate them. AMF is AMD's; QSV is Intel's; both ship as system MFTs on the vendor
  driver install.
- Capture-vs-encode distinction (re state the brief's WGC/MediaFoundation point): the **capture**
  side already uses WGC (`Cargo.toml:66-67` xcap `wgc`); the **encode** side is what this section
  surveys — they are independent levers.
- Cross-compilation: Windows builds still target `x86_64-pc-windows-msvc` from this repo
  (`build-agent.yml` matrix); COM apartment + MF are runtime concerns.
- Dynamic linking vs. fallback: MF is always available (system DLL); a hardware MFT may or may not be
  present. The MF enumeration `IMFActivate` path must fall back to the openh264 software MFT (or the
  existing openh264 crate) when no hardware MFT advertises H.264 — same fallback seam as §1.1.

### 1.3 macOS — VideoToolbox

- Crate: `video-trunk`/`core-video` via the `objc2` / `block` crates; direct `VideoToolbox` FFI is the
  common route (e.g. `vt` crate, community maturity low-medium). `VTCompressionSession` is the encode
  entry point.
- Licensing: VideoToolbox is an Apple framework (system-provided, no crate license cost).
- Integration: `VTCompressionSession` produces **AVCC (length-prefixed)** `CMSampleBuffer` output by
  default — **not Annex-B** — so the same AVCC→Annex-B conversion seam as NVENC (§2.1) is required.
  Property-set keying of keyframes maps cleanly onto the existing `IntraFramePeriod` concept, but the
  `CFDictionary` property bag is foreign to the current `EncoderConfig` builder
  (`desktop.rs:1202-1218`).
- Cross-compilation: macOS target builds from CI; the framework is runtime-present on macOS hosts only.
- Dynamic linking vs. fallback: VideoToolbox is always present on macOS; the fallback seam is "no
  hardware session available → openh264" (same trait-seam ask as §1.1).

### 1.4 Cross-platform NVIDIA — NVENC (recap)

Covered for Linux in §1.1; on Windows also reachable via the NVENC MF MFT (§1.2). The single crate
(`nvenc`) does not abstract the two OS ABIs, so a cross-platform NVENC path is effectively two
integrations behind one feature flag.

---

## 2. Wire & transport implications

### 2.1 Bitstream framing (Annex-B vs. AVCC) — current fact

The agent emits **Annex-B** and asserts it in tests (`desktop.rs:1227-1228` doc comment,
`encoder_emits_annex_b_and_an_idr_first` at `desktop.rs:1632-1667`). WebRTC on the wire carries H.264 as
**AVCC** (length-prefixed NALUs, RFC 6184); the `webrtc 0.21` / `rtc 0.21` stack performs the
Annex-B→AVCC packetization when the `Sample` bytes are handed to `sample_writer`
(`desktop.rs:1152-1161`). This is the **correct** framing seam to preserve: a hardware encoder that
naturally emits AVCC (NVENC, VideoToolbox, MF hardware MFTs) would short-circuit the packetization
work the `MediaEngine`/sender does today; one that emits Annex-B (openh264, MF Microsoft MFT) drops in
as a 1:1 replacement. Either way the **SDP negotiation is unchanged** — only the producer of the NALU
bytes changes.

### 2.2 Codec negotiation — H.264 today, AV1 gated

The `MediaEngine` is populated with `register_default_codecs` (`rtc.rs:414`), which for `webrtc 0.21`
registers H.264 and VP8 by default. **AV1 is not registered** and the browser offers first
(`rtc.rs:279-285` comment on Chrome offering VP8 PT 96 before H.264 is the lived failure mode), so
introducing AV1 encode is not a drop-in: it needs (a) the agent to register an AV1 payload
(`MIME_TYPE_AV1`) on the media engine, (b) `webrtc 0.21` to actually ship an AV1 RTP producer (it does
not in the 0.21 line — AV1 RTP support in `webrtc-rs` is incomplete behind feature flags that are off
in this version), and (c) a browser that offers/decodes AV1 in WebRTC (Chrome/Edge yes, Safari partial,
Firefox via libaom behind a pref). **Net: AV1 is not a 6b-low-latency lever in this dependency set**
without a `webrtc` upgrade — a future-phase decision, not a spike outcome.

### 2.3 Keyframe / PLI — the missing feedback path (fact)

The agent currently has **no PLI handling** (`desktop.rs:284` capture seam + openh264; the spec §2
"fact 6" posture the controller referenced). Today's recovery is purely time-based: `IntraFramePeriod`
of 60 (`desktop.rs:1217`) forces an IDR roughly every 2 s, and openh264's
`ScreenContentRealTime` additionally emits an IDR on content/geometry change
(`desktop.rs:2066-2071`, `screen_content_real_time_emits_idrs_on_content_change`). A hardware encoder
path inherits the same gap: without PLI/LFIR the receiver cannot ask for a recovery frame, so
keyframe scheduling must stay in the encoder's hands (e.g. VAAPI `VAEncPictureParameterBuffer` with
`pic_fields.bits`, MF `MF_VIDEO_ENCODER_CLEAN_SEI` / `eKeyQuery`). This is a **follow-on spike**, not
something P3 resolves.

### 2.4 Latency potential (estimate, not measurement)

This is a desk investigation; the L1 work in this same plan adds `captureMsP50` / `encodeMsP50`
(instrumentation that does not exist yet — `desktop.rs` has no timing probes today; the only timing
signal is `encode_time` passed to `SustainMonitor` at `desktop.rs:1114-1122`, used for the 720p30
fallback decision, not exposed as a metric). So any latency number below is an **expectation**,
labeled as such.

- Where time goes today: the encode call is synchronous and inline on the runtime worker
  (`desktop.rs:1184-1192` comment: "CPU-bound and synchronous ... fine at 15 fps"; `spawn_blocking` is
  listed as a Week 8-9 refinement). At 720p30 openh264 software encode is sub-frame on modern CPUs; the
  ceiling appears at 1080p30 where the `SustainMonitor` downgrade fires (`desktop.rs:1114-1133`).
- Hardware encode expectation: a fixed-function H.264 encoder offloads the CPU-bound slice; the
  realistic win is **CPU headroom** (room to run `spawn_blocking` without starving runtime I/O, and
  headroom for 1080p30/60fps) rather than a dramatic per-frame encode-time drop at low resolutions.
  The L1 instrumentation will tell us whether `encodeMsP50` is actually the bottleneck or whether
  capture → color conversion is.
- AV1 expectation: AV1's higher compression ratio typically costs **encode time / latency** per frame
  vs. H.264 at the same quality. On a fixed-function AV1 encoder (VAAPI `AV1_Enc`, NVENC AV1 on Ada+)
  the CPU offload is real, but the **RTP/browser path is the gating constraint** (§2.2), so AV1
  does not obviously lower 6b's glass-to-glass latency target (4.3: "no hard latency target, only
  measurable improvement + observability").

---

## 3. Cross-cutting findings

- **No new dependency.** Per task constraint, `Cargo.toml` / `Cargo.lock` / `package.json` and all
  source are untouched by P3. The crate names above are the investigation's output, not additions.
- **Build posture.** Any hardware path must sit behind the existing
  `cfg(not(target_env = "musl"))` gate (`Cargo.toml:42`) — the musl binary is terminal-only and must
  stay free of encoder code/VAAPI/MF/VideoToolbox linkage, exactly as openh264 + xcap currently are.
- **Fallback seam.** Today `DesktopEncoder` is a concrete struct consumed directly by `run_stream`
  (`desktop.rs:1193`, call site `desktop.rs:1125`). A hardware path needs a `dy`-dispatched encoder
  trait so "no GPU / no driver → openh264" is the default and hardware is opt-in per host — the same
  pattern ADR-23 used for the bitrate retarget seam (`desktop.rs:1248-1280`). This is the single
  largest code-level ask and should be its own task, not part of the spike.
- **Bitstream invariant.** Whatever producer is chosen, the output handed to `Sample` at
  `desktop.rs:1152` must remain a per-frame NAL byte buffer that the `webrtc 0.21` sender can
  packetize into RFC 6184 AVCC RTP — i.e. the Annex-B today, or AVCC-with-knowledge (§2.1). The SDP
  never changes.

---

## 4. Recommendations for future phases

1. **Spike next: VAAPI H.264 on Linux only.** It is the lowest-risk, highest-maturity path with an
   existing Rust binding (`va`) and a matching codec in the browser (H.264, no `webrtc` upgrade). Target:
   "openh264-equivalent Annex-B output via VAAPI surface, fall back to current openh264 path when
   `vaInitialize` fails." Acceptance = a single integration test that swaps the encoder behind a trait
   and asserts the first sample still starts with `[0,0,0,1]` (reusing `desktop.rs:1641`).
2. **Gate on VAAPI presence at runtime**, not at build time — keep the openh264 dependency (and the
   musl terminal build) intact; probe the host and only engage VAAPI when a driver answers.
3. **Measure before optimizing.** Land the L1 `captureMsP50` / `encodeMsP50` probes
   (this plan's L1 work) and confirm encode time is the bottleneck *before* adding a
   GPU/VAAPI/ MF/VideoToolbox dependency that only helps if the math adds up.
4. **Defer AV1 to a post-`webrtc`-upgrade phase.** AV1 in RTP needs a `webrtc-rs` line that ships AV1
   producers and a media-engine registration step; that is a dependency decision, not a codec spike.
5. **PLI feedback is a sibling spike.** Hardware H.264 without receiver-driven keyframes is fragile on
   lossy links; pair any hardware-encode adoption with a "PLI/LFIR → encoder keyframe" spike. Out of
   scope for P3.

---

## 5. One-line scope note on MediaCodec

The brief's Interfaces line names MediaCodec; MediaCodec is the Android NDK API and this agent targets
Linux/Windows/macOS only (`Cargo.toml` has no `target_os = "android"`), so MediaCodec is **out of
scope** for this agent.
