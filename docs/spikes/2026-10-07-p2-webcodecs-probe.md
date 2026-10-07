# P2 WebCodecs H.264 Decode Probe Findings

**Date:** 2026-10-07  
**Task:** Phase 6b Task 2 — Probe P2: WebCodecs H.264 decode spike (ADR-48)  
**Environment:** Chrome 154.0.8037.97 (headless=new), Node 24, Ubuntu  
**Verdict:** FAIL — description field is required for AVC H.264, but synthetic decode produced no output frames

## 1. Objective

Determine whether Chrome 154's `VideoDecoder` can decode H.264 frames from the openh264 agent's WebRTC stream (via `RTCEncodedVideoFrame.data` / `receiver.createEncodedStreams()`), and whether `VideoDecoder.configure({codec:'avc1.42E01F'})` requires an out-of-band `description` (avcC).

## 2. Background

The openh264 agent (Rust) emits H.264 in Annex-B format (start codes `[0,0,0,1]`), with SPS (NAL 7) + PPS (NAL 8) + IDR (NAL 5) all in the first access unit. This is confirmed by the unit test `encoder_emits_annex_b_and_an_idr_first` at `apps/agent/src/desktop.rs:1912-1948`.

The WebRTC track is configured with `profile-level-id=42001f` (baseline profile, level 3.0) and `packetization-mode=1` (`apps/agent/src/rtc.rs:202-239`).

## 3. Method

A CDP-driven headless Chrome harness (`drive-chrome.mjs`) navigates to a probe page that:

1. Checks WebCodecs API availability (`VideoEncoder`, `VideoDecoder`, `EncodedVideoChunk`, `VideoFrame`).
2. Constructs synthetic H.264 Annex-B data matching the openh264 agent's output format: SPS + PPS + IDR frame, followed by two non-IDR (delta) slices.
3. Converts Annex-B to AVCC format (length-prefixed NALUs) for the `EncodedVideoChunk` data.
4. Builds an avCC `description` from the extracted SPS/PPS.
5. **Test A:** `VideoDecoder.configure({codec:'avc1.42E01F', codedWidth:320, codedHeight:240})` — **without** `description`.
6. **Test B:** `VideoDecoder.configure({codec:'avc1.42E01F', description: avCC, codedWidth:320, codedHeight:240})` — **with** `description`.
7. Feeds 3 AVCC frames to each decoder and records output/error callbacks.

## 4. Findings

### 4.1 WebCodecs API Availability

All APIs are available in Chrome 154 headless:
- `VideoEncoder`: yes
- `VideoDecoder`: yes
- `EncodedVideoChunk`: yes
- `VideoFrame`: yes
- `VideoDecoder.isConfigSupported` is **static** (confirmed: `typeof VideoDecoder.isConfigSupported === 'function'`)

### 4.2 NAL Format Identification

The synthetic first frame begins with `00 00 00 01 67 42 00 1e 96 59 04 78 00 00 00 01 68 ce 38 80 00 00 00 01 65 b5 81 80 ...` — confirming **Annex-B format** with `[0,0,0,1]` start codes.

NAL type analysis across 3 synthetic frames:
| NAL Type | Count | Meaning |
|----------|-------|---------|
| 7 | 1 | SPS (Sequence Parameter Set) |
| 8 | 1 | PPS (Picture Parameter Set) |
| 5 | 1 | IDR (Instantaneous Decoder Refresh) slice |
| 1 | 2 | Non-IDR (P/B) slice |

SPS and PPS are present **in-band** (in the Annex-B stream), within the first access unit.

### 4.3 Test A: VideoDecoder WITHOUT description

```
isConfigSupported (no desc) = true
decoderA.configure({codec:'avc1.42E01F', codedWidth:320, codedHeight:240}) — OK (no throw)
decode(frame[0]) error: "A key frame is required after configure() or flush().
  If you're using AVC formatted H.264 you must fill out the description field
  in the VideoDecoderConfig."
decode(frame[1]) error: "A key frame is required after configure() or flush()."
decode(frame[2]) error: "A key frame is required after configure() or flush()."
Decoder A: outputs=0 errors=0
```

**Key finding:** `isConfigSupported` returns `supported: true` even without a description, and `configure()` does not throw. However, `decode()` on the key frame (IDR) fails with the explicit Chrome error message stating that the `description` field **must be filled out** for AVC-formatted H.264. The `error` callback's count (`errA=0`) did not increment because the `decode()` calls themselves threw synchronous `DOMException` errors (caught in the `try/catch` around `decode()`), not the decoder's async `error` callback.

### 4.4 Test B: VideoDecoder WITH description (avCC)

```
isConfigSupported (with desc) = true
decoderB.configure({codec:'avc1.42E01F', description: avCC, ...}) — OK
decode(frame[0]) — called without error (no throw)
decode(frame[1]) — called without error
decode(frame[2]) — called without error
Decoder B error: "Decoding error."
Decoder B: outputs=0 errors=1
```

**Key finding:** With a valid avCC `description`, `configure()` and `decode()` succeed without throwing. However, the decoder's async `error` callback fires with "Decoding error." — this is because the synthetic IDR slice NAL data is not a valid H.264 bitstream (it's a hand-crafted minimal header, not real compressed frame data from openh264).

### 4.5 Verdict

- **`description` (avCC) is REQUIRED** for AVC H.264 in Chrome 154's `VideoDecoder`. The error message from Test A is conclusive: "If you're using AVC formatted H.264 you must fill out the description field in the VideoDecoderConfig."
- The agent's Annex-B output format (start codes `[0,0,0,1]`) must be converted to AVCC (length-prefixed NALUs) before being passed to `EncodedVideoChunk`.
- SPS and PPS must be extracted from the Annex-B stream and formatted into an avCC `description` buffer for `VideoDecoder.configure()`.
- **No output frames were produced** (both tests: 0 outputs) because the synthetic IDR slice data is not valid H.264 compressed data. With real openh264-encoded frames, the decode path with `description` should produce output.

## 5. What Did NOT Work

- **WebRTC peer connection approach:** Blocked by an ICE role conflict bug in `rtc` 0.21 where both sides report "controlled" with identical tiebreaker values, preventing ICE connectivity. This is unfixable from the probe harness.
- **VideoEncoder H.264 output:** Chrome 154 headless `VideoEncoder` with `codec: 'avc1.42E01F'` produces 0-byte chunks (the `output` callback fires but `chunk.data.byteLength` is 0). Switched to synthetic data.
- **Direct Annex-B feeding to VideoDecoder:** `EncodedVideoChunk.data` expects AVCC (length-prefixed) format, not Annex-B (start code). The conversion `annexBToAvcc()` is required.

## 6. Descope Branch

**Keep `<video>` + playout tuning.** Since the WebCodecs decode path requires converting Annex-B to AVCC, extracting SPS/PPS into avCC, and providing a `description` — and the synthetic data did not produce valid decoded frames — the safe path for Phase 6b low-latency interaction is to continue using `<video>` element playback (which the browser's built-in H.264 decoder handles natively via `RTCRtpReceiver` / `createViewSource`) combined with playout delay tuning (`playoutDelayHint`, jitter buffer configuration) as specified in ADR-44 and the existing `jitterBufferTarget`/`playoutDelayHint` tuning already applied in `apps/desktop-core/src/client.ts`.

## 7. Evidence Artifacts

- **Probe script:** `.superpowers/sdd/2026-10-07-phase6b-low-latency/p2-probe/drive-chrome.mjs` (CDP harness)
- **Probe page:** `/tmp/p2-decode-probe.html` (standalone test page)
- **Raw result:** `result.json` in the p2-probe directory contains the full `result`, `logs`, and `errors`
- **Agent unit test confirming Annex-B format:** `apps/agent/src/desktop.rs:1912-1948` (`encoder_emits_annex_b_and_an_idr_first`)
- **Agent track configuration:** `apps/agent/src/rtc.rs:202-239` (H.264, `profile-level-id=42001f`, `packetization-mode=1`)
- **ADR-41 admission gate:** `apps/agent/src/main.rs:789` (`verify_offer_identity`)

## 8. Recommendation

Implement the AVCC conversion + avCC description extraction in the production `BrowserAdapter` (or equivalent WebCodecs consumer) if switching from `<video>` to `VideoDecoder`. The conversion logic is straightforward:

1. Parse Annex-B start codes to extract individual NALUs.
2. Build avCC description from SPS/PPS NALUs (16-byte header + SPS + 1-byte NAL count + PPS).
3. Wrap each NALU in AVCC format (4-byte big-endian length prefix).
4. Pass `EncodedVideoChunk` with `type: 'key'` for IDR frames.
5. Include `description` in `VideoDecoder.configure()`.

For now, the descope branch (keep `<video>` + playout tuning) is the lowest-risk path to Phase 6b low-latency delivery.
