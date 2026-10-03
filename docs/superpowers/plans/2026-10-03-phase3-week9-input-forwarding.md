# Phase 3 Week 9 — Desktop Input Forwarding (Pointer & Keyboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Week 8 desktop stream **interactive**: forward pointer and keyboard events from the browser over the **existing** `'control'` channel, decode them in the Rust agent, and inject them into the operating system — **behind a hard, agent-local gate that ships OFF by default** (ADR-29). The terminal flow and the Week 7/8 media path stay byte-identical.

**Architecture:** Week 8 opened one `'control'` data channel carrying `desktop-sources` / `desktop-select` / `desktop-bitrate` / `desktop-stats`. Week 9 adds **one browser→agent frame type**, `desktop-input`, on that same channel — no new channel (ADR-26). The browser sends **normalized intent** (pointer as `0..1` within the streamed source, physical `KeyboardEvent.code`, committed unicode text); the agent maps normalized → absolute source pixels (`DesktopSourceInfo.x/y/width/height`) and calls an `InputInjector` trait (ADR-28, ADR-30). The injector is a `cfg(not(target_env = "musl"))` dependency chosen by a half-day spike (ADR-27). A single agent-local flag, `--allow-input` / `AGENT_ALLOW_INPUT=1` (default **false**), resolved into `SessionConfig.allow_input`, gates every injection path: a remote peer cannot set it (ADR-29).

**Tech Stack:** TypeScript (`@ponter/shared`, `@ponter/desktop-core`, Vue 3 + Pinia), vitest; Rust (`webrtc`/`rtc` 0.21, `tokio`), `cargo test`/`cargo clippy`; werift (E2E offerer); Xvfb + `xdotool` (gate-open E2E); GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md` (ADR-26..30, merged on `main` as `b2bf167`)

> **Reading order:** read the spec's §2 (wire protocol), §4 (ADR-26..30), §6 (agent design), §7 (web design) and §10.3 (delivery sequence) before starting. This plan argues from the spec; where they disagree, the spec wins and the plan is wrong.

> **Cite discipline.** Every `file:line` in this plan was verified against `main` at `b2bf167` (2026-10-03), the commit the spec is on. Two spec cites have **drifted by +1** since PR #29 added one `use` line at `desktop.rs:31`; the corrected numbers are used here and flagged inline (§3.3 → `desktop.rs:141-193`; §3.4 → `desktop.rs:479-520`). If a later PR moves a cite again, re-verify before trusting this plan — do not copy a line number out of the spec unread.

## Global Constraints

Copied from the spec's project-wide requirements. Every task's requirements implicitly include this section.

- **Precondition — one worktree per branch, opened from a fresh `origin/main`.** Week 8 (PR #27, merged `be8a8c9`) and the Week 9 spec (PR #25, merged `3db3bd5`, the `b2bf167` line) must already be on `main`. Never `git checkout` in the shared working directory. The branch split is in **§ Branch & PR Strategy** below.
- **No new data channel, no new shared envelope.** `desktop-input` rides the existing `'control'` channel via `DataChannelManager.sendJson` (spec §2.1, §5.2). `WebRTCChannelType` already includes `'control'` (`packages/shared/src/types/webrtc.ts:7`) — do not re-add it. The `DataChannelMessage<T>` envelope is reused verbatim (`packages/shared/src/types/webrtc.ts:9-14`).
- **Terminal path stays byte-identical:** `channelLabels: ['terminal']`, one `'terminal'` channel, `terminal-*` frames. `desktop-input` is desktop-only and `control`-only; the terminal dispatcher never sees it (spec §2.4).
- **No server-side changes:** the server relays only SDP/ICE; data-channel bytes are peer-to-peer (spec §1.2, §9.4).
- **The gate is the point (ADR-29).** Input is **OFF by default**. `--allow-input` (env `AGENT_ALLOW_INPUT`), `default_value_t = false`, resolved into `SessionConfig.allow_input`. Every path that could inject sits behind `cfg.allow_input`. A `capabilities` value must **never** gate input — `capabilities` is attacker-controlled (audit H3). The gate-closed E2E test is the contract that proves the default build is inert.
- **Fail-soft.** No decode, mapping, or injector error may end the session or the control channel (spec §6.3, §9.4). Input is **fire-and-forget** — the agent sends **no** ack for a `desktop-input` frame, on any path (spec §2.3).
- **musl boundary is at the dependency, not the module.** `apps/agent/src/input.rs` holds only serde types, `decode_desktop_input`, `to_absolute`, and the `InputInjector` trait — **not** `cfg`-gated, it compiles on every target (exactly as `pty.rs` does). Only the **concrete injector** is `cfg(not(target_env = "musl"))`, and the injection dependency goes in `[target.'cfg(not(target_env = "musl"))'.dependencies]` beside `bytes`/`openh264`/`openh264-sys2`/`xcap` (`apps/agent/Cargo.toml:40`). `--allow-input` is accepted on all targets for CLI-shape uniformity but is **inert on musl** (no desktop session exists there, ADR-15) — mirrors `--desktop-source`.
- **Intentional breaking change (spec §5.3):** `DesktopClient.onSources` changes from `(sources: DesktopSourceInfo[]) => void` to `(payload: DesktopSourcesPayload) => void` (sources + `inputEnabled`). Every current caller of the old shape must be updated in the same FE branch — the full list is in **§ Branch & PR Strategy** ("Breaking-change file list"). The `confirmedSourceId` rollback logic in the store handler must be preserved while the handler shape changes (it must read `payload.sources`).
- **Rate limiting is browser-side only** (spec §5.3, §9.4): `DesktopClient.sendInput` coalesces `pointer-move` to `inputRateLimitHz` (default 60); discrete events are never coalesced. The agent does **not** rate-limit — stated, not hidden (spec §9.4).
- **Platform scope:** Linux is the runnable platform; macOS/Windows must compile and pass unit tests only; runtime injection on macOS/Windows stays unverified (spec §1.2, §8.6).
- **Repo rules:** `apps/server` must NOT runtime-value-import `@ponter/shared` (type-only is fine). GitHub URLs use `ngotuananh101`; Docker Hub namespace is `ngtuananh2011`.
- **English for all repo artifacts:** code, comments, commit messages, and docs stay English. The one exception is `docs/ARCHITECTURE.md`, which is written in Vietnamese — its additions match that file's own convention (Week 7/8 plan precedent).
- **CI gate names (current, post `ci.yml`-split):** `Build Agent / Verify`, `Build Agent / Linux/x64-musl`, `Build Agent / macOS/x64`, `Build Agent / macOS/arm64`, `Build Agent / Windows/x64-msvc`, `CI (Node) / Lint, Typecheck, Format & Node Tests`, `CI (E2E) / Cross-language terminal E2E`, `CI (Docker) / Docker Build Verification`. There is no `ci.yml`.
- **SonarCloud new-code duplication gate (>3% fails).** Any test prologue repeated across tests must be a shared helper from the first commit, not copy-paste. Week 8's precedent: `openDesktopWithSources` / `emitStats` in `apps/web/src/__tests__/terminal-store.test.ts:102-125`, and `openTestDesktopStream` in `packages/webrtc-core/test/e2e/desktop.e2e.test.ts:150-171`. Week 9's tests are written the same way — the helpers are named in each task.

## Review Focus

The spec's highest-risk behaviours (§10.4), each pinned to the test in the task that owns the code:

1. **The gate is the point (ADR-29).** Every path that could inject sits behind `cfg.allow_input`; the gate-closed E2E test proves the default build is inert. Pinned in **Task 4, `gate_closed_injects_nothing`** (a `CountingInjector` records zero calls with `allow_input = false`) and **Task 6, gate-closed E2E** (frame received, logged as dropped, `inputEnabled === false`, RTP unharmed).
2. **No new channel (ADR-26).** Input rides the Week 8 `'control'` channel; the terminal flow is untouched. Pinned in **Task 6** (the Week 7/8 desktop tests and the terminal suite pass unchanged).
3. **Fail-soft (§6.3, §9.4).** No decode/mapping/injection error can end the session. Pinned in **Task 4, `injector_error_is_fail_soft`** and the dispatcher's `Err` arm (log + `continue`).
4. **Coordinate honesty (ADR-30, §3.4).** The `scaleFactor`/DPR caveat is a recorded watch item, not silently assumed correct. Pinned in the mapping unit tests — **Task 4, `to_absolute`** (offset source, clamp) and **Task 5, `toNormalized`** (letterbox, pillarbox, black-bar clamp) — and stated in the demo doc (**Task 7**).
5. **AC honesty (§10.2).** The AC verify the **mechanism** and the **gate**, never a usable feature; H3/H2/M7/M8 remain open. Pinned in **Task 7, the AC table** (no row claims "input works for a real user").
6. **musl (§1.2, §10.4).** The injection dependency is `cfg(not(target_env = "musl"))`; the musl artifact stays terminal-only. Pinned by the `Build Agent / Linux/x64-musl` gate and **Task 4, Step 8** (a musl build check).

## Branch & PR Strategy

The spec's §10.3 says "single PR, `feat/phase3-week9-input-forwarding`". The PM has since agreed a **branch split** with the FE owner, because D1→D2→D4 is a TypeScript dependency chain (shared types gate the client and the web) while D3 (Rust agent) shares **no file** with it. Splitting removes cross-waiting; the pieces aggregate cleanly (the Week 8 PR #29 pattern: independent branches, clean cherry-pick, no conflicts).

| Branch | Deliverables | Owner | Files touched | Notes |
|---|---|---|---|---|
| `feat/phase3-week9-input-web` | **D1 + D2 + D4** (sequential *within* the branch: shared → desktop-core → web) | FE | `packages/shared/**`, `packages/desktop-core/**`, `apps/web/**` | Same branch because the TS types are a compile-time dependency chain; splitting them would force a cross-branch wait for no benefit. |
| `feat/phase3-week9-input-agent` | **D3** | BE | `apps/agent/**` | No file overlap with the FE branch. Independently buildable/testable; depends only on the **frozen wire shape** in § "Frozen interfaces" (not on the FE code landing). |
| `test/phase3-week9-input-e2e` | **D5** | **BE** (PM-decided) | `packages/webrtc-core/test/e2e/**`, `.github/workflows/ci-e2e.yml` | Needs both the agent flag (D3) and the wire types (D1) present on the integration base — so it opens **after** the other two, on a branch cut from the merged `main`. Owner is BE: the assertions are agent-behaviour (drop log, `xdotool` seat) and the §8.3 fallback seam (`test-injector`) is Rust-side. The earlier "whoever lands second" is dropped as nondeterministic. |
| `docs/phase3-week9-input-docs` | **D7 + D8** | **BA** (PM-decided) | `docs/**` only | Docs-only; independent of code. Can run in parallel with D5. Owner is BA: the Task 7 text is already written and its cites verified at `b2bf167`; it balances load (BE already carries D3 + D5). The manual demo runs on an X11 host and is recorded honestly, including "not observed". |

**Aggregation.** After the FE and BE branches merge, D5 and D7/D8 open against the updated `main`. If the team prefers a single PR after all (spec §10.3's literal wording), collapse FE+BE+D5+D8 into `feat/phase3-week9-input-forwarding` — the tasks below are written so either works; only the branch names in the `git push`/`gh pr create` steps change.

**Spike (D6 / ADR-27)** is a **finding**, not a branch: it runs first, on the BE side, and its result is recorded in the Week 9 spec's ADR-27 **before the D3 injector dependency is committed** (Task 1 below). That spec edit lands in **this** PR (`docs/phase3-week9-input-forwarding-plan`), so D3 is unblocked the moment it starts.

**This plan's PR (BA).** The plan + the ADR-27 spec finding ship together in `docs/phase3-week9-input-forwarding-plan`; it is the prerequisite for the FE/BE/D5/D7 branches above.

### Breaking-change file list (the intentional `onSources` change)

`onSources` moves from `DesktopSourceInfo[]` to `DesktopSourcesPayload` (spec §5.3). Every current caller of the old shape, verified at `b2bf167`:

| File | Site | Change |
|---|---|---|
| `packages/desktop-core/src/client.ts` | `onSources` (`:233-242`), `dispatchControl` `desktop-sources` arm (`:188-198`), `lastSources` field (`:30`) | yield/cache `DesktopSourcesPayload` instead of `DesktopSourceInfo[]` |
| `packages/desktop-core/test/client.test.ts` | `describe('DesktopClient control surface')` (`:233`) and every `payload: { sources: [...] }` frame (`:258-491`) | send `{ sources, inputEnabled }`; assert the new shape |
| `apps/web/src/stores/terminal.ts` | `onSources` handler (`:613-622`), `TabItem` (`:38-47`) | read `payload.sources` / `payload.inputEnabled`; add `desktopInputEnabled?` |
| `apps/web/src/__tests__/terminal-store.test.ts` | `desktopSourcesHandler` (`:15`), `openDesktopWithSources` (`:102-114`) | handler now takes a `DesktopSourcesPayload` |
| `apps/web/src/__tests__/DesktopView.test.ts` | `desktopTab` helper (`:8-18`), `twoSources` (`:72-99`) | build the tab with `desktopInputEnabled` where the toggle is under test |

> **Preserve the rollback logic.** In `apps/web/src/stores/terminal.ts:613-637` the `onSources`/`onStats` pair keeps a `confirmedSourceId` closure that snaps the picker back on a `select-refused`. When the handler shape changes, `tab.desktopSources = payload.sources` and `payload.inputEnabled` are read from the **same** payload; the `defaultId` lookup and the rollback must survive unchanged. A test in **Task 5** re-asserts the rollback after the shape change.

### Frozen interfaces (write these exactly — cross-branch contracts)

These are the seams between the FE and BE branches. They are **frozen** at the shapes below; if either side needs a change, that is a spec change, not a branch-local decision.

**D1 → shared (spec §2.2, §5.1):**

```typescript
export interface KeyModifiers { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; }

export type DesktopInput =
  | { kind: 'pointer-move'; x: number; y: number }
  | { kind: 'pointer-button'; button: 'left' | 'middle' | 'right'; pressed: boolean; x: number; y: number }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

export interface DesktopSourcesPayload { sources: DesktopSourceInfo[]; inputEnabled: boolean; }
```

**D2 → desktop-core (spec §5.3):**

```typescript
export interface DesktopClientOptions {
  trackTimeoutMs?: number;    // Week 8
  controlTimeoutMs?: number;  // Week 8
  inputRateLimitHz?: number;  // Week 9; DEFAULT_INPUT_RATE_LIMIT_HZ = 60
}
export class DesktopClient {
  sendInput(event: DesktopInput): void; // no-op + warn when the control channel is not open
}
```

**D4 → web (spec §7.1, §7.3):**

```typescript
export function toNormalized(
  clientX: number, clientY: number, rect: DOMRect, videoWidth: number, videoHeight: number,
): { x: number; y: number };                    // letterbox removed, clamped to 0..1
// store:
//   TabItem.desktopInputEnabled?: boolean
//   action: sendDesktopInput(tabId: string, event: DesktopInput): void
```

---

### Task 1: Injection-library spike — record the ADR-27 finding (D6)

> **STATUS: DONE (2026-10-03).** The spike ran on the BA side; verdict **PASS → depend on `enigo`** (ADR-27 branch 1: one crate behind the `InputInjector` trait). Probe crate at `/tmp/adr27-spike/`, report at `/tmp/adr27-spike/FINDING.md`. The steps below are kept as the **record of how the finding was produced** (and as the re-run recipe if the dependency ever needs re-evaluating); the **finding is filled in at Step 3** and Task 4 uses it. No dependency was committed by the spike; no PR. If you are implementing after this plan, **skip to Task 4** — Task 1's output is already on the page.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md` (ADR-27 — replace the "Spike PASS/FAIL" *hypothesis* with the **observed finding**)
- Create (throwaway, **not committed**): `/tmp/adr27-spike/` — the scratch probe crate
- Test: none — this task produces a **decision**, not code

**Interfaces:**
- Consumes: nothing.
- Produces (relied on by **Task 4**): the chosen injector dependency + the reason, recorded in ADR-27. Task 4's `Cargo.toml` step and its concrete-injector module name depend on which branch the spike picks.

> **Why a spike at all (spec §3.1, §3.5).** No input-injection crate exists in the repository or the cargo cache — `apps/agent/Cargo.lock` contains **0** occurrences of `enigo`, and the registry cache holds no `enigo`/`rdev`/`inputbot`/`uinput` source. Whether a given crate builds under the agent's toolchain and injects on X11 **cannot be answered from this repository** (spec §3.5). The spike is a half-day, and it chooses the **dependency**, never the delivery (ADR-27): both branches ship as written, so a FAIL shrinks nothing in scope.

- [ ] **Step 1: Stand up the throwaway probe**

Outside the repo's dependency graph (a scratch crate so the agent's `Cargo.lock` is untouched until the decision is made):

```bash
cargo new --bin /tmp/adr27-spike
cd /tmp/adr27-spike
cargo add enigo            # default features (libxdo on Linux/X11)
cargo build
```

Then the probe `main`: connect to the display, `move_mouse(400, 300, Abs)`, `button(Left, Click)`, `text("hi")`, and — for the Wayland branch — attempt the same under a Wayland session and record the failure mode.

- [ ] **Step 2: Run the four criteria from ADR-27**

Record a yes/no per criterion, with the exact command output that proves it:

| # | Criterion (ADR-27) | Evidence captured |
|---|---|---|
| a | Builds under the agent's toolchain on Linux/macOS/Windows | `cargo build` on Linux ✅; ~14 new lockfile crates, **pure Rust, no vendoring**; macOS/Windows recorded as **unverified** (no host, spec §3.5) |
| b | Injects pointer + keyboard on X11 | ✅ via XTest (what `xdotool` uses) |
| c | Credible Wayland path — or an explicit statement that it has none | default build is a **silent no-op** on GNOME Wayland (returns `Ok`, nothing moves); the `wayland` feature is **wlroots-only**, so it is **not** enabled; libei/portal is follow-up (spec §3.2) |
| d | Licensing + maintenance | **MIT**, maintained |

- [x] **Step 3: Record the finding in ADR-27 (replace the hypothesis with the result)**

The finding was recorded in `### ADR-27` (spec `:158-171`; the `**Finding**` paragraph lands at `:171`). ADR-27 keeps **both** branches as the fallback contract; the observed result is appended — it is **not** promoted into an acceptance criterion (ADR-27's Consequence: §10.2 must not reference the spike). The recorded paragraph:

```markdown
**Finding (2026-10-03, half-day spike, Fedora + X11):** PASS — `enigo` 0.6.1 (MIT) builds with
default features and injects pointer+keyboard on X11 via XTest; `Enigo` is `Send`, so it fits
`InputInjector` behind a `Box<dyn>` with no wrapper. Wayland: the default build is a silent
no-op on GNOME (returns `Ok`, nothing moves); the `wayland` feature is wlroots-only and is NOT
enabled — Wayland stays the §8.4-step-5 recorded limitation, with libei/portal as follow-up.
macOS: set `Settings::open_prompt_to_get_permissions = false` (default `true` would pop a GUI
prompt). ~14 new lockfile crates on Linux; pure Rust, so **no vendoring** (unlike xcap) and it
even builds on musl — the musl cfg-gate is policy, not a build constraint.
Chosen branch: **enigo**. The per-platform branch stays documented above as the fallback.
```

- [x] **Step 4: Sanity-check the decision against §3.4's DPR watch item**

Recorded: enigo consumes **physical** pixels on X11; `xcap` reports in the platform's native unit. §3.4 stays a **watch item** — `to_absolute` (Task 4) applies `scaleFactor` only if the concrete injector's unit differs. This is left open deliberately, not assumed correct.

- [x] **Step 5: Commit**

Landed in this PR (`docs/phase3-week9-input-forwarding-plan`) — the finding is a prerequisite for D3 (Task 4), which must not commit the `enigo` dependency before ADR-27 records the observed result (see the note at `:60`). Committed as `docs(spec): record the ADR-27 injection-library spike finding (enigo)`.

```bash
git add docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md
git commit -m "docs(spec): record the ADR-27 injection-library spike finding (enigo)"
```

> The probe crate at `/tmp/adr27-spike` is **not** committed. Nothing from it enters the repo; only the ADR-27 paragraph does.

---

### Task 2: `packages/shared` — input wire types (D1)

**Files:**
- Modify: `packages/shared/src/types/desktop.ts` (add `KeyModifiers`, `DesktopInput`, `DesktopSourcesPayload`)
- Modify: `packages/shared/src/types/index.ts` (extend the `./desktop.js` re-export block)
- Test: `packages/shared/test/desktop-types.test.ts` (extend the existing Week 8 test file)

**Interfaces:**
- Consumes: `DesktopSourceInfo` (already in `desktop.ts:11-27`); `DataChannelMessage<T>` (`types/webrtc.ts:9-14`); nothing else.
- Produces (relied on by **Tasks 3, 4, 5**):
  - `KeyModifiers { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }`
  - `DesktopInput` — the §2.2 union on `kind`
  - `DesktopSourcesPayload { sources: DesktopSourceInfo[]; inputEnabled: boolean }`

> **No new envelope, no channel change.** `WebRTCChannelType` already includes `'control'` (`types/webrtc.ts:7`); do not re-add it. These are payload shapes only (spec §5.1).

- [ ] **Step 1: Write the failing type tests**

Append to `packages/shared/test/desktop-types.test.ts` (the Week 8 file already imports `DesktopSourceInfo`/`DesktopStats` from `../src`):

```typescript
import type {
  DesktopInput,
  DesktopSourcesPayload,
  KeyModifiers,
} from '../src';

describe('Desktop input wire types (Week 9, spec §2.2)', () => {
  it('narrows the DesktopInput union on kind', () => {
    const mods: KeyModifiers = { ctrl: false, alt: false, shift: true, meta: false };
    const events: DesktopInput[] = [
      { kind: 'pointer-move', x: 0.5, y: 0.25 },
      { kind: 'pointer-button', button: 'left', pressed: true, x: 0.5, y: 0.25 },
      { kind: 'wheel', dx: 0, dy: -1, x: 0.5, y: 0.25 },
      { kind: 'key', code: 'ShiftLeft', pressed: true, modifiers: mods },
      { kind: 'text', text: 'hi' },
    ];
    // Exhaustiveness: a `switch` on `kind` must see exactly five arms.
    const seen = new Set(events.map((e) => e.kind));
    expect(seen).toEqual(
      new Set(['pointer-move', 'pointer-button', 'wheel', 'key', 'text']),
    );
    const move = events[0];
    if (move.kind === 'pointer-move') expect(move.x).toBe(0.5);
  });

  it('carries inputEnabled alongside the Week 8 sources', () => {
    const payload: DesktopSourcesPayload = {
      sources: [
        {
          id: 'monitor:1',
          kind: 'monitor',
          name: 'eDP-1',
          width: 1920,
          height: 1080,
          x: 0,
          y: 0,
          scaleFactor: 1,
          rotation: 0,
          isPrimary: true,
          default: true,
        },
      ],
      inputEnabled: false,
    };
    expect(payload.inputEnabled).toBe(false);
    expect(payload.sources[0]?.default).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test desktop-types`
Expected: FAIL — `DesktopInput` / `DesktopSourcesPayload` / `KeyModifiers` are not exported from `../src` (TS2305 / unresolved named export).

- [ ] **Step 3: Add the types to `desktop.ts`**

Append to `packages/shared/src/types/desktop.ts` (below `DesktopStats`):

```typescript
/**
 * Keyboard modifier state at the moment a `key` frame is emitted (spec §2.2).
 * Physical codes + modifier state make the mapping layout-independent.
 */
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * One forwarded input event (Week 9, spec §2.2). The `kind` tag selects the
 * fields. Pointer coordinates are normalized `0..1` within the *streamed
 * source* (the browser removes the `object-contain` letterbox first, ADR-30);
 * `code` is the physical `KeyboardEvent.code`; `text` is committed unicode.
 */
export type DesktopInput =
  | { kind: 'pointer-move'; x: number; y: number }
  | {
      kind: 'pointer-button';
      button: 'left' | 'middle' | 'right';
      pressed: boolean;
      x: number;
      y: number;
    }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/**
 * The `desktop-sources` payload (Week 8 + the Week 9 additive `inputEnabled`).
 * A Week 8 client that ignores the extra field is unaffected (spec §2.2).
 */
export interface DesktopSourcesPayload {
  sources: DesktopSourceInfo[];
  /** True iff the agent's input gate is open (ADR-29). */
  inputEnabled: boolean;
}
```

- [ ] **Step 4: Extend the barrel re-export**

In `packages/shared/src/types/index.ts:12`, the Week 8 line is:

```typescript
export type { DesktopSourceInfo, DesktopStats } from './desktop.js';
```

Replace it with (all type-only — no value export):

```typescript
export type {
  DesktopSourceInfo,
  DesktopStats,
  DesktopInput,
  DesktopSourcesPayload,
  KeyModifiers,
} from './desktop.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/shared test desktop-types && pnpm --filter @ponter/shared typecheck`
Expected: PASS (Week 8's 3 tests + the 2 new ones), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/desktop.ts packages/shared/src/types/index.ts packages/shared/test/desktop-types.test.ts
git commit -m "feat(shared): add desktop input wire types and DesktopSourcesPayload"
```

---

### Task 3: `packages/desktop-core` — `DesktopClient.sendInput` + rate limiting + the `onSources` shape change (D2)

**Files:**
- Modify: `packages/desktop-core/src/types.ts` (`DesktopClientOptions` gains `inputRateLimitHz?`)
- Modify: `packages/desktop-core/src/client.ts` (`sendInput`, the `pointer-move` coalescer, `onSources`/`dispatchControl`/`lastSources` → `DesktopSourcesPayload`)
- Test: `packages/desktop-core/test/client.test.ts` (extend the Week 8 `control surface` block)

**Interfaces:**
- Consumes: Task 2's `DesktopInput`, `DesktopSourcesPayload`; `DataChannelManager.sendJson(label, type, payload)` and `getChannel(label)` (Week 8); the existing `DesktopClient` constructor/`start`/`close`/`onSources`/`onStats`/`selectSource`/`setBitrate`.
- Produces (relied on by **Task 5**):
  - `DesktopClientOptions { trackTimeoutMs?; controlTimeoutMs?; inputRateLimitHz? }` (`inputRateLimitHz` default `60`)
  - `DesktopClient.sendInput(event: DesktopInput): void`
  - `DesktopClient.onSources(handler: (payload: DesktopSourcesPayload) => void): () => void` — **the breaking change**

> **Why `sendInput` is guarded, not raw (spec §5.3).** `DataChannelManager.sendJson` **throws** `Data channel "control" is not registered` when the label is absent (`packages/webrtc-core/src/data-channel.ts:75-77`), and `RTCDataChannel.send()` throws `InvalidStateError` when the channel is not `open`. `sendInput` is called from DOM event handlers, so it must mirror `sendControl` (`client.ts:274-280`): warn and return, never throw into the UI. The UI only forwards input after `onSources` reports `inputEnabled` (Task 5), so a closed channel is a defensive path.

> **Why `pointer-move` is coalesced but clicks are not (spec §5.3, §9.4).** A pointer stream fires far above 60 Hz; forwarding every move would amplify a well-behaved client into a flood. The newest position wins and stale intermediate moves are dropped. Discrete events (`pointer-button`, `wheel`, `key`, `text`) are **never** coalesced — dropping a click would be a correctness bug. Rate limiting is **browser-side only**; the agent does not rate-limit (stated in spec §9.4, not hidden).

- [ ] **Step 1: Extend `DesktopClientOptions`**

In `packages/desktop-core/src/types.ts` (currently `:13-18`):

```typescript
export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
  /** How long to wait for the control channel to open after the track. Default 5_000. */
  controlTimeoutMs?: number;
  /** Max `pointer-move` frames per second the client will forward. Default 60. */
  inputRateLimitHz?: number;
}
```

- [ ] **Step 2: Write the failing tests**

In `packages/desktop-core/test/client.test.ts`, the Week 8 `mockPeer()` helper (`:17`) already exposes `setControlState` (`:73`) and `sendJson`. Add a describe block for the input surface. The mock must record `sendJson` calls so coalescing is observable:

```typescript
describe('DesktopClient input surface (Week 9, spec §5.3)', () => {
  const sentInputs = (): Array<{ type: string; payload: unknown }> =>
    mockSendJson.mock.calls
      .filter((c) => c[1] === 'desktop-input')
      .map((c) => ({ type: c[1] as string, payload: c[2] }));

  it('forwards a discrete event when the channel is open', () => {
    // mockPeer() is already connected(); setControlState('open') is the Week 8
    // helper that flips getChannel('control').readyState.
    const { client } = connected();
    client.sendInput({ kind: 'pointer-button', button: 'left', pressed: true, x: 0.5, y: 0.5 });
    expect(mockSendJson).toHaveBeenCalledWith('control', 'desktop-input', {
      kind: 'pointer-button', button: 'left', pressed: true, x: 0.5, y: 0.5,
    });
  });

  it('warns and does not throw when the channel is not open', () => {
    const { client, peer } = mockPeer();          // not started → channel not open
    peer.setControlState('connecting');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => client.sendInput({ kind: 'text', text: 'a' })).not.toThrow();
    expect(mockSendJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('coalesces pointer-move to the configured rate and never drops discrete events', () => {
    vi.useFakeTimers();
    try {
      const { client } = connected({ inputRateLimitHz: 60 });
      // 120 moves in the same tick: only the first is forwarded now; the rest
      // are held and flushed at most once per 1/60 s.
      for (let i = 0; i < 120; i++) {
        client.sendInput({ kind: 'pointer-move', x: i / 120, y: 0 });
      }
      client.sendInput({ kind: 'key', code: 'KeyA', pressed: true,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false } });

      const movesNow = sentInputs().filter((s) => (s.payload as { kind: string }).kind === 'pointer-move');
      expect(movesNow).toHaveLength(1);            // the newest at flush time
      expect(sentInputs().filter((s) => (s.payload as { kind: string }).kind === 'key')).toHaveLength(1);

      vi.advanceTimersByTime(17);                  // ~1/60 s
      const movesAfter = sentInputs().filter((s) => (s.payload as { kind: string }).kind === 'pointer-move');
      expect(movesAfter.length).toBeGreaterThanOrEqual(2);
      // The last move carries the newest position, not a stale one.
      expect((movesAfter.at(-1)?.payload as { x: number }).x).toBeCloseTo(119 / 120);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces inputEnabled from the desktop-sources payload', () => {
    const { client } = connected();
    const seen: boolean[] = [];
    client.onSources((payload) => seen.push(payload.inputEnabled));
    emitSources([{ id: 'monitor:1', default: true }], true);
    expect(seen).toEqual([true]);
  });
});
```

> **Shared helpers, not copy-paste (SonarCloud >3%).** `connected()` already exists (`client.test.ts:235`); extend it to accept options (`connected({ inputRateLimitHz })`). Add a module-level `mockSendJson = vi.fn()` wired into `mockPeer()`'s `dataChannels.sendJson`, and an `emitSources(sources, inputEnabled)` helper beside the Week 8 `oneSource` (`:244`) so every test pushes a `DesktopSourcesPayload` through one place. This is the same discipline PR #29 used (`openDesktopWithSources`/`emitStats` in the web store tests).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/desktop-core test client`
Expected: FAIL — `sendInput` is not a function; `onSources` still yields `DesktopSourceInfo[]`.

- [ ] **Step 4: Change `lastSources` and `dispatchControl` to the payload shape**

In `packages/desktop-core/src/client.ts`:

```typescript
import type { DesktopInput, DesktopSourcesPayload } from '@ponter/shared';

const DEFAULT_INPUT_RATE_LIMIT_HZ = 60;
```

Change the field (`:30`) and the `desktop-sources` arm (`:188-198`):

```typescript
  private lastSources: DesktopSourcesPayload | undefined;
```

```typescript
      case 'desktop-sources': {
        const payload = msg.payload as Partial<DesktopSourcesPayload> | undefined;
        const next: DesktopSourcesPayload = {
          sources: payload?.sources ?? [],
          inputEnabled: payload?.inputEnabled === true,
        };
        this.lastSources = next;
        for (const listener of this.sourceListeners.slice()) {
          listener(next);
        }
        break;
      }
```

Change the listener array type and `onSources` (`:18-20`, `:233-242`):

```typescript
  private readonly sourceListeners: Array<(payload: DesktopSourcesPayload) => void> = [];
```

```typescript
  /** Capture-source enumeration + input gate, pushed by the agent once. */
  onSources(handler: (payload: DesktopSourcesPayload) => void): () => void {
    this.sourceListeners.push(handler);
    if (this.lastSources !== undefined) handler(this.lastSources);
    return () => {
      const idx = this.sourceListeners.indexOf(handler);
      if (idx >= 0) this.sourceListeners.splice(idx, 1);
    };
  }
```

- [ ] **Step 5: Add `inputRateLimitHz`, the coalescer, and `sendInput`**

In the constructor (`:39-47`) read the option; add the two private fields beside `pendingReject` (`:32-33`):

```typescript
  private readonly inputRateLimitHz: number;
  /** The newest coalesced `pointer-move` awaiting the next allowed send. */
  private pendingMove: DesktopInput | null = null;
  /** Whether a flush is already scheduled for the current rate window. */
  private moveFlushScheduled = false;
```

```typescript
    this.inputRateLimitHz = options?.inputRateLimitHz ?? DEFAULT_INPUT_RATE_LIMIT_HZ;
```

Add the method beside `selectSource`/`setBitrate` (`:265-280`):

```typescript
  /**
   * Forward one input event (spec §5.3). Discrete events go straight through;
   * `pointer-move` is coalesced to `inputRateLimitHz` (the newest position wins).
   * No-op + warn when the control channel is not open, mirroring `sendControl`.
   */
  sendInput(event: DesktopInput): void {
    if (event.kind === 'pointer-move') {
      this.pendingMove = event;
      if (this.moveFlushScheduled) return;
      this.moveFlushScheduled = true;
      const delayMs = Math.max(0, Math.round(1000 / this.inputRateLimitHz));
      setTimeout(() => this.flushPendingMove(), delayMs);
      return;
    }
    this.sendControl('desktop-input', event);
  }

  private flushPendingMove(): void {
    this.moveFlushScheduled = false;
    const move = this.pendingMove;
    this.pendingMove = null;
    if (move) this.sendControl('desktop-input', move);
  }
```

And extend `close()` (`:283-302`) to drop a pending move so a closed client sends nothing:

```typescript
    this.pendingMove = null;
```

> **Why `sendControl` (not a raw `sendJson`) is the sender.** `sendControl` (`:274-280`) already implements the `readyState === 'open'` guard and the `[desktop] control channel not open; dropping …` warn. `sendInput` reuses it so both paths share one guard and one message shape. `sendJson('control', 'desktop-input', event)` matches the wire contract exactly (spec §2.2).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop-core test client && pnpm --filter @ponter/desktop-core typecheck`
Expected: PASS — the four new tests + every Week 8 `control surface` test (updated to the payload shape in Step 7) green; typecheck clean.

- [ ] **Step 7: Update the Week 8 tests to the new `onSources` shape**

The Week 8 tests push `payload: { sources: [oneSource] }` (`:258-491`). Update every such frame to `{ sources: [oneSource], inputEnabled: false }` and every `onSources` assertion to read `payload.sources`. Keep the assertions' *intent* identical — only the shape moves. This is the intentional breaking change from the spec (§5.3); a stale `onSources((sources) => …)` that reads the array directly will fail typecheck, which is the guard.

- [ ] **Step 8: Commit**

```bash
git add packages/desktop-core/src/types.ts packages/desktop-core/src/client.ts packages/desktop-core/test/client.test.ts
git commit -m "feat(desktop-core): add sendInput with pointer-move coalescing; onSources yields DesktopSourcesPayload"
```

---

### Task 4: Agent — `input.rs`, the dispatcher branch, the gate, and CLI (D3)

**Files:**
- Create: `apps/agent/src/input.rs` (the `DesktopInput` enum, `InputInjector` trait, `decode_desktop_input`, `to_absolute`, and the `cfg(not(target_env = "musl"))` concrete injector)
- Modify: `apps/agent/src/main.rs` (`mod input`; `SessionConfig.allow_input`; `Cli.allow_input`; `inputEnabled` in the `desktop-sources` frame; the control-dispatcher input branch)
- Modify: `apps/agent/src/desktop.rs` (`frame_desktop_sources` gains `inputEnabled`)
- Modify: `apps/agent/Cargo.toml` (the injection dependency in the non-musl section — **only after Task 1's finding**)
- Test: `apps/agent/src/input.rs` (`#[cfg(test)] mod tests`) and `apps/agent/src/desktop.rs` (the `frame_desktop_sources` test at `:2187`)

**Interfaces:**
- Consumes: Task 1's chosen injector dependency (concrete injector only); `crate::pty::{MAX_FRAME_BYTES, DataChannelMessage}`; `desktop::DesktopSourceInfo`; `webrtc::data_channel::{DataChannel, DataChannelEvent}`; the Week 8 control dispatcher (`main.rs:1297-1368`).
- Produces (relied on by **Tasks 6, 7**):
  - `input::DesktopInput` (Rust mirror of §2.2), `input::Button`, `input::KeyModifiers`
  - `input::InputInjector: Send` (the seam)
  - `input::decode_desktop_input(raw: &str) -> Result<Option<DesktopInput>>`
  - `input::to_absolute(nx: f64, ny: f64, source: &DesktopSourceInfo) -> (i32, i32)`
  - `SessionConfig.allow_input: bool`; `Cli.allow_input: bool`; `frame_desktop_sources(sources, input_enabled, timestamp_ms)`
  - `desktop-sources` frame payload gains `inputEnabled`

> **The module is NOT `cfg`-gated; the dependency is (spec §6.1).** `input.rs` holds only serde types, `decode_desktop_input`, `to_absolute`, and the `InputInjector` trait — no heavy dependency — so it compiles on every target exactly as `pty.rs` does. Only the **concrete injector** is `cfg(not(target_env = "musl"))`, and the injection crate goes in `[target.'cfg(not(target_env = "musl"))'.dependencies]` (`Cargo.toml:40`). On musl the concrete type is simply never constructed — the dispatcher branch lives inside the non-musl `run_desktop_session` (`main.rs:1100-1102`), so no stub is required.

> **The gate is enforced before any injection (ADR-29, spec §2.3).** Gate closed ⇒ `tracing::debug!("dropping desktop-input: input disabled")` + `continue` — no injector consulted, no error frame, no session effect. Gate open ⇒ decode, map, inject; **any** error is logged and dropped. Input is **fire-and-forget**: no ack on any path.

- [ ] **Step 1: Write the failing Rust tests for the decoder, the mapping, and the gate**

Create `apps/agent/src/input.rs` with the tests first (the module compiles once the types below exist; write the tests at the bottom in `#[cfg(test)] mod tests`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> crate::desktop::DesktopSourceInfo {
        crate::desktop::DesktopSourceInfo {
            id: "monitor:1".to_string(),
            kind: crate::desktop::SourceKind::Monitor,
            name: "eDP-1".to_string(),
            width: 1920,
            height: 1080,
            x: 100,          // non-zero origin on purpose (§6.2)
            y: 50,
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: true,
            default: true,
        }
    }

    fn frame(payload: serde_json::Value) -> String {
        serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": payload,
            "timestamp": 0,
        })
        .to_string()
    }

    #[test]
    fn decodes_every_kind() {
        let move_ev = decode_desktop_input(frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.25 })))
            .unwrap().unwrap();
        assert_eq!(move_ev, DesktopInput::PointerMove { x: 0.5, y: 0.25 });

        let btn = decode_desktop_input(frame(serde_json::json!({ "kind": "pointer-button", "button": "left", "pressed": true, "x": 0.5, "y": 0.5 })))
            .unwrap().unwrap();
        assert_eq!(btn, DesktopInput::PointerButton { button: Button::Left, pressed: true, x: 0.5, y: 0.5 });

        let wheel = decode_desktop_input(frame(serde_json::json!({ "kind": "wheel", "dx": 0.0, "dy": -1.0, "x": 0.1, "y": 0.1 })))
            .unwrap().unwrap();
        assert_eq!(wheel, DesktopInput::Wheel { dx: 0.0, dy: -1.0, x: 0.1, y: 0.1 });

        let key = decode_desktop_input(frame(serde_json::json!({ "kind": "key", "code": "KeyA", "pressed": true, "modifiers": { "ctrl": true, "alt": false, "shift": false, "meta": false } })))
            .unwrap().unwrap();
        assert!(matches!(key, DesktopInput::Key { ref code, pressed: true, .. } if code == "KeyA"));

        let text = decode_desktop_input(frame(serde_json::json!({ "kind": "text", "text": "hi" })))
            .unwrap().unwrap();
        assert_eq!(text, DesktopInput::Text { text: "hi".to_string() });
    }

    #[test]
    fn clamps_normalized_coordinates_at_decode() {
        let ev = decode_desktop_input(frame(serde_json::json!({ "kind": "pointer-move", "x": 2.5, "y": -1.0 })))
            .unwrap().unwrap();
        assert_eq!(ev, DesktopInput::PointerMove { x: 1.0, y: 0.0 });
    }

    #[test]
    fn ignores_a_foreign_channel_or_type() {
        let wrong_channel = serde_json::json!({
            "type": "desktop-input", "channel": "terminal",
            "payload": { "kind": "text", "text": "x" }, "timestamp": 0,
        }).to_string();
        assert_eq!(decode_desktop_input(&wrong_channel).unwrap(), None);

        let wrong_type = serde_json::json!({
            "type": "desktop-select", "channel": "control",
            "payload": { "sourceId": "monitor:1" }, "timestamp": 0,
        }).to_string();
        assert_eq!(decode_desktop_input(&wrong_type).unwrap(), None);
    }

    #[test]
    fn rejects_an_oversize_frame_before_parsing() {
        // A frame larger than MAX_FRAME_BYTES must Err on size, not on parse.
        let huge = "x".repeat(crate::pty::MAX_FRAME_BYTES + 1);
        assert!(decode_desktop_input(&huge).is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(decode_desktop_input("{not json").is_err());
    }

    #[test]
    fn maps_normalized_to_absolute_with_a_nonzero_origin() {
        // source.x=100, width=1920 → 0.5 lands at 100 + 960 = 1060.
        assert_eq!(to_absolute(0.5, 0.5, &source()), (100 + 960, 50 + 540));
        // Clamp: out-of-range input is already clamped at decode, but the pure
        // function must not overflow the source rect either.
        assert_eq!(to_absolute(0.0, 0.0, &source()), (100, 50));
        assert_eq!(to_absolute(1.0, 1.0, &source()), (100 + 1920, 50 + 1080));
    }

    /// A test double so the gate is provable without a display (spec §6.5).
    #[derive(Default)]
    struct CountingInjector {
        pointer_moves: std::sync::atomic::AtomicUsize,
        keys: std::sync::atomic::AtomicUsize,
        fail_next: std::sync::atomic::AtomicBool,
    }
    impl InputInjector for CountingInjector {
        fn pointer_move(&mut self, _x: i32, _y: i32) -> anyhow::Result<()> {
            self.pointer_moves.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_next.swap(false, std::sync::atomic::Ordering::SeqCst) {
                anyhow::bail!("injected failure");
            }
            Ok(())
        }
        fn pointer_button(&mut self, _b: Button, _p: bool) -> anyhow::Result<()> { Ok(()) }
        fn wheel(&mut self, _dx: i32, _dy: i32) -> anyhow::Result<()> { Ok(()) }
        fn key(&mut self, _c: &str, _p: bool, _m: &KeyModifiers) -> anyhow::Result<()> {
            self.keys.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        fn text(&mut self, _t: &str) -> anyhow::Result<()> { Ok(()) }
    }

    #[test]
    fn gate_closed_injects_nothing() {
        // The dispatcher's gate is `cfg.allow_input`; this pins the *decision*
        // function so the gate is unit-tested, not only E2E (spec §6.5).
        let mut injector = CountingInjector::default();
        let mut applied = 0usize;
        for _ in 0..10 {
            if apply_if_allowed(false, frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5 })), &source(), &mut injector) {
                applied += 1;
            }
        }
        assert_eq!(applied, 0);
        assert_eq!(injector.pointer_moves.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn gate_open_injects_once_with_the_mapped_point() {
        let mut injector = CountingInjector::default();
        let applied = apply_if_allowed(true, frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5 })), &source(), &mut injector);
        assert!(applied);
        assert_eq!(injector.pointer_moves.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn injector_error_is_fail_soft() {
        let mut injector = CountingInjector::default();
        injector.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
        // Returns false (nothing applied) but does NOT panic/Err out.
        let applied = apply_if_allowed(true, frame(serde_json::json!({ "kind": "pointer-move", "x": 0.5, "y": 0.5 })), &source(), &mut injector);
        assert!(!applied);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked input::`
Expected: FAIL to compile — `input` module, `DesktopInput`, `InputInjector`, `decode_desktop_input`, `to_absolute`, `apply_if_allowed` do not exist.

- [ ] **Step 3: Write the types, the trait, the decoder, and the mapping**

Create the top of `apps/agent/src/input.rs` (spec §6.1, §6.2):

```rust
//! Desktop input forwarding: the wire decoder, the normalized→absolute mapping,
//! and the `InputInjector` seam (Week 9, spec §6.1).
//!
//! This module is **not** `cfg`-gated: it holds only serde types, pure
//! functions, and a trait — no injection dependency — so it compiles on every
//! target exactly as `pty.rs` does. Only the concrete injector is
//! `cfg(not(target_env = "musl"))` (spec §6.1).

use anyhow::{Context, Result};

use crate::desktop::DesktopSourceInfo;

/// The pointer button on the wire (spec §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button { Left, Middle, Right }

/// Keyboard modifier state (spec §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
pub struct KeyModifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// One decoded input event, mirroring the TS `DesktopInput` union (spec §6.1).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopInput {
    PointerMove { x: f64, y: f64 },
    PointerButton { button: Button, pressed: bool, x: f64, y: f64 },
    Wheel { dx: f64, dy: f64, x: f64, y: f64 },
    Key { code: String, pressed: bool, modifiers: KeyModifiers },
    Text { text: String },
}

/// The seam that makes the gate and the tests possible without a display
/// (ADR-27, ADR-29). One platform implementation sits behind it.
pub trait InputInjector: Send {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()>;
    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()>;
    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()>;
    fn key(&mut self, code: &str, pressed: bool, mods: &KeyModifiers) -> Result<()>;
    fn text(&mut self, text: &str) -> Result<()>;
}

/// The raw payload of a `desktop-input` frame (spec §2.2). The `kind` tag
/// selects which fields are read; serde's internally-tagged enum does the
/// discrimination, so an unknown `kind` is a decode error.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum DesktopInputWire {
    PointerMove { x: f64, y: f64 },
    PointerButton { button: Button, pressed: bool, x: f64, y: f64 },
    Wheel { dx: f64, dy: f64, x: f64, y: f64 },
    Key { code: String, pressed: bool, #[serde(default)] modifiers: KeyModifiers },
    Text { text: String },
}

fn clamp01(n: f64) -> f64 {
    if n.is_nan() { 0.0 } else { n.clamp(0.0, 1.0) }
}

/// Decode an inbound `desktop-input` frame (spec §6.1).
///
/// Same guard shape as `decode_pty_input` (`pty.rs:124`): a size cap checked
/// **before** parsing, then a strict channel/type match. Returns `Ok(None)` for
/// any frame that is not a `desktop-input` on the `control` channel; `Err` when
/// it is but cannot be decoded. Unlike the terminal path the payload is **JSON,
/// not base64** — input is structured, so the reuse is the guard *shape*.
pub fn decode_desktop_input(raw: &str) -> Result<Option<DesktopInput>> {
    if raw.len() > crate::pty::MAX_FRAME_BYTES {
        anyhow::bail!("inbound frame exceeds {} bytes", crate::pty::MAX_FRAME_BYTES);
    }
    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;
    if envelope.channel != "control" || envelope.r#type != "desktop-input" {
        return Ok(None);
    }
    let wire: DesktopInputWire =
        serde_json::from_value(envelope.payload).context("payload is not a DesktopInput")?;
    Ok(Some(match wire {
        DesktopInputWire::PointerMove { x, y } =>
            DesktopInput::PointerMove { x: clamp01(x), y: clamp01(y) },
        DesktopInputWire::PointerButton { button, pressed, x, y } =>
            DesktopInput::PointerButton { button, pressed, x: clamp01(x), y: clamp01(y) },
        DesktopInputWire::Wheel { dx, dy, x, y } =>
            DesktopInput::Wheel { dx, dy, x: clamp01(x), y: clamp01(y) },
        DesktopInputWire::Key { code, pressed, modifiers } =>
            DesktopInput::Key { code, pressed, modifiers },
        DesktopInputWire::Text { text } => DesktopInput::Text { text },
    }))
}

/// Map a normalized (0..1) point to absolute source pixels (spec §6.2, ADR-30).
///
/// `abs = source.x + round(n * source.dimension)`, clamped to the source rect.
/// `scaleFactor` is applied here if the injector's unit differs from xcap's
/// (spec §3.4 — a recorded watch item, settled by Task 1's spike or left to the
/// concrete injector).
pub fn to_absolute(nx: f64, ny: f64, source: &DesktopSourceInfo) -> (i32, i32) {
    let x = source.x + (clamp01(nx) * source.width as f64).round() as i32;
    let y = source.y + (clamp01(ny) * source.height as f64).round() as i32;
    (x, y)
}

/// Apply one frame to the injector iff the gate is open (spec §6.3).
///
/// Returns `true` iff an event was injected. **Fail-soft**: a decode error, a
/// non-input frame, or an injector error all return `false` after logging — the
/// caller continues the session (spec §6.3, §9.4). Pure over its inputs except
/// for the injector, so the gate is unit-testable without a display.
pub fn apply_if_allowed(
    allow_input: bool,
    raw: &str,
    source: &DesktopSourceInfo,
    injector: &mut dyn InputInjector,
) -> bool {
    if !allow_input {
        tracing::debug!("dropping desktop-input: input disabled");
        return false;
    }
    let event = match decode_desktop_input(raw) {
        Ok(Some(event)) => event,
        Ok(None) => return false,
        Err(e) => {
            tracing::debug!(error = %e, "dropping a malformed desktop-input frame");
            return false;
        }
    };
    let result = match event {
        DesktopInput::PointerMove { x, y } => {
            let (ax, ay) = to_absolute(x, y, source);
            injector.pointer_move(ax, ay)
        }
        DesktopInput::PointerButton { button, pressed, x, y } => {
            // Move first so the click lands on the intended point.
            let (ax, ay) = to_absolute(x, y, source);
            injector.pointer_move(ax, ay).and_then(|()| injector.pointer_button(button, pressed))
        }
        DesktopInput::Wheel { dx, dy, x, y } => {
            let (ax, ay) = to_absolute(x, y, source);
            injector.pointer_move(ax, ay).and_then(|()| injector.wheel(dx as i32, dy as i32))
        }
        DesktopInput::Key { code, pressed, modifiers } =>
            injector.key(&code, pressed, &modifiers),
        DesktopInput::Text { text } => injector.text(&text),
    };
    match result {
        Ok(()) => true,
        Err(e) => {
            tracing::debug!(error = %e, "dropping desktop-input after an injector error");
            false
        }
    }
}
```

- [ ] **Step 4: Add the concrete injector (non-musl) — enigo, per Task 1's finding**

Append, gated exactly like the dependency:

```rust
/// The concrete injector, chosen by the ADR-27 spike (Task 1: **enigo**).
/// Non-musl only: the musl artifact is terminal-only and never opens a desktop
/// session (spec §1.2, ADR-15). Enigo is `Send`, so it fits `InputInjector`
/// behind a `Box<dyn>` with no wrapper.
#[cfg(not(target_env = "musl"))]
pub mod platform {
    use super::*;

    pub struct PlatformInjector {
        inner: enigo::Enigo,
    }

    impl PlatformInjector {
        /// Created lazily on the first *allowed* input frame — a host with no
        /// display must not fail the stream merely because input is enabled
        /// (spec §6.3).
        pub fn try_new() -> Result<Self> {
            // On macOS the default pops a GUI permission prompt on first use;
            // the ADR-27 finding says turn it off (the prompt is not ours to
            // trigger from a headless agent).
            #[cfg(target_os = "macos")]
            let settings = enigo::Settings {
                open_prompt_to_get_permissions: false,
                ..enigo::Settings::default()
            };
            #[cfg(not(target_os = "macos"))]
            let settings = enigo::Settings::default();
            Ok(Self { inner: enigo::Enigo::new(&settings)? })
        }
    }

    impl InputInjector for PlatformInjector {
        fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
            use enigo::Mouse;
            self.inner.move_mouse(x, y, enigo::Coordinate::Abs)?;
            Ok(())
        }
        fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
            use enigo::{Button as E, Direction, Mouse};
            let b = match button {
                Button::Left => E::Left,
                Button::Middle => E::Middle,
                Button::Right => E::Right,
            };
            self.inner
                .button(b, if pressed { Direction::Press } else { Direction::Release })?;
            Ok(())
        }
        fn wheel(&mut self, dx: i32, dy: i32) -> Result<()> {
            use enigo::Mouse;
            if dy != 0 {
                self.inner.scroll(dy, enigo::Axis::Vertical)?;
            }
            if dx != 0 {
                self.inner.scroll(dx, enigo::Axis::Horizontal)?;
            }
            Ok(())
        }
        fn key(&mut self, code: &str, pressed: bool, _mods: &KeyModifiers) -> Result<()> {
            use enigo::{Direction, Keyboard};
            // `code` is a physical KeyboardEvent.code; `map_code` (below) is the
            // one code→enigo::Key table. Modifier state is not replayed — the
            // browser sends the modifier keys themselves as `key` frames
            // (ADR-28), so enigo sees the real press/release order.
            let Some(key) = map_code(code) else {
                tracing::debug!(code, "unknown KeyboardEvent.code; dropping key frame");
                return Ok(());
            };
            self.inner
                .key(key, if pressed { Direction::Press } else { Direction::Release })?;
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<()> {
            use enigo::Keyboard;
            self.inner.text(text)?;
            Ok(())
        }
    }

    /// Physical `KeyboardEvent.code` → `enigo::Key` (ADR-28). Letters and digits
    /// map through `Key::Unicode`; the common control/navigation keys use their
    /// dedicated variants. `None` for an unknown code, which the caller logs and
    /// drops (fail-soft, spec §6.3).
    ///
    /// **Do not replace the `Unicode` path with `enigo::Key::A`..`Key::Z` or a
    /// `Digit0`..`Digit9` variant.** In enigo 0.6.1 the letter variants are
    /// `#[cfg(target_os = "windows")]`-only (referencing them on Linux/macOS
    /// does not compile) and there is **no** `DigitN` variant at all. Routing
    /// printable characters through `Unicode` is the only mapping that compiles
    /// on all five agent targets.
    fn map_code(code: &str) -> Option<enigo::Key> {
        use enigo::Key;
        // Printable single characters → `Unicode` (see the doc note above). This
        // covers letters, digits, AND punctuation: enigo has no cross-platform
        // named variant for `,` `.` `/` etc. (`OEMComma`/`OEMPeriod`/`OEMMinus`
        // are `#[cfg(target_os = "windows")]`-only), so `Unicode` is the only
        // mapping that compiles everywhere. The frame's `modifiers` are NOT
        // replayed here — the browser sends the modifier keys themselves as
        // `key` frames (ADR-28), so enigo sees the real order.
        let ch = match code {
            "KeyA" => 'a', "KeyB" => 'b', "KeyC" => 'c', "KeyD" => 'd',
            "KeyE" => 'e', "KeyF" => 'f', "KeyG" => 'g', "KeyH" => 'h',
            "KeyI" => 'i', "KeyJ" => 'j', "KeyK" => 'k', "KeyL" => 'l',
            "KeyM" => 'm', "KeyN" => 'n', "KeyO" => 'o', "KeyP" => 'p',
            "KeyQ" => 'q', "KeyR" => 'r', "KeyS" => 's', "KeyT" => 't',
            "KeyU" => 'u', "KeyV" => 'v', "KeyW" => 'w', "KeyX" => 'x',
            "KeyY" => 'y', "KeyZ" => 'z',
            "Digit0" => '0', "Digit1" => '1', "Digit2" => '2', "Digit3" => '3',
            "Digit4" => '4', "Digit5" => '5', "Digit6" => '6', "Digit7" => '7',
            "Digit8" => '8', "Digit9" => '9',
            // Punctuation. Without these, `,` `.` `/` `;` `'` `` ` `` `[` `]`
            // `\` `-` `=` would hit `_ => return None` and be silently dropped —
            // a real gap when typing into a text field. (`!` `@` `(` … still
            // arrive via Shift+Digit, so only the unshifted punctuation is here.)
            "Comma" => ',', "Period" => '.', "Slash" => '/', "Semicolon" => ';',
            "Quote" => '\'', "Backquote" => '`', "BracketLeft" => '[',
            "BracketRight" => ']', "Backslash" => '\\', "Minus" => '-',
            "Equal" => '=',
            _ => '\0',
        };
        if ch != '\0' {
            return Some(Key::Unicode(ch));
        }

        // Fixed keys with dedicated cross-platform enigo variants. The
        // right-hand modifiers are the `R*` variants (`RShift`/`RControl`).
        let key = match code {
            "Enter" => Key::Return,
            "Escape" => Key::Escape,
            "Backspace" => Key::Backspace,
            "Tab" => Key::Tab,
            "Space" => Key::Space,
            "Delete" => Key::Delete,
            "ArrowUp" => Key::UpArrow,
            "ArrowDown" => Key::DownArrow,
            "ArrowLeft" => Key::LeftArrow,
            "ArrowRight" => Key::RightArrow,
            "Home" => Key::Home,
            "End" => Key::End,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "ShiftLeft" => Key::Shift,
            "ShiftRight" => Key::RShift,
            "ControlLeft" => Key::Control,
            "ControlRight" => Key::RControl,
            "AltLeft" | "AltRight" => Key::Alt,
            "MetaLeft" | "MetaRight" => Key::Meta,
            "CapsLock" => Key::CapsLock,
            _ => return None,
        };
        Some(key)
    }

    #[cfg(test)]
    mod tests {
        use super::map_code;
        use enigo::Key;

        #[test]
        fn map_code_routes_letters_and_digits_through_unicode() {
            // Letters/digits MUST go through `Key::Unicode`: `enigo::Key::A` is
            // `#[cfg(target_os = "windows")]`-only and there is no `DigitN`
            // variant, so `Key::A`/`Key::Digit0` would not compile on Linux or
            // macOS. Do not "optimise" this back to the letter variants.
            assert_eq!(map_code("KeyA"), Some(Key::Unicode('a')));
            assert_eq!(map_code("Digit3"), Some(Key::Unicode('3')));
            // Punctuation also goes through `Unicode` (no cross-platform named
            // variant exists) — without it `,` `.` `=` etc. would be dropped.
            assert_eq!(map_code("Comma"), Some(Key::Unicode(',')));
            assert_eq!(map_code("Equal"), Some(Key::Unicode('=')));
            // Named keys use their dedicated cross-platform variants; the
            // right-hand modifiers are the `R*` ones.
            assert_eq!(map_code("Enter"), Some(Key::Return));
            assert_eq!(map_code("ShiftLeft"), Some(Key::Shift));
            assert_eq!(map_code("ShiftRight"), Some(Key::RShift));
            assert_eq!(map_code("ControlRight"), Some(Key::RControl));
            assert_eq!(map_code("CapsLock"), Some(Key::CapsLock));
            // Unknown codes fail soft (drop, not panic) — spec §6.3.
            assert_eq!(map_code("Nope"), None);
        }
    }
}
```

> **If Task 1 had chosen the per-platform branch**, replace this single `platform` module with three `cfg(target_os = …)` modules (`SendInput` on Windows, `CGEventPost` on macOS, XTest on Linux) — all implementing the same `InputInjector` trait. The trait boundary is exactly what makes the swap one module (ADR-27). Do **not** change `decode_desktop_input`, `to_absolute`, or `apply_if_allowed`.
>
> **Wayland is a recorded limitation, not a silent gap (ADR-27 finding).** The default enigo build is a **silent no-op** on GNOME Wayland (it returns `Ok` and nothing moves); the `wayland` feature is wlroots-only and is **not** enabled. Do not add it. Wayland behaviour is covered by the manual demo (**Task 7**, §8.4 step 5), and — critically — the gate-open E2E asserts the **real seat** via `xdotool`, never enigo's return value (spec §8.3).

- [ ] **Step 5: Add the dependency (only the non-musl section) and register the module**

In `apps/agent/Cargo.toml`, inside `[target.'cfg(not(target_env = "musl"))'.dependencies]` (`:40`), add the crate Task 1 chose — **enigo 0.6.1, default features**:

```toml
# Input injection (ADR-27 finding: enigo, MIT). Non-musl: the musl artifact is
# terminal-only and never injects. Enigo is pure Rust (no vendoring, unlike
# xcap) and in fact builds on musl too — the cfg-gate here is policy, not a
# build constraint. The concrete injector lives in `input::platform`, gated the
# same way.
enigo = "0.6.1"
```

In `apps/agent/src/main.rs`, beside the existing `mod` declarations (near the top, where `mod desktop;`/`mod pty;` live):

```rust
mod input;
```

> **`input` is declared unconditionally** — it must compile on musl (spec §6.1). Only `input::platform` is non-musl.

- [ ] **Step 6: Add `allow_input` to `SessionConfig` and `Cli`**

In `apps/agent/src/main.rs`, `struct SessionConfig` (`:375-395`) gains a field (kept `#[allow(dead_code)]` on musl like its desktop siblings):

```rust
    /// Input forwarding gate (ADR-29). Off by default; inert on musl, where
    /// there is no desktop session (same shape as `desktop_source`).
    #[allow(dead_code)]
    allow_input: bool,
```

`struct Cli` gains the flag beside `desktop_select_timeout_ms` (`:93-94`), mirroring `desktop_source` (`:77-78`):

```rust
    /// Enable remote input injection (mouse + keyboard). OFF by default: this
    /// is the ADR-29 gate, an agent-local opt-in a remote peer cannot set.
    #[arg(long, env = "AGENT_ALLOW_INPUT", default_value_t = false)]
    allow_input: bool,
```

Then wherever `SessionConfig { … }` is constructed (the `Cli` → `SessionConfig` conversion in the supervisor), set `allow_input: cli.allow_input,`.

- [ ] **Step 7: Publish `inputEnabled` and add the dispatcher branch**

**7a.** In `apps/agent/src/desktop.rs`, `frame_desktop_sources` (`:1426-1434`) gains the flag:

```rust
pub fn frame_desktop_sources(
    sources: &[DesktopSourceInfo],
    input_enabled: bool,
    timestamp_ms: i64,
) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-sources".to_string(),
        channel: "control".to_string(),
        payload: serde_json::json!({ "sources": sources, "inputEnabled": input_enabled }),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of plain data cannot fail to serialize")
}
```

Update its unit test (`desktop.rs:2187`, `frame_desktop_sources_carries_the_envelope_and_the_default_flag`) to the new arity and assert `payload.inputEnabled` matches the argument. Update the call site in `main.rs` (`:1242`) to pass `cfg.allow_input`:

```rust
    let sources_frame = desktop::frame_desktop_sources(&sources, cfg.allow_input, crate::pty::now_ms());
```

**7b.** In `apps/agent/src/main.rs`, the control dispatcher's message arm (`:1324-1336`) currently routes `decode_control`. Add the input branch **before** the `decode_control` call, so a `desktop-input` frame never reaches the stream-control decoder:

```rust
                    Some(DataChannelEvent::OnMessage(message)) => {
                        let Ok(text) = std::str::from_utf8(&message.data) else {
                            tracing::debug!("ignoring a non-UTF-8 control frame");
                            continue;
                        };
                        // Input rides the same channel (ADR-26). The gate lives
                        // inside `apply_if_allowed`: closed ⇒ debug-log + drop,
                        // open ⇒ decode + inject, fail-soft either way (§2.3).
                        // The injector is created lazily on the first *allowed*
                        // frame — a host with no display must not fail the
                        // stream merely because input is enabled (§6.3).
                        if text.contains("\"desktop-input\"") {
                            if cfg.allow_input {
                                if injector.is_none() {
                                    match input::platform::PlatformInjector::try_new() {
                                        Ok(i) => injector = Some(Box::new(i)),
                                        Err(e) => tracing::debug!(error = %e, "input enabled but the injector is unavailable"),
                                    }
                                }
                                if let Some(injector) = injector.as_mut() {
                                    input::apply_if_allowed(
                                        cfg.allow_input, text, &current_source, injector.as_mut(),
                                    );
                                }
                            } else {
                                tracing::debug!("dropping desktop-input: input disabled");
                            }
                            continue;
                        }
                        match desktop::decode_control(text) { /* … unchanged … */ }
                    }
```

Declare the two locals before the `loop` in the dispatcher task (beside the Week 8 state):

```rust
        // The injector is built lazily (first allowed input frame) and reused.
        let mut injector: Option<Box<dyn input::InputInjector>> = None;
        // The geometry `to_absolute` maps into. Week 9 uses the source the
        // stream started on; a source swap does NOT update this in Week 9
        // (deferred — see the note below). Do not extend scope to fix it here.
        let current_source = /* the resolved default source (clone) */;
```

> **Why `text.contains("\"desktop-input\"")` and not a second decode.** `decode_control` (`desktop.rs:1373`) already returns `Ok(None)` for an unknown type, so the input frame could be routed by trying `decode_desktop_input` first. The cheap substring guard keeps the two decoders from both parsing every frame; **`apply_if_allowed` is still the only path that decides**, so the guard cannot bypass the gate. If a reviewer prefers, replace the guard with `decode_desktop_input(text)` returning `Ok(Some(_))` — the gate and the fail-soft behaviour are unchanged.
>
> **`current_source` after a swap.** Week 9 maps against the source the session started on. A later `desktop-select` swap changes what is streamed; updating `current_source` on a confirmed swap is **deferred** and recorded as a known limitation (the spec's §3.4 watch item covers the scaled-display half). Do not silently assume the geometry is current — the demo doc (**Task 7**) notes it.

- [ ] **Step 8: Run the tests and the musl build**

Run: `cargo test --manifest-path apps/agent/Cargo.toml --locked input:: && cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS — the 10 input tests + the updated `frame_desktop_sources` test; clippy clean.

Then confirm the musl artifact is unaffected (the `Build Agent / Linux/x64-musl` gate locally, if the target is installed):

```bash
cargo build --manifest-path apps/agent/Cargo.toml --locked --target x86_64-unknown-linux-musl
```

Expected: builds — no injection dependency on musl (`input::platform` is `cfg`-excluded there), and `allow_input` is accepted-but-inert.

- [ ] **Step 9: Commit**

```bash
git add apps/agent/src/input.rs apps/agent/src/main.rs apps/agent/src/desktop.rs apps/agent/Cargo.toml apps/agent/Cargo.lock
git commit -m "feat(agent): desktop input forwarding behind the ADR-29 gate (--allow-input)"
```

> **Residual risks this task does NOT close** (record them in the PR body; do not hide them):
> - **Wayland is unsolved.** The shipped enigo build is a silent no-op on GNOME Wayland (ADR-27 finding) — the feature does not work there. libei/portal is follow-up, not Week 9. **enigo's `Ok` is NOT proof of effect on Wayland** — the gate-open E2E must observe the seat via `xdotool`, never trust the return value.
> - **macOS/Windows runtime injection is unverified.** Those targets must compile and pass unit tests only (`Build Agent / macOS/x64`, `Build Agent / macOS/arm64`, `Build Agent / Windows/x64-msvc`); no CI hardware injects. This mirrors how Week 7/8 left runtime *capture* unverified (spec §1.2, §8.6).
> - **DPR/`scaleFactor` is a watch item** (spec §3.4): `to_absolute` applies `scaleFactor` only if the injector's unit differs from xcap's; a scaled display may land wrong until confirmed. The manual demo (Task 7) exercises it.

---

### Task 5: Web — `toNormalized`, the input toggle + listeners, the store, the footer (D4)

**Files:**
- Create: `apps/web/src/lib/desktop-input.ts` (`toNormalized` — a pure helper)
- Modify: `apps/web/src/components/desktop/DesktopView.vue` (input toggle + listeners)
- Modify: `apps/web/src/stores/terminal.ts` (`TabItem.desktopInputEnabled?`, `sendDesktopInput`, the `onSources` shape change)
- Modify: `apps/web/src/views/WorkspaceView.vue` (footer input indicator)
- Test: `apps/web/src/__tests__/desktop-input.test.ts` (new), `apps/web/src/__tests__/terminal-store.test.ts`, `apps/web/src/__tests__/DesktopView.test.ts`

**Interfaces:**
- Consumes: Task 2's `DesktopInput`/`DesktopSourcesPayload`; Task 3's `DesktopClient.sendInput` + `onSources(payload)`.
- Produces:
  - `toNormalized(clientX, clientY, rect, videoWidth, videoHeight): { x: number; y: number }`
  - `TabItem.desktopInputEnabled?: boolean`
  - store action `sendDesktopInput(tabId: string, event: DesktopInput): void`

> **Default OFF, invisible unless the agent opts in (spec §7.2, ADR-29).** The toggle renders **only** when `tab.desktopInputEnabled === true`. When the gate is closed (production default) the toggle never appears and **no listeners attach** — the element captures nothing. The `<video>` keeps **no `controls`**; the Week 8 `DesktopView.test.ts` assertion stays green.

> **The letterbox math lives in the browser (ADR-30).** The `<video>` uses `object-contain` (`DesktopView.vue:77`), so the stream is letterboxed/pillarboxed. A naive `clientX / rect.width` maps a click on the black bars to a wrong source point. `toNormalized` computes the aspect-fit content box, maps into it, and clamps to `0..1` — so the agent's job is a pure multiplication (Task 4, `to_absolute`).

- [ ] **Step 1: Write the failing `toNormalized` tests**

Create `apps/web/src/__tests__/desktop-input.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { toNormalized } from '../lib/desktop-input';

// A DOMRect is a plain shape for this pure function; build one with the fields
// it reads (left/top/width/height). jsdom's DOMRect works too, but a literal
// keeps the test DOM-free.
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRect;

describe('toNormalized (spec §7.1, ADR-30)', () => {
  it('maps a centred point through a letterbox (wide element)', () => {
    // Element 800×300, video 16:9 (1280×720). Content box is 533.33×300,
    // centred: left offset (800-533.33)/2 = 133.33.
    const { x, y } = toNormalized(133.33 + 266.67, 150, rect(0, 0, 800, 300), 1280, 720);
    expect(x).toBeCloseTo(0.5, 2);
    expect(y).toBeCloseTo(0.5, 2);
  });

  it('maps through a pillarbox (tall element)', () => {
    // Element 300×800, video 16:9. Content box is 300×168.75, centred:
    // top offset (800-168.75)/2 = 315.625.
    const { x, y } = toNormalized(150, 315.625 + 84.375, rect(0, 0, 300, 800), 1280, 720);
    expect(x).toBeCloseTo(0.5, 2);
    expect(y).toBeCloseTo(0.5, 2);
  });

  it('clamps a click on the black bar to the nearest edge', () => {
    // A point in the letterbox band (y above the content box) clamps to y = 0.
    const { x, y } = toNormalized(400, 5, rect(0, 0, 800, 300), 1280, 720);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBe(0);
  });

  it('accounts for the element offset on the page', () => {
    const { x } = toNormalized(200 + 133.33 + 266.67, 100 + 150, rect(200, 100, 800, 300), 1280, 720);
    expect(x).toBeCloseTo(0.5, 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/web test desktop-input`
Expected: FAIL — `../lib/desktop-input` does not exist.

- [ ] **Step 3: Write `toNormalized`**

Create `apps/web/src/lib/desktop-input.ts`:

```typescript
/**
 * Map a pointer position within an `object-contain` <video> to normalized
 * (0..1) source coordinates (Week 9, spec §7.1, ADR-30).
 *
 * The element letterboxes/pillarboxes the stream; this removes that box
 * (aspect-fit, centred) before mapping, so a click on a black bar clamps to an
 * edge instead of landing on a wrong source point.
 */
export function toNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  if (videoWidth <= 0 || videoHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  const videoAspect = videoWidth / videoHeight;
  const rectAspect = rect.width / rect.height;
  // The content box is the largest rect with the video's aspect ratio that
  // fits inside the element, centred.
  let contentW = rect.width;
  let contentH = rect.height;
  if (videoAspect > rectAspect) {
    contentH = rect.width / videoAspect;   // letterbox: bars top/bottom
  } else {
    contentW = rect.height * videoAspect;  // pillarbox: bars left/right
  }
  const offsetX = rect.left + (rect.width - contentW) / 2;
  const offsetY = rect.top + (rect.height - contentH) / 2;
  const x = (clientX - offsetX) / contentW;
  const y = (clientY - offsetY) / contentH;
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
```

- [ ] **Step 4: Extend the store (failing tests first)**

In `apps/web/src/__tests__/terminal-store.test.ts`, the Week 8 mock has `desktopSourcesHandler: ((sources: unknown[]) => void)` (`:15`) and `openDesktopWithSources` (`:102-114`). The shape change lands here. Update the mock + helpers:

```typescript
// The handler now receives a DesktopSourcesPayload (spec §5.3, breaking change).
let desktopSourcesHandler: ((payload: { sources: unknown[]; inputEnabled: boolean }) => void) | null = null;
const desktopSendInput = vi.fn();
// …inside the DesktopClient mock function:
    this.sendInput = desktopSendInput;
```

```typescript
  /** Push a `desktop-sources` payload through the mock client's handler. */
  function emitSources(
    sources: Array<{ id: string; default: boolean }>,
    inputEnabled = false,
  ): void {
    desktopSourcesHandler?.({ sources, inputEnabled });
  }

  async function openDesktopWithSources(
    sources: Array<{ id: string; default: boolean }>,
    inputEnabled = false,
  ) {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');
    emitSources(sources, inputEnabled);
    await nextTick();
    return { store, tabId };
  }
```

Reset `desktopSendInput` in `beforeEach` (`:85-95`). Then the new tests:

```typescript
  it('records desktopInputEnabled from the sources payload', async () => {
    const { store, tabId } = await openDesktopWithSources(
      [{ id: 'monitor:1', default: true }],
      true,
    );
    expect(store.tabs.find((t) => t.id === tabId)?.desktopInputEnabled).toBe(true);
  });

  it('sendDesktopInput forwards to the client for an open desktop tab', async () => {
    const { store, tabId } = await openDesktopWithSources(
      [{ id: 'monitor:1', default: true }],
      true,
    );
    store.sendDesktopInput(tabId, { kind: 'text', text: 'a' });
    expect(desktopSendInput).toHaveBeenCalledWith({ kind: 'text', text: 'a' });
  });

  it('sendDesktopInput is a no-op for a non-desktop or unknown tab', async () => {
    const store = useTerminalStore();
    store.sendDesktopInput('nope', { kind: 'text', text: 'a' });
    expect(desktopSendInput).not.toHaveBeenCalled();
  });

  it('still snaps the picker back on a refused select after the shape change', async () => {
    const { store, tabId } = await openDesktopWithSources(
      [{ id: 'monitor:1', default: true }, { id: 'monitor:2', default: false }],
    );
    store.selectDesktopSource(tabId, 'monitor:2');
    emitStats({ status: { kind: 'select-refused', detail: 'unknown source id' } });
    await nextTick();
    expect(store.tabs.find((t) => t.id === tabId)?.desktopSourceId).toBe('monitor:1');
  });
```

Run: `pnpm --filter @ponter/web test terminal-store`
Expected: FAIL — `desktopInputEnabled`, `sendDesktopInput` do not exist; the handler shape is wrong.

- [ ] **Step 5: Change the store**

In `apps/web/src/stores/terminal.ts`:

**5a.** `TabItem` (`:38-47`) gains a field:

```typescript
  /** Desktop tabs only: true iff the agent's input gate is open (ADR-29). */
  desktopInputEnabled?: boolean;
```

**5b.** The `onSources` handler (`:613-622`) reads the payload (preserving the `confirmedSourceId` rollback):

```typescript
        client.onSources((payload) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (!tab) return;
          tab.desktopSources = payload.sources;
          tab.desktopInputEnabled = payload.inputEnabled;
          const defaultId = payload.sources.find((s) => s.default)?.id;
          if (defaultId) confirmedSourceId = defaultId;
          tab.desktopSourceId ??= defaultId;
        }),
```

The `onStats` handler (`:623-637`) is unchanged — the rollback logic it holds is exactly what the shape change must preserve.

**5c.** A new action beside `setDesktopBitrate` (`:823-831`), and add it to the return object (`:836-843`):

```typescript
  /** Forward one input event to the agent (Week 9, spec §7.3). */
  function sendDesktopInput(tabId: string, event: DesktopInput): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.sendInput(event);
  }
```

```typescript
  return {
    // …
    sendDesktopInput,
  };
```

Import the type: `import type { DesktopInput, … } from '@ponter/shared';`.

- [ ] **Step 6: Extend `DesktopView.vue` (failing tests first)**

In `apps/web/src/__tests__/DesktopView.test.ts`, the Week 8 `desktopTab` helper (`:8-18`) builds a tab; add an `inputEnabled` parameter so the toggle tests read cleanly, then add:

```typescript
  it('renders no input toggle when the agent gate is closed', () => {
    const wrapper = mountDesktop(desktopTab({ desktopInputEnabled: false }));
    expect(wrapper.find('[data-test="desktop-input-toggle"]').exists()).toBe(false);
  });

  it('renders the toggle and attaches no listeners until it is on', async () => {
    const wrapper = mountDesktop(desktopTab({ desktopInputEnabled: true }));
    const toggle = wrapper.find('[data-test="desktop-input-toggle"]');
    expect(toggle.exists()).toBe(true);

    // Before enabling: a pointermove on the video forwards nothing.
    await wrapper.find('video').trigger('pointermove', { clientX: 10, clientY: 10 });
    expect(store.sendDesktopInput).not.toHaveBeenCalled();

    await toggle.setValue(true);
    await wrapper.find('video').trigger('pointermove', { clientX: 10, clientY: 10 });
    expect(store.sendDesktopInput).toHaveBeenCalled();
  });

  it('still renders the <video> with no controls', () => {
    const wrapper = mountDesktop(desktopTab({ desktopInputEnabled: true }));
    expect(wrapper.find('video').attributes('controls')).toBeUndefined();
  });
```

Run: `pnpm --filter @ponter/web test DesktopView`
Expected: FAIL — no `desktop-input-toggle`, no listeners.

- [ ] **Step 7: Add the toggle + listeners to `DesktopView.vue`**

In the `<script setup>` (after `onBitrateChange`, `:61-66`):

```typescript
import { toNormalized } from '@/lib/desktop-input';
import type { DesktopInput, KeyModifiers } from '@ponter/shared';

const inputOn = ref(false);
// Turning the toggle off must also drop the local state, so a later remount
// with the gate closed captures nothing.
watch(() => props.tab.desktopInputEnabled, (enabled) => {
  if (!enabled) inputOn.value = false;
});

function modifiersOf(e: KeyboardEvent | MouseEvent): KeyModifiers {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

function pointOf(e: MouseEvent): { x: number; y: number } {
  const el = videoEl.value;
  if (!el) return { x: 0, y: 0 };
  return toNormalized(e.clientX, e.clientY, el.getBoundingClientRect(), el.videoWidth, el.videoHeight);
}

function onPointerMove(e: PointerEvent): void {
  if (!inputOn.value) return;
  store.sendDesktopInput(props.tab.id, { kind: 'pointer-move', ...pointOf(e) });
}

function onPointerButton(e: PointerEvent, pressed: boolean): void {
  if (!inputOn.value) return;
  const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
  store.sendDesktopInput(props.tab.id, { kind: 'pointer-button', button, pressed, ...pointOf(e) });
}

function onWheel(e: WheelEvent): void {
  if (!inputOn.value) return;
  store.sendDesktopInput(props.tab.id, { kind: 'wheel', dx: e.deltaX, dy: e.deltaY, ...pointOf(e) });
}

function onKey(e: KeyboardEvent, pressed: boolean): void {
  if (!inputOn.value) return;
  // Physical code + modifier state (ADR-28): layout-independent.
  store.sendDesktopInput(props.tab.id, { kind: 'key', code: e.code, pressed, modifiers: modifiersOf(e) });
}
```

In the `<template>`: attach the listeners to the `<video>` **conditionally** and add `tabindex` only when the toggle is on, plus the toggle in the overlay:

```html
    <!-- Input listeners attach only when the operator opted in (ADR-29). -->
    <video
      ref="videoEl"
      autoplay
      muted
      playsinline
      :tabindex="inputOn ? 0 : undefined"
      class="h-full w-full object-contain"
      @pointermove="onPointerMove"
      @pointerdown="onPointerButton($event, true)"
      @pointerup="onPointerButton($event, false)"
      @wheel.prevent="onWheel"
      @keydown="onKey($event, true)"
      @keyup="onKey($event, false)"
    />
```

```html
      <label
        v-if="tab.desktopInputEnabled"
        class="flex items-center gap-1 text-muted-foreground"
      >
        <input
          data-test="desktop-input-toggle"
          type="checkbox"
          :checked="inputOn"
          @change="inputOn = ($event.target as HTMLInputElement).checked"
        />
        <span>Input</span>
      </label>
```

> **Remove the stale comments.** `DesktopView.vue:71` (`<!-- No `controls`: Week 7 is view-only (ADR-18). -->`) and `:80` (`<!-- Control chrome (Week 8). No input forwarding: that is Week 9. -->`) are now wrong — the view is *conditionally* interactive (ADR-26 supersedes ADR-18). Replace them with a comment naming the gate. The `controls` attribute stays absent: the toggle is our own chrome, not the browser's.

> **The `text` frame is wire-complete but has no web producer in Week 9 — deliberately.** The web listeners above cover pointer + `keydown`/`keyup` only (§7.2), which is the accepted Week 9 scope: ASCII/printable input reaches the agent through the `key` frames plus the agent-side `Key::Unicode` mapping (Task 4), so the `text` intent is redundant for plain typing. The `{ kind: 'text' }` frame stays in the shared union (Task 2), the agent decodes and injects it (Task 4, unit-tested), but **no web code emits it** — a real producer needs IME composition/preedit handling, which is a follow-up. The demo doc (**Task 7**) must state this plainly: `text` is agent-tested and wire-complete, **not** demoed end-to-end, and IME is **not** claimed.

- [ ] **Step 8: Footer indicator in `WorkspaceView.vue`**

The Week 8 media line is `:334-343`. Append the input indicator only when the tab reports it:

```html
              Media: H.264 ·
              {{
                terminalStore.activeTab.desktopStats
                  ? `${terminalStore.activeTab.desktopStats.width}×${terminalStore.activeTab.desktopStats.height}`
                  : 'connecting'
              }}
              <template v-if="terminalStore.activeTab.desktopInputEnabled !== undefined">
                · {{ terminalStore.activeTab.desktopInputEnabled ? 'input on' : 'input off' }}
              </template>
```

> When the gate is closed (default) the footer shows the media line alone — the feature is not advertised (spec §7.4). `desktopInputEnabled` is `undefined` until the first `desktop-sources` frame, so the indicator appears only once the agent has reported.

- [ ] **Step 9: Run the web suite**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS — `toNormalized` (4), the store tests, `DesktopView` tests (including the Week 8 "no `controls`" assertion), and `WorkspaceView`; typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/desktop-input.ts apps/web/src/components/desktop/DesktopView.vue \
  apps/web/src/stores/terminal.ts apps/web/src/views/WorkspaceView.vue \
  apps/web/src/__tests__/desktop-input.test.ts apps/web/src/__tests__/terminal-store.test.ts \
  apps/web/src/__tests__/DesktopView.test.ts apps/web/src/__tests__/WorkspaceView.test.ts
git commit -m "feat(web): desktop input toggle, letterbox mapping, and store action"
```

---

### Task 6: E2E — the two gate tests, and the `spawnAgent` env override (D5)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/harness.ts` (`spawnAgent` gains an optional env override)
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (two new tests; the Week 7/8 tests are kept)
- Modify: `.github/workflows/ci-e2e.yml` (add `xvfb` + `xdotool` to the system-dependency step)
- Test: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (run by `pnpm --filter @ponter/webrtc-core test:e2e`)

**Interfaces:**
- Consumes (from Tasks 1–4): the `--allow-input` flag and `AGENT_ALLOW_INPUT` env; the `inputEnabled` field on the `desktop-sources` payload; the `dropping desktop-input: input disabled` debug log line; `--desktop-source test`; the Week 8 `openDesktopPeer`/`openTestDesktopStream` helpers.
- Produces: nothing later code depends on — this is the last code task. (Task 7 is docs only.)

> **The suite is extended, not replaced (spec §8.3).** The existing `desktop.e2e.test.ts` (`describe.skipIf(!isLinux)`, `:63`) keeps every Week 7/8 assertion; the two new tests pin the gate. Both spawn the **production binary**; only the harness sets the flag (spec §8.3).

> **The gate-closed test needs the `debug` log to be observable (spec §8.3).** The drop is logged at `debug` (Task 4, Step 7b), but `spawnAgent` hardcodes `RUST_LOG=info` (`harness.ts:426`) with no env parameter, so the line is filtered out. The assert is **kept, not dropped**: without it the test would still pass if the frame were never delivered at all (a broken wire), so the log is what distinguishes "received and dropped" from "never arrived".

- [ ] **Step 1: Give `spawnAgent` an optional env override**

In `packages/webrtc-core/test/e2e/harness.ts`, `spawnAgent` (`:408-430`) currently merges `{ RUST_LOG: 'info' }`. Add a fourth parameter:

```typescript
/** Spawn the real binary and register it for teardown. */
export function spawnAgent(
  agentId: string,
  credential: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; output: () => string } {
  const spawned = spawnLogged(
    AGENT_BIN,
    [
      '--agent-id',
      agentId,
      '--server',
      WS_URL,
      '--credential',
      credential,
      '--stun',
      '',
      ...extraArgs,
    ],
    // The caller's env overrides the fixed default, so a test can raise the
    // log level (`{ RUST_LOG: 'debug' }`) to observe a `debug` line.
    { cwd: REPO_ROOT, env: { RUST_LOG: 'info', ...env } },
  );
  agents.push(spawned);
  return spawned;
}
```

- [ ] **Step 2: Add a shared `desktopInputFrames` helper (SonarCloud >3%)**

Both gate tests need to send a `desktop-input` frame and read the `desktop-sources` payload's `inputEnabled`. Add one helper beside the Week 8 `openTestDesktopStream` (`:150-171`) rather than repeating the prologue:

```typescript
  /** The `inputEnabled` flag the agent last reported on `desktop-sources`. */
  const inputEnabled = (frames: Array<DataChannelMessage<unknown>>): boolean | undefined => {
    const frame = frames.findLast((f) => f.type === 'desktop-sources');
    return (frame?.payload as { inputEnabled?: boolean } | undefined)?.inputEnabled;
  };

  /** Send one pointer-move at a known normalized point. */
  const sendPointerMove = (
    offerer: PeerConnection,
    x: number,
    y: number,
  ): void => {
    offerer.dataChannels.sendJson('control', 'desktop-input', {
      kind: 'pointer-move',
      x,
      y,
    });
  };
```

- [ ] **Step 3: Add the gate-closed test (the production contract)**

```typescript
  // Review Focus #1, spec §8.3: the default build is INERT. This is the test
  // that protects the shipped behaviour.
  it('receives a desktop-input frame and drops it when the gate is closed', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    // No --allow-input: the default. RUST_LOG=debug so the drop is observable.
    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test'], {
      RUST_LOG: 'debug',
    });
    await waitForAgentOnline(token, agentId);

    const { offerer, packets, controlFrames } = await openDesktopPeer(sessionId, token);
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(false);

      const before = packets.length;
      sendPointerMove(offerer, 0.5, 0.5);

      // (a) the agent logged the drop — proves the frame ARRIVED and was dropped,
      // not that the wire is broken.
      await waitFor(
        () => agent.output().includes('dropping desktop-input'),
        'the agent to log the drop',
        15_000,
      );
      // (b) the session is unharmed: RTP keeps flowing.
      await waitFor(
        () => packets.length > before,
        'continued RTP after a dropped input frame',
        15_000,
      );
      // (c) the gate is still reported closed.
      expect(inputEnabled(controlFrames)).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 4: Add the gate-open test (the injection path)**

**Import first.** This test (and only this one) shells out to `xdotool`. `desktop.e2e.test.ts` does **not** yet import `node:child_process` — `harness.ts` does (`:1`), but that binding is not re-exported. Add at the top of `desktop.e2e.test.ts`, beside the existing imports:

```typescript
import { execFileSync } from 'node:child_process';
```

Then the test:

```typescript
  // Review Focus #1/#4, spec §8.3: with --allow-input, a pointer-move reaches
  // the real seat. Asserted via `xdotool` (XTest under Xvfb), NEVER via enigo's
  // return value — a Wayland/GNOME no-op returns Ok (ADR-27 finding).
  it('injects a pointer-move when the gate is open under Xvfb', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    // The display is provided by the CI step (Step 5); DISPLAY=:99 by convention.
    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99', RUST_LOG: 'debug' },
    );
    await waitForAgentOnline(token, agentId);

    const { offerer, controlFrames } = await openDesktopPeer(sessionId, token);
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(true);

      // Pin the seat to a known origin FIRST. Xvfb's pointer starts at the
      // screen centre (spike: x:960 y:540 on 1920x1080), so a bare
      // "did it leave the origin?" assert would pass even if the injector did
      // nothing — a false green on the one test that proves real injection.
      execFileSync('xdotool', ['mousemove', '0', '0']);

      // Forward a normalized point and assert the EXACT mapped pixel, not just
      // "somewhere". The `test` source is 1280x720 at origin 0,0, so
      // to_absolute(0.25, 0.25) = (round(0.25*1280), round(0.25*720)) =
      // (320, 180). A small tolerance absorbs X11 pointer rounding.
      const [wantX, wantY] = [320, 180];
      sendPointerMove(offerer, 0.25, 0.25);
      await waitFor(
        () => {
          const out = execFileSync('xdotool', ['getmouselocation']).toString();
          // `xdotool getmouselocation` prints `x:NNN y:NNN ...`.
          const x = Number(/x:(\d+)/.exec(out)?.[1]);
          const y = Number(/y:(\d+)/.exec(out)?.[1]);
          return Math.abs(x - wantX) <= 2 && Math.abs(y - wantY) <= 2;
        },
        `the OS pointer to land near (${wantX}, ${wantY})`,
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

> **Why the exact point, not "moved".** Warping to `0,0` then asserting `320,180` proves the *whole* pipeline — normalized intent → `to_absolute` → enigo → XTest → the real X seat. Asserting only "left the origin" cannot distinguish a correct map from a wrong one (e.g. a transposed axis or an off-by-scale error would still leave `0,0`). The `test` source's `x/y = 0` and `scaleFactor = 1.0` make `320,180` the exact expected pixel.
>
> **Local X11 caveat.** Run on a real X session (not Xvfb), this test warps the operator's actual pointer to `0,0` and then `320,180`. That is acceptable for an E2E that must prove real-seat injection; it runs by default only in the CI job (Step 5) and locally only when the operator runs `test:e2e` deliberately. On a **Wayland** host (the common dev default), running this test locally will **fail as expected** — the ADR-27 finding is that the default enigo build is a silent no-op through Xwayland. Run it locally under `xvfb-run -a pnpm --filter @ponter/webrtc-core test:e2e`, or expect the known no-op failure — it is **not** a regression. CI always runs under Xvfb, so the gate is unaffected.

> **The §8.3 fallback, if XTest is unavailable under CI's Xvfb (spec §3.5, §8.3).** If `xdotool`/XTest cannot drive the seat, the test asserts the **injector call** instead, via a test-only seam: gate the `PlatformInjector` behind `#[cfg(feature = "test-injector")]` with a `CountingInjector`, expose the count on a debug line, and assert it. Record in the PR body **which** path was taken. Real-seat injection is then covered by the manual demo (Task 7). This is a stated, bounded trade-off — not a silent skip. The gate-closed test (Step 3) is unaffected either way.

- [ ] **Step 5: Add `xvfb` + `xdotool` to the E2E job**

In `.github/workflows/ci-e2e.yml`, the capture-stack step (`:66-67`) becomes:

```yaml
      - name: Install system dependencies (capture stack + Xvfb)
        run: sudo apt-get update && sudo apt-get install -y pkg-config libclang-dev libxcb1-dev libxrandr-dev libpipewire-0.3-dev libspa-0.2-dev libwayland-dev libegl-dev libgbm-dev libdrm-dev xvfb xdotool
```

Add a step that starts Xvfb before the E2E run and exports `DISPLAY`:

```yaml
      - name: Start Xvfb
        run: |
          Xvfb :99 -screen 0 1920x1080x24 &
          echo "DISPLAY=:99" >> "$GITHUB_ENV"
```

> If adding `xvfb`/`xdotool` is undesirable for the job, the Step 4 fallback applies and is recorded (spec §8.5 says exactly this).

- [ ] **Step 6: Run the full E2E suite**

Run: `cargo build --manifest-path apps/agent/Cargo.toml --locked && pnpm --filter @ponter/webrtc-core test:e2e`
Expected: PASS — the Week 7/8 desktop tests (media + control) plus the two new gate tests, and every other E2E file unchanged. On a host without the capture stack this still builds — `xcap`/`openh264` are runtime-only for `--desktop-source screen`, and this suite always passes `test`.

- [ ] **Step 7: Commit**

```bash
git add packages/webrtc-core/test/e2e/harness.ts packages/webrtc-core/test/e2e/desktop.e2e.test.ts .github/workflows/ci-e2e.yml
git commit -m "test(e2e): pin the input gate (closed = dropped, open = injected under Xvfb)"
```

---

### Task 7: `docs/ARCHITECTURE.md` reconciliation, ADR-18 superseded note, and the recorded demo (D7/D8)

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§8 roadmap `:949-951`, the "Còn lại (Tuần 9 — Spec B)" block)
- Modify: `docs/superpowers/specs/2026-10-01-phase3-week7-desktop-streaming-design.md` (ADR-18, `:163-170` — superseded note)
- Create: `docs/superpowers/specs/2026-10-03-phase3-week9-demo.md` (the recorded demo's checklist and results)
- Modify: (none otherwise — this task runs the gates and records outcomes)

**Interfaces:**
- Consumes: every artifact from Tasks 1–6.
- Produces: the reconciled `ARCHITECTURE.md`, the ADR-18 superseded note, the demo record, the PR.

> **Language.** `docs/ARCHITECTURE.md` is written in Vietnamese — its section headers (`## 8. Lộ trình Triển khai`) establish the file's convention. The additions below are Vietnamese to match, exactly as the Week 7/8 plans' Task 7 did. This is the one place the plan deviates from the global "repo docs stay English" rule, and it is because the rule defers to a file's own convention.

> **The roadmap item is NOT ticked (spec §11.1).** Input ships gated off (ADR-29); the item is annotated **partial**, not done. Verify the current wording before editing: the Week 8 plan (`be8a8c9`) already split the list into a done `##### Tuần 8` block and a `##### Còn lại (Tuần 9 — Spec B)` block (`ARCHITECTURE.md:941-951`). If a later PR re-shaped it, adjust the wording rather than duplicate.

- [ ] **Step 1: Annotate the Week 9 roadmap item as partial (not done)**

In `docs/ARCHITECTURE.md:949-951`, the block currently reads:

```markdown
##### Còn lại (Tuần 9 — Spec B)
- [ ] Điều khiển chuột & bàn phím (input forwarding) — hiện chỉ view-only (ADR-18)
```

Replace it with (the item stays **unchecked** — it is not usable until WS2/WS3; the ADR-18 reference becomes a supersede + gate pointer):

```markdown
##### Tuần 9: Input forwarding (đã có cơ chế, CHƯA dùng được)
- [ ] Điều khiển chuột & bàn phím (input forwarding) — cơ chế + wire đã xong, nhưng **mặc định TẮT** (ADR-29), chỉ bật bằng `--allow-input` cục bộ; chưa dùng được cho tới khi WS2/WS3 xong. (ADR-18 đã bị ADR-26 thay thế; cổng chặn bởi ADR-29)
```

- [ ] **Step 2: Mark ADR-18 superseded in the Week 7 spec**

In `docs/superpowers/specs/2026-10-01-phase3-week7-desktop-streaming-design.md`, `### ADR-18` (`:163-170`) currently ends with its Consequence ("a future week adds an input channel and the corresponding ADR"). Append a superseded note (matching the roadmap annotation):

```markdown
> **Superseded by ADR-26 (Week 9 spec, `docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md`).** The desktop view is no longer *unconditionally* view-only: it is view-only **unless the input gate is open** (ADR-29). Input rides the existing `control` channel; no separate channel was added.
```

- [ ] **Step 3: Confirm the perf table needs no edit (spec §11.3)**

Spec §11.3 records that Week 8's **D8** correction already landed in PR #27 (`be8a8c9`): the false `Desktop stream (Phase 3 target) | 60fps | Hardware H.265` row was replaced by the Week 8 software row + a spike-gated hardware row. **Week 9's D8 needs no perf-table edit.** Verify and move on:

```bash
grep -n "^| Desktop stream" docs/ARCHITECTURE.md
```

Expected: two rows — `Desktop stream (Week 8) | 1080p30 (nền 720p30) | Software H.264 (openh264)` and `Desktop stream (hardware, tương lai) | 60fps | H.264 hardware / AV1 — spike ADR-25, chưa chốt`. No H.265 row. If one is present, that is a Week 8 regression — report it, do not fix it here.

- [ ] **Step 4: Confirm Phase 4's stub is untouched (spec §11)**

Spec §11: Phase 4's stub (`ARCHITECTURE.md:953-955`, `### Phase 4: File Transfer (Tuần 10-11)` + its "Chưa thiết kế" note) is **not** in scope. Confirm the Step 1 edit changed nothing between it and `### Phase 5`.

- [ ] **Step 5: State the security status (spec §11.4)**

Spec §9.3 / §11.4: H3, H2, M7, M8 **remain open** after the Week 9 merge; the gate is a holding pattern until **WS2** (peer identity, closes H3) and **WS3** (enforce `approved`, closes H2). The roadmap's Phase 5 WS1-WS5 list (`ARCHITECTURE.md:961+`) already tracks these — **no new workstream**. Add one line under the Week 9 block so the dependency is explicit:

```markdown
> Input chỉ mở được sau **WS2** (định danh peer — đóng H3) và **WS3** (enforce `approved` — đóng H2). Xem `docs/security/2026-10-01-e2ee-zero-trust-audit.md`.
```

- [ ] **Step 6: Run the full local verification sweep**

Run each, in order, and do not proceed on a red result:

```bash
pnpm lint && pnpm typecheck && pnpm test
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/agent/Cargo.toml --locked
pnpm --filter @ponter/webrtc-core test:e2e
```

Expected: all PASS. This is the local mirror of the CI gates — `CI (Node) / Lint, Typecheck, Format & Node Tests`, `Build Agent / Verify`, `CI (E2E) / Cross-language terminal E2E` — so a green run means CI has no surprise waiting. Also confirm the musl artifact builds (Task 4, Step 8) for `Build Agent / Linux/x64-musl`. (There is no `ci.yml`.)

- [ ] **Step 7: Record the manual demo**

> Manual rows **not gated** — the recorded demo is evidence, not an acceptance criterion (spec §8.6). Follow spec §8.4; save the recording **outside the repo** (a large binary, not committed). Write the checklist and results to `docs/superpowers/specs/2026-10-03-phase3-week9-demo.md`.

```markdown
# Phase 3 Week 9 — Desktop Input Forwarding Demo

**Date:** <YYYY-MM-DD>
**Machine:** Fedora <version>, X11 session (and a Wayland session for step 5)
**Agent:** `ponter-agent --desktop-source screen --allow-input` (build <short sha>)
**Recording:** <path or link outside the repo>

## Status

<Observed / Not observed — if the manual pass was not run, say so plainly and
rely on the automated evidence (E2E gate tests + unit tests). Do not mark a row
observed that was not.>

## Checklist (spec §8.4)

| # | Check | Result |
|---|---|---|
| 1 | Input toggle appears only with `--allow-input` (`inputEnabled: true`) | ✅ / ❌ |
| 2 | Pointer over the video moves the remote cursor to the matching point | ✅ / ❌ |
| 3 | Click, scroll, and type land correctly on the remote screen | ✅ / ❌ |
| 4 | Footer shows `input on` / `input off` | ✅ / ❌ |
| 5 | **Wayland** session: record the outcome honestly (silent no-op on GNOME, ADR-27 finding) | ✅ / ❌ / N/A |
| 6 | **Scaled display** (`scaleFactor != 1`): the pointer lands where clicked (§3.4 caveat) | ✅ / ❌ / N/A |
| 7 | Without `--allow-input`: no toggle, input does nothing (the gate) | ✅ / ❌ |

## Observed

<What actually happened, including the Wayland result (silent no-op is the
expected ADR-27 finding — record it, do not hide it) and the scaled-display
result.>

## Real-screen evidence

<The gate-closed E2E log line (`dropping desktop-input`) and the gate-open
`xdotool` result, or the §8.3 CountingInjector fallback if that path was taken.>

## Notes

<Any deviation; the `current_source`-after-swap limitation (Task 4, Step 7b);
the `scaleFactor` watch item (spec §3.4).>

## Scope notes (state these — do not overclaim)

- **`text` frame:** wire-complete and agent-tested (Task 4), but **no web producer
  in Week 9** — printable ASCII reaches the agent via `key` frames + the
  agent-side `Key::Unicode` mapping. So typing is demoed through `key` frames;
  the `text` path is **not** exercised end-to-end here.
- **IME / composition:** **not** implemented and **not** claimed. A real `text`
  producer needs IME preedit handling — a follow-up.
```

- [ ] **Step 8: Confirm every acceptance criterion (spec §10.2)**

Walk spec §10.2 and tick each against evidence. **No row claims a usable feature** — the AC verify the *mechanism* and the *gate* (Review Focus #5):

| # | Criterion (spec §10.2) | Evidence |
|---|---|---|
| 1 | `cargo test --locked` passes with the new unit tests; musl still builds with no input dependency | Step 6 + `Build Agent / Verify` + `Build Agent / Linux/x64-musl` (Task 4, Step 8) |
| 2 | `pnpm lint && typecheck && test` pass workspace-wide including new surfaces | Step 6 + `CI (Node) / Lint, Typecheck, Format & Node Tests` |
| 3 | E2E: gate closed ⇒ frame received + logged dropped + session streams + `inputEnabled === false`; gate open ⇒ observable injection (or the recorded fallback) + `inputEnabled === true` | Step 6 + `CI (E2E) / Cross-language terminal E2E` (Task 6, Steps 3-4) |
| 4 | Terminal + Week 7/8 desktop E2E suites pass unchanged | Step 6 + `CI (E2E)` (Task 6) |
| 5 | Recorded demo shows input working **only** with `--allow-input` and inert without it; Wayland/scaled outcomes recorded honestly | Step 7 |
| 6 | `ARCHITECTURE.md` records the Week 9 scope, marks ADR-18 superseded, states input ships gated off | Steps 1-5 |

**Explicitly NOT acceptance criteria** (spec §10.2): "input works end-to-end for a real user" (it does not — the gate is closed by default); the ADR-27 spike (a goal that chooses a dependency); closing H3/H2/M7/M8 (WS2/WS3/WS1, still open).

- [ ] **Step 9: Open the PR(s)**

Per the **Branch & PR Strategy** above, open the branches that were actually cut. The FE branch (D1+D2+D4):

```bash
git push -u origin feat/phase3-week9-input-web
gh pr create --base main --title "feat(phase3): Week 9 — desktop input forwarding (web: types, sendInput, toggle)" --body "$(cat <<'EOF'
## Summary

Week 9 FE half: the input wire types (`DesktopInput`, `KeyModifiers`,
`DesktopSourcesPayload`), `DesktopClient.sendInput` with pointer-move
coalescing (60 Hz default), the `onSources` shape change (breaking), the
`toNormalized` letterbox mapping, and the `DesktopView` input toggle + store
action. The toggle renders only when the agent reports `inputEnabled` (ADR-29).

Spec: `docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md`
Plan: `docs/superpowers/plans/2026-10-03-phase3-week9-input-forwarding.md`

## Breaking change

`DesktopClient.onSources` now yields `DesktopSourcesPayload` (sources +
`inputEnabled`), not `DesktopSourceInfo[]` (spec §5.3). Callers updated:
`apps/web/src/stores/terminal.ts`, `packages/desktop-core/test/client.test.ts`,
`apps/web/src/__tests__/terminal-store.test.ts`, `apps/web/src/__tests__/DesktopView.test.ts`.

## Not in scope

The Rust agent (`--allow-input`, `input.rs`) — separate branch `feat/phase3-week9-input-agent`.
EOF
)"
```

The BE branch (D3), then D5 (E2E) and D7/D8 (docs) after the two merge — the same `gh pr create` shape, with the matching title and the plan's `Test plan` checklist. (If the team chose the single-PR route instead, use branch `feat/phase3-week9-input-forwarding` and one PR covering all deliverables, per spec §10.3.)

- [ ] **Step 10: Record the PR number(s) and hand off**

Note the PR URL(s). The demo recording (Step 7) is attached as a PR comment, not committed. No further commits are expected until review.
