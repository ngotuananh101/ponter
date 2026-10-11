# Hardware-Encode + H.265/HEVC Spike (2026-10-11)

Status: **investigation only — non-gating, no commitments.** This spike extends and partially updates
**P3** (`docs/spikes/2026-10-07-p3-hardware-codec.md`, ADR-25), which was a *desk* investigation written
before the desktop product existed. This spike adds a **measured** host result and an **H.265** verdict.
It gates nothing and commits nothing; adoption remains uncommitted.

> Follow-up: the same-day [quality / speed optimization spike](2026-10-11-quality-speed-optimization.md)
> surveys all image-quality and speed levers (including AV1) and supersedes the encode-side survey here
> where they overlap.

**Scope:** (1) measure whether a hardware H.264 encoder is viable on the spike host; (2) settle whether
HEVC/H.265 is a near-term lever. Every external claim carries a source URL that was opened; every
`file:line` was re-derived against the current tree.

---

## 0. Host (measured)

| Item | Value | How measured |
|---|---|---|
| CPU | Intel Core i5-14400, 16 CPUs / 10 cores / 2 threads-per-core | `nproc` = 16 |
| GPU | Intel **Raptor Lake-S UHD Graphics** `[8086:a782]` (iGPU only; no dGPU) | `lspci -nn -s 00:02.0` |
| Kernel | `7.2.8-200.fc44.x86_64` (i915 driver) | `uname -a`, `lspci -v` |
| VA-API | libva **2.23.0** | `ffmpeg -loglevel debug` |
| Media driver | `libva-intel-media-driver` (**iHD**) **26.2.4** | `rpm -qa`; `vaQueryVendorString` |
| MediaSDK | `intel-mediasdk` 23.2.2; `intel-gmmlib` 22.10.2 | `rpm -qa` |
| ffmpeg | **8.1.3**, built `--enable-vaapi --enable-libvpl --enable-libopenh264` | `ffmpeg -version`, `-buildconf` |
| Render node | `/dev/dri/renderD128` present, `crw-rw-rw-` | `ls -la /dev/dri/` |
| GuC/HuC FW | `tgl_guc_70.bin` 70.49.4, `tgl_huc.bin` 7.9.3 — loaded & authenticated | `journalctl -k -b` |

**Caveat:** single host, Intel iGPU only. Recorded; not generalisable.

> Observation (not a proven root cause): `journalctl -k` shows the i915 driver loading **Tiger Lake**
> GuC/HuC firmware (`tgl_guc_70` / `tgl_huc`) for a **Raptor Lake-S** part, and the media driver reports
> the platform as a generic Gen graphics. This is a plausible contributor to the missing encode
> profiles, but it was not isolated (no `sudo`, no kernel-module-param changes possible).

---

## 1. Host blocker — no H.264/HEVC/AV1 hardware encode profile on this host

The requested comparison (software H.264 vs `h264_vaapi`/`h264_qsv`/`hevc_vaapi`/`hevc_qsv`)
**cannot be produced on this host**: all four hardware encoders fail at initialisation. Established three
independent ways.

**(a) Raw libva probe** — a small C program linked against the system `libva.so.2` / `libva-drm.so.2`
that enumerates `vaQueryConfigProfiles` + per-profile `vaQueryConfigEntrypoints`:

```
$ ./vaprobe /dev/dri/renderD128
VA-API 1.23 on /dev/dri/renderD128
vendor: Intel iHD driver for Intel(R) Gen Graphics - 26.2.4 ()

entrypoints for VAProfileNone: st=0 count=2
  [10] VideoProc
  [12] ?

profiles advertised: st=0 count=8
  profile -1 (None): VideoProc; ?;
  profile  0 (MPEG2Simple): VLD (decode);
  profile  1 (MPEG2Main): VLD (decode);
  profile 12 (JPEGBaseline): VLD (decode); EncPicture;
  profile 19 (VP9Profile0): VLD (decode); EncSliceLP (low-power encode);
  profile 20 (VP9Profile1): VLD (decode); EncSliceLP (low-power encode);
  profile 21 (VP9Profile2): VLD (decode); EncSliceLP (low-power encode);
  profile 22 (VP9Profile3): VLD (decode); EncSliceLP (low-power encode);
```

→ Encode entrypoints exist only for JPEG (`EncPicture`) and VP9 (`EncSliceLP`). There is **no**
`VAProfileH264*`, **no** `VAProfileHEVCMain`, **no** `VAProfileAV1Profile0` advertised. Identical output
with the sandbox on and off, across repeated runs.

**(b) ffmpeg VAAPI** — `h264_vaapi`:

```
$ ffmpeg -f lavfi -i testsrc2=size=640x480:rate=30 -frames:v 2 \
    -vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null -
[h264_vaapi] Compatible profile VAProfileH264High (7) is not supported by driver.
[h264_vaapi] Compatible profile VAProfileH264Main (6) is not supported by driver.
[h264_vaapi] Compatible profile VAProfileH264ConstrainedBaseline (13) is not supported by driver.
[h264_vaapi] No usable encoding profile found.
```

Same for `hevc_vaapi` (`VAProfileHEVCMain (17)`) and `av1_vaapi` (`VAProfileAV1Profile0 (32)`).

**(c) ffmpeg QSV** (a second, independent frontend) — `h264_qsv`/`hevc_qsv`/`av1_qsv` fail with
"some encoding parameters are not supported by the QSV runtime", while **`vp9_qsv` and `mjpeg_qsv`
succeed**. So VAAPI and QSV agree.

**What is NOT broken** (rules out a dead device / permissions / sandbox):
- `vaInitialize` returns success; `vaQueryVendorString` = "Intel iHD driver … 26.2.4".
- VAAPI upload/download round-trip works: `-vf 'format=nv12,hwupload,hwdownload,format=nv12'` encodes 2 frames, no error.
- `vp9_vaapi` encodes 300 frames to a real file (§2).
- GuC/HuC firmware loaded & authenticated.
- Result is byte-identical sandboxed vs unsandboxed.
- Legacy `LIBVA_DRIVER_NAME=i965` no longer initialises (i965 removed from modern libva) — not a fallback.

**Conclusion:** the driver's *encode* capability on this box is limited to **VP9 + JPEG**. This is a
**host/driver profile-set limitation**, not an ffmpeg-flag problem — varying `-profile:v`, `-rc_mode`,
`-global_quality`, `-low_power`, `-init_hw_device`, `hwupload=extra_hw_frames=`, and `LIBVA_DRIVER_NAME`
did not change the profile enumeration (the profile list is returned by the driver *before* any encoder
options apply). Re-running the H.264 HW-vs-SW measurement requires a host whose driver exposes
`VAProfileH264*` with `EncSlice`/`EncSliceLP`.

---

## 2. Measurement table (VP9 proxy)

Fixed content `-f lavfi -i testsrc2=size=WxH:rate=30`, **300 frames (10 s @ 30 fps)**, target
**4 Mbit/s**. Timing via `/usr/bin/time -v` (wall clock + %CPU); 3 repeats each (range shown).

**720p30 (1280×720, 300 frames)**

| Encoder | Kind | Wall (s) | CPU % | Result |
|---|---|---|---|---|
| `libopenh264` (baseline) | software H.264 | 0.63–0.64 | 128–130% | OK 3975 kbit/s |
| `h264_vaapi` | HW H.264 | — | — | **no encode profile** |
| `h264_qsv` | HW H.264 | — | — | **not supported by QSV runtime** |
| `hevc_vaapi` | HW HEVC | — | — | **no encode profile** |
| `hevc_qsv` | HW HEVC | — | — | **not supported by QSV runtime** |
| `vp9_vaapi` | HW VP9 (only HW encode present) | 1.42–1.43 | 63–67% | OK 4041 kbit/s |
| `libvpx-vp9` (default) | software VP9 | 18.05 | 222% | OK 2781 kbit/s |
| `libvpx-vp9 -deadline realtime -cpu-used 8` | software VP9 (fast) | 0.86 | 247% | OK |

**1080p30 (1920×1080, 300 frames)**

| Encoder | Kind | Wall (s) | CPU % | Result |
|---|---|---|---|---|
| `libopenh264` (baseline) | software H.264 | 1.21–1.22 | 131–132% | OK 3934 kbit/s |
| `h264_vaapi` | HW H.264 | — | — | no encode profile |
| `h264_qsv` | HW H.264 | — | — | QSV unsupported |
| `hevc_vaapi` | HW HEVC | — | — | no encode profile |
| `hevc_qsv` | HW HEVC | — | — | QSV unsupported |
| `vp9_vaapi` | HW VP9 | 2.14–2.15 | 88–97% | OK 4069 kbit/s |
| `libvpx-vp9` (default) | software VP9 | 32.23 | 206% | OK |
| `libvpx-vp9 -deadline realtime -cpu-used 8` | software VP9 (fast) | 1.44 | 262% | OK |

**Exact commands** (720p shown; 1080p identical with `size=1920x1080`) — reproducible without the raw
artifacts:

```bash
# software baseline
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -c:v libopenh264 -b:v 4M -f null -
# HW H.264 VAAPI  (FAILS on this host)
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' -c:v h264_vaapi -b:v 4M -f null -
# HW H.264 QSV  (FAILS on this host)
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -c:v h264_qsv -b:v 4M -f null -
# HW HEVC VAAPI / QSV  (FAIL on this host) — same shape, -c:v hevc_vaapi / -c:v hevc_qsv
# HW VP9 VAAPI  (WORKS)
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -vaapi_device /dev/dri/renderD128 -vf 'format=nv12,hwupload' -c:v vp9_vaapi -b:v 4M -f null -
# software VP9 (default and realtime)
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -c:v libvpx-vp9 -b:v 4M -f null -
/usr/bin/time -v ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 300 \
    -c:v libvpx-vp9 -b:v 4M -deadline realtime -cpu-used 8 -f null -
```

**Framing**

| Encoder | Framing | Evidence |
|---|---|---|
| `libopenh264` (current pipeline) | **Annex-B** (`00 00 00 01` start codes) | `hexdump -C` first bytes `00 00 00 01 67 42 c0 1f …` (SPS `67 42 c0 1f` = baseline `42001f`, exactly the wire `profile-level-id`). |
| `vp9_vaapi` | **IVF container** (VP9 has no Annex-B concept) | first bytes `44 4b 49 46` = `"DKIF"` (IVF magic). |

The H.264/HEVC hardware encoders could not be inspected for framing because they never open. (VAAPI
H.264/HEVC *would* emit Annex-B via the ffmpeg vaapi encoder — an expectation, not a measurement here.)

**IDR / keyframe control**
- **openh264 (today):** no PLI path; recovery is time-based — `intra_frame_period(60)` ≈ IDR every 2 s
  (`apps/agent/src/desktop.rs:1628`), plus IDR-on-content-change from `ScreenContentRealTime`. There is
  **no PLI/keyframe-request handling** in the agent (`grep -rnwE 'PLI|PictureLoss|request_keyframe'
  apps/agent/src/` → no matches).
- **VAAPI (VP9, measured):** exposes `-idr_interval`; verified working (`-c:v vp9_vaapi -idr_interval 15`
  encodes cleanly). The *on-demand* (PLI-triggered) form remains a follow-on spike (P3 §2.3); this host
  can only demonstrate the periodic form.

**Is the win encode-time, CPU headroom, or neither?** Honest answer given the blocker: H.264 hardware
encode is **unmeasurable here**; the only available HW encoder is VP9, which is not representative (a
more expensive codec). What it shows:
- **CPU headroom, not encode time.** `vp9_vaapi` uses **~half the CPU** of software (63–67% vs 128–130%
  at 720p; 88–97% vs 131–132% at 1080p), but its **wall time is higher** (1.42 s vs 0.63 s at 720p;
  2.14 s vs 1.21 s at 1080p) because VP9 is intrinsically slower per frame. So the HW win is CPU offload,
  not per-frame latency — consistent with P3 §2.4's prediction.
- The software H.264 baseline is already sub-frame at both resolutions on this CPU (0.63 s / 300 frames
  = **2.1 ms/frame** at 720p; **4.0 ms/frame** at 1080p), so encode is not obviously the glass-to-glass
  bottleneck at these sizes.
- **Caveat (proxy):** this is VP9, not H.264. The real H.264-HW comparison is **unmeasured on this host**.
- **Caveat (software baseline fidelity):** the `libopenh264` figure is ffmpeg's `libopenh264` wrapper
  with default options — close to but **not identical** to the agent's Rust config
  (`UsageType::ScreenContentRealTime`, `Complexity::Low`, `intra_frame_period(60)`,
  `RateControlMode::Bitrate`; `apps/agent/src/desktop.rs:1616–1628`). Treat it as representative, not
  bit-exact.

---

## 3. Decode — browser-native, nothing to do

- The viewer is **browser-native**: `apps/web/src/components/desktop/DesktopView.vue` attaches the
  WebRTC track straight to `<video srcObject>` (`srcObject` set at `:188–191`, element at `:356`). The
  **browser** decodes H.264, and modern browsers HW-decode it when a GPU is present. There is **no Rust
  decoder** in the agent/desktop stack.
- **WebCodecs is already spiked and DESCoped — FAIL (ADR-48)** (`docs/spikes/2026-10-07-p2-webcodecs-probe.md`;
  recorded at `docs/ARCHITECTURE.md:1014`): Chrome 154's `VideoDecoder` produced no output frames for
  synthetic AVC.
- Corroborating detail from this host: even our own VAAPI **H.264 decode** fell back to software because
  the driver advertises no H.264 decode profile either — irrelevant to the product, since the decode
  that matters happens in the **browser's** decoder.

**Conclusion:** no decode work is justified unless/until a **native desktop viewer** is added (there is
none today). If decode ever matters, the lever is that native viewer, not the current stack.

---

## 4. H.265 / HEVC research

### 4.1 RTP — RFC 7798 (HEVC) vs RFC 6184 (H.264)

- **RFC 7798** — *RTP Payload Format for High Efficiency Video Coding (HEVC)* — https://www.rfc-editor.org/rfc/rfc7798
- **RFC 6184** — *RTP Payload Format for H.264 Video* — https://www.rfc-editor.org/rfc/rfc6184

| Aspect | H.264 (RFC 6184) | HEVC (RFC 7798) |
|---|---|---|
| NAL header size | **1 byte** — "A NAL unit consists of a one-byte header and the payload byte string." (§1.3) | **2 bytes** — "HEVC uses a two-byte NAL unit header." (§1.1.4; fields `F|Type|LayerId|TID`) |
| Aggregation packet type | STAP-A = **24** (Table 1; also STAP-B, MTAP) | AP = **48** (§4.4.2) |
| Fragmentation unit type | FU-A = **28** (§5.8; also FU-B) | FU = **49** (§4.4.3) |
| Extra shape | — | **PACI = 50** (§4.4.4; payload-content-info header extension) |

Same packet *concepts* (single NAL / aggregation / fragmentation), but a different NAL header width and
different type codes, plus HEVC adds the PACI form. An HEVC depacketizer is not a drop-in for H.264's.

### 4.2 webrtc-rs 0.21 already registers HEVC + AV1 — the stack is not the blocker

The agent depends on **`rtc = "0.21"` directly** (`apps/agent/Cargo.toml:31`; the comment at `:27–30`
says it is direct so it resolves to the same 0.21 line `webrtc` uses). `apps/agent/src/rtc.rs:413–415`
populates the `MediaEngine` with `register_default_codecs()`. In `rtc-0.21.0`
(`~/.cargo/registry/src/index.crates.io-*/rtc-0.21.0/`):

- `MediaEngine::register_default_codecs()` (`src/peer_connection/configuration/media_engine.rs:350`)
  registers, with RTX for each: VP8 (PT 96), VP9 (PT 98, 100), H.264 (PT 102/127/125/108/127/123),
  **AV1 (PT 41)** (`mime_type: MIME_TYPE_AV1`, `sdp_fmtp_line: "profile-id=0"`, `:543–551`), and
  **HEVC (PT 126)** (`mime_type: MIME_TYPE_HEVC`, `:556–561`).
- `MIME_TYPE_HEVC = "video/H265"` (`:114`); `MIME_TYPE_AV1 = "video/AV1"` (`:142`).
- `RTCRtpCodec::payloader()` (`src/rtp_transceiver/rtp_sender/rtp_codec.rs:94–99`) maps `MIME_TYPE_HEVC`
  → `rtp::codec::h265::HevcPayloader`, and (`:114–115`) `MIME_TYPE_AV1` → `rtp::codec::av1::Av1Payloader`.
- `rtc-rtp-0.21.0/src/codec/h265/mod.rs` is a **full RFC 7798 implementation** — **1125 lines**, module
  doc cites RFC 7798, defines the two-byte NAL header and the AP `48` / FU `49` / PACI `50` packet
  shapes (`:307–311`), with a **13-test** suite (`h265_test.rs`, 984 lines). Not a stub.

**Therefore the webrtc-rs / RTP side is not the blocker for HEVC — nor, technically, for AV1
(`Av1Payloader` exists).** Both are already registered in the media engine.

> **Correction (2026-10-11).** P3 (`docs/spikes/2026-10-07-p3-hardware-codec.md`) states in §0 (line 46)
> and §2.2 (line 167–168) that `register_default_codecs` "registers H.264 and VP8 only" and that "**AV1
> is not registered**". That is **wrong** for the dependency the agent uses: `rtc 0.21` registers
> **H.264, VP8, VP9, AV1 (PT 41) and HEVC (PT 126)**, each with RTX (crate source above). The P3 doc has
> been corrected in place; see this section for the evidence.

### 4.3 Browser support + patent licensing — the real gate

#### 4.3.1 Measured: Chrome 154 does not offer HEVC in WebRTC (this host)

Rather than only citing caniuse, the **actual** `RTCRtpSender/Receiver.getCapabilities('video')` was
probed in the **Chrome 154.0.8037.97** on this host (headless, `--dump-dom`):

```
UA: HeadlessChrome/154.0.0.0
SEND (13 codecs): VP8, rtx, H264×6, AV1, VP9×2, red, ulpfec
RECV (19 codecs): VP8, rtx, VP9×4, H264×8, AV1×2, red, ulpfec, flexfec-03
```

**`video/H265` is absent from BOTH the send and the receive capability lists** (`grep -oiE 'h265|hevc'`
over the DOM → no match), while **AV1 and VP9 are present**. So on this Chrome an HEVC sender path would
negotiate nothing — the browser never puts H265 in its SDP. (Bonus corroboration of the current wire
choice: Chrome's H.264 fmtp offers exactly `profile-level-id=42001f`, matching the agent's openh264
baseline output.)

**Decode layer (second, independent probe).** `navigator.mediaCapabilities.decodingInfo()` for 1080p30 in
the same Chrome 154:

```
hevc  hvc1.1.6.L93.B0 -> supported=false smooth=false powerEfficient=false
hevc  hev1.1.6.L93.B0 -> supported=false smooth=false powerEfficient=false
h264  avc1.42E01F     -> supported=true
av1   av01.0.04M.08   -> supported=true
vp9   vp09.00.10.08   -> supported=true
```

Chrome 154 on this host reports HEVC as **not decodable at all** (both `hvc1` and `hev1`), while
H.264/AV1/VP9 are supported. HEVC is absent from Chrome at **both** the WebRTC negotiation layer *and*
the decode layer. Re-running with `--enable-features=PlatformHEVCDecoderSupport` still returned
`supported=false` (the flag alone does not enable it here — and this host's iHD driver exposes no HEVC
decode profile anyway, §1).

#### 4.3.2 Sourced: per-browser support + patent licensing

**Per-browser HEVC support (playback/decode)** — [caniuse.com/hevc](https://caniuse.com/hevc):

| Browser | HEVC status (caniuse) | Note |
|---|---|---|
| **Safari** (desktop + iOS) | full | the only mainstream engine with unconditional HEVC |
| **Chrome** | partial | hardware-decode only; **not in WebRTC** (see below) |
| **Edge** | partial | inherits Chrome; Windows HEVC needs the Microsoft Store "HEVC Video Extensions" |
| **Firefox** | not supported (recent partial) | Mozilla historically refused H.265 for licensing reasons |

caniuse's own summary states HEVC is *"hard for browsers to universally support because it is complex
and expensive to license"* and *"competes with AV1 which … provides a free license"*
([caniuse.com/hevc](https://caniuse.com/hevc)). Wikipedia's HEVC article likewise records that the
licensing fees are a main reason adoption has been low on the web, and that large tech companies formed
the Alliance for Open Media to ship the royalty-free AV1 alternative
([en.wikipedia.org/wiki/High-Efficiency_Video_Coding](https://en.wikipedia.org/wiki/High-Efficiency_Video_Coding)).

**WebRTC-specific support** (the layer that matters here):

- **MDN, WebRTC codecs** — the *mandatory* WebRTC video codecs are **VP8** and **H.264 Constrained
  Baseline**; among optional codecs MDN lists **HEVC/H.265 as "Chrome 136+ only"** — no Firefox, no
  Safari-WebRTC entry ([MDN: WebRTC codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs)).
  This is the strongest *positive* public claim for HEVC-in-WebRTC, and it is Chrome-only.
- **Wikipedia, WebRTC#Codec support** — lists H.264 CB, VP8, VP9, AV1 — **H.265/HEVC is not mentioned
  at all** ([en.wikipedia.org/wiki/WebRTC#Codec_support](https://en.wikipedia.org/wiki/WebRTC#Codec_support)).

> **Reconciling the "Chrome 136+" claim with the measurement.** MDN says Chrome 136+ carries
> HEVC-in-WebRTC, yet the **Chrome 154.0.8037.97 measured here offers no `video/H265` in
> `RTCRtpSender/Receiver.getCapabilities` and reports HEVC `supported=false`** (§4.3.1). Even the most
> favourable public claim does not reproduce on this host: HEVC negotiation in Chrome is at best
> platform/hardware-gated (a Windows hardware-decode path), not a general capability. A sender cannot
> rely on it.

**Patent licensing (the structural reason browsers resist):**

- **Via LA** (formerly **MPEG LA**) operates an HEVC pool; MDN names Via LA as the HEVC licensing
  administrator — *"Licensing is managed by Via LA"* ([MDN: video codecs](https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_codecs)).
  Pool page: [via-la.com/hevc](https://www.via-la.com/hevc/) (as of 2025-12-15 this HEVC/VVC program is
  managed by Video Codec Licensing LLC, a subsidiary of Access Advance).
- **Access Advance — HEVC Advance** pool licenses patents essential to the HEVC standard on FRAND terms
  — *"The license terms and conditions are Fair, Reasonable, and Non-Discriminatory"*
  ([accessadvance.com/licensing/hevc](https://accessadvance.com/licensing/hevc/)); a Patent Profile
  License effective 1 July 2026 sets the royalty structure
  ([royalty rates](https://accessadvance.com/hevc-advance-patent-pool-detailed-royalty-rates/)).
- **Velos Media** — a third HEVC pool ([en.wikipedia.org/wiki/High-Efficiency_Video_Coding](https://en.wikipedia.org/wiki/High-Efficiency_Video_Coding)).
  (The vendor host could not be verified during this spike — noted, not asserted.)

Three independent pools over one standard is royalty-stacking: a WebRTC product shipping HEVC must reason
about all three, whereas H.264's pools are older and AV1 is royalty-free. That structural cost — not any
technical deficiency — is the reason the browsers above have kept HEVC out of the WebRTC
mandatory/optional sets.

### 4.4 Encode cost vs H.264 on this hardware

Unmeasurable here: the H.264 and HEVC hardware encoders both fail to open (§1), so there is no same-host
`hevc_*` vs `h264_*` comparison. Any compression-gain-vs-cost statement must be re-measured on a host
with the HEVC encode profile exposed.

### 4.5 Verdict

**BLOCKED for Ponter today — and the block is measured, not assumed.**

- **Not blocked by our stack:** webrtc-rs 0.21 already ships and registers an HEVC (and AV1) RTP payload
  with a real RFC 7798 payloader (§4.2).
- **Blocked by the browser:** measured here, **Chrome 154 offers `video/H265` in neither send nor receive
  `RTCRtpCapabilities`** (§4.3.1). If the receiving browser will not negotiate H265, an HEVC sender path
  is dead on arrival regardless of our stack.
- **Licensing reinforces it** (§4.3.2): HEVC's multiple patent pools vs H.264 are why browsers have been
  slow to adopt it.
- **Single most decisive reason:** *the receiving browser does not offer/negotiate HEVC in WebRTC* —
  measured directly on Chrome 154; the browser, not our RTP layer, is the binding constraint.

**Verdict wording: BLOCKED (browser gate), with the stack already HEVC-ready.** Contrast with AV1: AV1
*is* offered by Chrome (measured: present in both send and receive lists) and *is* registered in
`rtc 0.21` — so if any modern codec is a near-term lever, it is **AV1, not HEVC**. HEVC should be
re-evaluated only if/when target browsers add H265 to their WebRTC capability set.

---

## 5. Corrections to prior art

1. **P3 (`docs/spikes/2026-10-07-p3-hardware-codec.md`), §0 and §2.2** — the claim that
   `register_default_codecs` "registers H.264 and VP8 only" / "AV1 is not registered" is **incorrect**
   for `rtc 0.21`: it registers H.264, VP8, VP9, **AV1 (PT 41)** and **HEVC (PT 126)**, each with RTX
   (crate source, §4.2). The P3 doc has been corrected in place with a dated note.
2. **P3 §2.4 (latency)** — its "CPU headroom, not latency" prediction is *consistent* with the one HW
   encoder measurable here (VP9: ~half CPU, higher wall time), but P3's numbers were expectations; this
   spike still cannot confirm them for H.264 on this host.

---

## 6. Reproduction artifacts (all under `/tmp/hw-encode-spike/`, ephemeral)

| Artifact | What it is |
|---|---|
| `vaprobe.c` / `vaprobe` | Raw libva probe (enumerates `vaQueryConfigProfiles` + per-profile entrypoints). |
| `vaprobe.out` | Its output (the 8-profile list, §1). |
| `measure.sh` | The measurement harness (all encoders, both resolutions). |
| `results/` | Per-run `*.time` (`/usr/bin/time -v`) and `*.log` (ffmpeg output) for every encoder/resolution, plus 3× repeat files. |
| `results/out_*.h264` / `out_*.ivf` | Real encoded files used for size/bitrate/framing. |
| `rtc-caps.html` / `rtc-caps-dom.html` | Chrome `RTCRtpSender/Receiver.getCapabilities('video')` probe + DOM dump. |
| `mc-probe*.html` | Chrome `MediaCapabilities.decodingInfo` probe (plain + `PlatformHEVCDecoderSupport`). |
| `vaapi-debug.log`, `libva-trace.log.*` | ffmpeg `-loglevel debug` and `LIBVA_TRACE` captures. |

All commands were run on the host of §0 on 2026-10-11. No figure is estimated or carried over. The
commands are inlined in §2 so the measurement is reproducible without these `/tmp` files.
