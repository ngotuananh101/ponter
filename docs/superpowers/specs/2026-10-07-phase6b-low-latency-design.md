# Phase 6b: Low-latency Interaction — Design Spec

- **Date:** 2026-10-07
- **Status:** Framework approved by owner (2026-10-07; 4 decisions locked, 3 defaults confirmed), pending written review
- **Baseline:** `main` @ `48edac1` (PR #49 merged)
- **Schedule:** Phase 6's second half. 6a Interactivity shipped 2026-10-07; this is **6b Latency**
- **Related:** Phase 6a spec `docs/superpowers/specs/2026-10-06-phase6a-interactive-desktop-design.md` (§4.3 defers the latency pipeline here; ADR-44 baseline); Week 7 spec §1.2 ("WebCodecs rendering … a later quality concern"); Week 8 spec §ADR-25 (hardware-codec spike, carried here); Week 9 spec ADR-30 (letterbox mapping); `docs/ARCHITECTURE.md` §8 (Phase 6) and §11 (performance table)

---

## 1. Why Phase 6b, and what "done" means here

6a made the desktop **interactive** (two-gate input, identity admission, rate cap, input-latency baseline
of 0–1 ms loopback). It deliberately shipped **no** latency work: the render path is a plain
`<video>` + `srcObject`, there is no jitter/playout control, no cursor layer, no WebCodecs, and no
way to observe video-path latency anywhere. 6b is that pipeline.

Recon at `48edac1` changes the shape of the problem in three ways:

1. **The agent is already tuned.** The encoder runs `ScreenContentRealTime` / `Complexity::Low` /
   `RateControlMode::Bitrate` with in-place bitrate retargeting and GCC congestion control. The
   remaining agent-side wins are small (keyframe-on-demand, frame timing observability) — the big
   wins are **browser-side playout** and **instrumentation**.
2. **Cursor is missing, not slow.** X11 and Windows capture paths do **not** include the cursor in
   frames; macOS does. So the controller sees only its own local cursor, and a view-only watcher
   sees no cursor at all. "Cursor prediction" for the controller is mostly free once the layer
   exists (local echo); the real work is producing, streaming, and rendering the cursor.
3. **Nothing about the browser can be verified by the current E2E harness.** The cross-language
   suite drives a Node-side werift peer; decode, playout, and WebCodecs only exist in a real
   browser. Verification for browser-real features needs its own answer (P1, ADR-49).

**Done means:**

1. A viewer sees the remote cursor: position streamed on change (60 Hz poll, send-on-change), shape
   on change, `visible:false` when the cursor leaves the streamed source; the controller gets a
   zero-latency local echo; view-only mode extrapolates at most 100 ms. Proven on X11 by E2E.
2. The browser playout pipeline is tuned for interactivity (`jitterBufferTarget` /
   `playoutDelayHint`, feature-detected, default ON, configurable), with before/after numbers
   recorded.
3. Latency is observable in components (agent capture→encode; browser present-time health) and as an
   **input-echo round-trip** (browser → agent inject → cursor read-back → browser); glass-to-glass
   same-host is measured by a documented method (ADR-47); real-network numbers are recorded in the
   demo doc.
4. The WebCodecs render path ships **only if** probe P2 passes (ADR-48); otherwise the descope
   branch executes and `<video>` + tuned playout remains — a valid outcome of this spec.
5. The ADR-25 hardware-codec spike runs as a timeboxed investigation and produces a written finding;
   it gates nothing.
6. Docs reconcile: ARCHITECTURE §8/§11, demo doc with measured numbers, cursor platform matrix
   recorded honestly.
7. CI 11/11 green; Sonar new-code duplication clean.

**Owner decisions locked (2026-10-07):** (1) cursor is a **full layer** — position + shape, overlay
+ prediction; (2) browser-real features are verified by a **timeboxed Playwright spike** (adopt the
smoke test on pass; manual + unit fakes documented on fail); (3) **one spec, layered execution**;
(4) latency targets are **set from measured numbers**, not promised upfront.

**Working defaults confirmed with the framework:** cursor frames ride **plaintext** like every other
agent→browser control frame (video is plain SRTP today; no new encryption scope); playout tuning
defaults **ON**; **no hard glass-to-glass target** is committed in this spec.

## 2. Current state, re-verified against the tree at `48edac1`

| # | Fact | Evidence |
|---|------|----------|
| 1 | The render path is `<video>` + `srcObject` only; **zero** WebCodecs / `playoutDelayHint` / `jitterBufferTarget` / `requestVideoFrameCallback` anywhere | `DesktopView.vue:22-42` (attach), `:189-198` (`<video>`); repo-wide grep finds none of the APIs |
| 2 | The peer abstraction exposes `getStats()` but nothing latency-related uses it | `packages/webrtc-core/src/types.ts:33`; `connection.ts:267` |
| 3 | **X11 capture has no cursor**: the recorder is plain `GetImage`; **Windows WGC explicitly disables it** (`SetIsCursorCaptureEnabled(false)`); **macOS enables it** (`setCapturesCursor(true)`); Wayland portal is compositor-dependent (no cursor handling in the recorder) | xcap 0.9.8 `linux/xorg_video_recorder.rs` (no cursor refs), `windows/wgc.rs:165`, `windows/wgc_video_recorder.rs:106`, `macos/impl_video_recorder.rs:451`; agent uses `xcap::VideoRecorder` (`desktop.rs:284-291`) |
| 4 | The encoder is already tuned: `ScreenContentRealTime`, `Complexity::Low`, `RateControlMode::Bitrate`, `intra_frame_period(60)`, in-place retarget (spike-verified), bitrate clamp 250 k–20 M | `desktop.rs:1200-1222`, `apply_bitrate` ~`:1250` |
| 5 | openh264 exposes `ForceIntraFrame` (raw `force_intra_frame(bIDR)` + safe wrapper) — the missing half of keyframe-on-demand | openh264 0.9.8 `encoder.rs:74`, `:1047` |
| 6 | webrtc-rs 0.21 delivers inbound PLI to **stats only** by default; the app receives it only via an interceptor marking `Attribute::DeliverToApplication`, then `TrackLocalEvent::OnRtcpPacket`. **The agent has no PLI handling today.** | `rtc-0.21.0/.../interceptor.rs:120`; `webrtc-0.21.0/src/media_stream/track_local/mod.rs:59-63`; `examples/rtcp-processing`; agent grep for PLI/keyframe: empty |
| 7 | `xcap::Frame` carries **no timestamp**; capture→encode timing must be stamped at the agent | xcap `video_recorder.rs:6-10` |
| 8 | The input wire has **no `seq`**; the browser coalesces pointer-moves at 60 Hz | `packages/shared/src/types/desktop.ts` (`DesktopInput`); `packages/desktop-core/src/client.ts:388-407` |
| 9 | Agent→browser control frames are **plaintext** (sources, stats, e2ee-ack); only inbound `desktop-input` is E2EE-encrypted when negotiated | `main.rs` control task ~`:2084-2215`; `decrypt_desktop_input` `:2313` |
| 10 | **Xvfb supports XFIXES** (opcode 138, verified empirically); `x11rb 0.13.2` is already in the dependency tree (via enigo) with an `xfixes` feature; `get_cursor_image` exists; enigo's `Mouse::location()` exists (X11 `query_pointer`) | local probe on this machine; `x11rb/src/protocol/xfixes.rs:100`; enigo 0.6.1 `lib.rs:382`, `linux/x11rb.rs:478` |
| 11 | The `image` crate (0.25.10, **png** feature) is already in the tree via xcap — PNG-encoding the cursor shape needs no new dependency | `apps/agent/Cargo.lock:1443`; xcap `Cargo.toml` (`image` with `png`) |
| 12 | `desktop-stats` carries no timing: `{width, height, fps, targetBitrateBps, status?}` | `packages/shared/src/types/desktop.ts` |
| 13 | The test-pattern source encodes its frame counter in the image: `bar_x = (n * 8) % w` (1280 → 160-frame period) — a same-host glass-to-glass measurement can decode `n` from pixels | `desktop.rs:170-183` |
| 14 | There is **no browser automation** in the repo: vitest only; the E2E suite drives a Node werift peer | `packages/webrtc-core/vitest.e2e.config.ts`; `test/e2e/harness.ts` |
| 15 | `jitterBufferTarget` takes ms (≤ 4000; `RangeError` beyond); `playoutDelayHint` is the older non-standard knob; browser support must be **feature-detected**, no version promises | MDN; both absent from the repo |

## 3. Architecture decisions (ADR-45 to ADR-49)

### ADR-45: The cursor is a first-class streamed layer — position, shape, local echo

**Producer matrix (honest, per platform):**

| Platform | Position | Shape | Mechanism |
|----------|----------|-------|-----------|
| X11 (incl. Xvfb) | Yes — **E2E-proven** | Yes | `query_pointer` + XFixes `get_cursor_image` (dirty-checked by cursor `serial`) |
| Windows | Yes — best-effort, compile-checked only | Yes — best-effort, compile-checked only | `GetCursorPos` + `DrawIconEx`→DIB→RGBA→PNG (runtime unverified — same posture as WGC capture) |
| macOS | No stream needed | No | The cursor is **already in the frames** (`setCapturesCursor(true)`); the agent sets `cursorInFrame: true` and runs no poller |
| Wayland | Not committed | Not committed | Portal/compositor-dependent; recorded limitation (ADR-27 precedent) |

- **Poller:** new `apps/agent/src/cursor.rs` (non-musl, desktop-only). Polls at 60 Hz, **sends only on
  change** (position delta or shape serial). Position is mapped root→streamed-source coordinates
  using the current source geometry (same `current_source` state the input path uses); a cursor
  outside the streamed monitor sends `visible:false` (clamped coordinates). The poller runs
  **regardless of the input gate** — a view-only watcher is exactly who needs it.
- **Wire — new frame `desktop-cursor`** on the control channel (plaintext, per the confirmed
  default):

  ```
  { x: number, y: number,          // normalized 0..1 within the streamed source
    visible: boolean,
    seq: number,                   // agent-side monotonic sample counter
    lastInputSeq?: number,         // echo: the last applied desktop-input seq (ADR-47)
    shape?: { png: string,         // base64 RGBA PNG, only when the shape changed
              hotspotX: number, hotspotY: number, serial: number } }
  ```

  Shape PNG is capped (skip the shape field when > 32 KiB); position still flows. Shape changes are
  rare (serial-keyed), so the cap is a safety valve, not a normal path.
- **Input echo key — `seq`:** the pointer variants of `DesktopInput` gain an optional `seq`
  (browser-assigned monotonic session counter). The agent records the last applied seq and echoes it
  in every subsequent cursor frame. This is also the ADR-47 round-trip measurement's clock.
- **Browser overlay:** a canvas positioned over the video (`DesktopView.vue` — outside `ui/`), using
  the same letterbox geometry as the input mapping. `desktop-input.ts` gains `contentBox()` (shared
  by the existing `toNormalized` and the new inverse `toClient()`), so both directions use one
  formula. Rendering rules:
  - **Controlling** (`inputOn`): draw at the **local pointer position** when it is over the video
    (zero-latency local echo — the remote cursor converges to it); `cursor: none` on the video.
  - **View-only**: draw the streamed position, **linearly extrapolated** from the last two samples
    for at most 100 ms, then hold (pure function, unit-tested; prevents visible stepping at 60 Hz
    poll under network delay).
  - **Shape:** draw the streamed PNG at its hotspot when present; otherwise a built-in arrow.
  - Hidden when `cursorInFrame` is true (macOS) or `visible:false`.
- **`desktop-sources` gains `cursorInFrame: boolean`** (additive; pre-6b agent ⇒ normalize `false`).
- **No new dependency**: `x11rb` (already in tree) gains a direct dependency with the `xfixes`
  feature; the `image` crate (already in tree) is used for PNG.
- **Recorded limitation (carried from Week 9's `current_source` note):** cursor mapping uses the
  current source geometry; after a source switch the mapping follows the new source, and the
  controller's coordinate space does the same via the existing input path — the two stay consistent.

### ADR-46: Playout tuning through an optional media seam; default ON, configurable

- **Mechanism:** `DesktopClientOptions.playoutDelayMs?: number | null` (default **100**, `null`
  disables). Applied once the remote track resolves, through a new optional seam on the connection
  abstraction — `getVideoReceiver?(): unknown` on `RTCPeerConnectionLike` (BrowserAdapter returns the
  video `RTCRtpReceiver`; werift/mocks return nothing ⇒ no-op, E2E unaffected).
- **Feature detection:** prefer `receiver.jitterBufferTarget = ms` (ms, ≤ 4000) when present; else
  `receiver.playoutDelayHint = ms / 1000` (seconds) when present; else leave the browser default and
  report `false`. No version promises — detection only.
- **Why default ON:** "Speed First" is a stated product principle; the knob is what makes the
  interactive path interactive. `null` exists for hostile-jitter networks.
- **Why 100 ms as the shipped default:** conservative first step — it is strictly better than an
  adaptive default under good conditions and safe under mediocre ones. The demo protocol measures
  glass-to-glass at **100 / 50 / 0 ms** and the owner pins the final default from that table (a
  one-line change; ADR-47 §measurement).
- **Where the value is applied:** `desktop-core` (DOM-free) at track resolution — it already owns
  the track lifecycle. The WebCodecs path (ADR-48, web-side) reuses the same seam.

### ADR-47: Latency is measured in components plus an input-echo round-trip; glass-to-glass is same-host pattern decoding

Four layers, cheapest-to-most-honest:

1. **Agent components — capture→encode.** `RawFrame` gains a `seq` (test source: its counter;
   screen/window sources: a monotonic counter). The stream loop records per encoded frame
   `(seq, captureEpochMs, encodeMs)` into a 32-sample ring and publishes rolling p50s plus the ring
   on `desktop-stats` (additive, optional fields: `frameSeq`, `captureMsP50`, `encodeMsP50`,
   `frameSamples[]`). Fully automated: Rust unit tests pin the rolling math; E2E asserts the fields
   appear and are sane.
2. **Browser present-time health (light).** `requestVideoFrameCallback` (feature-detected) tracks
   presented-frame count and inter-present gaps; the footer shows a compact summary when available.
   Pure computation, unit-tested; no wire change.
3. **Input-echo round-trip (browser → agent inject → cursor read-back → browser).** Requires ADR-45:
   the browser stamps `seq → sentAtMs` (bounded map), the agent echoes `lastInputSeq` on cursor
   frames, the browser computes `echoMs = receiveMs − sentAtMs(seq)`. This is the interactive
   control loop's honest number and it works **in the werift E2E harness too** (the harness plays the
   browser role). E2E asserts the echo arrives with the right seq and prints a summary
   (`[6b echo] n=<count> min=<ms> median=<ms> max=<ms>`); DesktopView surfaces the latest `echoMs` in the footer.
4. **Glass-to-glass, same-host (Playwright or manual, P1-dependent).** The test-pattern bar position
   encodes frame counter `n` (`bar_x = (n*8) % 1280`, 160-frame period). A real browser draws the
   presented frame to a canvas, decodes `n` from pixels, waits (≤ ~1 s) for a `desktop-stats` whose
   `frameSamples` ring covers `n`, and reports `g2g = canvasSampleMs − captureEpochMs(n)`. Clock
   requirement: **same host** (Date.now domains align; documented). The protocol runs at playout
   targets 100/50/0 ms and the numbers land in the demo doc. If P1 fails, the identical protocol is
   a documented manual step.
- **What is deliberately NOT claimed:** no in-band timestamps are added to the video stream (no SEI
  hacks); real-network glass-to-glass is not automatable here and is recorded as a manual procedure
  with the same pattern method (clocks noted).
- **ADR-44 continuity:** the 6a input delta (agent-side) stays; `echoMs` extends it across the full
  loop, and both are printed in the same demo-doc section.

### ADR-48: The WebCodecs render path is spike-gated (P2) with an automatic fallback

- **Shape:** receiver-side `RTCRtpScriptTransform` in a dedicated worker → `VideoDecoder` → draw
  `VideoFrame` to the video's canvas (transferred `OffscreenCanvas` when available). The `<video>`
  element is **not** given `srcObject` while this path is active (no double decode).
- **Gating probe P2 (timebox: half a day):** verify (a) `RTCRtpScriptTransform` + `VideoDecoder` exist in the
  target Chrome; (b) the H.264 format of `RTCEncodedVideoFrame.data` the agent's stream produces
  (Annex-B vs AVCC; whether `description` is needed for `configure()`); (c) decode produces frames
  for the openh264 stream without renegotiation. **Pass** ⇒ implement with feature-detection +
  **automatic fallback** to `<video>` on any failure (absence, `configure` error, decode error
  budget). **Fail** ⇒ execute the descope branch: keep `<video>`, record the finding (what failed,
  what was tried) in the demo doc, and the spec is still satisfied (§8 gate 4 accepts both).
- **Feature detection is runtime, never a version check** — same posture as ADR-46.
- **Fallback safety:** on fallback the code must attach `srcObject` and tear the worker down
  cleanly; on close, the worker and decoder are closed (`close()`), pinned by unit tests on the
  controller with fakes.
- **Scope guard:** the WebCodecs path changes only rendering; input, cursor, and control frames are
  untouched by it.

### ADR-49: Browser-real features are verified by a timeboxed Playwright spike (P1); manual + fakes otherwise

- **P1 (timebox: one day):** stand up headless Chrome against a **fresh agent binary** under Xvfb
  (pattern: the existing E2E harness), open a desktop session, and prove: connect, first track,
  `desktop-sources` visible, one injected input echo, the applied playout knob
  (`jitterBufferTarget` / `playoutDelayHint`) observable via `evaluate`. Decide adopt-vs-document on
  the evidence (CI reliability first).
- **Adopt (pass):** one smoke spec (its location is decided in the plan) runs in CI
  with the same discipline as the E2E job (fresh binary, exclusive port, Xvfb) — and it carries the
  ADR-47 glass-to-glass protocol.
- **Document (fail):** the demo doc records what blocked it (launch/network/flake), the smoke
  assertions collapse into unit tests over fakes, and glass-to-glass becomes the manual procedure.
- **Why a spike, not a commitment:** the repo has zero browser automation; a full CI browser
  framework is its own project, and the ADR-23/25 precedent (spike, then commit only what passed)
  is the house style.

### L0 probe P3 — the ADR-25 hardware-codec spike (non-gating, carried here)

Executed as a timeboxed investigation (half-day): AV1 / H.264 hardware **encode** availability on
the agent (library support, licensing, integration effort — candidates to be enumerated in the
finding, e.g. NVENC/VAAPI-class paths). Output: a short written finding in the demo doc (or a
dedicated note linked from it). It gates nothing and commits nothing; adoption remains a later
phase. This closes the Week 8 carry-forward in the same "investigate, don't promise" style.

## 4. Scope decisions

### 4.1 One spec, layered execution

Delivery layers (the plan's task order): **L0** probes P1/P2/P3 → **L1** measurement → **L2** playout
tuning → **L3** cursor layer → **L4** WebCodecs (gated by P2) → **L5** docs/demo/perf-table. Each
layer lands working software; a P2 fail at L0 removes L4 cleanly.

### 4.2 Plaintext posture for cursor frames (confirmed default)

`desktop-cursor` is agent→browser metadata of the same class as `desktop-sources`/`desktop-stats`
(plaintext today). It reveals cursor position — which the viewer already sees in the video itself
(or would, on macOS). No new encryption scope; the security note in the demo doc records this
posture.

### 4.3 No hard latency target (owner decision 4)

The demo doc records measured numbers (components, echo, g2g at 100/50/0 ms) and the owner pins the
playout default and any target **from those numbers**. The spec promises *measurable improvement
and observability*, not a figure.

### 4.4 Windows/macOS/Wayland posture

Windows: best-effort position+shape, compile-checked only (CI build), runtime unverified — the
established posture for Windows runtime (WGC capture precedent). macOS: cursor in-frame, no poller
(`cursorInFrame: true`), unit-pinned, runtime unverified. Wayland: not committed.

## 5. Wire, store, and UI changes (all additive)

| Layer | Change |
|-------|--------|
| Wire | **New** `desktop-cursor` frame (ADR-45 shape). `desktop-sources` gains `cursorInFrame: boolean`. `desktop-stats` gains optional `frameSeq`, `captureMsP50`, `encodeMsP50`, `frameSamples[]`. `DesktopInput` pointer variants gain optional `seq`. |
| Rust | `cursor.rs` (poller: X11 full, Windows best-effort, cfg-gated); `RawFrame.seq`; stream loop ring + p50s; `frame_desktop_cursor(...)` + updated `frame_desktop_sources(...)`/`frame_desktop_stats(...)`; control task gains the cursor event branch; `Cargo.toml`: direct `x11rb` dep (`xfixes`), direct `image` dep (png) — both already in the tree. |
| TS types | `packages/shared/src/types/desktop.ts`: `DesktopCursorPayload`, `DesktopShape`, stats/sources additions, `seq?` on pointer inputs. |
| Normalization | `packages/desktop-core/src/client.ts`: `desktop-cursor` dispatch; `cursorInFrame: payload?.cursorInFrame === true`; stats fields normalized (numbers default undefined, never NaN); `seq` counter on `sendInput`; `playoutDelayMs` applied via the seam at track resolution. |
| Seam | `RTCPeerConnectionLike.getVideoReceiver?(): unknown` (optional; BrowserAdapter implements, werift/mocks omit). |
| Store | `TabItem.desktopCursor?`, `desktopCursorInFrame?`, `desktopEchoMs?`; handlers record cursor frames, compute `echoMs` from the bounded `seq → sentAtMs` map. |
| UI | `DesktopView.vue`: overlay canvas over the video (letterbox-correct, `cursor:none` while controlling); footer shows `echoMs` and the present-time summary when available; overlay hidden when `cursorInFrame`/`!visible`. `desktop-input.ts`: `contentBox()` extracted, `toClient()` added. |
| WebCodecs (L4, P2-gated) | New web-side module: worker (transform + decoder + draw) + feature-detect + fallback controller; unit-tested with fakes. |

No server, DB, or signaling changes.

## 6. Testing strategy

**Rust unit:** cursor shape dirty-check by serial; PNG size cap skip; poller→frame mapping (incl.
`visible:false` outside source); ring + rolling p50 math; `RawFrame.seq` assignment; cursor/stat
frame builders (field-pinned both directions).

**E2E (cross-language, werift — the load-bearing proofs):**
- Cursor round-trip (gate open): inject a pointer-move with `seq` → cursor frames arrive, position
  ≈ injected point (±2 px tolerance), `lastInputSeq` echoes the sent seq.
- View-only (gate closed): injection is dropped **and** cursor frames still stream.
- Stats additions: `frameSamples` present and sane (seq monotonic, timestamps ordered).
- Echo summary printed (`[6b echo] n=<count> min=<ms> median=<ms> max=<ms>`).
- All existing suites stay green (non-regression).

**Web unit:** `contentBox`/`toClient` math (letterbox cases); extrapolation pure function (clamps at
100 ms, holds, no overshoot); present-gap computation; `echoMs` computation with out-of-order/unknown seq; normalization of
all new fields (missing ⇒ safe defaults); playout seam: absent receiver ⇒ no-op, present ⇒ set
(prefer `jitterBufferTarget`, else `playoutDelayHint`, else report false); WebCodecs controller:
fallback on absent API / configure error / decode error budget; worker teardown on close.

**Playwright smoke (P1-adopted only):** connect to a fresh agent under Xvfb; first track; sources
frame; one input echo round-trip; playout target observable; ADR-47 g2g protocol prints
`[6b g2g] n=<count> min=<ms> median=<ms> max=<ms>`. Budget: one spec, exclusive port, fresh binary — the E2E job's discipline.

**Manual (recorded in the demo doc):** real-network numbers (component + echo + g2g protocol with
clock note); cursor visual check (shape, hotspot, extrapolation smoothness); macOS `cursorInFrame`
honesty if a mac is available.

**Local verification includes `pnpm format:check`** (Week 12 carry-forward), `cargo fmt --check` /
`clippy -D warnings` / `cargo test --locked`, full Vitest suites, and the E2E job locally where the
change touches the agent.

**Sonar:** new code stays non-duplicated (parameterize tests, extract helpers — the Week 13/16
gotcha).

## 7. Risks and stop conditions

- **R1 — P1 (Playwright) fails or flakes in CI.** Mitigation: timebox; adopt only on evidence;
  the documented-manual branch is a first-class outcome (§ADR-49). Stop condition: two failed
  adoption attempts ⇒ document branch.
- **R2 — P2 format mismatch (Annex-B vs AVCC / missing description).** Mitigation: the probe answers
  it before implementation; the descope branch keeps `<video>` + tuning. Stop condition: no working
  `configure()` within the timebox ⇒ descope.
- **R3 — Xvfb cursor shape is degenerate (1×1 or absent).** Mitigation: E2E pins position + echo
  only; shape correctness is pinned at the unit level (dirty-check, PNG cap, wire shape) and by the
  manual visual check.
- **R4 — `jitterBufferTarget` unsupported in the user's browser.** Feature-detect + `playoutDelayHint`
  fallback + no-op; UI shows nothing false. Pinned by unit fakes.
- **R5 — Cursor echo pairing races (coalesced moves, unknown seq).** The echo map is bounded and
  miss-tolerant (unknown seq ⇒ skip, never crash); E2E uses distinct seqs.
- **R6 — Extrapolation overshoot.** Clamped to 100 ms and to the source bounds; pure function,
  unit-tested; disabled while controlling (local echo is authoritative).
- **R7 — WebCodecs double-decode / teardown leak.** Fallback detaches cleanly; worker/decoder
  closed on session end; unit-pinned with fakes.
- **R8 — Windows cursor path ships compile-checked only.** Accepted and recorded (posture
  precedent); runtime verification deferred with the rest of Windows runtime capture.

## 8. Definition of done — exit gates

1. **ADR-45:** X11 E2E proves position round-trip + seq echo + view-only streaming; unit tests pin
   shape dirty-check, PNG cap, `visible:false`, ring math; overlay renders per the rules and is
   hidden on `cursorInFrame`; `cursorInFrame` normalization pinned.
2. **ADR-46:** the seam applies the target on the browser path (unit + Playwright when adopted;
   manual otherwise); no-op elsewhere; default 100 ms; `null` disables; before/after numbers
   recorded.
3. **ADR-47:** stats fields flow (E2E); echo round-trip asserted and summarized (E2E); present-time
   health pinned by unit tests; g2g protocol run and recorded (Playwright or manual); demo doc
   carries all numbers at 100/50/0 ms.
4. **ADR-48:** P2 evidence recorded; pass ⇒ feature-detected path with automatic fallback + unit
   coverage + smoke assertion when P1 adopted (manual verification otherwise); fail ⇒ descope
   branch documented. Both outcomes satisfy this gate.
5. **ADR-49:** P1 evidence recorded; adopt ⇒ smoke in CI green; document ⇒ manual procedure in the
   demo doc.
6. **P3:** ADR-25 finding written (non-gating).
7. **Docs:** ARCHITECTURE §8 6b rows + §11 table updated with measured numbers; demo doc complete;
   cursor platform matrix honest.
8. **CI green (the existing 11 checks; plus the Playwright smoke when P1 is adopted); Sonar new-code
   duplication clean.**

## 9. Explicitly out of scope

- Terminal latency work; audio; clipboard; file-transfer latency.
- Hardware-codec **adoption** (the spike is a finding, not a commitment).
- Cursor **shape** on Windows beyond best-effort compile-checked code; any Wayland commitment.
- Multi-monitor cursor mapping beyond the streamed source's origin (cursor on another monitor ⇒
  `visible:false`); automatic mid-session source-follow.
- E2EE for agent→browser control frames (unchanged posture; cursor rides plaintext like sources and
  stats).
- Phase 5 deferred minors (T6b F6/F7/F8, T7 M1/M2/M3, T5-M6, `requiresApproval` dead export) —
  tracked separately.
- In-band video timestamps (SEI or similar); real-network automation.
