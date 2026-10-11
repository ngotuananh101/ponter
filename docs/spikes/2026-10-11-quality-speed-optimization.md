# Quality / Speed Optimization Spike (2026-10-11)

Status: **investigation only — non-gating, no commitments.** This spike records every direction we found
for improving the **desktop-stream image quality and speed**, including **AV1** (the owner's explicit
call-out). It gates nothing and commits nothing; adoption remains uncommitted. It **extends** the
same-day hardware-encode spike (`docs/spikes/2026-10-11-hardware-encode-h265.md`) on the encode side and
**updates** the older desk survey **P3** (`docs/spikes/2026-10-07-p3-hardware-codec.md`, ADR-25) where
noted. Every external claim carries a source URL that was opened; every `file:line` was re-derived
against the current tree.

**Provenance.** Spike executed by the FE session (media pipeline, Scope A) with the BE session's
server/transport review folded in as Appendix B. Measurements were taken on the host of §0 on
2026-10-11. Predecessor spike: `docs/spikes/2026-10-11-hardware-encode-h265.md`.

---

## Labeling rule (used throughout)

- **[M]** — **measured** on this host; the command is pasted inline so the number is reproducible.
- **[E]** — **expectation** (reasoned, not measured here).
- **[S]** — **sourced claim**; the URL was opened and read for this spike.
- **[S?]** — sourced but **weak**: the cited page 404s / was unreachable, so the claim rests on a
  fallback (a spec page or a sibling source). Called out as weaker on purpose.
- **[C]** — **repo claim**: a `file:line` citation, re-derived against `main` @ `9eb153f`.

> **`[C]` base re-pin.** The raw measurement notes were taken at `3702b66`; this doc re-pins every
> `[C]` citation to **`9eb153f`** (PR #113). `3702b66..9eb153f` is **docs-only** (three files under
> `docs/**`, zero `apps/**`/`packages/**`), so every source citation is byte-identical at both SHAs —
> but each was re-derived against the current tree regardless.

---

## 0. Host + the binding limitation

| Item | Value | How measured |
|---|---|---|
| CPU | Intel Core i5-14400, **16 threads** | `nproc` = 16 |
| GPU | Intel **Raptor Lake-S UHD** (iGPU only), `/dev/dri/renderD128` | `lspci`, `ls /dev/dri` |
| Media driver | libva **2.23.0** / **iHD 26.2.4** | `ffmpeg -loglevel debug`; `rpm -qa` |
| ffmpeg | **8.1.3** | `ffmpeg -version` |

**Host limitation (binding, restated per claim).** The iHD driver exposes **no H.264 / HEVC / AV1
encode profile** — only **VP9 + JPEG** encode (established three ways in the predecessor spike;
re-confirmed here for `av1_vaapi`/`av1_qsv`). Therefore:

- every **hardware-encode** number below is **VP9-only**;
- H.264 / HEVC / AV1 **hardware**-encode quality and speed are **[E]**, never measured here;
- all software codec comparisons (§2, §4, §5) are **measured**, since they are pure-CPU.

---

## TL;DR — ranked shortlist (highest leverage first)

Order is load-bearing (do not re-rank): it is the leverage order the spike found.

| # | Lever | Moves | Impact | Effort | Risk | Measurable here? |
|---|---|---|---|---|---|---|
| **1** | **Speed up / vectorise `downscale`** (scalar per-pixel RGBA box filter) | speed | **[M]** pure-CPU scalar loop, **≈7.07 ms/frame** (1080p→720p, C proxy = lower bound) — *more than the ~4 ms H.264 encode itself*; a SIMD/`fast_image_resize` path removes a real per-frame cost | Low | Low | **Y** (C proxy; bench the fn) |
| **2** | **openh264 rate-control mode** — verify `bitrate` (already set) | quality (same bitrate) | **[M]** `rc_mode=bitrate` beats ffmpeg's `quality` default by +0.14% SSIM / +0.15 dB at the *same* ~2 Mbit/s — **but the agent already sets `RateControlMode::Bitrate`**, so this is a **confirmation, not a change** | none | none | **Y** |
| **3** | **`libaom-av1` realtime (cpu-used 8) instead of SVT-AV1** — IF AV1 is pursued | quality | **[M]** AV1 realtime beats H.264 quality-per-bit at matched bytes (VMAF 94.27 vs 90.74; SSIM 0.9834 vs 0.9793 at ~2 Mbit/s) — but see the AV1 verdict (§5.4) | High (codec swap) | High | **Y** |
| **4** | **PLI / keyframe-on-demand (LFIR)** — the missing feedback path | latency/quality on loss | **[C]** no PLI path exists (`grep` → none); a lost IDR currently waits up to `intra_frame_period(60)` ≈ 2 s to recover | Medium | Medium | **N** (needs two peers) |
| **5** | **Duplicate-frame skip / damage-region capture** | speed (CPU) + bits | **[E]** static screens re-encode identically every tick; skipping saves encoder CPU (codecs already save the bits) | Medium–High | Medium | **N** (needs live desktop) |
| **6** | **Content-aware ABR + telemetry extension (VMAF/QoE)** | quality adaptivity | **[E]** today ABR is bitrate-only (`desktop-stats`), with no quality feedback | Medium | Low | Partly |
| **7** | **Encode off the runtime worker (`spawn_blocking`)** | latency jitter | **[C]** encoder runs inline on the async worker (`desktop.rs:1595-1598`) — and the code **itself names `spawn_blocking` as a deferred "Week 8–9 refinement"**; a slow frame can jitter the runtime | Low | Low | **Y** (load test) |
| **8** | **AV1** (whole codec) | quality + royalty-free | **[M]** the quality-per-bit win is real (VMAF +3.5 for libaom at matched bytes) but CPU cost is the blocker | High | High | **Y** (SW encode) |

**AV1 go/no-go: CONDITIONAL GO — but NOT as a default switch.** See §5.4. The quality-per-bit edge over
H.264 is **real but modest** at 720p (SSIM ≈ +0.4%, **VMAF +3.5** at matched bytes) and costs **~2.3×
CPU / ~4.5× wall time** with `libaom-av1` realtime; SVT-AV1 realtime matches H.264's wall time but
**burns ~5× the CPU**. Recommendation: **keep H.264 as the default; treat AV1 as an opt-in quality mode**
gated on a capability handshake and a machine-class check — not a drop-in.

---

## 1. Capture

**Current state [C].** Capture is `xcap`-based, running on a **dedicated thread** (`desktop.rs:354-360`:
"`xcap`'s capture objects are not `Send` on every platform"), with a **5 s first-frame timeout**
(`FIRST_FRAME_TIMEOUT`, `desktop.rs:395`). Windows monitor capture uses a **3-tier fallback
WGC → DXGI → GDI** (merged PR #79). The GDI/poll fallback polls every **33 ms ≈ 30 Hz**
(`GDI_DEFAULT_POLL_INTERVAL`, `desktop.rs:502`), overridable via `AGENT_DESKTOP_POLL_INTERVAL_MS`
(`desktop.rs:523-524`).

**Levers:**

- **Dirty-rect / damage-region capture** — encode only changed regions. Windows DXGI Desktop Duplication
  surfaces dirty/move rects; X11 has XDamage; **Wayland is split**. **[S]** (Appendix C.3). **Impact:**
  quality + perf. **Measurable here? N** (needs a live desktop; this host is not running an agent
  session). **Recommendation:** medium-term; requires surfacing damage rects through `xcap`, which may
  not expose them (Appendix C.3).
- **Duplicate-frame skip** — do not re-encode a frame identical to the previous one. **Measured [M]:**
  a *static* 300-frame clip encodes to **~7 kbps** vs **~3990 kbps** for moving `testsrc2` at the same
  `-b:v 4M` — the codec **already** realises ~99.8% of the bit saving on static content (H.264: 9351 B vs
  4 988 352 B; AV1: 10 166 B vs 4 892 308 B). So a duplicate-frame skip buys **almost no bits** — its
  only real value is **CPU** (skip the whole `downscale`+`encode` for an unchanged frame). Pairs directly
  with lever #1. **Measurable here? N** (needs a live desktop), but the bit-irrelevance is **measured**.
  ```bash
  ffmpeg -y -f lavfi -i "color=c=gray:s=1280x720:d=10:r=30" -frames:v 300 -c:v ffv1 static720.mkv
  ffmpeg -y -i static720.mkv -frames:v 300 -c:v libopenh264 -rc_mode bitrate -b:v 4M -f matroska enc_static.mkv
  # → ~9351 bytes (~7 kbps)
  ```
- **Pixel format** — capture yields **RGBA8**, converted to YUV 4:2:0 by openh264's
  `YUVBuffer::from_rgba8_source` (`desktop.rs:1648-1651`). A direct NV12 capture path would remove a
  per-frame conversion, but `xcap` gives RGBA and the encoder needs NV12 — the conversion is unavoidable
  without a platform-specific capture rewrite. **Impact:** speed. **Measurable here? N.**
- **Downscale — the top lever.** **[M]** it is a scalar per-pixel RGBA box filter (`downscale`,
  `desktop.rs:204-253`), executed on every frame that exceeds the profile box (test
  `downscale_uses_the_profile_box`, `desktop.rs:2491`). **Measured cost [M]:** a standalone C proxy
  replicating the exact loop structure (1080p→720p, 300 iterations) runs at **≈7.07 ms/frame** — *larger
  than the H.264 encode itself (~4 ms/frame @1080p)*. The C proxy is a **lower bound** (the Rust version
  adds bounds checks + a `Vec` alloc per frame), so the real cost is **≥7 ms/frame** on any downscaled
  frame. **This is the single most concrete, local, measurable CPU lever in the pipeline.**
  ```c
  // dsbench.c — same loop as desktop.rs downscale(): per-output-pixel box average over RGBA8
  gcc -O2 -o dsbench dsbench.c && ./dsbench   // 1080p->720p scalar box-filter: ~7.07 ms/frame over 300 iters
  ```
  **Recommendation:** replace the scalar loop with a SIMD path (`fast_image_resize`, or a hand-vectorised
  box filter) — expected several-× reduction. Measurable by swapping the fn in a bench.
  **Telemetry note [C]:** the downscale is **not** invisible — but it is **mislabelled**. In the streaming
  loop, `capture_instant` is stamped *after* `next_frame` returns (`desktop.rs:1489`), and
  `capture_ms = encode_start - capture_instant` (`desktop.rs:1498-1501`), which spans exactly the
  `crop_to_even(downscale(...))` call at `desktop.rs:1491`. So ADR-47's **`captureMsP50` actually measures
  the downscale+crop transform, not capture acquisition** — and the real capture-acquisition time (inside
  `next_frame`) is not measured at all. A large `captureMsP50` is (mostly) the box filter, not the screen
  grab.
- **Frame pacing** — `drain_latest` (drop-oldest) keeps the newest frame per tick (`desktop.rs:1587`,
  called at `:754`), and the ticker uses `MissedTickBehavior::Delay` so a slow frame is absorbed rather
  than queued (`desktop.rs:1595-1599`). **[C]** This is already a good latency posture; no obvious change.

---

## 2. Encode — software (openh264)

**Current state [C]** (`DesktopEncoder::new`, `desktop.rs:1611-1636`): `UsageType::ScreenContentRealTime`,
`adaptive_quantization(false)`, `background_detection(false)`, `RateControlMode::Bitrate` (`:1626`),
`Complexity::Low` (`:1627`), `intra_frame_period(60)` (`:1628`), `VuiConfig::bt709()`. The encoder is
**synchronous, inline on the runtime worker** — the code's own doc-comment (`desktop.rs:1595-1598`) says
so and defers `spawn_blocking` to "a Week 8–9 refinement". Bitrate is clamped 250 kbit/s–20 Mbit/s
(`MIN_BITRATE_BPS`/`MAX_BITRATE_BPS`, `desktop.rs:1719-1720`; `clamp_bitrate`, `:1733`).

**Measured — openh264 `rc_mode` sweep [M]** (720p30, 300 frames, target 2 Mbit/s, SSIM/PSNR vs a
lossless `ffv1` source):

| `rc_mode` | actual kbps | SSIM All | PSNR (dB) |
|---|---|---|---|
| `quality` (ffmpeg default) | 1987 | 0.979303 | 38.603 |
| **`bitrate`** | **1999** | **0.980719** | **38.756** |
| `buffer` | 10477 | 0.997910 | 50.161 |

```bash
ffmpeg -y -i src720.mkv -frames:v 300 -c:v libopenh264 -rc_mode bitrate -b:v 2M -f matroska out.mkv
ffmpeg -i out.mkv -i src720.mkv -lavfi "[0:v][1:v]ssim;[0:v][1:v]psnr" -f null -
```

**Reading:** `rc_mode=bitrate` gives a small but **free** quality gain at the same bitrate (≈ +0.14% SSIM,
+0.15 dB) — but the agent **already** sets `RateControlMode::Bitrate` in the Rust config, so **this lever
is already taken in production**; ffmpeg's default (`quality`) merely differs from the agent. `buffer`
ignores the target entirely (10.5 Mbit/s) — useless for a rate-limited stream. **Recommendation:**
confirm the production RC mode is `bitrate` (it is) — **no change needed**; the sweep is evidence the
config is already right.

**Other openh264 knobs [E]:** `Complexity` (Low/Medium/High) trades CPU for quality; screen-content text
sharpness and ROI exist in openh264's API but are not plumbed through the Rust wrapper. **Recommendation:**
low priority — H.264 SW quality is already competitive (§4).

---

## 3. Encode — hardware

**Recap [M].** `h264_vaapi`, `h264_qsv`, `hevc_vaapi`, `hevc_qsv`, `av1_vaapi`, `av1_qsv` all fail to
initialise on this host — the iHD driver advertises encode only for **VP9 + JPEG**. Re-confirmed this
spike:

```
[av1_vaapi] No usable encoding profile found.
[av1_qsv]   some encoding parameters are not supported by the QSV runtime.
```

**The only measurable HW encoder is VP9** — `vp9_vaapi` uses **~half the CPU** of software H.264
(63–67% vs 128–130% @720p) but is **slower in wall time** (1.42 s vs 0.63 s) because VP9 is intrinsically
costlier. **[M]** (predecessor spike). **Verdict:** HW encode is a **CPU-headroom** lever, not an
encode-time lever; and it is **not available on this host** for H.264/HEVC/AV1. Re-measure on a host whose
driver exposes the encode profiles. **Measurable here? N** (except VP9).

---

## 4. Codecs — quality-per-bit at matched bytes

**Measured [M]** (720p30, 300 frames, SSIM/PSNR vs a lossless `ffv1` source; commands below). Bytes are
reported **as produced** (see the rate-control caveat):

| Codec / settings | target | actual kbps | SSIM All | PSNR (dB) |
|---|---|---|---|---|
| `libopenh264 -rc_mode bitrate` | 2M | 1999 | 0.980719 | 38.756 |
| `libsvtav1 -preset 10` | 1.6M | 1743 | 0.978041 | 35.243 |
| `libsvtav1 -preset 10` | 1.8M | 1961 | 0.978675 | 35.775 |
| `libsvtav1 -preset 10` | 2M | 2176 | 0.979060 | 36.237 |
| **`libaom-av1 -cpu-used 8 -usage realtime`** | **2M** | **1960** | **0.983358** | **39.352** |
| `libvpx-vp9 -deadline realtime -cpu-used 8` | 2M | 1704 | 0.977255 | 36.839 |
| `libaom-av1 -cpu-used 6 -usage realtime` | 2M | 1959 | 0.992902 | 42.482 |

```bash
ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 -c:v ffv1 -pix_fmt yuv420p src720.mkv   # lossless reference
ffmpeg -y -i src720.mkv -frames:v 300 -c:v libaom-av1 -cpu-used 8 -usage realtime -deadline realtime -b:v 2M -f matroska r_aom_2M.mkv
ffmpeg -i r_aom_2M.mkv -i src720.mkv -lavfi "[0:v][1:v]ssim;[0:v][1:v]psnr" -f null -
```

**Reading (honest, matched bytes):**

- At **~2 Mbit/s**, `libaom-av1` realtime gives **0.9834 SSIM / 39.35 dB** vs H.264's **0.9793 / 38.60** —
  a **real but modest** quality-per-bit edge (≈ +0.4% SSIM, +0.75 dB) at essentially the same bytes
  (1960 vs 1987 kbps).
- **SVT-AV1 preset 10 is *worse* than H.264 at matched bytes on SSIM** here (0.9787 vs 0.9807) — its
  single-pass realtime RC overshot the target (~2176 vs 2000 kbps) and its aggressive preset hurt
  text/pattern quality. At **matched bytes**, SVT preset 10 does *not* beat H.264 on SSIM. (But note:
  **VMAF disagrees** — see the cross-check table below, where SVT-10 lands *above* H.264; the honest
  verdict is **≈ parity**, not "worse".)
- The quality win appears **only with `libaom-av1` at higher `cpu-used` cost** (cpu-used 6 → 0.9929 SSIM
  but 6.77 s/300 frames ≈ 11× H.264 wall time). **That is not a live-stream tradeoff.**

**1080p30 @ target 4 Mbit/s [M]** (same harness, `src1080.mkv` lossless reference):

| Codec | wall (s) | CPU % | actual kbps | SSIM | PSNR |
|---|---|---|---|---|---|
| `libopenh264 -rc_mode bitrate` | 1.22 | 253% | 3986 | 0.982291 | 39.034 |
| `libaom-av1 -cpu-used 8 -usage realtime` | 3.32 | 266% | 3916 | 0.983629 | 39.511 |
| `libsvtav1 -preset 8` | 2.57 | 811% | 4347 | 0.988384 | 39.843 |

**Reading @1080p:** libaom-av1 realtime now costs **about the same CPU as H.264** (266% vs 253%) but
2.7× the wall time, for +0.13% SSIM; SVT-AV1 preset 8 shows a larger quality edge (+0.6% SSIM) but at
**811% CPU and +9% bitrate overshoot**. The AV1 quality edge **does grow slightly with resolution**, but
the CPU/wall-time cost is the constant problem.

**VMAF cross-check @ ~2 Mbit/s [M]** — SSIM alone under-weights perceptual text/edge quality; VMAF is
the perceptual metric of record. Same files as above:

| Codec / settings | actual kbps | **VMAF** | SSIM (for contrast) |
|---|---|---|---|
| `libopenh264 -rc_mode bitrate` | 1987 | **90.736** | 0.9793 |
| `libvpx-vp9 -deadline realtime -cpu-used 8` | 1704 | **90.350** | 0.9773 |
| `libaom-av1 -cpu-used 8 -usage realtime` | **1960** (matched) | **94.269** | 0.9834 |
| `libsvtav1 -preset 10` | 2202 (+11%) | **91.632** | 0.9792 |
| `libsvtav1 -preset 8` | 2176 (+10%) | **94.458** | 0.9872 |

```bash
ffmpeg -hide_banner -i r_aom_2M.mkv -i src720.mkv -lavfi "libvmaf" -f null -   # → VMAF score: 94.268665
```

**Reading — VMAF is *more* favourable to AV1 than SSIM, and it disagrees with SSIM on SVT-10:**

- **At matched bytes**, `libaom-av1` realtime is **+3.53 VMAF** over H.264 (94.27 vs 90.74) — a
  *substantially* larger perceptual margin than SSIM's +0.4%. VMAF weights the text/edge structure AV1
  preserves better, which SSIM's block statistics miss.
- **SVT-AV1 preset 10 flips sign**: SSIM says *worse* than H.264 (0.9792 vs 0.9793), VMAF says *better*
  (91.63 vs 90.74). **The two metrics disagree on SVT-10** — the honest conclusion is that SVT-10 is
  **at parity with H.264, not clearly worse**; SSIM's verdict was too harsh. (SVT-10 also carried +11%
  bytes here, so part of its VMAF edge is the byte overshoot — but its *matched-byte* verdict is
  "≈ parity", not "worse".)
- The **ordering is stable across both metrics** for the main comparison: **libaom-AV1 > H.264 > VP9**
  at matched bytes. Only the SVT-preset-10 marginal case is metric-dependent.

**Caveat on content [E]:** `testsrc2` is a synthetic moving pattern; screen content (text/UI) has
different rate-distortion characteristics. A real screen-content sample is the correct test bed (not
available in a read-only spike). Treat the *ordering* (AV1 ≥ H.264 > VP9 at matched bytes; SVT-10 ≈
H.264) as the finding, not the exact SSIM/VMAF deltas. VMAF here uses the **default built-in model**
(`vmaf_v0.6.1`, auto-located by ffmpeg 8.1.3) — no custom model, no phone model.

---

## 5. AV1 (deep) — the owner's explicit call-out

### 5.1 Browser support — measured

**[M]** Chrome 154.0.8037.97 on this host offers **`video/AV1` in BOTH send and receive**
`RTCRtpCapabilities` (predecessor spike §4.3.1: the SEND list includes AV1, the RECV list includes
AV1×2), and `MediaCapabilities.decodingInfo` reports AV1 `supported=true` for `av01.0.04M.08`. So the
**browser gate that blocks HEVC does NOT block AV1**. **[S]** browser-support URLs in Appendix C.2
(MDN: AV1 in WebRTC for Chrome 113+ / Firefox 136+).

### 5.2 Stack readiness — verified in crate source [C]

`rtc 0.21` **registers AV1 (PT 41)** — verified in the crate source this spike:
`media_engine.rs:543-551` builds the AV1 `RTCRtpCodecParameters` (`mime_type: MIME_TYPE_AV1`,
`sdp_fmtp_line: "profile-id=0"`, `payload_type: 41`) and `:553` adds its RTX (`rtx_codec(106, 41)`);
`rtp_codec.rs:114-115` maps the MIME type to a real `Av1Payloader`. `apps/agent/src/rtc.rs:414-415` calls
`register_default_codecs()`, so **AV1 is already registered**. **[S]** AV1's RTP payload format is the
**AOMedia spec "RTP Payload Format For AV1" v1.0.0** — **there is no IETF RFC for AV1's RTP payload
format** (see Appendix C.2).

### 5.3 Encoder reality — measured

Realtime speed, 720p30, 300 frames, target 4 Mbit/s **[M]**:

| Encoder | wall (s) | CPU % | note |
|---|---|---|---|
| `libopenh264` (baseline) | 0.63 | 128% | ~1 core |
| `libsvtav1 -preset 12` | 0.69 | **672%** | ~6.7 cores |
| `libsvtav1 -preset 10` | 0.69 | 677% | |
| `libsvtav1 -preset 8` | 1.30 | 653% | |
| `libaom-av1 -cpu-used 8 -usage realtime` | 2.81 | 256% | ~2.6 cores, 4.5× wall |
| `librav1e -speed 10` | **31.59** | 103% | unusable for realtime |
| `libvpx-vp9 -deadline realtime -cpu-used 8` | 0.87 | 246% | |

```bash
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 -c:v libsvtav1 -preset 12 -b:v 4M -f null -
```

**Reconciles with an independent run [M]:** a second run got SVT-AV1 0.74 s / 656% and aom 2.81 s / 251%
vs 0.69 s / 672% and 2.81 s / 256% here — **same picture**: SVT-AV1 realtime matches H.264 wall time but
**burns ~5× the CPU**; libaom realtime is ~4.5× the wall time at ~2× the CPU.

**SVT-AV1 preset vs quality at matched target (2M) [M]:**

| preset | wall (s) | CPU % | actual kbps | SSIM | PSNR |
|---|---|---|---|---|---|
| 6 | 2.85 | 725% | 2145 | 0.990812 | 40.381 |
| 8 | 1.47 | 676% | 2176 | 0.987212 | 39.156 |
| 10 | 0.78 | 704% | 2202 | 0.979154 | 36.342 |
| 12 | 0.77 | 708% | 2196 | 0.979096 | 36.277 |

**Reading:** to *beat* H.264 (SSIM 0.9807) SVT-AV1 needs **preset 8 or slower** (≥ 1.47 s/300f = **2.3×
H.264 wall time at ~5× CPU**), and it **still overshoots the bitrate** (~2176 vs 2000 kbps). The fast
presets (10–12) that match H.264's wall time land at **≈ parity** with H.264 — SSIM says slightly *worse*,
VMAF says *better* (the two metrics disagree; see §4). Only preset 8-or-slower clearly beats H.264.

**Rate-control inaccuracy [M]** — a real finding for a live stream: SVT-AV1 single-pass realtime **does
not hold the target** (2M → 2176 kbps, ~+9–13% across all targets 1M/2M/4M/8M). A production AV1 path
would need `-maxrate`/`-bufsize` (capped VBR) or 2-pass — neither is realtime-friendly.

**HW AV1 encode [M]:** `av1_vaapi` and `av1_qsv` both **fail on this host** (same driver limit as
H.264/HEVC). HW AV1 **encode** (NVENC AV1 on RTX 40+, Intel Arc, AMD AMF) is the only way AV1 becomes
cheap for a live agent — **[S]** (Appendix C.2) — but it is **not testable here**.

**Integration cost [C/E]:** registering the AV1 RTP payload is free (already done by
`register_default_codecs()`), but the **agent has no AV1 *encoder*** — openh264 produces H.264 only.
Adopting AV1 means adding a Rust AV1 encoder dependency (SVT-AV1 bindings, the `rav1e` crate, or libaom
bindings) plus its rate-control plumbing, in place of openh264. **This is the real "effort = High"**
behind the AV1 row in the shortlist: a new encoder integration, not a config change.

### 5.4 AV1 verdict — CONDITIONAL GO (opt-in), NOT a default switch

- **Quality-per-bit:** a **real win** over H.264 at matched bytes, and only with `libaom-av1` realtime —
  **SSIM +0.4% / PSNR +0.75 dB / VMAF +3.53** at 2 Mbit/s on synthetic content (VMAF is the larger, more
  perceptual signal) — at **~2.3× CPU and ~4.5× wall time**. On this host, the cheapest realtime AV1 that
  *beats* H.264 costs materially more than H.264. (Metric caveat: SSIM and VMAF **disagree** on SVT-AV1
  preset 10 — see §4 — so the win is robust for libaom, marginal-to-parity for fast SVT presets.)
- **CPU is the blocker** for a live agent: SVT-AV1 needs ~5–7 cores; libaom realtime needs ~2.5 cores
  *and* ~4× the wall time. A 16-thread agent can afford it; a small one cannot.
- **Royalty-free is a genuine advantage** over HEVC (and over H.264's pools) — **[S]** (Appendix C.2).
- **Browser + stack are ready** (AV1 measured in Chrome send+recv; `rtc 0.21` registers it) — so **AV1 is
  the *only* modern codec with no gate on our side**.
- **Go/no-go:** **GO only as an opt-in "quality" mode** — capability-gated (browser advertises AV1),
  machine-class-gated (≥ N cores), defaulting **off**. **NO-GO as the default codec** today: the quality
  delta does not justify 2–7× the encode cost for every session, and single-pass realtime AV1 RC overshoots
  the bitrate. **Re-evaluate as a default when HW AV1 encode is broadly available** on target machines.

---

## 6. Rate control / adaptation

**Current state [C].** ABR **is** network-adaptive but **bitrate-only**: the agent registers
`transport-cc` congestion control (`rtc.rs:418-431`,
`configure_congestion_control(..., CongestionFeedback::Twcc, ...)`) with a GCC estimator wrapped so its
target is observable (`rtc::abr::ReportingEstimator`, `rtc.rs:97-158`); an `abr_task`
(`lib.rs:2088-2108`) polls the estimate and, when it moves enough, sends a bitrate retarget. The retarget
goes through `abr_next_target` (`desktop.rs:1744-1760`): clamp to 250k–20M, ignore the untouched seed
(`ABR_INITIAL_BPS` = 4 Mbit/s, `rtc.rs:87`) within a 5% band, and apply a **15% dead-band** before
emitting. The control frame is `desktop-bitrate` → `clamp_bitrate` (`desktop.rs:1733`) →
`DesktopEncoder::apply_bitrate` (a raise needs `ENCODER_OPTION_MAX_BITRATE` on layer 0 first,
`desktop.rs:1666-1691`). `StreamProfile` defaults: `DEFAULT_1080P30` = 1080p30 @ 6 Mbit/s, `SAFE_720P30`
= 720p30 @ 4 Mbit/s (`lib.rs:451-464`).

**What's missing (the levers):** ABR adapts **bitrate only** — it never changes **resolution or fps**
under constraint, and it is **not content-aware** (a static screen and a video drive the same bitrate).
There is **no SVC and no simulcast**.

- **Resolution/fps adaptation** — **[E]** dropping to 720p (or 15 fps) under a low GCC estimate degrades
  more gracefully than starving 1080p of bits. The classic "degrade resolution before quality" lever;
  not present.
- **CBR/VBR/CQP** — the H.264 path uses openh264 `RateControlMode::Bitrate` (CBR-ish). **[M]**
  `rc_mode=buffer` (CQP-like) blew past the target (10.5 Mbit/s) — not usable under a cap.
- **SVC / temporal layers** — not present. **[E]** would give graceful degradation under loss;
  significant plumbing. **[S]** (Appendix C.1).
- **Keyframe-on-demand (PLI/LFIR)** — **the missing feedback path [C]:**
  `grep -rnwE 'PLI|PictureLoss|request_keyframe' apps/agent/src/` → **no matches**. Recovery is
  time-based only: `intra_frame_period(60)` ≈ IDR every 2 s at 30 fps (`desktop.rs:1628`). On packet
  loss, the viewer cannot ask for a keyframe — it waits up to 2 s. **Highest-value rate-control lever.**
  **Measurable here? N** (needs two peers + induced loss).

---

## 7. Transport (WebRTC) — see Appendix B (BE) for the server angle

**Client/agent-side [C]:** the H.264 track is stamped with the codec PT chosen by `desktop_stream_params`
— deliberately **not** `.first()`, because a Chrome offer lists VP8 (PT 96) before H.264 (PT 102) and
`.first()` once stamped H.264 payloads with VP8's PT, rendering black (`rtc.rs:279-290`). **Congestion
control IS wired for desktop**: `transport-cc` feedback + a GCC estimator (`rtc.rs:418-431`) driving the
ABR retarget loop (§6) — this is the main transport lever and it is **already implemented**. RTX/NACK/FEC
are handled by the `rtc` stack; the app exposes no further transport knobs. **[S]** for
GCC/transport-cc/RTX/FEC and SDP codec preference (Appendix C.1). **Measurable here? N** (needs a live
session).

---

## 8. Decode / playout (viewer)

**Current state [C].** Browser-native decode via `<video srcObject>`
(`apps/web/src/components/desktop/DesktopView.vue:188-191`, element at `:356-360`). Playout tuning exists
(ADR-46): `packages/desktop-core/src/client.ts` writes `jitterBufferTarget` (Chrome) or `playoutDelayHint`
(Firefox), default **100 ms** (`client.ts:95-96`, applied at `:510-529`). WebCodecs was **DESCoped**
(ADR-48 FAIL).

**Why ADR-48 failed [C]:** the P2 spike (`docs/spikes/2026-10-07-p2-webcodecs-probe.md`) shows the
failure was **specific to AVC/H.264**: Chrome 154's `VideoDecoder` **requires** an out-of-band
`description` (avCC) for AVC, and the agent emits **Annex-B** — so a WebCodecs path would need
Annex-B→avCC conversion + SPS/PPS extraction. That is an **H.264-specific packaging requirement**, not a
fundamental WebCodecs limitation.

**Levers:**

- **Re-evaluate WebCodecs for AV1** — **[E]** AV1's `VideoDecoder` config does **not** carry the same
  avCC-`description` requirement as AVC, so the exact reason ADR-48 failed would not apply to AV1. **BUT**
  our viewer is a browser `<video>`, which **already decodes AV1 natively** in Chrome (hardware decode
  where available) — so WebCodecs buys **nothing for the browser viewer** regardless of codec. WebCodecs
  would only matter if a **native (non-browser) desktop viewer** needed AV1 decode in-app. *(The
  AV1-decoder-config claim is **[E]**, not sourced here — no WebCodecs spec page was opened for this
  spike.)* **Verdict:** still a **NO** for the current browser viewer; keep on the shelf for a future
  native viewer.
- **`jitterBufferTarget` / `playoutDelayHint`** — already tuned to 100 ms; **[E]** lowering it cuts
  latency but risks more stutter. A tradeoff dial, not a free win.
- **Canvas / OffscreenCanvas** — the app already draws a cursor overlay on a canvas over the `<video>`
  (`DesktopView.vue:44-62`). **[E]** no decode-path change available.

---

## 9. Quality measurement / ABR

**Current state [C].** Telemetry is ADR-47's `FrameTimingRing` — `captureMsP50` / `encodeMsP50`
(`desktop.rs:40-70`), surfaced in `desktop-stats`. **No quality metric (VMAF/SSIM/PSNR) is measured at
runtime.**

**Levers [S]:** VMAF/SSIM/PSNR/XPSNR definitions + VMAF's model-file requirement — Appendix C.4. **[M]**
all are available as ffmpeg filters on this host (`libvmaf`, `ssim`, `psnr`, `xpsnr` present); VMAF ran on
the default built-in model (`vmaf_v0.6.1`) with no extra model file. **Metric choice matters [M]:** on our
own encodes, SSIM and VMAF **ranked SVT-AV1 preset 10 differently** (§4) — SSIM said "worse than H.264",
VMAF said "better". A runtime/regression metric must therefore be chosen deliberately: **VMAF is the
perceptual metric of record**, SSIM is cheaper but can mislead on text/edges. **Recommendation:** extend
ADR-47 telemetry with a cheap objective proxy (encoder QP / bits-per-frame) rather than full VMAF (too
heavy for a live agent); use VMAF offline for regression testing. **Measurable here? Y** offline.

---

## 10. Latency budget

**Current state [C]** — ADR-47's four layers (from `docs/ARCHITECTURE.md:1161-1162`): (1) capture→encode
rolling stats (`captureMsP50`/`encodeMsP50`), (2) present-time health, (3) input-echo round-trip,
(4) same-host glass-to-glass. Measured, not promised.

**Where the ms go [M/E]:**

- **Downscale:** **[M]** ≥ 7.07 ms/frame (1080p→720p, scalar box filter) — **larger than the encode**,
  and it sits on the *critical path before* `encode()` every frame. The biggest *local* CPU term on the
  agent and the clearest lever (#1).
- **Capture→encode:** H.264 SW encode is already **2.1 ms/frame @720p, 4.0 ms/frame @1080p** on this CPU
  **[M]** — small relative to a 30 fps (33 ms) budget. **The encode itself is not the bottleneck; the
  pre-encode downscale is.**
- **Playout:** fixed **100 ms** jitter-buffer target (`client.ts:95-96`) — the largest single *tunable*
  latency term. **[E]** lowering it trades latency for stutter.
- **Transport:** one-way network + GCC dynamics; **[E]** the dominant unknown in real deployments.
- **Which lever moves the most:** for *latency*, the **playout buffer** (100 ms, tunable) and **PLI
  recovery** (up to 2 s after loss) dominate; for *CPU*, **`downscale`** dominates (measured ≥7 ms/frame,
  > encode); for *quality*, the codec / rate-control choice dominates.

---

## Appendix A — Measurement environment & reproduction

Reference source: `src720.mkv` (lossless `ffv1`, 300 frames, 720p30). Per-run `/usr/bin/time -v` and
encoded outputs are ephemeral. Quality via the `ssim` + `psnr` (+ `libvmaf`) ffmpeg filters against
`src720.mkv`. **All commands are inlined in the sections above**, so the measurements are reproducible
without the raw artifacts (no `/tmp` link).

Crate-source citations (§5.2) are relative to the vendored crate, not the repo:
`rtc-0.21.0/src/peer_connection/configuration/media_engine.rs` and
`rtc-0.21.0/src/rtp_transceiver/rtp_sender/rtp_codec.rs` under `~/.cargo/registry/src/index.crates.io-*/`.
All `apps/**` / `packages/**` citations are repo-relative on `main @ 9eb153f` (identical to `3702b66` —
PR #113 is docs-only).

---

## Appendix B — Scope B: server / transport infrastructure (BE)

**One-line verdict:** **no server-side media lever exists today** — the server is a pure signaling +
ICE-config relay and never touches media; the only server-shaped knob is TURN relay deployment capacity
(49 relay ports from `docker/docker-compose.prod.yml:68-69`, no bandwidth cap configured), and the only
architectural lever would be an SFU (flagged, not designed, unneeded for 1:1 P2P). E2EE (WS1) covers the
terminal data channel only — zero overhead on video (DTLS-SRTP at the peers). **So all
image-quality/speed levers are client/agent-side (Scope A).**

| Question | Finding | Evidence |
|---|---|---|
| Server touches media? | **No** — signaling + ICE config only | `signal.ts:16,59,138,198`; `webrtc.ts:15-17`; `ws.ts:836-840`; `grep -rin media apps/server/src` → only the words "browser-mediated" and "immediately" (no media code) |
| TURN a quality/latency lever? | **Conditional, deployment-scoped** — no code cap to lift; 49 relay ports from config | `docker/docker-compose.prod.yml:68-69`; `ice.ts:7,53`; `grep` for caps → none |
| Server-mediated lever? | **Only an SFU would be one — flagged, not designed** | `ARCHITECTURE.md:120-133` (1:1 P2P) |
| E2EE overhead on video? | **None** — terminal channel only; video = DTLS-SRTP at the peers | `docs/superpowers/specs/2026-10-07-ws1-e2ee.md`; `terminal-protocol.md`; `grep` → no server crypto |

**Bottom line:** all realistic quality/speed levers live on the two peers (Scope A). The server side
offers, at most, **deployment tuning of the TURN relay** for the relayed subset of sessions — and no
in-code media lever exists to change today.

---

## Appendix C — Sourced claims (URLs opened)

**[S]** = the page was fetched and read. **[S?]** = the research reported the page **404 / unreachable**,
so the claim rests on the fallback named beside it (weaker).

### C.1 WebRTC transport (GCC / transport-cc / RTX / FEC / SVC / playout / codec preference)

- **Congestion control (GCC).** GCC is the canonical sender-side bandwidth estimator: a **delay-based**
  estimator (inter-packet arrival jitter; overuse when one-way delay rises) plus a **loss-based**
  estimator (~10% loss triggers a lower target); receiver feedback (transport-cc or REMB) feeds both.
  **There is no IETF RFC for GCC** — it exists as the expired draft
  `draft-ietf-rmcat-gcc` ("A Google Congestion Control Algorithm for Real-Time Communication",
  **Expired Internet-Draft** — https://datatracker.ietf.org/doc/draft-ietf-rmcat-gcc/) and as the
  Chromium implementation. **[S?]** — no stable RFC. — *Repo tie-in: our agent runs exactly this —
  `transport-cc` + a GCC estimator driving ABR (§6/§7, `rtc.rs:418-431`).*
- **transport-cc feedback.** Receiver→sender RTCP feedback carrying per-packet arrival-time deltas,
  delivered via the one-byte RTP header extension `urn:ietf:params:rtp-hdrext:transport-cc` (RFC 8285
  framework — https://www.rfc-editor.org/rfc/rfc8285, "A General Mechanism for RTP Header Extensions").
  **Status: draft/experimental, never RFC'd**, but shipped in Chromium/WebKit. **[S?]** — the spec is the
  expired draft "RTP Extensions for Transport-wide Congestion Control"
  (https://datatracker.ietf.org/doc/draft-holmer-rmcat-transport-wide-cc-extensions/); no stable RFC
  exists for transport-cc itself.
- **REMB.** REMB (Receiver Estimated Maximum Bitrate) caps the sender to the receiver's signaled max
  bitrate; it is **superseded by transport-cc**. It exists only as the expired draft
  `draft-alvestrand-rmcat-remb` ("RTCP message for Receiver Estimated Maximum Bitrate", **Expired
  Internet-Draft** — https://datatracker.ietf.org/doc/draft-alvestrand-rmcat-remb/), so **[S?]**. *A
  commonly repeated claim that "Chrome disabled REMB in 2022" could **not** be sourced in this spike —
  the Chromium issue tracker did not return readable content — so it is **not asserted here**.*
- **NACK (RFC 4585) + RTX (RFC 4588).** NACK = the AVPF feedback profile; RTX retransmission uses a
  separate SSRC (`a=ssrc-group:FID`), 2-byte OSN. Cost = **one RTT** (~50–200 ms). **[S]**
  https://www.rfc-editor.org/rfc/rfc4585 ("Extended RTP Profile for Real-time Transport Control Protocol
  (RTCP)-Based Feedback (RTP/AVPF)"); **[S]** https://www.rfc-editor.org/rfc/rfc4588 ("RTP Retransmission
  Payload Format").
- **RED (RFC 2198).** In-band redundancy at negative timestamp offsets — no round trip, ~20–30% overhead;
  used mainly for audio. **[S]** https://www.rfc-editor.org/rfc/rfc2198 ("RTP Payload for Redundant Audio
  Data").
- **ULPFEC (RFC 5109).** XOR FEC over a separate stream; recovery in one FEC block, coarse-grained.
  **[S]** https://www.rfc-editor.org/rfc/rfc5109 ("RTP Payload Format for Generic Forward Error
  Correction"; the algorithm is "Uneven Level Protection (ULP)").
- **FlexFEC-03 (RFC 8627).** 2-D XOR FEC with per-packet bitmasks; shipped in Chrome 2017 then disabled
  in favour of NACK+RTX. **[S]** https://www.rfc-editor.org/rfc/rfc8627 ("RTP Payload Format for Flexible
  Forward Error Correction (FEC)").
- **SVC vs simulcast.** SVC = one bitstream with spatial+temporal layers (`scalabilityMode` `L1T3` etc.);
  dropping a temporal layer needs **no re-encode** (low latency) but costs ~20–30% compression efficiency
  vs independent simulcast layers. Chromium configures SVC for **VP8/VP9/AV1** (and temporal scalability
  for H.264/H.265). **[S]** https://www.w3.org/TR/webrtc-svc/ . — *Repo tie-in: neither SVC nor simulcast
  is present (§6).*
- **`jitterBufferTarget`** (RTCRtpReceiver): preferred jitter-buffer hold, a `DOMHighResTimeStamp` in
  **milliseconds**, "a positive value of no greater than **4000 milliseconds**"; out-of-range throws
  `RangeError`. **[S]**
  https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget . *Repo tie-in:
  already used with a feature check (`client.ts:510-529`).*
- **`playoutDelayHint`** (RTCRtpReceiver): minimum playout delay, in **seconds**; being superseded by
  `jitterBufferTarget`. **[S?]** the MDN page **404s**
  (https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/playoutDelayHint → 404); the claim
  rests on the W3C spec — https://www.w3.org/TR/webrtc/ . *Repo tie-in: used as the Firefox path, and the
  repo writes it in **seconds** (`client.ts:529` divides ms by 1000) — consistent with the spec.*
- **`setCodecPreferences`**: reorders/filters negotiated codecs **via API**, not SDP-string munging. **It
  lives on `RTCRtpTransceiver`, not `RTCRtpSender`** — verified:
  https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/setCodecPreferences → 200; the
  `RTCRtpSender` variant → 404. **[S]** . — *Repo tie-in: we sidestep this by selecting the H.264 PT
  explicitly rather than `.first()` (§7, `rtc.rs:279-290`).*
- **`degradationPreference`** (RTCRtpSendParameters.encodings): `balanced` / `maintain-framerate` /
  `maintain-resolution` / `maintain-framerate-and-resolution`. **[S]**
  https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSendParameters . — *Note: applies to **browser
  senders** (the web viewer's own capture), NOT to our Rust agent, which is not a browser.*
- **Chrome screen-share hints** (`getDisplayMedia` codec/degradation hints): **[S?]**
  https://developer.chrome.com/docs/web-platform/screen-sharing-api → **404** (verified); treated as
  **[S?]**. — *Also browser-sender-only; not on our agent's path.*

**Net for our pipeline:** the transport layer offers **no new agent-side lever** — GCC/transport-cc is
already wired, RTX/NACK/FEC are handled by the `rtc` stack, and `setCodecPreferences` /
`degradationPreference` / screen-share hints all apply to **browser senders**, which we are not. The one
*architectural* transport lever worth noting is **SVC/temporal layers** (§6) — not present today.

### C.2 AV1 browser support / RTP payload / HW encode / royalty

- **AV1 in WebRTC — browser support.** MDN's WebRTC-codecs guide documents AV1 in WebRTC for **Chrome
  113+** and **Firefox 136+** (the latter adds AV1 simulcast + the Dependency-Descriptor RTP header
  extension); `RTCRtpSender/Receiver.getCapabilities("video").codecs` returns the AV1 codec object.
  **[S]** https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs . — *Our own
  measurement (§5.1) confirms it locally: Chrome 154 offers `video/AV1` send+recv.*
- **AV1 RTP payload format.** **There is no IETF RFC for the AV1 RTP payload format.** Verified two ways
  this spike: (a) the IETF datatracker has **no** `draft-ietf-payload-*av1*` document
  (https://datatracker.ietf.org/api/v1/doc/document/?name__contains=av1 → only NETVC slide decks); (b)
  RFC 9328 is **not** AV1 — it is "RTP Payload Format for Versatile Video Coding (VVC)"
  (https://www.rfc-editor.org/rfc/rfc9328.json → `"title": "RTP Payload Format for Versatile Video Coding
  (VVC)"`). AV1's RTP payload format is the **AOMedia spec "RTP Payload Format For AV1", v1.0.0**. **[S]**
  https://aomediacodec.github.io/av1-rtp-spec/ . — *Note for the record: the merged predecessor spike
  (`docs/spikes/2026-10-11-hardware-encode-h265.md`) cites **only** RFC 7798 (HEVC) and RFC 6184 (H.264)
  — it never cites an AV1 payload RFC; the "9328" mis-citation was internal to an earlier draft of
  **this** document and is corrected here.*
- **AV1 royalty-free.** AV1 was developed by the **Alliance for Open Media (AOMedia)**; it "aims to be a
  video format for the web that is both state-of-the-art and royalty free", with "a royalty-free
  licensing model that does not hinder adoption in open-source projects." **[S]**
  https://en.wikipedia.org/wiki/AV1 ; primary spec at https://aomediacodec.github.io/av1-spec/ ("AV1
  Bitstream & Decoding Process Specification").
- **HW AV1 encode availability.** The first NVENC generation with AV1 encode is **Ada Lovelace (RTX 40)**
  — Wikipedia's NVENC article: Nvidia "announced the next-gen NVENC with 8K 10-bit 60FPS **AV1 fixed
  function hardware encoder** in Ada Lovelace GPUs"; Turing (RTX 20) and Ampere (RTX 30) subsections do
  **not** list AV1 encode. **[S]** https://en.wikipedia.org/wiki/Nvidia_NVENC . Vendor matrix
  (https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new) is a **JS-rendered
  table** that did not yield reliable text extraction in this spike, so the generation boundary is cited
  to the Wikipedia article instead. — *Correction: an earlier pass over-claimed Turing/Ampere; the
  boundary is Ada onward. This is why "HW AV1 is the only way AV1 gets cheap" is a **future** statement,
  not a today one — most installed GPUs still lack it. Intel Arc / AMD AMF also offer AV1 encode (not
  fetched here; out of scope).*

### C.3 Capture APIs (dirty-rect / damage-region)

- **Windows — DXGI Desktop Duplication exposes dirty + move rectangles.** `GetFrameDirtyRects` returns
  "non-overlapping rectangles that indicate the areas of the desktop image that the operating system
  updated since you processed the previous desktop image"; `GetFrameMoveRects` returns "rectangles of
  pixels in the desktop image that the operating system moved to another location". Exactly the
  dirty-region signal a damage-region encoder needs. **[S]**
  https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api . — *Our Windows capture
  path already uses DXGI as the tier-2 fallback (PR #79); surfacing its dirty rects through `xcap` is the
  gap.*
- **X11 — XDamage reports damaged regions.** The Damage extension "monitors regions affected by rendering
  operations" and emits a `DamageNotify` event with an `area: Rectangle`; `DamageSubtract` clears
  repaired damage. **[S]**
  https://xorg.freedesktop.org/archive/current/doc/damageproto/damageproto.txt .
- **Wayland — damage exists, but at different layers.** `zwlr_screencopy_frame_v1` has a **`damage`
  event** ("carries the coordinates of the damaged region" — x/y/w/h of a box changed since the last
  copy) **[S]** https://wayland.app/protocols/wlr-screencopy-unstable-v1 . **However**, the
  **xdg-desktop-portal ScreenCast** interface (the API `xcap` actually uses on Wayland) documents **full
  frames over PipeWire, with no damage-region delivery** **[S]**
  https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html . — *So on
  Wayland, the portal path gives no damage info today; damage would require a
  wlr-screencopy/`ext-image-copy-capture` backend instead of the portal.*
- **Net:** damage-region capture is **available on Windows (DXGI) and X11 (XDamage)**, **not via the
  Wayland portal** — a real platform asymmetry for the dirty-rect lever in §1.

### C.4 Quality metrics (VMAF / SSIM / PSNR / XPSNR)

- **VMAF** = "Perceptual video quality assessment based on multi-method fusion" (Netflix/vmaf). It is a
  **full-reference** metric (needs reference + distorted) and uses **model files**; ffmpeg's `libvmaf`
  auto-locates a default model (`vmaf_v0.6.1` on this host — §4/§9). **[S]** https://github.com/Netflix/vmaf .
- **SSIM / PSNR / XPSNR** are all available as ffmpeg filters on this host **[M]** (`ffmpeg -filters`
  lists `ssim`, `psnr`, `xpsnr`, `libvmaf`). **[M] The metric choice changes the verdict** on our own
  encodes: SSIM ranked SVT-AV1 preset 10 *worse* than H.264 while VMAF ranked it *better* (§4) — so SSIM
  alone is not a safe proxy for perceptual quality on text/edge screen content. **[S]** the VMAF design
  rationale (multi-method fusion vs single-metric SSIM) is the source of that divergence:
  https://github.com/Netflix/vmaf .
