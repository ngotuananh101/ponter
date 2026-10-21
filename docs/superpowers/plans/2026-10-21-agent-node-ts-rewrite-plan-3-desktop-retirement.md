# Agent Node/TS Rewrite — Plan 3: Desktop integration, Rust retirement, CI, docs

> **Status: TASK LIST ONLY. Not executable yet.**
>
> This file records the Plan 3 obligations that Plans 1 and 2 hand forward, so
> that no obligation is lost between plans. It deliberately contains **no code
> fences and no step-level instructions**: a half-written plan whose steps look
> executable is worse than an explicitly incomplete one, because an executor
> will run it. When this plan is authored in full, it must follow
> `superpowers:writing-plans` and carry the same TEST-INTEGRITY declaration
> discipline as Plans 1 and 2.
>
> **Why it exists at all:** Plan 2's coverage matrix assigns B38 to Plan 2 and
> Task 9 defers it to "Plan 3". BA's audit (`…-plan-2-audit.md`, B-7) found that
> a deferred obligation with no destination is a dropped obligation. The
> resolution applied was to land B38 in Plan 2's Task 1, but the same defect
> applies to every other "Plan 3's" in Plans 1 and 2. This file is the
> destination list — B38 is no longer one of them.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md`
— §6 (retirements), §6.2 (CI changes), §10 (the desktop integration).

**Predecessors:** Plan 1 (`…-plan-1-spike-foundation-addon.md`, committed
`0c0147c`) and Plan 2 (`…-plan-2-core.md`).

---

## Global Constraints

- **No Rust fallback.** By the end of this plan nothing may depend on `cargo`,
  `apps/agent/target/`, or the Rust binary. The Rust tree is deleted here.
- **TEST-INTEGRITY:** never delete, skip or weaken a test to make it green.
  Every test change declares before→after `it()`/`expect()` counts and the
  rationale. An undeclared change is BLOCKING. This applies with full force to
  the Rust deletions below: a deleted Rust test must be matched to a TS test
  that carries its behaviour, or to an explicitly recorded retirement with the
  reason there is nothing to carry.
- **Commit attribution:** author `Ngo Tuan Anh <ngotuananh2101@gmail.com>`,
  zero `Co-authored-by` trailers.

---

## Task list

These are obligations, not yet tasks. Each must be expanded into a full task
with Files / Interfaces / steps before this plan is executable.

### T1. The N-API addon ships inside the packaged desktop app

- Build the addon against **Electron's** headers, not the system Node headers,
  or the `.node` file loads in `vitest` and fails in the shipped app with
  `NODE_MODULE_VERSION` mismatch.
- The addon build must run **before** `electron-vite build`, so the binary is
  inlined into the app bundle (spec §6.2).
- `pnpm-workspace.yaml`'s `allowBuilds` gains the addon package (spec D9) or
  pnpm silently skips its install script — a silent skip that presents as "the
  addon is missing at runtime".

### T2. Delete `build-agent.yml` and re-express its API-access guard

- The workflow is removed (spec R6), and **its API-access guard must not be
  lost with it**. It is re-expressed as a Vitest source-scan gate modelled on
  `packages/api-client/test/api-access-gate.test.ts` (spec §6.2, C13/D13).
- The retirement is only honest if the replacement gate exists **in the same
  commit** that deletes the workflow. Two commits, and there is a window where
  neither gate runs.

### T3. `ci-node.yml`: add `apps/agent/**` to `paths:` AND remove the three filters — one change, both halves

This is the single most defect-prone item in the plan, because **either half
alone is a silent no-op that looks like success**:

- Add `apps/agent/**` to `paths:` and leave the filters, and the agent's pushes
  now trigger the job while the filters still exclude the agent from it. The
  job runs, is green, and the agent was never gated. This is the **mirror image**
  of the bug `0030391` fixed, and it is worse, because the fixed bug at least
  failed loudly (`turbo` treats an unmatched filter as fatal).
- Remove the filters and leave `paths:`, and nothing ever triggers the job for
  an agent-only branch, so the removal has no effect.

The `ci-node.yml` comment as it stands at `0030391` says the filter "is what
keeps the not-yet-gating package out of a job that runs on unrelated pushes"
**when** Plan 3 adds the path. Per spec §6.2 the filter is **deleted in the same
edit** that adds the path, so that sentence describes a state that never exists
and must be corrected by this task's commit.

**`CONTRIBUTING.md` moves in the same commit.** It carries the same three
commands at lines 16, 17 and 19 as the documented pre-PR workflow, and it is
the occurrence a `grep` over `.github/workflows/` does not find — Plan 1's
`0030391`-era text is right about that, and the filter strings it names are the
filter strings this task removes. Leaving them behind splits one invariant
across two states: CI without the filters, and the guide contributors follow
with them. On a clean clone, anyone following the guide hits a fatal
`No package found with name '@ponter/agent-node'` — the exact error `0030391`
fixed — which is why the two strings cannot be separated in time.

The guide's `For the Rust agent` `cargo fmt` / `cargo clippy` / `cargo test`
block (lines 22-27, currently missing `--locked` relative to
`build-agent.yml:118,121,124`) is **not** this task's: it retires with T6, and
a deletion needs no correction on the way out.

### T4. `build-desktop.yml`: retire the Rust steps, add the addon build and the agent's vitest suite

- Remove the Rust toolchain setup, the cargo cache, "Build Rust agent binary",
  and the "Run agent tests" cargo step.
- Add: build the N-API addon against Electron's headers, then run the agent's
  vitest suite, **before** the desktop build.
- The step-order change is load-bearing: the addon must exist when
  `electron-vite build` runs, and the agent's tests must gate the desktop
  artifact rather than trail it.

### T5. `ci-e2e.yml`: the agent-binary dependency becomes the in-process agent

### T6. Delete the Rust tree

- `apps/agent/src/*.rs`, `apps/agent/vendor/`, `Cargo.toml`, `Cargo.lock`,
  `rust-toolchain.toml`.
- **Before deleting, close the retirement ledger.** Plans 1 and 2 accumulate
  R-entries (retired behaviours, dropped noise rules, the `files-download-chunk`
  outbound type, the four `decode_*` guard tests). Each must be either matched
  to a TS test that carries its behaviour or recorded as a retirement with the
  reason it carries nothing. A deletion that outruns the ledger is a silent
  coverage loss, and the plan cannot detect it afterwards — the evidence is
  what gets deleted.

### T7. The desktop app consumes `@ponter/agent-node`

- `apps/desktop` depends on the agent package; `agent-supervisor.ts` stops
  looking for a Rust binary at `apps/agent/target/{release,debug}` and starts
  the Node entry point.
- `agent-supervisor.ts:94-97` (`PONTER_AGENT_PATH`) and its
  `resolveBinaryPath()` fallback chain are the specific lines this changes.

### T8. Close Plan 2's carried-forward items

- **B19** — if `applyBitrate` did not land in Plan 1 Task 4's addon, it is a gap
  here (Plan 2's coverage-matrix update says so explicitly).
- **B-10 — the auto-ABR loop** (audit §B-10). This is the only item in this list
  that is a *behaviour*, not an artifact, and the only one whose disposition is
  not a repair: the audit established that no sentence in the spec, Plan 1,
  Plan 2 or this file claims the automatic bitrate loop exists in the
  TypeScript agent, so the §9.4 "every row of §4" gate cannot fail on it. Two
  possible landings, and the choice is the owner's (see T9):
  - **It ships.** Then it needs a new §4 B-row, a task with a declared test
    count, a decision on the estimator (werift exposes only its TWCC
    `SenderBandwidthEstimator`, reachable as `pc.getSenders()[0].senderBWE` —
    a GCC port means re-implementing), and an answer to the SDP delta the Rust
    emits and the TS does not: `a=rtcp-fb … transport-cc` plus an `extmap`
    entry on both the video and audio m-lines, plus pacing.
  - **It does not ship.** Then it needs an R-row in the retirement ledger and
    an `ARCHITECTURE.md:970` amendment, because that document describes the
    loop as current behaviour.
  Do not close this item by observing that the Rust is deleted. That is the
  failure T6 exists to name.
- **N-4 — the 16 KiB terminal splitter.** Plan 2's Task 12 adds an
  `emitChunks` splitter that the Rust does not have (`MAX_PTY_CHUNK` at
  `pty.rs:22` is only the read buffer; `frame_pty_output` at `pty.rs:141-143`
  never splits). This was deliberately **not** adjudicated by the docs audit: it
  is a spec/protocol question for the owner, not a docs call. Two facts to put
  in front of them — a 16 KiB PTY read bound is a transport fact and terminal
  output can exceed it; and the Rust not splitting is not evidence that not
  splitting is correct.

### T9. Docs: ARCHITECTURE, ADRs, guides

- The living docs still describe the Rust agent. `docs/guides/agent-setup.md`
  documents `--cols`/`--rows` as CLI flags, which no longer exist.
- ADR-89's prose cites a `desktop/devices.rs` that was already deleted before
  this rewrite began; that is a pre-existing drift this plan should close while
  it is in the area.

---

## What this file is NOT allowed to become

A place where an obligation goes to be forgotten. Every item above names either
(a) an artifact that must exist, (b) a deletion that must be matched by a
successor, or (c) a gate that must move without a window in which neither the
old nor the new gate runs. If an item cannot be stated in one of those three
forms, it does not belong here.
