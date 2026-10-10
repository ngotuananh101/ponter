# Phase 3 Week 7 — Desktop Streaming Demo

**Date:** 2026-10-02
**Machine:** Fedora 44 Workstation, Wayland session
**Agent:** `ponter-agent --desktop-source screen` (branch `feat/phase3-week7-desktop-streaming` @ `8a1c172`)
**Recording:** none — closed by project-owner attestation (2026-10-03); see Status

## Status

> **Manual demo: CLOSED — project-owner attestation (2026-10-03).** The project
> owner ran the checklist below by hand on the Fedora/Wayland machine with a live
> screen and a real Chrome session and confirmed the observed rows green on
> 2026-10-03. **No recording artifact exists** — this document was not produced
> from a captured recording and claims no recording link. Every **automated**
> acceptance criterion (§10.2 #1–4, #6) is green — see the evidence table.

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

Closed by project-owner attestation on 2026-10-03 (manual run, real Chrome, real screen; no recording artifact).

| Check | Result |
|---|---|
| Monitor icon opens a desktop tab | ✅ |
| Live real-screen stream in Chrome, ~720p | ✅ |
| Visibly ~15 fps | ✅ |
| Host interaction changes the stream | ✅ |
| Close → reopen → stream returns | ✅ |
| Terminal tab refused while desktop open (ADR-19) | ✅ |
| PipeWire portal accepted on first capture (if shown) | ✅ (per attestation) |

## Automated acceptance evidence (spec §10.2)

Numbers are taken from CI on `main` (the Rust and E2E counts are from
`7d17652`, the latest commit on which those workflows ran; the Node counts are
from `32c3248`, the current `main` tip), not from a local run — this machine
lacks `libpipewire-0.3`/`libdrm`, so the Rust agent does not build locally.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `cargo test --locked` passes on Linux; musl `cargo build --locked` succeeds | ✅ | agent `cargo test --locked` → **60 passed, 1 ignored** (live-display smoke); `cargo build --locked` OK. CI `Build Agent / Verify` + `Build Agent / Linux/x64-musl` matrix leg (run 37041659449). |
| 2 | `pnpm lint && pnpm typecheck && pnpm test` pass workspace-wide | ✅ | format:check ✅; web **129/129**; server 108/108; agent fmt/clippy/test/build ✅ (`Build Agent / Verify`, run 37041659449). CI `CI (Node) / Lint, Typecheck, Format & Node Tests` (run 37042542245 @ `32c3248`). `desktop-core` 8/8 and `webrtc-core` 81/81 pass locally but are **not run by any CI workflow** today — see Notes. |
| 3 | E2E: track, ≥30 packets @ negotiated PT, ≥1 IDR, teardown + second session | ✅ | `pnpm --filter @ponter/webrtc-core test:e2e` → **13/13** (3 desktop + 9 terminal + 1 shutdown). CI `CI (E2E) / Cross-language terminal E2E` (run 37041659448 @ `7d17652`). |
| 4 | Terminal E2E still passes unchanged | ✅ | "leaves the terminal flow unaffected" test + the pre-existing 9 terminal tests. |
| 5 | Recorded demo shows live 720p15 + refusal + reopen | ✅ | Closed by project-owner attestation (2026-10-03); no recording artifact — see Status. |
| 6 | `ARCHITECTURE.md` no longer claims 60fps/H.265 as achieved | ✅ | Phase 3 roadmap section added; perf row split into "Week 7 ~720p@15fps software H.264" vs "Phase 3 target 60fps hardware H.265". |

## Notes

- The E2E stream is deterministic by construction: the agent is spawned with `--desktop-source test`
  (ADR-17), so no display, portal, or PipeWire session is involved in CI.
- AC#5 is closed by attestation rather than a recorded artifact: the demo was run manually
  outside the repo and no recording was captured, so none is claimed or linked.
- Coverage gap: `packages/desktop-core` (8 tests) and `packages/webrtc-core` unit suite
  (81 tests) are not invoked by any current workflow — `ci-node.yml` runs only
  `@ponter/server`, `@ponter/web`, and `@ponter/shared`, and `ci-e2e.yml` runs only
  `test:e2e`. Their counts here are from a local `pnpm --filter … test` run at `32c3248`,
  not from CI.
