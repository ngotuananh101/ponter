# Phase 3 Week 9 — Desktop Input Forwarding Demo

**Date:** 2026-10-04
**Machine:** Fedora Linux, X11 session
**Agent:** `ponter-agent --desktop-source screen --allow-input` (build 19bf0b1)

## Status

**Not observed** (manual real-seat pass not run; relying on automated evidence: cross-language E2E gate tests and unit tests in PR #31 and PR #32).

## Checklist (spec §8.4)

| # | Check | Result |
|---|---|---|
| 1 | Input toggle appears only with `--allow-input` (`inputEnabled: true`) | ✅ (verified by unit & E2E specs) |
| 2 | Pointer over the video moves remote cursor to matching point | ✅ (verified by E2E injection under Xvfb) |
| 3 | Click, scroll, and type land correctly on remote screen | ✅ (verified by agent unit tests) |
| 4 | Footer shows `input on` / `input off` | ✅ (verified by web unit tests) |
| 5 | Wayland session: record outcome honestly | N/A / ⚠️ (silent no-op on GNOME Wayland as expected per ADR-27 spike finding) |
| 6 | Scaled display (`scaleFactor != 1`): pointer lands where clicked | N/A (watch item per spec §3.4) |
| 7 | Without `--allow-input`: no toggle, input does nothing (the gate) | ✅ (verified by gate-closed E2E test) |

## Observed

No manual real-seat pass was run. All results derive from the automated evidence in PR #31 (web/unit + E2E gate tests) and PR #32 (agent unit tests + musl build). The Wayland row is recorded as N/A/⚠️ per ADR-27: the default enigo build is a silent no-op on GNOME Wayland; no assertion is made that it "works" there. The scaled-display row is a watch item per spec §3.4 and was not exercised.

## Real-screen evidence

The gate-closed E2E log line (`dropping desktop-input`) and the gate-open `xdotool` result are captured in PR #31's E2E gate tests (Task 6, Steps 3-4). The `CountingInjector` fallback (§8.3) is available for CI without a display server but was not needed for the Week 9 evidence set.

## Notes

- `current_source` after a source swap: Week 9 maps against the source the stream started on; a source swap does NOT update this coordinate space in Week 9 (deferred per Task 4, Step 7b).
- `scaleFactor` watch item (spec §3.4): pointer mapping under non-1.0 scaling is unverified in Week 9; tracked as N/A.

## Scope notes

- **`text` frame:** wire-complete and agent-tested, but **no web producer in Week 9** — printable ASCII reaches the agent via `key` frames + `Key::Unicode` mapping. Typing is demoed through `key` frames; `text` is not exercised end-to-end. IME / composition is NOT implemented and NOT claimed.
- **AltRight / MetaRight collapse:** `map_code` in `apps/agent/src/input.rs` maps `AltRight` to `Key::Alt` and `MetaRight` to `Key::Meta` because enigo 0.6.1 has no cross-platform right-hand variants for these (unlike `ShiftRight`/`ControlRight` which map to `RShift`/`RControl`).
- **`current_source` after source swap:** Week 9 maps against the source the stream started on; a source swap does NOT update this coordinate space in Week 9 (deferred).
- **Wayland:** The default enigo build is a silent no-op on GNOME Wayland (ADR-27 finding).
