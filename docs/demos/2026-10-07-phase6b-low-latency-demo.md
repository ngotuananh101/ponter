# Phase 6b — Low-latency Interaction Demo Walkthrough

**Date:** 2026-10-07
**Machine:** Fedora Linux (X11), loopback WebRTC + Xvfb
**Agent:** `apps/agent` built debug via `cargo build --manifest-path apps/agent/Cargo.toml`; web at `apps/web`
**Branch HEAD:** `feat/phase6b-low-latency`

## Status

**Not observed manually.** This walkthrough is a *runnable script*: each step is the command(s) you would run and the observation you would make. The figures in the "Measured latency" section are **cited** from the cross-language E2E suite (`packages/webrtc-core/test/e2e/desktop.e2e.test.ts`), the P1 Playwright spike (`docs/spikes/2026-10-07-p1-playwright-smoke.md`), the P2 WebCodecs probe (`docs/spikes/2026-10-07-p2-webcodecs-probe.md`), and the P3 hardware-codec investigation (`docs/spikes/2026-10-07-p3-hardware-codec.md`). This doc is docs-only and reconciles the architecture; it is not a re-measurement.

The design basis is `docs/superpowers/specs/2026-10-07-phase6b-low-latency-design.md` (ADR-45 through ADR-49).

## Security posture

- **Two gates, both required for injection (ADR-42):** (A) `--allow-input` / `AGENT_ALLOW_INPUT`, set by the operator locally — a remote peer cannot open it; and (B) peer identity verified at admission by `verify_offer_identity` (ADR-41). A missing one of the two drops every input frame. The agent default is `false` (input closed), preserving the Week 9 gate-closed contract verbatim.
- **ADR-41 admission gate closes C1 for every mode:** `verify_offer_identity` is hoisted to run before the mode dispatch in `run_one_session`, so Terminal, Desktop, Files, and unknown-capability offers all fail closed. A proof-less offer bails with **no answer of any kind** — not even `approved: false` — so an unverifiable peer learns nothing.
- **Plaintext cursor posture (ADR-45):** `desktop-cursor` is agent→browser metadata of the same class as `desktop-sources`/`desktop-stats` (plaintext today). The video track is plain SRTP (no new encryption scope on cursor frames). Inbound `desktop-input` remains E2EE-encrypted when negotiated. The cursor reveals position — which the viewer already sees in the video itself (or would, on macOS) — so no confidentiality is newly exposed. See `docs/superpowers/specs/2026-10-07-phase6b-low-latency-design.md §4.2 (ADR-45 plaintext rationale)`.
- **ADR-43 rate cap still active:** a flooding peer is capped at 120 Hz after decryption + Gate A, before injection; the session survives the burst.

---

## Steps

### 1. Start the agent under Xvfb, with or without `--allow-input`

```bash
# Build the agent (debug), then run under a virtual framebuffer.
cargo build --manifest-path apps/agent/Cargo.toml --locked

# Xvfb provides the headless X server the cursor poller and input injection run against.
# (Start it once per session: Xvfb :99 -screen 0 1280x1024x24 &)
DISPLAY=:99 ./apps/agent/target/debug/ponter-agent \
  --agent-id agent-myhost-01 \
  --server ws://localhost:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "" \
  --desktop-source test \
  --allow-input   # omit for the view-only / gate-closed path
```

**Expected observation:**
- Agent log line `starting ponter-agent` (INFO); on connect, INFO `connected to the signaling server`.
- With `--allow-input`: `desktop-sources` reports `inputEnabled: true` (Gate A open).
- Without `--allow-input` (default): `desktop-sources` reports `inputEnabled: false`; a forwarded `desktop-input` frame is dropped and the agent logs `dropping desktop-input`.

### 2. Open a desktop session from the web UI and observe the cursor overlay + playout tuning

Navigate to the local web client (e.g. `http://localhost:3000`), connect, and open a **Desktop** session. The `DesktopView.vue` component renders the cursor overlay canvas over the `<video>` element (letterbox-aligned via `contentBox()`).

**Expected observations:**

- **Remote cursor canvas overlay (ADR-45):** `desktop-cursor` frames stream on the `control` data channel. The overlay canvas draws the streamed position (or the local pointer when controlling).
- **Local echo while controlling (`--allow-input` + verified peer):** the operator's own pointer is drawn directly on the canvas (`cursor: none` on the `<video>` element to avoid a double cursor); the remote cursor converges to it. This is zero-latency local echo — no extrapolation.
- **View-only extrapolation (gate closed):** the canvas draws the streamed position, **linearly extrapolated** from the last two samples for at most 100 ms, then holds. The extrapolation is a pure function (unit-tested) and is suppressed while controlling.
- **Playout tuning applied (ADR-46):** under the hood, `apps/desktop-core/src/client.ts` applies the receiver seam once the remote video track resolves:
  - Chrome path: `receiver.jitterBufferTarget = 100` (ms)
  - Firefox path: `receiver.playoutDelayHint = 0.1` (seconds)
  - Default is 100 ms; `playoutDelayMs = null` disables tuning (receiver left untouched).
  - The P1 smoke proved both knobs are writable on the app's real `RTCRtpReceiver` via `evaluate`.

### 3. Run the E2E test suite

These are the cross-language tests that pin ADR-45 (cursor stream), ADR-47 (latency instrumentation + echo), and the view-only / gate-closed invariants. They run against the freshly built agent binary.

```bash
# Build once more to be sure the binary is fresh, then run the cross-language suite.
cargo build --manifest-path apps/agent/Cargo.toml --locked
DISPLAY=:99 pnpm --filter @ponter/webrtc-core exec vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts
```

**Tests relevant to 6b (all in the `cross-language desktop E2E` describe block, skipped on non-Linux):**

| Test title | What it pins |
|---|---|
| `streams cursor position and echoes the applied input sequence under Xvfb` | ADR-45 full round-trip: inject a pointer-move with a browser-assigned `seq` → cursor frames arrive, position ≈ injected point (±2 px tolerance), `lastInputSeq` echoes the sent `seq`. |
| `keeps streaming cursor frames in view-only mode while dropping input` | ADR-45 view-only path: injection is dropped **and** cursor frames still stream; session unharmed after the drop. |
| `publishes rolling frame timing samples in desktop-stats (ADR-47)` | ADR-47 tier 1: `frameSamples` present and sane; `captureMsP50` and `encodeMsP50` ≥ 0; seqs strictly increase; capture timestamps non-decreasing. |
| `measures the cursor input-echo round-trip and prints a summary (ADR-47)` | ADR-47 tier 3: `[6b echo] n=... min=...ms median=...ms max=...ms` is printed; every echo ≤ 5000 ms. |

---

## Measured latency (ADR-47)

> **Clock caveat (same-host only):** the glass-to-glass protocol below decodes a test-pattern bar position whose frame counter `n` is stamped by the agent's capture epoch and sampled by the browser canvas — both on the same host, so `Date.now()` domains align. On a real remote network the two clocks do not align; real-network numbers are recorded as a **manual documented procedure** (§ below), not an automatable same-host number.

### Capture → encode (agent components)

Cited from `desktop-stats` rolling samples (E2E test `publishes rolling frame timing samples in desktop-stats (ADR-47)`):

`captureMsP50 ≈ 0–1 ms, encodeMsP50 ≈ 11–15 ms`

Format: `captureMsP50 = <p50 capture ms>; encodeMsP50 = <p50 encode ms>` emitted every 1 s as a rolling ring on `desktop-stats`. The E2E asserts the fields exist and are sane (seqs strictly increase, timestamps non-decreasing); the literal values are the agent's own measurements under Xvfb + the `test` source, asserted by E2E test `publishes rolling frame timing samples in desktop-stats (ADR-47)`.

### Input-echo round-trip (browser → agent inject → cursor read-back → browser)

Cited from the E2E test `measures the cursor input-echo round-trip and prints a summary (ADR-47)`:

```
[6b echo] n=9 min=80ms median=80ms max=81ms
```

(12 moves injected at 80 ms intervals, 9 echoes captured within the 1-second sampling window under a 60 Hz cursor poller, every echo <= 5000 ms, median 80 ms matching the dispatch cadence.)

Format: `[6b echo] n=<count> min=<ms> median=<ms> max=<ms>` — printed by the test to stdout. The test injects 12 distinct `seq` values (one per 80 ms), waits for the echo on `desktop-cursor` frames (`lastInputSeq`), and computes `echoMs = receiveMs − sentAtMs(seq)`. Every echo is asserted ≤ 5000 ms.

### Glass-to-glass (same-host, test-pattern decode protocol)

The test-pattern bar position encodes frame counter `n` (`bar_x = (n * 8) % 1280`, period 160). The same-host protocol:

1. Open a desktop session and let the stream stabilize.
2. Set the playout target to 100 ms / 50 ms / 0 ms (via the `DesktopClientOptions` seam or the browser devtools `evaluate` knob from P1).
3. A real browser (headless Chrome via Playwright, P1-adopted) draws the presented frame to a `<canvas>`, decodes `n` from the bar pixel position.
4. The browser waits (≤ ~1 s) for a `desktop-stats` frame whose `frameSamples` ring covers `n`, reads `captureEpochMs(n)`.
5. Reports `g2g = canvasSampleMs − captureEpochMs(n)` for each target.

Expected output format:

With loopback WebRTC (same host) and `jitterBufferTarget = 100 ms`, glass-to-glass totals ~115 ms (100 ms playout target + ~15 ms encode/pipeline latency from the capture→encode measurement above). At 50 ms playout target, it scales down accordingly (~65 ms). These are same-host figures: the agent's `captureEpochMs` (stamped at capture) and the browser decode timestamp share the same clock domain (`Date.now()`), so the g2g subtraction is internally consistent. On a real remote network the two clocks do not align — see the manual real-network procedure below, which carries the same-host clock caveat.

i.e. one `[6b g2g @<delay>ms] n=<count> min=<ms> median=<ms> max=<ms>` line per playout target (100 / 50 / 0 ms).

### Real-network procedure (manual, documented)

When the browser is not on the same host as the agent, the same-host clock alignment no longer holds. The documented real-network procedure:

1. Run the agent and browser on separate hosts over a real WebRTC path (no loopback).
2. Use a high-contrast test-pattern frame (e.g. the `test` source's bar position at a known `n`) held on screen for ≥ 2 s.
3. Record, on the viewer host, the wall-clock time T1 at which the pattern pixel appears (manual timestamp via a frame-grabbing tool, or `requestVideoFrameCallback` present-time when available).
4. On the agent host, read the `captureEpochMs` for that same frame `n` from `desktop-stats` (the ring includes `captureEpochMs`).
5. Compute `g2g_real = T1 − captureEpochMs(n)` with the **same-host clock caveat** noted (NTP drift between hosts applies; record it).
6. Repeat at playout targets 100 / 50 / 0 ms.

This is a manual procedure; it is recorded here so the numbers always carry the clock-alignment qualifier.

---

## Probes outcomes (L0)

| Probe | ADR | Outcome | Evidence |
|---|---|---|---|
| P1 — Playwright headless WebRTC smoke | ADR-49 | **ADOPT** | `docs/spikes/2026-10-07-p1-playwright-smoke.md`; 6/6 green, connect < 300 ms, playout knobs observable via `evaluate`. |
| P2 — WebCodecs H.264 decode | ADR-48 | **FAIL + DESCOPE** | `docs/spikes/2026-10-07-p2-webcodecs-probe.md`; Annex-B vs AVCC format gap, synthetic decode produced 0 frames. Descope branch kept: `<video>` + playout tuning (`jitterBufferTarget` / `playoutDelayHint`). Both outcomes satisfy spec §8 gate 4. |
| P3 — Hardware codec investigation | ADR-25 | **Investigation only, non-gating** | `docs/spikes/2026-10-07-p3-hardware-codec.md`; recommends Linux VAAPI H.264 next; VAAPI `va` + `AVProfileH264Main` / `VAEntrypointEncSlice` match the Annex-B wire; NVENC/QSV/AMF surveyed; AV1 blocked by `webrtc 0.21` not shipping AV1 RTP producers. Adoption uncommitted. |

## Cursor platform matrix (honest)

| Platform | Position | Shape | Mechanism | Status |
|---|---|---|---|---|
| X11 (incl. Xvfb) | Yes | Yes | `query_pointer` + XFixes `get_cursor_image` (dirty-checked by cursor `serial`) | **E2E-proven** — pinned by `streams cursor position and echoes the applied input sequence under Xvfb` |
| Windows | Yes | Yes | `GetCursorPos` + `DrawIconEx`→DIB→RGBA→PNG | **Best-effort, compile-checked only** (runtime unverified — same posture as WGC capture) |
| macOS | No stream needed | No | Cursor already in frames (`setCapturesCursor(true)`); agent sets `cursorInFrame: true`, runs no poller | **Unit-pinned, runtime unverified** — `cursorInFrame: true` normalization pinned by unit tests; no claim of Mac runtime testing |
| Wayland | Position | Shape | Portal/compositor-dependent | **Not committed** — recorded limitation (ADR-27 precedent); no cursor handling in the recorder |

**Plaintext cursor posture:** `desktop-cursor` rides the same plaintext agent→browser control channel as `desktop-sources`/`desktop-stats`. It reveals cursor position — which the viewer already sees in the video itself (or would, on macOS, where the cursor is in-frame). No new encryption scope is introduced. REJECT any implication that cursor frames are E2EE-encrypted.

## What this demonstrates end-to-end

| ADR | Mechanism | E2E test title (in `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`) |
|---|---|---|
| ADR-45 | Cursor is a first-class streamed layer; position+shape separate from video; local echo when controlling | `streams cursor position and echoes the applied input sequence under Xvfb` |
| ADR-45 | Cursor layer is independent of the input gate — view-only still streams cursor | `keeps streaming cursor frames in view-only mode while dropping input` |
| ADR-47 | Four-tier latency instrumentation: agent capture/encode rolling ring on `desktop-stats` | `publishes rolling frame timing samples in desktop-stats (ADR-47)` |
| ADR-47 | Input-echo round-trip: browser stamps `seq → sentAtMs`, agent echoes `lastInputSeq`, browser computes round-trip | `measures the cursor input-echo round-trip and prints a summary (ADR-47)` |
| ADR-46 | Playout tuning seam (`jitterBufferTarget` / `playoutDelayHint`) applied at track resolution | (P1-adopted smoke asserts the knobs are writable; E2E werift peer is unit-tested against the seam) |
| ADR-49 | Browser-real features verified via Playwright spike | `docs/spikes/2026-10-07-p1-playwright-smoke.md` (ADOPT, 6/6 green) |

All four cursor/stats tests live in the `cross-language desktop E2E` block (`describe.skipIf(!isLinux)`), pinned against a freshly built agent binary under `DISPLAY=:99`.

## Non-goals

- **Terminal latency work** — the terminal path's `delta_ms` (ADR-44) is the 6a input-delta; 6b does not touch terminal encoding or shell latency.
- **Hardware codec adoption (ADR-25)** — P3 is an investigation finding only; VAAPI/H.264 on Linux is the next candidate, adoption uncommitted and not in this phase.
- **Windows cursor beyond compile-checked** — best-effort position+shape; runtime verification deferred with the rest of Windows runtime capture (WGC precedent). No claim of Windows cursor testing.
- **Wayland commitment** — the portal/compositor-dependent path is recorded as a limitation; no cursor handling in the recorder.
- **E2EE on cursor frames** — `desktop-cursor` is plaintext by the confirmed default (same as `desktop-sources`/`desktop-stats`). Inbound `desktop-input` remains E2EE when negotiated; cursor frames introduce no new encryption scope.
- **WebCodecs render path** — P2 failed + descoped; `<video>` + tuned playout is the shipped render path for 6b.
- **In-band video timestamps (SEI)** — deliberately not added; real-network glass-to-glass is the manual procedure above.
