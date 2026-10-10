# Phase 4 Week 10 — File Transfer Demo

**Date:** 2026-10-04
**Machine:** Fedora Linux, X11 session
**Agent:** `ponter-agent --files-root /tmp/ponter-demo-files` (agent code at `d67e705`; branch HEAD at write time `b32ef24` — both pre-rewrite SHAs, not on main; content shipped in PR #40 squash `e0e1137`)

> **Note on commit SHAs (2026-10-10).** Every SHA cited in this document is a pre-rewrite snapshot SHA (the branch state at demo time) and is **not** an ancestor of `main`; the Phase 4 Week 10 work shipped on main as PR #40 squash `e0e1137`.

## Status

**Not observed** (manual real-seat pass not run; relying on automated evidence from the Task 10 E2E suite (`packages/webrtc-core/test/e2e/files.e2e.test.ts`, commit `b32ef24`, 8/8 passing) and the files unit tests). The web-tab visual experience was not manually observed.

## Checklist (spec §8.4)

| # | Check | Result |
|---|---|---|
| 1 | Gate open: root listing shows the seeded files and subdirectory | ✅ (verified by E2E `lists the seeded directory with sizes and types` at `b32ef24` — automated listing; the web-tab visual was not manually observed) |
| 2 | Enter subdirectory, breadcrumb back to root | ⬜ not run (not exercised end-to-end; the web-tab UI path was not manually observed) |
| 3 | Download a small file; hash matches the on-disk original | ✅ (verified by E2E `downloads a 600 KiB file byte-for-byte across the 16-chunk window` at `b32ef24` — byte-equal via `Buffer.compare`) |
| 4 | Download the > 100 MiB file; progress advances; stopwatch observation recorded (informal, not gated) | ⬜ not run (no manual pass; no throughput number recorded — throughput is Week 11 scope, not measured) |
| 5 | Upload a file from the desktop; bytes land on disk; no `.part` remains | ✅ (verified by E2E `uploads a 100 KiB file that lands byte-equal with no .part left behind` at `b32ef24`) |
| 6 | Cancel a mid-flight download; transfer line disappears; a later listing still works | ✅ (verified by E2E `cancel mid-download stops the chunks, logs, and leaves the session usable` at `b32ef24`) |
| 7 | Attempt an overwrite; `FILE_EXISTS` banner appears ("A file with that name already exists"); original bytes unchanged | ✅ (verified by E2E `refuses an upload onto an existing name with FILE_EXISTS and leaves it untouched` at `b32ef24`; banner text per `apps/web/src/lib/file-errors.ts:14`: `A file with that name already exists`) |
| 8 | Gate closed (`--files-root` omitted): files tab shows the refusal message; no session opens | ✅ (verified by E2E `refuses the offer when the gate is closed` at `b32ef24`; web UI refusal text per `apps/web/src/stores/terminal.ts:835`: `The agent refused this session. It may be busy (one session per agent) or file access may not be configured on the agent.`; agent log line per `apps/agent/src/main.rs:793`: `refused: files root not configured or unusable`) |

Additional automated evidence (not in the 8-step checklist):
- `refuses paths outside the root with PATH_OUTSIDE_ROOT` (test 5 at `b32ef24`)
- `refuses a declared-oversize upload before any chunk with FILE_TOO_LARGE` (test 8 at `b32ef24`)

## Observed

No manual real-seat pass was run. All results derive from the automated evidence in the Task 10 E2E suite (`packages/webrtc-core/test/e2e/files.e2e.test.ts`, commit `b32ef24`, 8/8 passing) and the files unit tests. No stopwatch throughput observation was recorded — check 4 was not run because no manual pass was performed.

## Real-screen evidence

No screenshots or recording reference. The automated evidence is captured in the Task 10 E2E suite (commit `b32ef24`), which exercises checks 1, 3, 5, 6, 7, and 8 programmatically; check 2 (subdirectory/breadcrumb) and check 4 (>100 MiB download) were not run end-to-end.

## Notes

- **Throughput is not a claim.** The > 10MB/s target (`ARCHITECTURE.md:1147`) is Week 11 scope; Week 10 runs a single sequential stream. No throughput number is recorded here — check 4 was not run and is marked ⬜ not run.
- **No E2EE.** File bytes and names cross the wire under DTLS only (H11/M7/M8). Application-layer encryption is WS1 (Phase 5).
- **No peer identity.** The agent does not verify the client (H3); `approved` is not enforced (H2). The gate (ADR-32) is a policy holding pattern closed by WS1/WS2/WS3 (Phase 5).
- **Windows/macOS runtime unverified.** The path sandbox is compile + unit-tested on those targets only (spec §3.7).
- **Week 11 not started.** Large files, streaming to disk, and performance work are out of scope.

## Scope notes

- **Browser memory:** the thin slice holds a whole file in memory (client buffer + Blob on download; `File.arrayBuffer()` on upload) — accepted for the thin slice, revisited in Week 11 (spec §9.4).
- **One transfer per direction:** a second download while one runs is refused with `TRANSFER_BUSY`; a concurrent upload is allowed.
- **No overwrite:** uploads onto an existing name are refused (`FILE_EXISTS`) — by design in the thin slice (ADR-33), not a bug.
