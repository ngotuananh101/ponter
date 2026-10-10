# Phase 3 Week 8 — Stream Quality & Source Selection Demo

**Date:** 2026-10-03
**Machine:** Fedora 44 Workstation, Wayland session
**Agent:** `ponter-agent --desktop-source screen` (branch `feat/phase3-week8-stream-quality` @ `6ce398f` — pre-rewrite SHA, not on main; content shipped in PR #27 squash `82fa821`), default profile 1080p30
**Recording:** none — manual rows not formally gated; see Status

## Status

> **Manual Chrome demo: NOT GATED — owner decision (2026-10-03).** The project
> owner will exercise the checklist below informally (or skip it) at their own
> convenience; it is not a gate for Week 8. **No recording artifact exists** and
> this document claims none. The rows that only a human at a real browser can
> observe (picker chrome, a source **switch** in the UI, the visible bitrate
> change, the 720p30 fallback note) are therefore **not marked observed** — see
> the Observed table.
>
> **What this document *does* carry, verified on this host:** the **automated**
> acceptance criteria (§10.2 #1–4, #6) are green — see the evidence table — and a
> real-screen cross-language probe (the same `PeerConnection` + werift offerer the
> E2E suite uses, but spawned with `--desktop-source screen`, i.e. the real
> capture stack, not the `test` pattern) established end to end that the real
> path enumerates a real monitor, streams it at 1080p30, opens the control
> channel, and echoes a manual bitrate — see "Real-screen evidence" below. That
> is the automated substrate of AC#5; the UI interaction itself is left to the
> owner, informally.

## Checklist (spec §8.4)

1. Fedora dev machine; build the agent; run `AGENT_CREDENTIAL=… ponter-agent --desktop-source screen` (default profile 1080p30).
2. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; log in; open a desktop tab.
3. Observe: the stream appears **immediately** (default = primary monitor) at 1080p30; the picker lists monitors/windows.
4. Switch to a second monitor or a window → stream changes with a brief blip; stats update.
5. Move the bitrate control → the stream visibly changes bitrate; `desktop-stats` reflects it.
6. On a weaker host (or by forcing `AGENT_DESKTOP_PROFILE=1080p30` under load), observe the documented **720p30 fallback** and the stats note.
7. Record glass-to-glass latency informally (target < 200 ms on LAN; not gated, as in Week 7's "viewable").

## Observed

| Check | Result |
|---|---|
| Stream appears immediately on the default (primary) source at 1080p30 | ✅ (real-screen probe: first `desktop-stats` = 1920×1080 @ 30fps / 6 Mbps) |
| Picker lists monitors/windows | ✅ (real-screen probe: `desktop-sources` carried `monitor:1235` "Meta-0", 1920×1080, `default: true`) |
| Switching source changes the stream (brief blip), stats update | — (manual; not gated — owner decision 2026-10-03) |
| Bitrate control changes the stream, `desktop-stats` reflects it | ✅ (real-screen probe: `desktop-bitrate` 3 Mbps → `desktop-stats` echo) |
| 720p30 fallback + `quality-downgraded` note on a host that cannot sustain 1080p30 | — (manual; not gated — owner decision 2026-10-03); N/A on this host (it sustains 1080p30) |
| LAN glass-to-glass latency observed < 200 ms (informal, not gated) | — (informal; not gated) |
| Video stays view-only (no input forwarded) | ✅ (`DesktopView.test.ts` asserts no pointer/keyboard forwarding); manual check informal |

## Real-screen evidence (automated, this host)

Run as a throwaway probe (not committed): the E2E `PeerConnection` + werift
offerer, spawned with `--desktop-source screen` against the real capture stack.

```
REAL_SOURCES=[{"id":"monitor:1235","kind":"monitor","name":"Meta-0","w":1920,"h":1080,"def":true}]
REAL_PACKETS=39 codec=video/h264
REAL_FIRST_STATS={"width":1920,"height":1080,"fps":30,"targetBitrateBps":6000000}
REAL_BITRATE_ECHO=ok
```

- The real enumeration produced exactly the primary monitor, flagged `default: true` — the same flag the browser auto-selects (ADR-22).
- The stream opened at the **1080p30 default** (1920×1080 @ 30fps, 6 Mbps) — the ADR-21/ADR-24 profile, on a real screen, not the test pattern.
- RTP flowed (39 packets in the window) on `video/h264`.
- A manual `desktop-bitrate` of 3 Mbps was applied and echoed back in a later `desktop-stats` — the same wire path the E2E suite pins.

The ignored live-display unit tests also pass on this host:
`enumerate_sources_lists_at_least_one_monitor` and
`screen_source_smoke_on_a_live_display` (real capture), plus
`source_for_rejects_an_id_absent_from_the_enumeration`.

## Notes

- **Task 3/4b IDR watch item — FIRED, resolved.** The plan assumed
  `ScreenContentRealTime` emits an IDR only on the first frame. Measured against
  `DesktopEncoder::new`: it emits an IDR on **every content change** (5 IDRs / 5
  changed frames), constant content emits none, and a geometry change gives 2
  IDRs across 3 frames. The PM ruled (2026-10-03) to keep the usage type and the
  fallback unchanged and to **pin the measured behavior** instead of the
  disproven assertion (`screen_content_real_time_emits_idrs_on_content_change`,
  commit `a2de973`, pre-rewrite; PR #27 squash `82fa821`). **What this changes for the demo:** a source switch's "brief
  blip" is a normal content-change IDR, not a distinct one-shot artifact — the
  switch is *at least as* self-healing as the plan assumed, since real desktop
  content keeps re-keying anyway.
- The E2E stream (the committed suite) is deterministic by construction: the
  agent is spawned with `--desktop-source test` (ADR-17), so no display, portal,
  or PipeWire session is involved in CI. The real-screen evidence above is a
  separate, uncommitted probe.
- AC#5's human-observable rows are **not gated** for Week 8 (owner decision,
  2026-10-03); the owner will exercise the checklist informally. Unlike Week 7,
  no attestation is recorded here — this document reports only what was actually
  verified on this host (the automated criteria + the real-screen probe) and
  marks the manual rows as not observed rather than closed.
- Auto-ABR and the ADR-25 hardware-codec spike are **not** acceptance criteria
  (spec §10.2); they are goals/annotations only.
