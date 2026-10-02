# Phase 3 Week 7 — Desktop Streaming Demo

**Date:** 2026-10-02
**Machine:** Fedora 44 Workstation, Wayland session
**Agent:** `ponter-agent --desktop-source screen` (branch `feat/phase3-week7-desktop-streaming` @ `2256246`)
**Recording:** _pending — see Status below_

## Status

> **Manual demo: PENDING USER.** The recorded demo requires the physical
> Fedora/Wayland display (a live screen, the PipeWire portal dialog, and a real
> Chrome session). It was **not** captured in this automated run. The checklist
> below is what the recording must show; the results table is filled in when the
> demo is recorded. Every **automated** acceptance criterion (§10.2 #1–4, #6) is
> green — see the evidence table.

## Checklist (spec §8.4)

1. Fedora dev machine, Wayland session; capture build deps installed
   (`pipewire-devel libspa-devel mesa-libgbm-devel libdrm-devel mesa-libEGL-devel`, `nasm` optional).
2. `cargo build` the agent; run `ponter-agent --desktop-source screen` (credential supplied).
3. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; log in; register an
   agent in the dialog with `['terminal', 'desktop']`.
4. Workspace: click the Monitor icon on the agent row → desktop tab opens → Chrome shows the
   live screen at ~720p, visibly ~15 fps; interacting with the host changes the stream (proving
   it is the real display, not the test pattern).
5. Close the tab → reopen → the stream returns. Open a terminal tab while desktop is open → the
   clear ADR-19 refusal message.
6. Wayland: if the portal dialog appears on first capture, accept it on camera — that is the
   documented PipeWire ScreenCast path.

## Observed

| Check | Result |
|---|---|
| Monitor icon opens a desktop tab | ⏳ pending user |
| Live real-screen stream in Chrome, ~720p | ⏳ pending user |
| Visibly ~15 fps | ⏳ pending user |
| Host interaction changes the stream | ⏳ pending user |
| Close → reopen → stream returns | ⏳ pending user |
| Terminal tab refused while desktop open (ADR-19) | ⏳ pending user |
| PipeWire portal accepted on first capture (if shown) | ⏳ pending user |

## Automated acceptance evidence (spec §10.2)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `cargo test --locked` passes on Linux; musl `cargo build --locked` succeeds | ✅ | agent `cargo test --locked` → 47 passed, 1 ignored (live-display smoke); `cargo build --locked` OK. CI `rust` + `build-agent` musl legs. |
| 2 | `pnpm lint && pnpm typecheck && pnpm test` pass workspace-wide | ✅ | format:check ✅; web lint ✅; web 77/77; desktop-core 8/8; webrtc-core 81/81; agent fmt/clippy/check ✅ (container). CI `verify`. |
| 3 | E2E: track, ≥30 packets @ negotiated PT, ≥1 IDR, teardown + second session | ✅ | `pnpm --filter @ponter/webrtc-core test:e2e` → 12/12 (3 desktop + 9 terminal). |
| 4 | Terminal E2E still passes unchanged | ✅ | "leaves the terminal flow unaffected" test + the pre-existing 9 terminal tests. |
| 5 | Recorded demo shows live 720p15 + refusal + reopen | ⏳ pending user | This document. |
| 6 | `ARCHITECTURE.md` no longer claims 60fps/H.265 as achieved | ✅ | Phase 3 roadmap section added; perf row split into "Week 7 ~720p@15fps software H.264" vs "Phase 3 target 60fps hardware H.265". |

## Notes

- The E2E stream is deterministic by construction: the agent is spawned with `--desktop-source test`
  (ADR-17), so no display, portal, or PipeWire session is involved in CI.
- The manual demo is the only remaining gate; it is recorded outside the repo (large binary) and
  attached as a PR comment, not committed.
