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
    count, and a decision on the estimator (werift exposes only its TWCC
    `SenderBandwidthEstimator`, reachable as `pc.getSenders()[0].senderBWE` —
    a GCC port means re-implementing). The SDP is **not** a separate part of
    this decision; see the third fact below for why it is already settled.
  - **It does not ship.** Then it needs an R-row in the retirement ledger and
    an `ARCHITECTURE.md:970` amendment, because that document describes the
    loop as current behaviour.
  - **Facts that bear on the choice.** The first two change what "ship"
    costs; neither decides ship-or-not by itself. The third is already
    settled and is recorded only so an executor does not mistake it for an
    open question.
    - **The pacer.** `configure_congestion_control` installs `Slot::Pacer`
      (`interceptor_registry.rs:717`), which is what turns a retargeted encoder
      into a measured departure pattern; a congestion loop without it samples
      the frame boundaries instead. **werift has no RTP pacer** — `grep -riE
      'pacer|pacing'` over its whole `lib/` hits one comment in the SCTP stack
      and nothing in the RTP path. So "port the loop" means porting the
      estimator *and* building the pacing, or accepting a control loop that
      measures something the Rust did not. REMB is not an alternative: werift
      parses it into `receiverEstimatedMaxBitrate` (`rtpSender.js:693`) and
      nothing reads the field.
    - **The estimator's leak.** `senderBWE.js:133-142` (function), `:134-140`
      (the defect) iterates `Object.keys(sentInfo)` — the field names of the
      single packet just sent — so the eviction loop runs over four `NaN`s and
      deletes nothing. Unbounded growth per sender for the session lifetime, on
      exactly the negotiated path a port must use (without the `extmap` the
      sequence never increments and nothing accumulates, which is why it is
      easy to miss). An upstream defect in the estimator itself, present
      whether or not anything uses it — not an argument against exposing it,
      but material to building on it.
    - **The SDP is settled, and this is not a decision.** Recorded here because
      an earlier draft of this item presented it as one, which invited the
      owner to weigh something with no weight. Measured facts:
      - The Rust registers the TWCC feedback and header extension for
        `[Video, Audio]` (`interceptor_registry.rs:676` — the loop; `:678` is
        the `CongestionFeedback::Twcc` arm it contains). The product has no
        audio m-line: `rtc.rs:220`/`:235` add a single `RtpCodecKind::Video`
        track and `grep -rniE 'audio' apps/agent/src/ --include=*.rs` returns
        nothing — so the audio half is dormant registration, not a wire
        behaviour. The header extension id is `None` in that call
        (`:686-692`), i.e. it is left to negotiation.
      - **Both stacks therefore take the extmap id from the offer**, by the
        same mechanism. Rust: `PeerConnection::answer()` →
        `update_header_extension` (`media_engine.rs:917-946`). werift: it
        inherits whatever id the browser offered — measured 4-in/4-out and
        7-in/7-out.
      - **The rtcp-fb half needs no local config either.** werift echoes the
        offer's `a=rtcp-fb … transport-cc` on every payload that carried it,
        with or without local configuration.
      - **The extmap appears only when both halves are present, and it is the
        offer's id that wins.** Measured by BE and re-run independently at
        `.superpowers/probes/be-twcc-sdp/` (git-ignored, one command to
        reproduce; pinned there by sha256 —
        `probe.mjs` `9f155272…7649b46`, `output.txt` `f2fe9e5f…e5239d6b` — so a
        reader can tell whether the artifact moved): `useTransportWideCC()`
        configured **and** the offer carrying the extension ⇒ `a=extmap:4 …`
        for an offer id of 4, `a=extmap:7 …` for 7. Either half alone ⇒
        **NONE**. So the rule is a conjunction, not a config flag — and an
        implementer who sets `useTransportWideCC()` and assumes the extension
        is now on the wire is wrong until the browser offers it. The mechanism
        is the `transceiverManager.js:265-266` filter: remote extensions are
        kept only if local config names the same URI, and werift's default is
        `headerExtensions: { audio: [], video: [] }` (`peerConnection.js:1084-1087`).
      - A port must therefore configure `useTransportWideCC()`; that is a task
        detail, not an owner question. The old sentence "the `extmap` id needs
        no decision" is true **only of the id** — the id is always the offer's
        — and was misleading about the extension's presence, which does depend
        on local config.
      - Note the task fences understate the real offer: the captured Chrome
        offer (`apps/agent/spike/report.json:30`) carries `a=extmap:4 …` and
        `a=rtcp-fb:96 transport-cc`, while
        `packages/webrtc-core/test/synthetic-offer.ts` carries neither. An
        implementer reasoning from the fixture would be wrong about production.
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
