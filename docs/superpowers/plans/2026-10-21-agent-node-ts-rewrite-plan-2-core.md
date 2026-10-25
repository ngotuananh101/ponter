# Agent Node/TypeScript Rewrite — Plan 2: The TypeScript Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Rust agent's runtime behaviour — signalling, identity, E2EE, terminal, files, input, and the desktop session — into `apps/agent` as TypeScript, suite by suite, so that every row of the behavioural-parity matrix that Plan 1 did not own is proven by a test in this tree.

**Architecture:** One Node ESM package (`@ponter/agent-node`) whose `src/` mirrors the service boundaries the Rust tree already had. Every module is a pure function or a narrow class with its dependencies passed in; sockets, PTYs, encoders and clocks arrive through interfaces so each file is testable without a live peer, a live pty or a real display. The heavy primitives (E2EE crypto, stream profiles, message types, error codes) are **imported** from `@ponter/shared`, `@ponter/crypto`, `@ponter/webrtc-core` and `@ponter/api-client`, never re-implemented — the reuse map in the spec §3.4 is the authority on which package owns what.

**Tech Stack:** Node.js 24, TypeScript (ESM), werift 0.24.4, `ws`, `node-pty`, `@ponter/{shared,crypto,webrtc-core,api-client}`, `@ponter/agent-native` (Plan 1 Task 4), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md` — §3.3 (packetizer placement), §3.4 (reuse map), §3.5 (the `PeerConnection` inversion, R-S1…R-S4), §4.1–§4.6 (the behaviour inventory), §4.7 (retirements), §6.1 (package layout), §8 (P3–P5), §8.1 (TEST-INTEGRITY), §9.1 (the wire-contract gate), §9.4 (the behavioural-parity gate), §11.1 (Q1–Q5).

**Plan series:** Plan 1 (spike, foundations, the N-API addon) → **Plan 2 (this file — the TS core)** → Plan 3 (desktop integration, Rust retirement, CI, docs). Plan 1 is a hard prerequisite. Plan 2 must land before Plan 3; they must not run in parallel.

**Coverage matrix:** `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md` is the row inventory. Plan 2 owns **49 B-rows**: B1–B14, B18, B20, B22–B24, B27–B30, B34, B36–B56, B58, B59, B61, B62. (An earlier draft said 38; the enumerated list has always summed to 49, and the matrix's Plan-2 rows are exactly those 49 — the figure was carried, never counted. Same defect shape as the R3 split, which was corrected for the same reason.) B19 has no home in any plan (coverage-matrix §4.1 — the two-step option order lives in the addon); Plan 2 owns the *clamp* (B20) and the *decode* (B62) around it, not `applyBitrate`.

---

## Global Constraints

These apply to every task. Most are copied verbatim from the spec; the ones marked **(P2)** are Plan-2-specific consequences established while writing this plan.

- **No Rust fallback.** Nothing here may depend on `cargo`, `apps/agent/target/`, or the Rust binary. The Rust tree stays on disk until Plan 3 and is read as **reference only**.
- **All code, identifiers, comments, commit messages and documentation are in English.** Zero Vietnamese characters in any diff.
- **Commit attribution:** author is `Ngo Tuan Anh <ngotuananh2101@gmail.com>`. **Never** add a `Co-authored-by` trailer of any kind.
- **No credentials in process lists (ADR-13).** Config is env-var-only. The credential travels in the `Authorization` upgrade header and **never** in a URL, a log line, or a frame. The env-var names (`AGENT_ID`, `AGENT_SERVER`, `AGENT_CREDENTIAL`, `STUN_SERVER`, `AGENT_ALLOW_INPUT`, `AGENT_FILES_ROOT`, `AGENT_IDENTITY_PATH`, `AGENT_DESKTOP_PROFILE`, `AGENT_DESKTOP_DEFAULT_SOURCE`, `AGENT_DESKTOP_SOURCE`, `AGENT_DESKTOP_SELECT_TIMEOUT_MS`, `AGENT_DESKTOP_POLL_INTERVAL_MS`, `AGENT_SHELL`, `RUST_LOG`) are the desktop↔agent contract and must not be renamed.
  - **`AGENT_DESKTOP_SOURCE` is not `AGENT_DESKTOP_DEFAULT_SOURCE`.** The former selects the *capture backend* — `screen` (the display) or `test` (a deterministic pattern, which is what CI and the E2E harness set, `main.rs:64`). The latter picks *which source streams before any selection*, `main.rs:72`. An earlier draft of this plan omitted the first and would have made the E2E harness unreproducible against the Node agent.
  - **`AGENT_DESKTOP_SELECT_TIMEOUT_MS` (default 5000, ADR-22) and `AGENT_DESKTOP_POLL_INTERVAL_MS` (defaults to the profile's frame interval, `desktop.rs:582`) are also contract.** The poll interval alone has six dedicated Rust tests (`desktop.rs`), so dropping it would lose tested behaviour, not merely a knob.
  - **`cols` / `rows` are stdin geometry, not env vars.** The Rust binds them as bare clap flags with no `env =` (`main.rs:56-60`) and defaults 80×24. They stay fields on `AgentConfig` — the PTY needs them — but there is no `AGENT_COLS`/`AGENT_ROWS` to read, and an earlier draft inventing those two names would have created a contract the Rust never had.
- **The identity file is written with mode `0o600`.** Non-negotiable. Creation uses `wx` so an existing key is never truncated.
- **The addon must never let a C++ exception cross the FFI boundary, must bounds-check every buffer, and must return errors as JS exceptions with a stable code — never as a crash.** (Consumed here, built in Plan 1 Task 4.)
- **TEST-INTEGRITY:** never delete, skip or weaken a test to make it green. Every test change declares the before→after `it()`/`expect()` counts and the rationale. An undeclared change is BLOCKING.
- **`packages/ui-components/src/components/ui/**` is shadcn-vue generated.** Never edit it.
- **Historical records are not edited.** `docs/superpowers/{specs,plans}/*`, `docs/demos/*`, `docs/spikes/*`, `docs/notes/*`, `docs/security/*` stay as written. This plan may cite them, never edit them.
- **(P2) `rewriteWsScheme` is a new function; `toWsUrl` keeps its contract.** `packages/webrtc-core/src/url.ts` gains a **sibling**, not a behaviour change. `toWsUrl` is a *base-URL* helper whose whole-string trim is correct for its three composer callers (`agent-supervisor.ts:131`, `fleet.ts:103`, `ws-ticket.ts:4`); the agent's `AGENT_SERVER` is already a *complete* WS URL, and the Rust `to_ws_url` splits the `?`/`#` suffix off before trimming so a query value ending in `/` survives. Re-homing the 11 `to_ws_url` tests onto `toWsUrl` would assert semantics it must not gain. **The reason this is a sibling and not a fix, stated so no executor has to hunt for it:** the two implementations disagree on a base URL carrying a query — `http://h/a/?next=/` becomes `ws://h/a/?next=` under `toWsUrl` and `ws://h/a?next=/` under `to_ws_url` — and *both* produce a broken URL if you then append `/api/ws/agent`, because the path lands inside the query value. Fixing that is P6's job at three call sites; Plan 2 must not widen either helper's contract to paper over it.
- **(P2) The agent gets its own reconnect ladder.** `ReconnectBackoff` in `packages/webrtc-core/src/backoff.ts` is `min(initial × 2^n, max) + ±jitter`; the Rust agent is `min(current × 1.5, 2000)` with **integer rounding and no jitter**. These are different mechanisms and the second one is what the signalling server has been tested against. Do **not** reuse `ReconnectBackoff`; do **not** widen it with a `factor` option.
- **(P2) Do not assert fractional milliseconds in the backoff test.** The Rust's own comment scopes its parity test to "the factor, the initial value, the cap and the reset rule — not the fractional milliseconds". The Rust computes `current.as_secs_f64() * 1.5 * 1000` and rounds; the TS computes `currentMs * 1.5` and rounds. Both ladders are **200 → 300 → 450 → 675 → 1013**, and they part at the **sixth** rung: 1520 (TS) versus 1519 (Rust). The mechanism is the f64 *seconds* round-trip, and it is worth stating correctly because an earlier draft got it backwards twice. At the 675 step the two agree — `Math.round(1012.5)` is **1013**, not 1012 (JS rounds half toward `+Infinity`), and the f64 path lands just above the tie at `1012.5000000000002`, which also rounds to 1013. The divergent tie is one rung later, at **1519.5**: TS computes `1013 * 1.5 = 1519.5` exactly and rounds **up to 1520**, while the Rust's `1.013 * 1.5 * 1000` is `1519.4999999999998` and rounds **down to 1519**. So the 675 step is not the divergence — it is the step where the two agree in spite of the tie, and saying otherwise points a future reader at the wrong rung. **Assert `[200, 300, 450, 675]` and the 2000 cap**, exactly as the Rust test does, and assert the later rungs within ±1 ms rather than equal.
- **(P2) `apps/agent/tsconfig.json` must keep `include: ["src/**/*.ts", "test/**/*.ts"]` and `types: ["node"]` through the Rust→Node manifest conversion.** Without `src/**` the typecheck exits 0 having checked nothing; without `types: ["node"]` tsc never loads the hoisted `@types/node` and every `Buffer` reference in `src/` fails as TS2591. A typecheck that cannot fail is not a gate.
- **(P2) Commands assume Plan 1 Task 1 has landed.** Once `apps/agent` is `@ponter/agent-node` with its own `vitest` devDependency and `vitest.config.ts`, the ordinary `./apps/agent/node_modules/.bin/vitest run <file>` works. **Do not copy the `--root apps/agent` workaround** that was necessary only while `apps/agent/package.json` was still the Rust manifest. If the command fails with "no such file", the prerequisite has not landed — stop and say so; do not invent a path.
- **(P2) `ci-node.yml` does not yet run `apps/agent/**`.** Its `paths:` filter omits the directory until Plan 3. Every task's verification therefore runs locally and the report must say so explicitly; a green local suite is the only evidence this plan has.

## Review Focus

The input classes and failure modes the spec implies but no single task's happy-path test exercises. Each line is pinned by a test in the task that owns the code.

1. **A reconnect ladder that resets when it should not.** The Rust supervisor reassigns `BACKOFF_INITIAL` on activity, and after seven rungs holds at 2000 ms indefinitely. A port that resets on every *attempt* instead of on every *successful connection* hammers a downed server at 200 ms forever, and a port that never resets leaves a brief blip costing 2 s on the next connect. Pinned in Task 3 (the "reset only on connect" property) and again in Task 5 (the supervisor wiring).
2. **A frame that is neither a signal, nor ICE config, nor a challenge.** The three parsers each return "not mine" (`null` in TS) rather than throwing, and the cascade order decides whether the ICE push is consumed or logged as malformed — seven warnings per connect if inverted. Pinned in Task 4 (the "one ICE frame produces zero warnings" test) and Task 5 (the cascade order).
3. **An empty-plaintext E2EE frame.** The Rust rejects a 28-byte frame (12 IV + 16 tag) on decrypt while its own `encrypt` happily produces one for `[]`; `@ponter/crypto` accepts it and returns `new Uint8Array(0)`. The TS keeps the round-tripping behaviour. Pinned in Task 7.
4. **A path component that survives every textual check and still escapes the root** — a symlink inside the sandbox pointing anywhere, or a `..` that normalises after `canonicalize`. Pinned in Task 10 (the symlink-escape case), because that is the one case the prefix comparison cannot catch by inspection.
5. **A desktop frame that is identical to the last one, forever.** The static skip forces an encode every `round(fps)` skips; a port that counts *seconds* instead of *frames* stops emitting on a 60 fps host at the wrong cadence, and a port that resets the reference on the forced frame wrong can loop between two hashes. Pinned in Task 13.

---

## File Structure

Locked so implementers cannot disagree about what creates what.

| Path | Responsibility | B-rows |
|---|---|---|
| `apps/agent/src/config.ts` | Env-var resolution into one frozen `AgentConfig`; the credential-missing error; **operator shell resolution** (`resolveShell`, `firstAvailable`, `windowsShellRoots`) | B2, B34, B38, B39, B54, B59 |
| `apps/agent/src/logging/index.ts` | `RUST_LOG` level policy + the target+message noise predicate | B54 |
| `apps/agent/src/signalling/backoff.ts` | The agent's own ladder: factor 1.5, cap 2000, integer ms, no jitter | B3 |
| `apps/agent/src/signalling/constants.ts` | Ping/idle/frame-cap constants — one place, one decision each | B5, B6 |
| `apps/agent/src/signalling/close.ts` | `classifyClose` — 4401/4409 terminal, everything else transient | B4 |
| `apps/agent/src/signalling/messages.ts` | Re-exports the `@ponter/shared` unions plus the ICE/challenge payload types; no local copies of signal types | B1, B7 |
| `apps/agent/src/signalling/inbound.ts` | The three-parser cascade: challenge → ICE → signal | B1, B6, B7 |
| `apps/agent/src/signalling/client.ts` | `ws` socket: upgrade header, run loop, ping/flush, close handling | B1, B2, B4, B5, B6, B7 |
| `apps/agent/src/signalling/auth.ts` | `isAuthFatal` — 401 or `UNAUTHORIZED`; a 403 is not fatal | R3 (the api.rs pair) |
| `apps/agent/src/session/peer.ts` | werift answerer wiring: ICE config, PT selection, DC label gate | B10, B11, B12, B13, B27 |
| `apps/agent/src/session/ice.ts` | TURN/TCP filtering, `mapIceServers`, H.264 PT selection, m-line index | B10, B11, B12 |
| `apps/agent/src/session/identity-proof.ts` | The five ordered offer-proof failures; `advertisesE2ee` | B8, B9, B55 |
| `apps/agent/src/session/packetizer.ts` | **Already written in Plan 1 Task 3.** Do not recreate. | B26 |
| `apps/agent/src/session/data-channels.ts` | Channel-label gate, envelope unwrap, dispatch to the terminal/files/desktop handlers, the outbound `send` | B13 |
| `apps/agent/src/identity/store.ts` | Ed25519 PKCS#8 file, mode 0600, base64 raw public key, sign | B47, B48 |
| `apps/agent/src/identity/frame.ts` | `buildAgentIdentityFrame` — the WS2 challenge answer | B47, B55 |
| `apps/agent/src/e2ee/manager.ts` | hello/ack handshake over `@ponter/crypto` | B49–B52 |
| `apps/agent/src/terminal/shell-policy.ts` | Allowlist for *peer-requested* shells | B36, B37 |
| `apps/agent/src/terminal/pty.ts` | `node-pty` wrapper, base64 16 KiB chunking, exit reaping, 10-session limit | B39, B40, B41 |
| `apps/agent/src/files/sandbox.ts` | The 7-step containment algorithm | B44 |
| `apps/agent/src/files/protocol.ts` | The 25-byte binary header, chunk arithmetic, the constants | B42, B43 |
| `apps/agent/src/files/session.ts` | Transfer state machine: window, ack batching, resume, pause. **Modified after Task 11** by Task 20's four transfer repairs (`0a3f900`) and Task 22's decode-boundary validation (`2e3f763`) | B42, B43, B45, B46 |
| `apps/agent/src/input/decode.ts` | Input JSON decode, 0..1 clamp, 120 Hz limiter, agent-local gate | B28, B29, B30, B34 |
| `apps/agent/src/desktop/static-skip.ts` | Frame signature + skip counters | B22 |
| `apps/agent/src/desktop/timing-ring.ts` | The 32-frame timing ring and its two medians | B24 |
| `apps/agent/src/desktop/sustain.ts` | The quality ladder | B18, B23 |
| `apps/agent/src/desktop/control.ts` | Bitrate clamp, `DesktopSelectMessage` decode, `StreamControl` | B20, B62 |
| `apps/agent/src/desktop/frames.ts` | `desktop-stats`, `desktop-cursor`, `desktop-sources` frame builders | B56, B58, B61 |
| `apps/agent/src/desktop/session.ts` | Capture → downscale → encode → packetize → send loop | B14, B59 |
| `apps/agent/src/runtime.ts` | Lifecycle: start / stop / status; the tick driver's interval handles (MAJOR-1) | B53 |
| `apps/agent/src/index.ts` | Public surface: `createAgentRuntime` | — |
| `packages/shared/src/types/stream-profile.ts` | **Modify (Plan 1 owns it).** Add `export type ProfileId = (typeof STREAM_PROFILES)[number]['id']` beside `StreamProfile`. Five modules here import it by name; without it every `ProfileId` reference in this plan is an unresolved type. | B18, B20, B24, B56, B62 |
| `packages/webrtc-core/src/url.ts` | **Modify.** Add `rewriteWsScheme` beside `toWsUrl` | B2 |
| `packages/webrtc-core/test/url.test.ts` | **Modify.** Add the `rewriteWsScheme` describe block (12 cases) | B2 |
| `packages/api-client/test/agent-api-access-gate.test.ts` | **Modify.** Re-point at the TS agent tree — **landed as Task 21** (`0b471e0`) | R3, R6 |
| `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md` | **Modify.** Flip Plan 2's rows to "Covered" with their test file | §9.4 gate |

**Not created here:** `apps/agent/src/session/packetizer.ts` (Plan 1 Task 3), `apps/agent/native/**` (Plan 1 Task 4), `apps/agent/spike/**` (Plan 1 Task 1), `apps/desktop/**` supervisor rewiring (Plan 3), `.github/workflows/**` (Plan 3).

**One correction to Plan 1's text, recorded here so the next reader does not re-derive it:**

> Plan 1's Task 5 TEST-INTEGRITY declaration for
> `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` said
> "1 `it()` → 2 `it()`". That baseline was wrong. The file at `453a779`
> already had **2** `it()` and **4** `expect()`; after the rewrite it has
> **2** `it()` and **2** `expect()`. The two removed `expect()` were guards
> inside the `rustProfileNames()` regex helper (`start > -1`, `end > start`),
> which protected a mechanism the rewrite deletes. Removing them is correct,
> not a weakening. **The declaration is 2→2 `it()`, 4→2 `expect()`, with the
> rationale "the regex helper the two guards protected is gone".** The
> implementer caught this; PM verified it independently against `git show
> 453a779:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts`.

**One arithmetic correction to the coverage matrix (R3), recorded here because Plan 2 executes it:**

> Coverage-matrix R3 says `api.rs`'s 20 tests split into "7 retired, 13 live".
> The counts are right; the *two-way shape* is what is wrong.
>
> PM re-derived the split by classifying all 20 `#[test]` functions in
> `apps/agent/src/api.rs` by the symbol each one exercises, at `453a779`:
>
> | target | count | tests |
> |---|---|---|
> | `to_ws_url` | **11** | `rewrites_http_to_ws`, `rewrites_https_to_wss`, `passes_ws_schemes_through`, `trims_trailing_slashes`, `does_not_append_a_path`, `preserves_a_ws_query_value_ending_in_slash`, `rewrites_https_with_a_query_value_ending_in_slash`, `trims_a_path_slash_before_the_query_without_altering_it`, `preserves_a_fragment_suffix_unchanged`, `rejects_an_unknown_scheme`, `the_cli_default_normalizes_to_itself` |
> | `with_bearer` | **2** | `sets_the_authorization_header`, `rejects_a_credential_with_a_control_character` |
> | `ApiError` | **7** | `parses_the_error_envelope`, `parses_an_object_details_field`, `falls_back_to_api_error_when_code_is_absent`, `non_json_body_with_a_status_is_api_error_not_network_error`, `network_has_no_status_and_the_network_sentinel`, `auth_fatal_on_401_or_unauthorized_code`, `not_auth_fatal_on_other_failures` |
> | | **20** | 11 + 2 + 7 |
>
> So the 7 that touch `ApiError` are exactly the 7 the matrix calls retired. The
> matrix's own parenthetical — "`from_response` ×4, `network` ×1, `is_auth_fatal`
> ×2" — also sums correctly to 7. But two of those seven
> (`auth_fatal_*`) assert **live behaviour**: a 401 or `UNAUTHORIZED` code is
> auth-fatal and a 403 is not, which is the classifier issue #107 / PR #110
> established and which `apps/agent/src/signalling/auth.ts` (Task 5) must carry.
> Their Rust test retires with `ApiError`; their assertion must not.
>
> **Ruling: the split is THREE-WAY — 13 re-homed / 2 ported-then-retired / 5 retired**
> (13 + 2 + 5 = 20). The 13 re-homed are the 11 `to_ws_url` tests and the 2
> `with_bearer` tests. The 2 ported-then-retired are `auth_fatal_on_401_or_unauthorized_code`
> and `not_auth_fatal_on_other_failures` — ported to Task 5 *before* the Rust test
> retires. The 5 plain-retired are the other `ApiError` tests.
>
> A two-way split cannot express this, and that is why the number kept moving: calling the
> auth-fatal pair "retired" undercounts live coverage, and calling it "re-homed" overcounts
> the re-homed side. Both descriptions are locally true and the pair is neither purely one
> nor the other.
>
> **Why this matters and is not pedantry:** an earlier draft of this plan claimed
> "8 retired, 12 live" on the strength of a hand-count that put `to_ws_url` at 10.
> It is 11 — so 13 live tests exist before the auth-fatal pair is counted at all, and
> no partition of 20 yields 12. The error was invisible because the arithmetic still
> summed to 20: a miscount in one bucket offset by a miscount in another is the hardest
> kind of error to catch by eye. BA re-derived the same 11/2/7 independently, from the
> tree, after this plan's first correction was written — two independent derivations
> agreeing is the only thing that settles a count like this.
>
> **`to_ws_url`'s 11 tests do NOT re-home onto `toWsUrl`** — the ruling is stated
> in full in **Global Constraints (P2)** above, and repeated here only because this
> is the paragraph an executor reads when deciding where a test goes. They re-home onto the new
> `rewriteWsScheme`, because `toWsUrl`'s whole-string trim has different
> semantics: the two implementations disagree on a base URL that carries a query
> or a fragment (`http://h/a/?next=/` → `ws://h/a/?next=` vs `ws://h/a?next=/`).

---

### Task 1: Config resolution and the logger

**Files:**
- Create: `apps/agent/src/config.ts`
- Create: `apps/agent/src/logging/index.ts`
- Test: `apps/agent/test/config.test.ts`, `apps/agent/test/logging/index.test.ts`

**Interfaces:**
- Consumes: `StreamProfile` and `STREAM_PROFILES` from `@ponter/shared` (Plan 1 Task 5).
- Produces:
  - `interface AgentConfig { agentId; server; credential; shell; identityPath; stun; cols; rows; allowInput; filesRoot; desktopProfile: StreamProfile; desktopDefaultSource: string; desktopSource: 'screen' | 'test'; desktopSelectTimeoutMs: number; desktopPollIntervalMs: number | null }` — `desktopPollIntervalMs: null` means "use `desktopProfile.fps`'s frame budget", which is what the Rust does: `parse_poll_interval` falls back to `profile.frame_budget()` (`desktop.rs:567-584`). `null` rather than a pre-computed number so the config stays a pure env mapping and the 16 667 µs of a 60 FPS budget never gets rounded to 17 ms here.
  - `function loadConfig(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): AgentConfig` — throws `AgentConfigError` with `code: 'MISSING_CREDENTIAL' | 'UNKNOWN_PROFILE' | 'UNKNOWN_DESKTOP_SOURCE'`; never returns a partially-resolved object. `platform` is the seam the Windows shell detection needs — passing it defaults to `process.platform` and exists so the shell-order tests run on any host, exactly as the Rust split `resolve_shell_value` out of `resolve_shell` (`main.rs:145-176`).
  - `function firstAvailable<T>(preference: readonly string[], resolve: (name: string) => T | undefined): T | undefined` — the Rust's `first_available` (`main.rs:169-182`), generic over the resolved value so a caller can return a path rather than a bare name.
  - `const WINDOWS_SHELL_PREFERENCE: readonly ['pwsh', 'powershell', 'cmd.exe']` and `function windowsShellRoots(env: NodeJS.ProcessEnv): string[]` — the well-known install roots (`main.rs:186-218`), which exist because the PowerShell 7 MSI does not always add its directory to `PATH`.
  - `function resolveShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe?: (name: string, roots: string[]) => string | undefined): string` — `AGENT_SHELL`, then `SHELL`, then the platform default (`/bin/sh` on unix, the detected Windows shell, then `cmd.exe`).
  - `function isNoise(target: string, message: string): boolean`
  - `function createLogger(env: NodeJS.ProcessEnv): Logger` where `interface Logger { error; warn; info; debug }` and each takes `(fields: Record<string, unknown>, message: string)`.

- [ ] **Step 1: Write the failing config test**

```ts
// apps/agent/test/config.test.ts
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_SHELL_PREFERENCE,
  firstAvailable,
  loadConfig,
  resolveShell,
  windowsShellRoots,
} from '../src/config.js';

const base = {
  AGENT_ID: 'a1',
  AGENT_CREDENTIAL: 'ag_secret',
  SHELL: '/bin/bash',
  HOME: '/home/u',
};

describe('loadConfig', () => {
  it('applies every documented default', () => {
    const c = loadConfig({ ...base });
    expect(c.server).toBe('ws://localhost:8787/api/ws/agent');
    expect(c.stun).toBe('stun:stun.l.google.com:19302');
    expect(c.cols).toBe(80);
    expect(c.rows).toBe(24);
    expect(c.allowInput).toBe(false);
    expect(c.filesRoot).toBeNull();
    expect(c.desktopProfile.id).toBe('1080p30');
  });

  it('defaults the identity path under XDG_CONFIG_HOME when set', () => {
    const c = loadConfig({ ...base, XDG_CONFIG_HOME: '/xdg' });
    expect(c.identityPath).toBe('/xdg/ponter/agent-identity.pkcs8');
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME is unset', () => {
    const c = loadConfig({ ...base });
    expect(c.identityPath).toBe('/home/u/.config/ponter/agent-identity.pkcs8');
  });

  it('refuses to start without a credential, naming both sources', () => {
    expect(() => loadConfig({ ...base, AGENT_CREDENTIAL: undefined })).toThrowError(
      /no agent credential: set AGENT_CREDENTIAL/,
    );
  });

  it('rejects an unknown desktop profile rather than defaulting silently', () => {
    expect(() => loadConfig({ ...base, AGENT_DESKTOP_PROFILE: '1440p' })).toThrowError(
      /unknown desktop profile "1440p"/,
    );
  });

  it('reads the agent-local input gate, which no peer can flip', () => {
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: '1' }).allowInput).toBe(true);
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: '0' }).allowInput).toBe(false);
    expect(loadConfig({ ...base, AGENT_ALLOW_INPUT: 'true' }).allowInput).toBe(true);
  });

  it('leaves filesRoot null when the env var is empty', () => {
    expect(loadConfig({ ...base, AGENT_FILES_ROOT: '' }).filesRoot).toBeNull();
  });

  it('defaults the capture backend to the screen and accepts the test pattern', () => {
    expect(loadConfig({ ...base }).desktopSource).toBe('screen');
    expect(loadConfig({ ...base, AGENT_DESKTOP_SOURCE: 'test' }).desktopSource).toBe('test');
  });

  it('rejects an unknown capture backend rather than falling back to the screen', () => {
    expect(() => loadConfig({ ...base, AGENT_DESKTOP_SOURCE: 'window' })).toThrowError(
      /unknown desktop source "window"/,
    );
  });

  it('defaults the selection timeout to 5000 ms and reads an explicit one', () => {
    expect(loadConfig({ ...base }).desktopSelectTimeoutMs).toBe(5000);
    expect(loadConfig({ ...base, AGENT_DESKTOP_SELECT_TIMEOUT_MS: '250' }).desktopSelectTimeoutMs).toBe(
      250,
    );
  });

  it('leaves the poll interval null unless one is set, so the profile budget applies', () => {
    expect(loadConfig({ ...base }).desktopPollIntervalMs).toBeNull();
    expect(loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: '16' }).desktopPollIntervalMs).toBe(
      16,
    );
  });

  it('treats a zero or unparseable poll interval as unset, not as a spin loop', () => {
    expect(loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: '0' }).desktopPollIntervalMs).toBeNull();
    expect(
      loadConfig({ ...base, AGENT_DESKTOP_POLL_INTERVAL_MS: 'soon' }).desktopPollIntervalMs,
    ).toBeNull();
  });

  // --- operator shell resolution (B38) ---
  // The six `main.rs` tests for this surface were assigned to Plan 2 by the
  // coverage matrix and deferred to Plan 3 by Task 9. They live here instead:
  // this is config-time resolution, the same moment the Rust's `main` did it.

  it('an explicit AGENT_SHELL always wins over detection, on every platform', () => {
    expect(loadConfig({ ...base, AGENT_SHELL: '/usr/bin/fish' }, 'linux').shell).toBe('/usr/bin/fish');
    expect(loadConfig({ ...base, AGENT_SHELL: 'pwsh.exe' }, 'win32').shell).toBe('pwsh.exe');
  });

  it('on unix falls back to $SHELL and then to /bin/sh', () => {
    expect(loadConfig({ ...base, SHELL: '/usr/bin/zsh' }, 'linux').shell).toBe('/usr/bin/zsh');
    expect(loadConfig({ AGENT_CREDENTIAL: 'ag_x' }, 'linux').shell).toBe('/bin/sh');
  });

  it('prefers the Windows shells in order and stops at the first hit', () => {
    const resolve = (present: readonly string[]) => (name: string) =>
      present.includes(name) ? `C:\\found\\${name}` : undefined;
    // cmd.exe being present must not shadow a pwsh that is also installed.
    expect(firstAvailable(WINDOWS_SHELL_PREFERENCE, resolve(['cmd.exe']))).toBe('C:\\found\\cmd.exe');
    expect(firstAvailable(WINDOWS_SHELL_PREFERENCE, resolve(['pwsh', 'cmd.exe']))).toBe(
      'C:\\found\\pwsh',
    );
    expect(firstAvailable(WINDOWS_SHELL_PREFERENCE, resolve(['powershell', 'cmd.exe']))).toBe(
      'C:\\found\\powershell',
    );
    expect(firstAvailable(WINDOWS_SHELL_PREFERENCE, () => undefined)).toBeUndefined();
  });

  it('carries a resolved absolute path through, not the bare name', () => {
    const pref = ['pwsh', 'powershell', 'cmd.exe'];
    const resolved = firstAvailable(pref, (name) =>
      name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : undefined,
    );
    expect(resolved).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('finds PowerShell 7 in its install root when it is not on PATH', () => {
    // The MSI does not always add its directory to PATH, so a PATH-only probe
    // would fall through to the older powershell.exe — the case the Rust's
    // `windows_shell_roots` exists for.
    const env = { ProgramFiles: 'C:\\Program Files' };
    const roots = windowsShellRoots(env);
    expect(roots[0]).toBe('C:\\Program Files\\PowerShell\\7');
    expect(roots).toContain('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
    expect(resolveShell({ ...base }, 'win32', (name, _roots) =>
      name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : undefined,
    )).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('falls back to cmd.exe only when nothing else resolves', () => {
    expect(resolveShell({ ...base }, 'win32', () => undefined)).toBe('cmd.exe');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./apps/agent/node_modules/.bin/vitest run test/config.test.ts`
Expected: FAIL — `Failed to resolve import "../src/config.js"`.

- [ ] **Step 3: Implement `config.ts`**

```ts
// apps/agent/src/config.ts
import { STREAM_PROFILES, type StreamProfile } from '@ponter/shared';
import { existsSync } from 'node:fs';

export type AgentConfigErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'UNKNOWN_PROFILE'
  | 'UNKNOWN_DESKTOP_SOURCE';

export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  constructor(code: AgentConfigErrorCode, message: string) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
  }
}

export interface AgentConfig {
  readonly agentId: string;
  readonly server: string;
  readonly credential: string;
  readonly shell: string;
  readonly identityPath: string;
  readonly stun: string;
  readonly cols: number;
  readonly rows: number;
  readonly allowInput: boolean;
  readonly filesRoot: string | null;
  readonly desktopProfile: StreamProfile;
  readonly desktopDefaultSource: string;
  /** `AGENT_DESKTOP_SOURCE` (`main.rs:64`): which frame source the agent captures. */
  readonly desktopSource: 'screen' | 'test';
  /** `AGENT_DESKTOP_SELECT_TIMEOUT_MS` (`main.rs:80`, ADR-22), default 5000. */
  readonly desktopSelectTimeoutMs: number;
  /** `AGENT_DESKTOP_POLL_INTERVAL_MS`; `null` means the profile's frame budget. */
  readonly desktopPollIntervalMs: number | null;
}

const DEFAULT_SERVER = 'ws://localhost:8787/api/ws/agent';
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const DEFAULT_PROFILE = '1080p30';
const DEFAULT_SOURCE = 'primary';
const DEFAULT_DESKTOP_SOURCE = 'screen';
const DEFAULT_SELECT_TIMEOUT_MS = 5000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The two capture backends the Rust's `DesktopSource` enum accepts (`lib.rs:427`). */
const DESKTOP_SOURCES = ['screen', 'test'] as const;

/** `1`/`true`/`yes` on, anything else off. Off is the default: the gate is opt-in. */
function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A positive integer or `null` — the shape of an optional interval.
 *
 * The Rust treats an absent, empty, zero or unparseable value as "use the
 * fallback" (`desktop.rs:567-572`), and a zero interval is a busy loop, so `0`
 * is normalized to `null` here rather than surfacing as a spin.
 */
function envOptionalInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the agent's configuration from the environment only.
 *
 * There is no CLI: the desktop supervisor passes every value as an env var, and
 * a credential on argv would be visible in `ps` (ADR-13). Every fallback here is
 * a value the Rust CLI also defaulted to, so a deployment that sets nothing
 * behaves exactly as before.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AgentConfig {
  const credential = env.AGENT_CREDENTIAL?.trim();
  if (!credential) {
    throw new AgentConfigError(
      'MISSING_CREDENTIAL',
      'no agent credential: set AGENT_CREDENTIAL (the value is ag_...)',
    );
  }

  const profileName = env.AGENT_DESKTOP_PROFILE?.trim() || DEFAULT_PROFILE;
  const desktopProfile = STREAM_PROFILES.find((p) => p.id === profileName);
  if (!desktopProfile) {
    const known = STREAM_PROFILES.map((p) => p.id).join(', ');
    throw new AgentConfigError(
      'UNKNOWN_PROFILE',
      `unknown desktop profile "${profileName}"; expected ${known}`,
    );
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || `${env.HOME ?? ''}/.config`;

  const rawSource = env.AGENT_DESKTOP_SOURCE?.trim() || DEFAULT_DESKTOP_SOURCE;
  if (!(DESKTOP_SOURCES as readonly string[]).includes(rawSource)) {
    throw new AgentConfigError(
      'UNKNOWN_DESKTOP_SOURCE',
      `unknown desktop source "${rawSource}"; expected ${DESKTOP_SOURCES.join(', ')}`,
    );
  }
  const desktopSource = rawSource as 'screen' | 'test';

  return Object.freeze({
    agentId: env.AGENT_ID?.trim() ?? '',
    server: env.AGENT_SERVER?.trim() || DEFAULT_SERVER,
    credential,
    shell: resolveShell(env, platform),
    identityPath:
      env.AGENT_IDENTITY_PATH?.trim() || `${configHome}/ponter/agent-identity.pkcs8`,
    stun: env.STUN_SERVER ?? DEFAULT_STUN,
    // `--cols`/`--rows` are clap flags with no `env =` (`main.rs:56-60`) and the
    // supervisor never passes them, so these are constants, not env reads. The
    // PTY still needs an initial geometry and the renderer resizes it on attach.
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    allowInput: envFlag(env.AGENT_ALLOW_INPUT),
    filesRoot: env.AGENT_FILES_ROOT?.trim() ? env.AGENT_FILES_ROOT.trim() : null,
    desktopProfile,
    desktopDefaultSource: env.AGENT_DESKTOP_DEFAULT_SOURCE?.trim() || DEFAULT_SOURCE,
    desktopSource,
    desktopSelectTimeoutMs: envInt(
      env.AGENT_DESKTOP_SELECT_TIMEOUT_MS,
      DEFAULT_SELECT_TIMEOUT_MS,
    ),
    desktopPollIntervalMs: envOptionalInt(env.AGENT_DESKTOP_POLL_INTERVAL_MS),
  });
}

// --- operator shell resolution (B38) ---
// Ported from `main.rs:145-260`. This is a config-time concern, so it lives in
// `config.ts` rather than in the terminal package: the value it produces is a
// field of `AgentConfig`, and the shell *policy* that governs peer-requested
// shells is a different thing entirely (Task 9's `ShellPolicy`).

/** Windows shells in preference order (`main.rs:185`). */
export const WINDOWS_SHELL_PREFERENCE = ['pwsh', 'powershell', 'cmd.exe'] as const;

/**
 * The first candidate `resolve` yields a value for, in order.
 *
 * Pure, so the ordering is testable without a real `PATH` or filesystem, and
 * generic over the resolved type so a caller can return an absolute path
 * rather than the bare name (`main.rs:169-182`).
 */
export function firstAvailable<T>(
  preference: readonly string[],
  resolve: (name: string) => T | undefined,
): T | undefined {
  for (const name of preference) {
    const resolved = resolve(name);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Directories where a Windows shell may live without being on `PATH`.
 *
 * `pwsh` is the case that matters: the MSI installs to
 * `C:\Program Files\PowerShell\7\` and does not always add that directory to
 * `PATH`, so a `PATH`-only probe would miss PowerShell 7 and fall through to
 * the older `powershell.exe` (`main.rs:186-207`).
 */
export function windowsShellRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    'C:\\Program Files\\PowerShell\\7',
    'C:\\Program Files\\PowerShell\\7-preview',
  ];
  const programFiles = env.ProgramFiles?.trim();
  if (programFiles) {
    roots.push(`${programFiles}\\PowerShell\\7`, `${programFiles}\\PowerShell\\7-preview`);
  }
  const programFilesX86 = env['ProgramFiles(x86)']?.trim();
  if (programFilesX86) {
    roots.push(`${programFilesX86}\\PowerShell\\7`);
  }
  roots.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  return roots;
}

/**
 * Resolve the operator's shell from the environment.
 *
 * `AGENT_SHELL` wins unconditionally — a pinned value must never be overridden
 * by detection, or existing deployments would silently change shell. Then
 * `$SHELL`, then the platform default. On Windows the default is the first
 * shell found in preference order, falling back to the bare `cmd.exe`, which
 * `CreateProcess` resolves to `%SystemRoot%\System32\cmd.exe` (`main.rs:155-176`).
 *
 * `probe` exists so the Windows path is unit-testable on any host; production
 * passes nothing and gets a real `PATH` + install-root probe.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probe?: (name: string, roots: string[]) => string | undefined,
): string {
  const explicit = env.AGENT_SHELL?.trim();
  if (explicit) return explicit;

  if (platform !== 'win32') {
    return env.SHELL?.trim() || '/bin/sh';
  }

  const resolve = probe ?? resolveWindowsShell;
  const roots = windowsShellRoots(env);
  return firstAvailable(WINDOWS_SHELL_PREFERENCE, (name) => resolve(name, roots)) ?? 'cmd.exe';
}

/**
 * Locate one Windows shell, preferring a `PATH` hit and falling back to the
 * well-known install roots (`main.rs:213-260`).
 *
 * The result is always an absolute path so node-pty never has to guess, and it
 * is returned unmodified — this value is an executable, not a command line, so
 * there is no interpolation of user input here.
 */
function resolveWindowsShell(name: string, roots: string[]): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue;
    for (const ext of ['.exe', '']) {
      const candidate = `${dir}\\${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const root of roots) {
    for (const ext of ['.exe', '']) {
      const candidate = `${root}\\${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Write the failing logger test**

```ts
// apps/agent/test/logging/index.test.ts
import { describe, expect, it } from 'vitest';
import { isNoise } from '../../src/logging/index.js';

describe('isNoise', () => {
  it('matches on target AND message, never the message alone', () => {
    expect(isNoise('ponter_agent', 'no such remote')).toBe(false);
  });

  it('keeps an unknown line from a known-noisy target', () => {
    expect(isNoise('werift', 'something the table has never seen')).toBe(false);
  });

  it('keeps every line when the table is empty', () => {
    // The table ships empty for werift today: the Rust rules name Rust crates.
    // A port that fabricated ten rules that can never fire would be dead code.
    expect(isNoise('anything', 'anything at all')).toBe(false);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `./apps/agent/node_modules/.bin/vitest run test/logging/index.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/logging/index.js"`.

- [ ] **Step 6: Implement `logging/index.ts`**

```ts
// apps/agent/src/logging/index.ts
/**
 * Level policy (`RUST_LOG`, default `info`) plus the known-benign-line filter.
 *
 * `RUST_LOG` outlives the Rust tree on purpose: it is the documented knob the
 * desktop supervisor and the self-hosting guide tell an operator to set, and
 * renaming it would break deployments that already use it.
 *
 * The Rust filter carried ten rules. **None of them port**: every one names a
 * Rust crate's target (`rtc_ice`, `rtc_dtls`, `libwayshot_xcap`, `quinn_udp`,
 * `webrtc::peer_connection::*`) and the TypeScript stack is werift, which logs
 * through a different mechanism. The *mechanism* ports — a (target, substring)
 * pair where both must match — and the rules are added as werift's own noise is
 * discovered while wiring the peer. The five retired rationales that carry real
 * operational knowledge (the coturn loopback 403, the DTLS alert that cannot be
 * distinguished from a fatal one, the loopback STUN write, the mDNS candidate,
 * the duplicate ICE discards) are recorded in the retirement note for Plan 3 so
 * they are not lost, and are re-expressed here if werift has equivalents.
 */
export type NoiseRule = readonly [target: string, message: string];

/** Both parts must match: the target scopes the crate, the substring the case. */
export const NOISE: readonly NoiseRule[] = [];

export function isNoise(target: string, message: string): boolean {
  return NOISE.some(([t, m]) => target.startsWith(t) && message.includes(m));
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Resolve the active level from `RUST_LOG`.
 *
 * The Rust used `EnvFilter`, whose full grammar is per-target directives. The
 * agent only ever relied on the bare level form (`RUST_LOG=debug`), so this
 * reads a comma-separated list, takes the last bare level it finds, and ignores
 * `target=level` directives rather than pretending to implement them. An
 * unrecognised value falls back to `info`, as `EnvFilter::try_from_default_env`
 * falling back to `info` did.
 */
export function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.RUST_LOG?.trim();
  if (!raw) return 'info';
  let level: LogLevel = 'info';
  for (const part of raw.split(',')) {
    const candidate = part.trim().toLowerCase();
    if (candidate in ORDER) level = candidate as LogLevel;
  }
  return level;
}

export function createLogger(
  env: NodeJS.ProcessEnv,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const threshold = ORDER[levelFromEnv(env)];
  const emit = (level: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (ORDER[level] > threshold) return;
    if (isNoise(typeof fields.target === 'string' ? fields.target : '', message)) return;
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    sink(`${level.toUpperCase()} ${message}${extra ? ` (${extra})` : ''}`);
  };
  return {
    error: (f, m) => emit('error', f, m),
    warn: (f, m) => emit('warn', f, m),
    info: (f, m) => emit('info', f, m),
    debug: (f, m) => emit('debug', f, m),
  };
}
```

- [ ] **Step 7: Run both suites green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/config.test.ts test/logging/index.test.ts
./node_modules/.bin/prettier --write apps/agent/src/config.ts apps/agent/src/logging/index.ts apps/agent/test/config.test.ts apps/agent/test/logging/index.test.ts
git add apps/agent/src/config.ts apps/agent/src/logging/index.ts apps/agent/test/config.test.ts apps/agent/test/logging/index.test.ts
git commit -m "feat(agent): resolve env-var config and the RUST_LOG level policy"
```

**TEST-INTEGRITY declaration:** new files, **21 new `it()` / 40 new `expect()`** (`config.test.ts` 18/37, `logging/index.test.ts` 3/3). No existing test is touched. Two additions grew this fence beyond the plan's original shape, and both are recorded here rather than silently absorbed:

- **B-8's three desktop env vars (+5 `it()`, +9 `expect()`).** The Rust binds `AGENT_DESKTOP_SOURCE`, `AGENT_DESKTOP_SELECT_TIMEOUT_MS` and `AGENT_DESKTOP_POLL_INTERVAL_MS`; a port that read none of them would have dropped a tested behaviour (`parse_poll_interval` alone has seven Rust tests, `desktop.rs:3870-3935`). Two of the five are the poll interval's zero/garbage normalisation, which is not cosmetic: a zero interval is a busy loop.
- **B38's six shell-resolution tests (+6 `it()`, +13 `expect()`).** The coverage matrix assigned B38 to Plan 2; Task 9 deferred it to Plan 3, which does not exist. These are ports, not new coverage, and the reason they land here rather than in Task 9 is that they resolve the *operator's* shell at config time (the Rust did it in `main`), whereas Task 9 governs which shells a *peer* may request. The six: `an_explicit_shell_always_wins_over_detection`, `unix_falls_back_to_shell_env_then_bin_sh`, `shell_preference_is_ordered_and_stops_at_the_first_hit`, `first_available_can_resolve_to_a_path_not_just_the_bare_name`, `windows_prefers_powershell_7_over_legacy_powershell` and `allow_input_cli_and_env_parsing` — the last one folded into the `AGENT_ALLOW_INPUT` case already here, since the env half is all that survives with no CLI.

The logger's three port `known_noise_is_matched_by_target_and_message`, `the_same_message_from_another_target_is_kept` and `an_unknown_message_is_kept`.

---

### Task 2: `rewriteWsScheme` and the WS upgrade header

**Files:**
- Modify: `packages/webrtc-core/src/url.ts`
- Modify: `packages/webrtc-core/test/url.test.ts`
- Create: `apps/agent/src/signalling/upgrade.ts`
- Test: `apps/agent/test/signalling/upgrade.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `function rewriteWsScheme(url: string): string` — 1:1 port of `api.rs:16-42`. Throws `Error('unsupported URL scheme in <url>')` on any other scheme and on `''`.
  - `function buildUpgradeHeaders(credential: string): Record<string, string>` — returns `{ Authorization: 'Bearer <cred>' }`; throws `Error('credential is not a valid header value')` if the credential contains any character outside `[\x21-\x7E]` (i.e. a control character or a space would corrupt the header).

- [ ] **Step 1: Write the failing `rewriteWsScheme` tests**

Append to the existing file — do **not** restructure or rename the existing `describe` blocks:

```ts
// packages/webrtc-core/test/url.test.ts  (append)
describe('rewriteWsScheme', () => {
  it('rewrites http to ws', () => {
    expect(rewriteWsScheme('http://localhost:8787/api/ws/agent')).toBe(
      'ws://localhost:8787/api/ws/agent',
    );
  });

  it('rewrites https to wss', () => {
    expect(rewriteWsScheme('https://signal.example.com/x')).toBe(
      'wss://signal.example.com/x',
    );
  });

  it('passes ws and wss through unchanged', () => {
    expect(rewriteWsScheme('ws://h/p')).toBe('ws://h/p');
    expect(rewriteWsScheme('wss://h/p')).toBe('wss://h/p');
  });

  it('trims a trailing path slash', () => {
    expect(rewriteWsScheme('http://h/p/')).toBe('ws://h/p');
    expect(rewriteWsScheme('ws://h/')).toBe('ws://h');
  });

  it('does not append a path of its own', () => {
    expect(rewriteWsScheme('http://h:8787/api/ws/agent').match(/\/api\/ws\/agent/g)).toHaveLength(1);
  });

  it('preserves a query value that ends in a slash', () => {
    // The regression the split-before-trim ordering exists for: a whole-string
    // trim would drop this slash and change what the server receives.
    expect(rewriteWsScheme('wss://signal.example/api/ws/agent?next=/')).toBe(
      'wss://signal.example/api/ws/agent?next=/',
    );
  });

  it('preserves a query value through an https rewrite', () => {
    expect(rewriteWsScheme('https://signal.example/api/ws/agent?scope=/')).toBe(
      'wss://signal.example/api/ws/agent?scope=/',
    );
  });

  it('trims the path slash before the query without altering the query', () => {
    expect(rewriteWsScheme('http://h/p/?q=1/')).toBe('ws://h/p?q=1/');
  });

  it('preserves a fragment byte for byte', () => {
    expect(rewriteWsScheme('http://h/p/#frag')).toBe('ws://h/p#frag');
  });

  it('rejects an unknown scheme and the empty string', () => {
    expect(() => rewriteWsScheme('ftp://h/p')).toThrow(/unsupported URL scheme/);
    expect(() => rewriteWsScheme('')).toThrow(/unsupported URL scheme/);
  });

  it('leaves the agent CLI default URL unchanged', () => {
    expect(rewriteWsScheme('ws://localhost:8787/api/ws/agent')).toBe(
      'ws://localhost:8787/api/ws/agent',
    );
  });

  it('differs from toWsUrl exactly where a query or fragment is present', () => {
    // This pins why the two functions coexist. If someone later "simplifies"
    // one into the other, this case fails.
    expect(toWsUrl('http://h/a/?next=/')).toBe('ws://h/a/?next=');
    expect(rewriteWsScheme('http://h/a/?next=/')).toBe('ws://h/a?next=/');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./packages/webrtc-core/node_modules/.bin/vitest run test/url.test.ts`
Expected: FAIL — `rewriteWsScheme is not defined` (11 failing cases).

- [ ] **Step 3: Implement `rewriteWsScheme`**

```ts
// packages/webrtc-core/src/url.ts  (append, below toWsUrl)

/**
 * Rewrite a **complete** WebSocket URL's scheme (ADR-89, URL-3/4 — the agent's
 * contract). `http://`→`ws://`, `https://`→`wss://`; `ws://`/`wss://` pass
 * through; anything else throws.
 *
 * Two differences from {@link toWsUrl}, both deliberate:
 *
 * 1. The `?`/`#` suffix is split off **before** the trailing-slash trim. This
 *    function receives a finished URL, not a base, so a query value ending in
 *    `/` (`?next=/`, `?scope=/`) is data and must survive; trimming the whole
 *    string would silently change it.
 * 2. Nothing is appended. `toWsUrl`'s callers compose a path afterwards; this
 *    one's caller already has the path.
 *
 * Do not merge the two. `toWsUrl` is a base-URL helper and its whole-string
 * trim is correct for that use; changing it would change which base URLs the
 * desktop and web accept.
 */
export function rewriteWsScheme(url: string): string {
  const splitAt = url.search(/[?#]/);
  const head = splitAt === -1 ? url : url.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : url.slice(splitAt);
  const trimmed = stripTrailingSlashes(head);
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice(8)}${suffix}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice(7)}${suffix}`;
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return `${trimmed}${suffix}`;
  throw new Error(`unsupported URL scheme in ${JSON.stringify(url)}`);
}
```

- [ ] **Step 4: Write the failing upgrade-header test**

```ts
// apps/agent/test/signalling/upgrade.test.ts
import { describe, expect, it } from 'vitest';
import { buildUpgradeHeaders } from '../../src/signalling/upgrade.js';

describe('buildUpgradeHeaders', () => {
  it('sets a bearer Authorization header', () => {
    expect(buildUpgradeHeaders('ag_secret')).toEqual({ Authorization: 'Bearer ag_secret' });
  });

  it('rejects a credential carrying a control character', () => {
    expect(() => buildUpgradeHeaders('bad\nvalue')).toThrow(/not a valid header value/);
  });

  it('rejects a credential carrying a space', () => {
    expect(() => buildUpgradeHeaders('bad value')).toThrow(/not a valid header value/);
  });

  it('never puts the credential in a query string', () => {
    const headers = buildUpgradeHeaders('ag_secret');
    expect(Object.keys(headers)).toEqual(['Authorization']);
    expect(JSON.stringify(headers)).not.toMatch(/\?/);
  });
});
```

- [ ] **Step 5: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/upgrade.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/signalling/upgrade.js"`.

```ts
// apps/agent/src/signalling/upgrade.ts
/**
 * The one place the agent builds a `Bearer` header (AUTH-3, ADR-13).
 *
 * The credential travels in the upgrade header and never in a query string: a
 * URL is logged by every proxy and by Cloudflare's own request log. The
 * validity check is the HTTP/1.1 field-value grammar reduced to what matters —
 * printable ASCII with no space — because `ws` would happily send a header
 * containing a newline and let the request be spliced.
 */
const VALID_HEADER_VALUE = /^[\x21-\x7E]+$/;

export function buildUpgradeHeaders(credential: string): Record<string, string> {
  if (!VALID_HEADER_VALUE.test(credential)) {
    throw new Error('credential is not a valid header value');
  }
  return { Authorization: `Bearer ${credential}` };
}
```

- [ ] **Step 6: Run every affected suite, then commit**

```bash
./packages/webrtc-core/node_modules/.bin/vitest run test/url.test.ts
./apps/agent/node_modules/.bin/vitest run test/signalling/upgrade.test.ts
./node_modules/.bin/prettier --write packages/webrtc-core/src/url.ts packages/webrtc-core/test/url.test.ts apps/agent/src/signalling/upgrade.ts apps/agent/test/signalling/upgrade.test.ts
git add packages/webrtc-core/src/url.ts packages/webrtc-core/test/url.test.ts apps/agent/src/signalling/upgrade.ts apps/agent/test/signalling/upgrade.test.ts
git commit -m "feat(webrtc-core): add rewriteWsScheme for complete WS URLs"
```

**TEST-INTEGRITY declaration:**
- `packages/webrtc-core/test/url.test.ts`: **7 `it()` / 18 `expect()` → 19 `it()` / 34 `expect()`** — the appended fence adds 12 `it()` and 16 `expect()`. The three existing `describe` blocks are untouched; one new block is appended. No assertion is removed or weakened.
- `apps/agent/test/signalling/upgrade.test.ts`: new file, 4 `it()` / 5 `expect()`.

Both figures are counted from the fences in this task, not carried over: an earlier draft declared the growth as "15 `expect()`" and the after-state as a delta, which read as consistent while understating the added assertions by one.

---

### Task 3: The reconnect ladder, close classification, and keepalive constants

**Files:**
- Create: `apps/agent/src/signalling/backoff.ts`
- Create: `apps/agent/src/signalling/close.ts`
- Create: `apps/agent/src/signalling/constants.ts`
- Test: `apps/agent/test/signalling/backoff.test.ts`, `apps/agent/test/signalling/close.test.ts`, `apps/agent/test/signalling/constants.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const BACKOFF_INITIAL_MS = 200`, `const BACKOFF_MAX_MS = 2000`, `const BACKOFF_FACTOR = 1.5`
  - `function nextBackoff(currentMs: number): number`
  - `type RunEnd = { kind: 'terminal'; code: number } | { kind: 'transient' }`
  - `function classifyClose(code: number | null): RunEnd`
  - `const PING_INTERVAL_MS = 30_000`, `const IDLE_TIMEOUT_MS = 90_000`, `const MAX_INBOUND_FRAME_BYTES = 256 * 1024`, `const MAX_DATA_CHANNEL_FRAME_BYTES = 64 * 1024`

- [ ] **Step 1: Write the failing backoff tests**

```ts
// apps/agent/test/signalling/backoff.test.ts
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_FACTOR,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  nextBackoff,
} from '../../src/signalling/backoff.js';

describe('nextBackoff', () => {
  it('grows by the factor from the initial value', () => {
    expect(BACKOFF_INITIAL_MS).toBe(200);
    expect(BACKOFF_FACTOR).toBe(1.5);
    let d = BACKOFF_INITIAL_MS;
    const seen = [d];
    for (let i = 0; i < 3; i += 1) {
      d = nextBackoff(d);
      seen.push(d);
    }
    expect(seen).toEqual([200, 300, 450, 675]);
  });

  it('caps at the maximum', () => {
    let d = BACKOFF_INITIAL_MS;
    for (let i = 0; i < 12; i += 1) d = nextBackoff(d);
    expect(d).toBe(BACKOFF_MAX_MS);
  });

  it('never returns a value below the initial value', () => {
    // The supervisor resets to BACKOFF_INITIAL_MS; this pins that the reset
    // target is the floor, not an arbitrary smaller number.
    expect(nextBackoff(BACKOFF_INITIAL_MS)).toBeGreaterThan(BACKOFF_INITIAL_MS);
  });

  it('returns an integer number of milliseconds', () => {
    let d = BACKOFF_INITIAL_MS;
    for (let i = 0; i < 10; i += 1) {
      d = nextBackoff(d);
      expect(Number.isInteger(d)).toBe(true);
    }
  });

  it('agrees with the Rust ladder to within one millisecond at every rung', () => {
    // The Rust computes `(current.as_secs_f64() * 1.5 * 1000).round()`; this
    // computes `Math.round(current * 1.5)`. Both reach 200/300/450/675/1013
    // exactly. They part at the rung after that: TS `1013 * 1.5` is exactly
    // 1519.5 and rounds up to 1520, while the Rust's `1.013 * 1.5 * 1000` is
    // 1519.4999999999998 and rounds down to 1519. The Rust's own test scopes
    // parity to factor/initial/cap/reset and explicitly not the fractional
    // milliseconds, so this asserts the tolerance rather than the value.
    const rust = [200, 300, 450, 675, 1013, 1519, 2000];
    let d = BACKOFF_INITIAL_MS;
    for (const expected of rust) {
      expect(Math.abs(d - expected)).toBeLessThanOrEqual(1);
      d = nextBackoff(d);
    }
  });

  it('does not add jitter', () => {
    // ReconnectBackoff in @ponter/webrtc-core jitters by ±50 ms by default.
    // The agent's ladder must be deterministic: the same input always yields
    // the same output, so a test can assert it and a log line can be trusted.
    const outputs = new Set(Array.from({ length: 50 }, () => nextBackoff(200)));
    expect(outputs.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/backoff.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/signalling/backoff.js"`.

```ts
// apps/agent/src/signalling/backoff.ts
/**
 * The agent's reconnect ladder.
 *
 * Deliberately NOT `ReconnectBackoff` from this monorepo's `@ponter/webrtc-core`.
 * That class is the browser/HTTP ladder: `min(initial × 2^n, max) + ±jitter`,
 * where the jitter is anti-thundering-herd behaviour for many browser tabs. An
 * agent has one socket per host, the signalling server has been tested against
 * this exact ladder, and a shared class configured into a different shape on
 * one consumer would mean two things.
 *
 * Integer milliseconds and no jitter: `Duration` cannot hold 1012.5, and the
 * Rust rounds at each step.
 */
export const BACKOFF_INITIAL_MS = 200;
export const BACKOFF_MAX_MS = 2000;
export const BACKOFF_FACTOR = 1.5;

export function nextBackoff(currentMs: number): number {
  return Math.round(Math.min(currentMs * BACKOFF_FACTOR, BACKOFF_MAX_MS));
}
```

- [ ] **Step 3: Write the failing close-code and constants tests**

```ts
// apps/agent/test/signalling/close.test.ts
import { describe, expect, it } from 'vitest';
import { classifyClose } from '../../src/signalling/close.js';

describe('classifyClose', () => {
  it('treats 4409 (replaced) as terminal', () => {
    expect(classifyClose(4409)).toEqual({ kind: 'terminal', code: 4409 });
  });

  it('treats 4401 (unauthorized) as terminal', () => {
    expect(classifyClose(4401)).toEqual({ kind: 'terminal', code: 4401 });
  });

  it('treats a normal close as transient', () => {
    expect(classifyClose(1000)).toEqual({ kind: 'transient' });
    expect(classifyClose(1001)).toEqual({ kind: 'transient' });
  });

  it('treats a missing close frame as transient', () => {
    // A socket that dies without a close frame is exactly the case reconnect
    // exists for.
    expect(classifyClose(null)).toEqual({ kind: 'transient' });
  });

  it('treats an unmapped application code as transient', () => {
    expect(classifyClose(4400)).toEqual({ kind: 'transient' });
    expect(classifyClose(1013)).toEqual({ kind: 'transient' });
  });
});
```

```ts
// apps/agent/test/signalling/constants.test.ts
import { describe, expect, it } from 'vitest';
import {
  IDLE_TIMEOUT_MS,
  MAX_DATA_CHANNEL_FRAME_BYTES,
  MAX_INBOUND_FRAME_BYTES,
  PING_INTERVAL_MS,
} from '../../src/signalling/constants.js';

describe('keepalive constants', () => {
  it('pings every 30 s and tolerates exactly three missed pings', () => {
    // The two constants are one decision: the server treats a ping older than
    // 90 s as a dead socket, so the interval must be a third of the timeout.
    // Changing either alone fails here rather than in production.
    expect(PING_INTERVAL_MS).toBe(30_000);
    expect(IDLE_TIMEOUT_MS).toBe(90_000);
    expect(PING_INTERVAL_MS * 3).toBe(IDLE_TIMEOUT_MS);
  });
});

describe('frame caps', () => {
  it('caps a signalling frame at 256 KiB', () => {
    expect(MAX_INBOUND_FRAME_BYTES).toBe(256 * 1024);
  });

  it('caps a data-channel frame at 64 KiB', () => {
    expect(MAX_DATA_CHANNEL_FRAME_BYTES).toBe(64 * 1024);
  });
});
```

- [ ] **Step 4: Run them and watch them fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/close.test.ts test/signalling/constants.test.ts`
Expected: FAIL — both modules unresolved.

```ts
// apps/agent/src/signalling/close.ts
/**
 * How the signalling socket ended, as far as the reconnect loop cares (M2).
 *
 * 4409 = this agent was replaced by a newer connection; 4401 = the credential
 * was rejected. Reconnecting against either flaps a server that has already
 * decided, and in the 4409 case would evict the connection that replaced this
 * one. Everything else — 1000, 1001, 1013, an unmapped application code, or no
 * close frame at all — is a death the next attempt can plausibly fix.
 *
 * A pure function over `number | null` on purpose: the close-code policy is the
 * part that can be tested without a socket, and the part that must not drift.
 */
export type RunEnd = { kind: 'terminal'; code: number } | { kind: 'transient' };

const TERMINAL_CODES = new Set([4401, 4409]);

export function classifyClose(code: number | null): RunEnd {
  if (code !== null && TERMINAL_CODES.has(code)) return { kind: 'terminal', code };
  return { kind: 'transient' };
}
```

```ts
// apps/agent/src/signalling/constants.ts
/**
 * Liveness and framing constants. Not in `@ponter/webrtc-core`: those live only
 * in the Rust `signal.rs`, and the browser transport's equivalents are a
 * different mechanism (there is no 90 s idle check in the browser client).
 */
/** Sent as a `{"type":"ping"}` text frame plus a real WS ping, then flushed. */
export const PING_INTERVAL_MS = 30_000;
/** Three missed pings. The server forgets a socket after this silence. */
export const IDLE_TIMEOUT_MS = 90_000;
/**
 * Checked **before** parsing, so a hostile peer cannot make the agent allocate
 * an object graph proportional to the frame.
 */
export const MAX_INBOUND_FRAME_BYTES = 256 * 1024;
/** SCTP message cap the browser also enforces; a pty chunk plus its envelope. */
export const MAX_DATA_CHANNEL_FRAME_BYTES = 64 * 1024;
```

- [ ] **Step 5: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/signalling/backoff.test.ts test/signalling/close.test.ts test/signalling/constants.test.ts
./node_modules/.bin/prettier --write apps/agent/src/signalling/{backoff,close,constants}.ts apps/agent/test/signalling/{backoff,close,constants}.test.ts
git add apps/agent/src/signalling apps/agent/test/signalling
git commit -m "feat(agent): add the reconnect ladder, close classification and keepalive constants"
```

**TEST-INTEGRITY declaration:** three new files, **14 new `it()` / 20 new `expect()`**. The Rust counterparts are `signal.rs`'s `backoff_sequence`, `keepalive_window_is_three_missed_pings`, `classify_close_treats_replaced_and_unauthorized_as_terminal` and `classify_close_treats_everything_else_as_transient` — 4 Rust tests become 15 TS tests, an expansion, never a reduction.

> **Do not take `signal.rs:100-103`'s line numbers for `transport.ts`.** That comment, copied into the Rust from the Week 5 spec, points at `transport.ts:45-46` for the two interval declarations and `:140-143` / `:165-168` / `:171-174` for the three `* 1.5` sites. All four ranges have since drifted: the declarations are at **50-51** with their defaults at **79-80**, and the three `Math.min(this.currentIntervalMs * 1.5, …)` sites are at **209-210**, **234-235** and **240-241**. The numbers below are the only ones this plan asserts, and they come from the Rust test, not from the comment. (This is why the plan cites `signal.rs` by *test name* throughout and never by line.)

---

### Task 4: The inbound parsing cascade

**Files:**
- Create: `apps/agent/src/signalling/messages.ts`
- Create: `apps/agent/src/signalling/inbound.ts`
- Test: `apps/agent/test/signalling/messages.test.ts`, `apps/agent/test/signalling/inbound.test.ts`

**Interfaces:**
- Consumes: `SignalMessage`, `SignalOffer`, `SignalAnswer`, `IceCandidateSignal`, `IdentityProof`, `IceServerConfig` from `@ponter/shared`; `MAX_INBOUND_FRAME_BYTES` from `./constants.js`.
- Produces:
  - `function parseInbound(raw: string): SignalMessage | null` — throws `InboundParseError` on malformed JSON or an unknown envelope `type`; returns `null` for a `pong`, and `null` for an `error` frame **after** logging via the injected logger.
  - `function parseIceServers(raw: string): IceServerEntry[] | null` — the local `IceServerEntry`, not shared's `IceServerConfig`: the Rust has its own `IceServerEntry` with `urls: Vec<String>`, while shared's `urls` is `string | string[]`, so the port keeps the list-only shape the server actually pushes.
  - `function parseIdentityChallenge(raw: string): string | null`
  - `function dispatchInbound(raw: string, logger: Logger): InboundEvent` where `type InboundEvent = { kind: 'signal'; message } | { kind: 'ice'; servers } | { kind: 'challenge'; nonce } | { kind: 'ignored' }` — the cascade in the one order that works.

- [ ] **Step 1: Write the failing messages test**

```ts
// apps/agent/test/signalling/messages.test.ts
import { describe, expect, it } from 'vitest';
import { parseInbound } from '../../src/signalling/inbound.js';

describe('the signal envelope', () => {
  it('round-trips an offer with its capabilities and camelCase payload', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":["terminal"]}}}';
    const parsed = parseInbound(raw);
    expect(parsed).toMatchObject({ type: 'offer', data: { sessionId: 's1', sdp: 'v=0' } });
    expect(JSON.stringify(parsed)).toContain('"sessionId"');
    expect(JSON.stringify(parsed)).not.toContain('session_id');
  });

  it('carries an identity proof', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","proof":{"signature":"c2ln","fingerprint":"AB"}}}}';
    expect(parseInbound(raw)).toMatchObject({
      data: { proof: { signature: 'c2ln', fingerprint: 'AB' } },
    });
  });

  it('treats the proof as optional for older peers', () => {
    const raw = '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0"}}}';
    expect((parseInbound(raw) as { data: Record<string, unknown> }).data.proof).toBeUndefined();
  });

  it('round-trips the user signing key in camelCase', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","userSigningPublicKey":"cGs="}}}';
    expect(parseInbound(raw)).toMatchObject({ data: { userSigningPublicKey: 'cGs=' } });
  });

  it('parses an ice-candidate with the WebRTC-spec capital M', () => {
    // `sdpMLineIndex` is not what any camelCase rule produces; the wire field is
    // capitalised because the WebRTC spec capitalises it. Both the browser and
    // the server emit this spelling, so the type must model it literally.
    const raw =
      '{"type":"signal","data":{"type":"ice-candidate","data":{"sessionId":"s1","candidate":"c","sdpMid":"0","sdpMLineIndex":0}}}';
    expect(parseInbound(raw)).toMatchObject({ data: { sdpMLineIndex: 0 } });
  });

  it('keeps a hostile sdpMLineIndex parseable so the boundary can reject it', () => {
    // -1 and 70000 must deserialize; the u16 narrowing happens at the peer
    // boundary, which turns them into a typed rejection rather than a generic
    // "malformed frame".
    for (const bad of [-1, 70000]) {
      const raw = `{"type":"signal","data":{"type":"ice-candidate","data":{"sessionId":"s1","candidate":"c","sdpMLineIndex":${bad}}}}`;
      expect(parseInbound(raw)).toMatchObject({ data: { sdpMLineIndex: bad } });
    }
  });

  it('returns null for a pong and for an error frame', () => {
    expect(parseInbound('{"type":"pong"}')).toBeNull();
    expect(parseInbound('{"type":"error","code":"VALIDATION_ERROR"}')).toBeNull();
  });

  it('throws on malformed JSON and on an unknown envelope type', () => {
    expect(() => parseInbound('{')).toThrow();
    expect(() => parseInbound('{"type":"hello","data":{}}')).toThrow();
  });

  it('rejects an oversize frame before parsing it', () => {
    expect(() => parseInbound('x'.repeat(256 * 1024 + 1))).toThrow(/exceeds/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `messages.ts` and `inbound.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/messages.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/signalling/messages.ts
/**
 * The signalling types are `@ponter/shared`'s. This module re-exports them and
 * adds only the payload shapes that exist solely on the agent side (the pushed
 * ICE configuration and the WS2 identity challenge).
 *
 * The Rust tree hand-mirrored these types in `signal.rs` and then pinned the
 * mirror with round-trip tests. A same-language import is strictly better: a
 * drift is a type error rather than a test failure.
 */
export type {
  IceCandidateSignal,
  IceServerConfig,
  IdentityProof,
  SignalAnswer,
  SignalMessage,
  SignalOffer,
} from '@ponter/shared';

export interface IceChallengePayload {
  /** The nonce the agent must sign and echo. */
  nonce: string;
}

/**
 * One ICE server as the server pushes it. `urls` is a list because a TURN entry
 * is advertised as two URLs (UDP and TCP) under one credential pair.
 */
export interface IceServerEntry {
  urls: string[];
  username?: string | null;
  credential?: string | null;
}
```

```ts
// apps/agent/src/signalling/inbound.ts
import type { Logger } from '../logging/index.js';
import { MAX_INBOUND_FRAME_BYTES } from './constants.js';
import type { IceServerEntry, SignalMessage } from './messages.js';

export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

type Envelope =
  | { type: 'signal'; data: SignalMessage }
  | { type: 'pong' }
  | { type: 'error'; code?: string };

function guardSize(raw: string): void {
  if (raw.length > MAX_INBOUND_FRAME_BYTES) {
    throw new InboundParseError(`inbound frame exceeds ${MAX_INBOUND_FRAME_BYTES} bytes`);
  }
}

/**
 * A `signal` frame nests `{type, data}` inside `{type:'signal', data}`: the
 * outer `type` is the transport discriminator, the inner one names the signal.
 *
 * `hello` is deliberately absent — the server's inbound handler has no arm for
 * it and answers `VALIDATION_ERROR`.
 */
export function parseInbound(raw: string, logger?: Logger): SignalMessage | null {
  guardSize(raw);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    throw new InboundParseError('malformed inbound frame');
  }
  if (envelope?.type === 'signal' && envelope.data) return envelope.data;
  if (envelope?.type === 'pong') return null;
  if (envelope?.type === 'error') {
    logger?.warn({ code: envelope.code ?? 'unknown' }, 'server sent an error frame');
    return null;
  }
  throw new InboundParseError(`unknown inbound envelope type`);
}

/**
 * The `ice-servers` frame the server pushes on connect. Returns `null` for any
 * frame that is not one, so the caller falls through to the next parser.
 */
export function parseIceServers(raw: string): IceServerEntry[] | null {
  guardSize(raw);
  let frame: { type?: string; data?: { iceServers?: IceServerEntry[] } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  if (frame?.type !== 'ice-servers') return null;
  return frame.data?.iceServers ?? [];
}

/**
 * The WS2 `identity-challenge` nonce. Returns `null` for any frame that is not
 * one. An oversize frame throws, like the other parsers.
 */
export function parseIdentityChallenge(raw: string): string | null {
  guardSize(raw);
  let frame: { type?: string; data?: { nonce?: string } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  if (frame?.type !== 'identity-challenge') return null;
  return typeof frame.data?.nonce === 'string' ? frame.data.nonce : null;
}

export type InboundEvent =
  | { kind: 'signal'; message: SignalMessage }
  | { kind: 'ice'; servers: IceServerEntry[] }
  | { kind: 'challenge'; nonce: string }
  | { kind: 'ignored' };

/**
 * The cascade, in the only order that works.
 *
 * `parseIdentityChallenge` and `parseIceServers` return `null` for "not mine";
 * `parseInbound` throws for anything that is not a signal frame. So the two
 * specific parsers must run first: run `parseInbound` first and every
 * `identity-challenge` and `ice-servers` frame becomes a logged parse error, and
 * the agent builds its peer with no TURN and never answers the identity
 * challenge — which makes every downstream offer-proof gate fail closed.
 */
export function dispatchInbound(raw: string, logger: Logger): InboundEvent {
  const nonce = parseIdentityChallenge(raw);
  if (nonce !== null) return { kind: 'challenge', nonce };

  const servers = parseIceServers(raw);
  if (servers !== null) return { kind: 'ice', servers };

  const message = parseInbound(raw, logger);
  if (message === null) return { kind: 'ignored' };
  return { kind: 'signal', message };
}
```

- [ ] **Step 3: Write the failing cascade test**

```ts
// apps/agent/test/signalling/inbound.test.ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging/index.js';
import {
  dispatchInbound,
  parseIceServers,
  parseIdentityChallenge,
} from '../../src/signalling/inbound.js';

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ RUST_LOG: 'debug' }, (l) => lines.push(l));
  return { logger, lines };
}

describe('parseIceServers', () => {
  it('parses the pushed frame with a STUN and a dual-transport TURN entry', () => {
    const raw = JSON.stringify({
      type: 'ice-servers',
      data: {
        iceServers: [
          { urls: ['stun:stun.example.com:19302'] },
          {
            urls: [
              'turn:turn.example.com:3478?transport=udp',
              'turn:turn.example.com:3478?transport=tcp',
            ],
            username: '1700000000:user-1',
            credential: 'cred-abc',
          },
        ],
      },
    });
    expect(parseIceServers(raw)).toEqual([
      { urls: ['stun:stun.example.com:19302'] },
      {
        urls: [
          'turn:turn.example.com:3478?transport=udp',
          'turn:turn.example.com:3478?transport=tcp',
        ],
        username: '1700000000:user-1',
        credential: 'cred-abc',
      },
    ]);
  });

  it('parses a STUN-only frame', () => {
    const raw = JSON.stringify({
      type: 'ice-servers',
      data: { iceServers: [{ urls: ['stun:h:3478'] }] },
    });
    expect(parseIceServers(raw)).toHaveLength(1);
  });

  it('returns null for a frame that is not an ice-servers frame', () => {
    expect(parseIceServers('{"type":"pong"}')).toBeNull();
  });
});

describe('parseIdentityChallenge', () => {
  it('returns the nonce', () => {
    expect(parseIdentityChallenge('{"type":"identity-challenge","data":{"nonce":"n1"}}')).toBe(
      'n1',
    );
  });

  it('returns null for a non-challenge frame', () => {
    // Fixture fidelity only: the unwrapped offer also returns null, so this is
    // not a semantic change — it just feeds the shape the wire really carries.
    expect(
      parseIdentityChallenge('{"type":"signal","data":{"type":"offer","data":{"sessionId":"s"}}}'),
    ).toBeNull();
    expect(parseIdentityChallenge('{"type":"ice-servers","data":{"iceServers":[]}}')).toBeNull();
  });
});

describe('dispatchInbound', () => {
  it('classifies a challenge before anything else', () => {
    const { logger } = captureLogger();
    expect(dispatchInbound('{"type":"identity-challenge","data":{"nonce":"n1"}}', logger)).toEqual(
      { kind: 'challenge', nonce: 'n1' },
    );
  });

  it('classifies the ICE push without logging a parse failure', () => {
    const { logger, lines } = captureLogger();
    const event = dispatchInbound(
      JSON.stringify({ type: 'ice-servers', data: { iceServers: [{ urls: ['stun:h'] }] } }),
      logger,
    );
    expect(event.kind).toBe('ice');
    // The cascade order is what this asserts: an inverted order turns this
    // frame into a "dropping malformed inbound frame" warning.
    expect(lines.filter((l) => l.includes('malformed'))).toHaveLength(0);
    expect(lines.filter((l) => l.includes('WARN'))).toHaveLength(0);
  });

  it('classifies a signal frame', () => {
    const { logger } = captureLogger();
    const event = dispatchInbound('{"type":"signal","data":{"type":"offer","data":{}}}', logger);
    expect(event.kind).toBe('signal');
  });

  it('ignores a pong without a warning', () => {
    const { logger, lines } = captureLogger();
    expect(dispatchInbound('{"type":"pong"}', logger)).toEqual({ kind: 'ignored' });
    expect(lines).toHaveLength(0);
  });

  it('logs a server error frame at warn and ignores it', () => {
    const { logger, lines } = captureLogger();
    expect(dispatchInbound('{"type":"error","code":"E"}', logger)).toEqual({ kind: 'ignored' });
    expect(lines.some((l) => l.includes('server sent an error frame'))).toBe(true);
  });
});
```

- [ ] **Step 4: Run all three suites, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/signalling/messages.test.ts test/signalling/inbound.test.ts
./node_modules/.bin/prettier --write apps/agent/src/signalling/{messages,inbound}.ts apps/agent/test/signalling/{messages,inbound}.test.ts
git add apps/agent/src/signalling apps/agent/test/signalling
git commit -m "feat(agent): parse the inbound cascade in challenge, ICE, signal order"
```

**TEST-INTEGRITY declaration:** two new files, **19 new `it()` / 28 new `expect()`**. The Rust counterparts are `signal.rs`'s `offer_round_trip`, `carries_an_identity_proof`, `proof_is_optional_for_backward_shapes`, `offer_with_user_signing_key_round_trips`, `parses_the_pushed_ice_servers_frame`, `parses_a_stun_only_ice_servers_frame`, `parse_identity_challenge_returns_none_for_non_challenge`, `an_ice_servers_frame_is_not_taken_as_one`, `rejects_malformed` and `oversize_frame_is_rejected_before_parsing` — 10 Rust tests become 18 TS tests. Two of them (`the cascade order produces zero warnings`, `dispatchInbound ignores a pong without a warning`) are **new**: the Rust had no test for the cascade order, which is precisely the ordering that a porter is most likely to invert.

**The fences' signal frames carry the transport envelope** — `{"type":"signal","data":{"type":"offer",…}}`, matching `signal.rs`'s internally-tagged `InboundFrame::Signal { data }` (`:131-143`) and the server's own send (`ws.ts:72`). The `messages.test.ts` fence previously fed unwrapped `{"type":"offer",…}` literals, which `parseInbound` rejects as an unknown envelope type; the fixtures are now the shape the wire carries. `pong`, `error` and `hello` stay top-level, because those **are** top-level envelope variants.

---

### Task 5: The signalling client and the run loop

**Files:**
- Create: `apps/agent/src/signalling/auth.ts`
- Create: `apps/agent/src/signalling/client.ts`
- Test: `apps/agent/test/signalling/auth.test.ts`, `apps/agent/test/signalling/client.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (Task 1); `Logger` (Task 1); `buildUpgradeHeaders`, `rewriteWsScheme` (Task 2); `nextBackoff`, `classifyClose`, constants (Task 3); `dispatchInbound` (Task 4); `AgentIdentity` (Task 6 — `{ publicKeyBase64: string; sign(bytes: Uint8Array): Uint8Array }`); `buildAgentIdentityFrame(nonce)` (Task 6).
- Produces:
  - `function isAuthFatal(frame: { status?: number; code?: string }): boolean`
  - `interface SignallingSocket { send(data: string): void; close(code?: number): void; on(event, cb): void }`
  - `interface SignallingDeps { connect(url, headers): SignallingSocket; logger: Logger; now(): number; every(ms: number, fn: () => void): () => void }`
  - `class SignallingClient { constructor(deps, config, identity, handlers); runOnce(): Promise<RunEnd>; run(): Promise<void> }`
  - `interface SignallingHandlers { onOffer(msg): void; onIceServers(servers): void; onAnswer(msg): void; onCandidate(msg): void }`

- [ ] **Step 1: Write the failing auth-classification test**

```ts
// apps/agent/test/signalling/auth.test.ts
import { describe, expect, it } from 'vitest';
import { isAuthFatal } from '../../src/signalling/auth.js';

describe('isAuthFatal', () => {
  it('treats a 401 status as fatal', () => {
    expect(isAuthFatal({ status: 401, code: 'API_ERROR' })).toBe(true);
  });

  it('treats an UNAUTHORIZED code as fatal even without a status', () => {
    expect(isAuthFatal({ code: 'UNAUTHORIZED' })).toBe(true);
  });

  it('does NOT treat a 403 as fatal', () => {
    // Issue #107 / PR #110 settled this: a 403 means "this peer may not do
    // that", not "this credential is dead". Reconnecting is the wrong response
    // and the Rust test `not_auth_fatal_on_other_failures` pins it.
    expect(isAuthFatal({ status: 403, code: 'FORBIDDEN' })).toBe(false);
  });

  it('does not treat a server error or a bare status as fatal', () => {
    expect(isAuthFatal({ status: 500, code: 'SERVER_ERROR' })).toBe(false);
    expect(isAuthFatal({ status: 200, code: 'API_ERROR' })).toBe(false);
    expect(isAuthFatal({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/auth.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/signalling/auth.ts
/**
 * Is this failure fatal to the *credential*, as opposed to fatal to the
 * *request*? (B53, ported from `api.rs`'s `is_auth_fatal`.)
 *
 * The distinction is the whole reason reconnect exists: a 500 or a 403 is
 * worth retrying or ignoring, while a 401 or `UNAUTHORIZED` means this agent
 * will never be admitted. Reconnecting on those hammers a server that has
 * already decided, and on `4409` would evict the connection that replaced us.
 *
 * Deliberately not a message-substring match: issue #107 replaced message
 * matching with this stable signal pair because a server rewording its message
 * silently turned a fatal into an infinite loop.
 */
export interface AuthSignal {
  status?: number;
  code?: string;
}

export function isAuthFatal(frame: AuthSignal): boolean {
  return frame.status === 401 || frame.code === 'UNAUTHORIZED';
}
```

- [ ] **Step 3: Write the failing client test**

The socket is faked at the `connect` seam, so this suite never opens a port.

```ts
// apps/agent/test/signalling/client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logging/index.js';
import {
  SignallingClient,
  type SignallingDeps,
  type SignallingSocket,
} from '../../src/signalling/client.js';
import { loadConfig } from '../../src/config.js';

function fakeSocket() {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const sent: string[] = [];
  const socket: SignallingSocket = {
    send: (d) => sent.push(d),
    close: (code) => emit('close', code ?? 1000),
    on: (ev, cb) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), cb]);
    },
  };
  function emit(ev: string, ...args: unknown[]) {
    for (const cb of handlers.get(ev) ?? []) cb(...args);
  }
  return { socket, sent, emit };
}

function harness() {
  let clock = 0;
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const logLines: string[] = [];
  let socketHandle = fakeSocket();
  let connects = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const deps: SignallingDeps = {
    connect: (url: string, headers: Record<string, string>) => {
      connects += 1;
      calls.push({ url, headers });
      return socketHandle.socket;
    },
    logger: createLogger({ RUST_LOG: 'debug' }, (l) => logLines.push(l)),
    now: () => clock,
    every: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers) if (!t.cancelled) t.fn();
  };
  return {
    deps,
    sent: () => socketHandle.sent,
    emit: (...a: [string, ...unknown[]]) => socketHandle.emit(...a),
    logLines,
    connects: () => connects,
    calls: () => calls,
    advance,
    reset: () => {
      socketHandle = fakeSocket();
    },
  };
}

const config = loadConfig({
  AGENT_ID: 'a1',
  AGENT_CREDENTIAL: 'ag_secret',
  AGENT_SERVER: 'ws://h:8787/api/ws/agent',
});
const identity = {
  publicKeyBase64: 'cGs=',
  sign: () => new Uint8Array([1, 2, 3]),
};

function makeClient(h: ReturnType<typeof harness>, overrides = {}) {
  const handlers = {
    onOffer: vi.fn(),
    onIceServers: vi.fn(),
    onAnswer: vi.fn(),
    onCandidate: vi.fn(),
    onChallenge: vi.fn(),
    ...overrides,
  };
  return { client: new SignallingClient(h.deps, config, identity, handlers), handlers };
}

describe('SignallingClient.runOnce', () => {
  it('connects to the configured URL with a Bearer header', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('close', 4409);
    await done;
    expect(h.calls()[0]).toEqual({
      url: 'ws://h:8787/api/ws/agent',
      headers: { Authorization: 'Bearer ag_secret' },
    });
  });

  it('routes a signal frame to the matching handler', async () => {
    const h = harness();
    const { client, handlers } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s","sdp":"v"}}}');
    h.emit('close', 4409);
    await done;
    expect(handlers.onOffer).toHaveBeenCalledWith({ type: 'offer', data: { sessionId: 's', sdp: 'v' } });
  });

  it('answers an identity challenge with a signed frame', async () => {
    const h = harness();
    const { client, handlers } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{"type":"identity-challenge","data":{"nonce":"n1"}}');
    h.emit('close', 4409);
    await done;
    expect(handlers.onChallenge).not.toHaveBeenCalled();
    const reply = JSON.parse(h.sent()[0] as string);
    expect(reply.type).toBe('agent-identity');
    expect(reply.data.nonce).toBe('n1');
    expect(reply.data.publicKey).toBe('cGs=');
    expect(reply.data.signature).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('ends the run transiently when the socket dies without a close frame', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('close', null);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('ends the run terminally on 4409 and on 4401', async () => {
    for (const code of [4401, 4409]) {
      const h = harness();
      const { client } = makeClient(h);
      const done = client.runOnce();
      h.emit('open');
      h.emit('close', code);
      await expect(done).resolves.toEqual({ kind: 'terminal', code });
    }
  });

  it('ends the run terminally on a server UNAUTHORIZED error frame', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{"type":"error","code":"UNAUTHORIZED","message":"bad credential"}');
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4401 });
  });

  it('keeps the socket open for a 403 error frame and ends transiently later', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{"type":"error","code":"FORBIDDEN","message":"not your session"}');
    h.emit('close', 1006);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('drops an oversize frame and keeps the socket open', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', 'x'.repeat(256 * 1024 + 1));
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
    expect(h.logLines.some((l) => l.includes('exceeds'))).toBe(true);
  });

  it('drops a malformed frame and keeps the socket open', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{not json');
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
  });

  it('sends a ping on every keepalive tick', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.advance(30_000);
    h.emit('close', 4409);
    await done;
    expect(h.sent().some((s) => s.includes('"ping"'))).toBe(true);
  });

  it('ends the run transiently after 90 s of complete silence', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.advance(90_000);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('does not time out while frames keep arriving', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    for (let i = 0; i < 4; i += 1) {
      h.advance(30_000);
      h.emit('message', '{"type":"pong"}');
    }
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
  });
});

describe('SignallingClient.run', () => {
  it('stops without reconnecting after a terminal close', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    h.emit('open');
    h.emit('close', 4409);
    await expect(done).resolves.toBeUndefined();
    expect(h.connects()).toBe(1);
  });

  it('reconnects after a transient close, waiting between attempts', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    h.emit('open');
    h.emit('close', 1006);
    h.reset(); // the NEXT connect() must capture the fresh socket
    await vi.advanceTimersByTimeAsync(199);
    expect(h.connects()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connects()).toBe(2);
    h.emit('open');
    h.emit('close', 4409);
    await done;
    vi.useRealTimers();
  });

  it('resets the ladder after a successful connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    // First death without ever connecting: 200 ms.
    h.emit('close', 1006);
    h.reset(); // the NEXT connect() must capture the fresh socket
    await vi.advanceTimersByTimeAsync(200);
    // Second attempt connects, then dies: the ladder must be back at 200.
    h.emit('open');
    h.emit('close', 1006);
    h.reset();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.connects()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connects()).toBe(3);
    h.emit('open');
    h.emit('close', 4409);
    await done;
    vi.useRealTimers();
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/signalling/client.test.ts`
Expected: FAIL — module unresolved; then each behavioural case fails until implemented.

```ts
// apps/agent/src/signalling/client.ts
import type { AgentConfig } from '../config.js';
import type { Logger } from '../logging/index.js';
import type { AgentIdentity } from '../identity/store.js';
import { buildAgentIdentityFrame } from '../identity/frame.js';
import { rewriteWsScheme } from '@ponter/webrtc-core';
import { isAuthFatal } from './auth.js';
import { IDLE_TIMEOUT_MS, PING_INTERVAL_MS } from './constants.js';
import { BACKOFF_INITIAL_MS, nextBackoff } from './backoff.js';
import { classifyClose, type RunEnd } from './close.js';
import { dispatchInbound } from './inbound.js';
import { buildUpgradeHeaders } from './upgrade.js';

export interface SignallingSocket {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void;
}

export interface SignallingDeps {
  connect(url: string, headers: Record<string, string>): SignallingSocket;
  logger: Logger;
  now(): number;
  /** Schedules `fn` every `ms`; returns a cancel handle. */
  every(ms: number, fn: () => void): () => void;
  /** Sleeps; injectable so tests drive it with fake timers. */
  sleep?(ms: number): Promise<void>;
}

export interface SignallingHandlers {
  onOffer(message: unknown): void;
  onAnswer(message: unknown): void;
  onCandidate(message: unknown): void;
  onIceServers(servers: unknown): void;
}

export class SignallingClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private lastRunOpened = false;

  constructor(
    private readonly deps: SignallingDeps,
    private readonly config: AgentConfig,
    private readonly identity: AgentIdentity,
    private readonly handlers: SignallingHandlers,
  ) {
    this.url = rewriteWsScheme(config.server);
    this.headers = buildUpgradeHeaders(config.credential);
  }

  /** One connection, from connect to close. */
  runOnce(): Promise<RunEnd> {
    return new Promise<RunEnd>((resolve) => {
      const socket = this.deps.connect(this.url, this.headers);
      let settled = false;
      let lastActivityAt = this.deps.now();
      let cancelPing: (() => void) | null = null;

      const finish = (end: RunEnd): void => {
        if (settled) return;
        settled = true;
        cancelPing?.();
        socket.close();
        resolve(end);
      };

      socket.on('open', () => {
        this.lastRunOpened = true;
        this.deps.logger.info({ url: this.url }, 'signalling connected');
        lastActivityAt = this.deps.now();
        cancelPing = this.deps.every(PING_INTERVAL_MS, () => {
          if (this.deps.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
            this.deps.logger.warn({ idleMs: IDLE_TIMEOUT_MS }, 'signalling idle timeout');
            finish({ kind: 'transient' });
            return;
          }
          socket.send(JSON.stringify({ type: 'ping' }));
        });
      });

      socket.on('message', (raw: unknown) => {
        lastActivityAt = this.deps.now();
        if (typeof raw !== 'string') return;
        try {
          const event = dispatchInbound(raw, this.deps.logger);
          if (event.kind === 'challenge') {
            socket.send(buildAgentIdentityFrame(event.nonce, this.identity));
            return;
          }
          if (event.kind === 'ice') {
            this.handlers.onIceServers(event.servers);
            return;
          }
          if (event.kind !== 'signal') return;
          const message = event.message as { type?: string; data?: unknown };
          if (message.type === 'offer') this.handlers.onOffer(message);
          else if (message.type === 'answer') this.handlers.onAnswer(message);
          else if (message.type === 'ice-candidate') this.handlers.onCandidate(message);
        } catch (error) {
          // Fail-soft: a hostile or corrupt frame costs one frame, never the
          // session. The Rust dropped these the same way.
          this.deps.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'dropping an unparseable inbound frame',
          );
        }
      });

      socket.on('error', (error: unknown) => {
        this.deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'signalling socket error',
        );
      });

      socket.on('close', (code: unknown) => {
        finish(classifyClose(typeof code === 'number' ? code : null));
      });

      // The error frame is consumed by `dispatchInbound`, which logs it. Auth
      // fatality must still end the run rather than fall through to a retry, so
      // it is classified here from the raw bytes — the only place that still
      // has them.
      const checkAuth = (raw: unknown): void => {
        if (typeof raw !== 'string' || !raw.includes('UNAUTHORIZED')) return;
        try {
          const parsed = JSON.parse(raw) as { type?: string; code?: string };
          if (parsed.type === 'error' && isAuthFatal({ code: parsed.code })) {
            this.deps.logger.error({ code: parsed.code }, 'the server rejected this credential');
            finish({ kind: 'terminal', code: 4401 });
          }
        } catch {
          /* already logged by the message handler */
        }
      };
      socket.on('message', checkAuth);
    });
  }

  /**
   * Reconnect until something terminal happens.
   *
   * The ladder resets **only after a successful connection**, not after every
   * attempt: a server that accepts the socket and immediately drops it is still
   * a server in trouble, and resetting on connect-attempt would hammer it at
   * 200 ms forever.
   */
  async run(): Promise<void> {
    let wait = BACKOFF_INITIAL_MS;
    for (;;) {
      this.lastRunOpened = false;
      const end = await this.runOnce();
      if (end.kind === 'terminal') {
        this.deps.logger.info({ code: end.code }, 'signalling ended terminally; not reconnecting');
        return;
      }
      // Reset on a successful CONNECT, not on a successful run: a server that
      // accepts the socket and immediately drops it is still a server in
      // trouble, and resetting on every attempt would hammer it at 200 ms.
      if (this.lastRunOpened) wait = BACKOFF_INITIAL_MS;
      this.deps.logger.info({ waitMs: wait }, 'signalling dropped; reconnecting');
      await sleep(this.deps, wait);
      wait = nextBackoff(wait);
    }
  }
}

function sleep(deps: SignallingDeps, ms: number): Promise<void> {
  if (deps.sleep) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

> The `checkAuth` listener above is deliberately a **second** `message` listener rather than a branch inside the first: `dispatchInbound` owns logging and returns `ignored` for error frames, so the fatality decision needs the raw bytes before they are swallowed. Both listeners run on the same event; `finish()` is idempotent via `settled`.
>
> `lastRunOpened` is a class field rather than a richer `RunEnd` because `RunEnd` is landed in `close.ts` (`be9dfdc`) as `transient | terminal` and that shape is shared with the callers of `runOnce()`; the "did this attempt ever open?" bit is a private concern of the reconnect loop, so it stays on the loop's own object.

- [ ] **Step 5: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/signalling/auth.test.ts test/signalling/client.test.ts
./node_modules/.bin/prettier --write apps/agent/src/signalling/{auth,client}.ts apps/agent/test/signalling/{auth,client}.test.ts
git add apps/agent/src/signalling apps/agent/test/signalling
git commit -m "feat(agent): add the signalling client, run loop and auth-fatality classifier"
```

**TEST-INTEGRITY declaration:** two new files, **19 new `it()` / 29 new `expect()`**. Ported from `signal.rs`: `classify_close_treats_*` ×2, `auth_fatal_on_401_or_unauthorized_code`, `not_auth_fatal_on_other_failures`, `rejects_malformed`, `oversize_frame_is_rejected_before_parsing`, `answers_the_identity_challenge_with_a_verifiable_proof`, `keepalive_window_is_three_missed_pings`. **New** (no Rust counterpart): the two `run()` reconnect tests, since the Rust's reconnect loop was `run_with_reconnect` in `lib.rs` and had no test of its own. The spec repair above (ladder-reset signal, harness `calls` hook, reset ordering, `onChallenge` removal) adds and removes **zero** assertions: both counts are unchanged from the pre-repair fence.

---

### Task 6: The identity store and the agent identity frame

**Files:**
- Create: `apps/agent/src/identity/store.ts`
- Create: `apps/agent/src/identity/frame.ts`
- Test: `apps/agent/test/identity/store.test.ts`, `apps/agent/test/identity/frame.test.ts`

**Interfaces:**
- Consumes: `canonicalProofMessage`, `normalizeFingerprint`, `parseSdpFingerprint` from `@ponter/shared`.
- Produces:
  - `interface AgentIdentity { publicKeyBase64: string; sign(bytes: Uint8Array): Uint8Array }`
  - `function loadOrCreateIdentity(path: string): AgentIdentity`
  - `function buildAgentIdentityFrame(nonce: string, identity: AgentIdentity): string`
  - `const AGENT_IDENTITY_SIGNING_PREFIX = 'ponter-ws2-agent-identity-v1'`

- [ ] **Step 1: Write the failing store test**

```ts
// apps/agent/test/identity/store.test.ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../../src/identity/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ponter-identity-'));
}

describe('loadOrCreateIdentity', () => {
  it('creates the file on first use and reloads the same key', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    const first = loadOrCreateIdentity(path);
    const second = loadOrCreateIdentity(path);
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
  });

  it('writes the key file owner-only, mode 0600', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    loadOrCreateIdentity(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates the parent directory when it does not exist', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'id.pkcs8');
    expect(() => loadOrCreateIdentity(path)).not.toThrow();
  });

  it('never truncates an existing key — a corrupt file is an error, not a reset', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    writeFileSync(path, 'not a pkcs8 key', { mode: 0o600 });
    expect(() => loadOrCreateIdentity(path)).toThrow(/identity file is not a valid PKCS#8/);
    expect(readFileSync(path, 'utf8')).toBe('not a pkcs8 key');
  });

  it('signs and verifies a round trip through the raw key the server imports', async () => {
    // The published key must be the RAW 32-byte form: the server imports it with
    // `subtle.importKey('raw', ...)` (`apps/server/src/routes/ws.ts:960`), and an
    // SPKI DER key (44 bytes) throws `DataError: Invalid keyData` there. This
    // assertion therefore goes through the server's own import path.
    const path = join(tempDir(), 'agent-identity.pkcs8');
    const identity = loadOrCreateIdentity(path);
    const message = Buffer.from('hello');
    const signature = identity.sign(message);
    const raw = Buffer.from(identity.publicKeyBase64, 'base64');
    const key = await webcrypto.subtle.importKey(
      'raw',
      raw,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    expect(
      await webcrypto.subtle.verify('Ed25519', key, signature, message),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/identity/store.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/identity/store.ts
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The agent's long-lived Ed25519 identity (B47).
 *
 * Two properties are load-bearing and both are enforced by the filesystem call,
 * not by a subsequent `chmod`:
 *
 * - **`0o600` at creation.** A create-then-chmod leaves a window where the key
 *   is world-readable. `open(..., 0o600)` applies the mode atomically.
 * - **`wx`, never `w`.** An existing file must never be truncated: a truncated
 *   key is an unrecoverable identity loss, and the agent would happily
 *   regenerate one and present a new fingerprint to every peer. `wx` makes the
 *   second create throw `EEXIST`, which the caller turns into a hard error.
 *
 * Only the PKCS#8 private key is persisted. The public key is derived on load,
 * so the two can never disagree.
 */
export interface AgentIdentity {
  readonly publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

/**
 * Derive the **raw 32-byte** Ed25519 public key.
 *
 * The wire form is raw, not SPKI DER: `apps/server/src/routes/ws.ts:960` imports
 * it with `subtle.importKey('raw', ...)`, and the Rust's `public_key_base64`
 * (`identity.rs:46`) encodes `public_key_raw()`. An SPKI DER key (44 bytes) is
 * rejected there with `DataError: Invalid keyData`, which the server turns into
 * a 4401 'Identity proof failed' — an agent that can never authenticate.
 */
function rawPublicKeyBase64(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url').toString('base64');
}

function toIdentity(privateKey: KeyObject): AgentIdentity {
  return {
    publicKeyBase64: rawPublicKeyBase64(privateKey),
    sign: (bytes) =>
      new Uint8Array(nodeSign(null, Buffer.from(bytes), privateKey)),
  };
}

function readPrivateKey(path: string): KeyObject {
  try {
    return createPrivateKey({
      key: readFileSync(path),
      type: 'pkcs8',
      format: 'der',
    });
  } catch (error) {
    const wrapped = new Error(
      `identity file is not a valid PKCS#8 Ed25519 key (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // The errno `code` must survive the wrap: `loadOrCreateIdentity` uses it to
    // tell "no file yet" (ENOENT — a first run) from "the file is there and
    // unusable" (everything else — a hard error).
    (wrapped as NodeJS.ErrnoException).code = (
      error as NodeJS.ErrnoException
    ).code;
    throw wrapped;
  }
}

export function loadOrCreateIdentity(path: string): AgentIdentity {
  try {
    return toIdentity(readPrivateKey(path));
  } catch (error) {
    // A present-but-corrupt file is *not* a reason to mint a new identity:
    // doing so silently changes the agent's fingerprint and every peer's TOFU
    // record. Only a missing file is a first run.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, der);
  } finally {
    closeSync(fd);
  }
  return toIdentity(privateKey);
}
```

- [ ] **Step 3: Write the failing frame test**

```ts
// apps/agent/test/identity/frame.test.ts
import { describe, expect, it } from 'vitest';
import { buildAgentIdentityFrame } from '../../src/identity/frame.js';

const identity = {
  publicKeyBase64: 'cGs=',
  sign: (bytes: Uint8Array) => new Uint8Array(Buffer.from(`sig:${Buffer.from(bytes).toString()}`)),
};

describe('buildAgentIdentityFrame', () => {
  it('signs the canonical agent-identity string', () => {
    const frame = buildAgentIdentityFrame('nonce-1', identity);
    const parsed = JSON.parse(frame);
    const signed = Buffer.from(parsed.data.signature, 'base64').toString();
    expect(signed).toBe('sig:ponter-ws2-agent-identity-v1\nnonce=nonce-1');
  });

  it('carries the nonce and the base64 public key', () => {
    const parsed = JSON.parse(buildAgentIdentityFrame('n', identity));
    expect(parsed).toMatchObject({ type: 'agent-identity', data: { nonce: 'n', publicKey: 'cGs=' } });
  });

  it('is a single line of JSON with no trailing newline', () => {
    const frame = buildAgentIdentityFrame('n', identity);
    expect(frame).not.toContain('\n');
    expect(frame.trim()).toBe(frame);
  });

  it('produces a different signature for a different nonce', () => {
    const a = JSON.parse(buildAgentIdentityFrame('a', identity)).data.signature;
    const b = JSON.parse(buildAgentIdentityFrame('b', identity)).data.signature;
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/identity/frame.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/identity/frame.ts
import type { AgentIdentity } from './store.js';

/**
 * The agent→server WS2 identity frame (B48's agent side).
 *
 * The signed bytes are a two-line string, not the JSON: signing the serialized
 * frame would make the signature depend on key order and whitespace, so a
 * server implementation in another language could not reproduce it. The
 * `nonce=` line is the challenge echo that makes the signature fresh — without
 * it a captured frame replays forever.
 */
export const AGENT_IDENTITY_SIGNING_PREFIX = 'ponter-ws2-agent-identity-v1';

export function buildAgentIdentityFrame(nonce: string, identity: AgentIdentity): string {
  const message = `${AGENT_IDENTITY_SIGNING_PREFIX}\nnonce=${nonce}`;
  const signature = identity.sign(new TextEncoder().encode(message));
  return JSON.stringify({
    type: 'agent-identity',
    data: {
      nonce,
      publicKey: identity.publicKeyBase64,
      signature: Buffer.from(signature).toString('base64'),
    },
  });
}
```

- [ ] **Step 5: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/identity
./node_modules/.bin/prettier --write apps/agent/src/identity apps/agent/test/identity
git add apps/agent/src/identity apps/agent/test/identity
git commit -m "feat(agent): add the Ed25519 identity store and the WS2 identity frame"
```

**TEST-INTEGRITY declaration:** two new files, **9 new `it()` / 11 new `expect()`**. Ports `identity.rs`'s `generates_then_reloads_the_same_public_key`, `identity_file_is_owner_only`, `sign_and_verify_round_trip`. The `parses_and_normalizes_sdp_fingerprint` test does **not** port — `normalizeFingerprint` already lives in `@ponter/shared` (B9 is reuse). Two are **new**: the never-truncate property and the parent-directory creation, neither of which the Rust tested. The Task 6 spec repair (errno `code` preservation across the error wrap, raw 32-byte public key derivation via JWK `x`, server-path subtle import verification) preserves the count exactly: 9 new `it()` / 11 new `expect()` (store 5/6 + frame 4/5), with zero assertions added or removed.

---

### Task 7: The E2EE handshake

**Files:**
- Create: `apps/agent/src/e2ee/manager.ts`
- Test: `apps/agent/test/e2ee/manager.test.ts`
- Modify: `apps/agent/package.json`, `pnpm-lock.yaml` (the dependencies in Step 0)

**Interfaces:**
- Consumes: `@ponter/crypto`'s `buildSessionKey`, `generateUserKeyPair`, `importSigningPublicKeyRaw`, `EncryptionManager` (B49–B51, already gating per D4); `@ponter/shared`'s `canonicalKeyBinding` and `WS1_TERMINAL_INFO`; `AgentIdentity` (Task 6). The test consumes `@ponter/terminal-core`'s `TerminalE2ee` — **the browser is the peer**, so the seam test uses the real class rather than a second hand-rolled one.
- Produces:
  - `class E2eeSession { static acceptHello(identity: AgentIdentity, sessionId: string, hello: E2eeHello, peerSigningPublicKeyRawBase64: string): Promise<{ session: E2eeSession; ack: E2eeAck } | null>; encrypt(plaintext: Uint8Array): Promise<Uint8Array>; decrypt(framed: Uint8Array): Promise<Uint8Array> }`
  - `interface E2eeHello { terminalId: string; ecdhPublicKey: string; signature: string }`
  - `interface E2eeAck { terminalId: string; ecdhPublicKey: string; signature: string }`
  - `export { WS1_TERMINAL_INFO }` — re-exported from `@ponter/shared`, never redeclared here.

- [ ] **Step 0: Add the dependencies, and install them**

`apps/agent` declares neither `@ponter/crypto` nor `@ponter/terminal-core` today, so
the module below does not resolve and the fence cannot run. Measured on the same
resolution matrix as the Task 11 gap
(`.superpowers/probes/b12g-task11-staging-gap-v2/`, state **S3**): a manifest edit
alone resolves nothing, because nothing links `apps/agent/node_modules/@ponter/*`
until an install runs. `@ponter/terminal-core` is a **devDependency** — a test-only
consumer of a browser package, the same dependency direction Task 11 established
for `@ponter/file-core` — while `@ponter/crypto` is a runtime dependency.

```bash
pnpm --filter @ponter/agent-node add --workspace @ponter/crypto
pnpm --filter @ponter/agent-node add -D --workspace @ponter/terminal-core
```

Both commands write `apps/agent/package.json` **and** regenerate `pnpm-lock.yaml`.
CI installs with `--frozen-lockfile` (`ci-node.yml:78`) and its `paths:` includes
`pnpm-lock.yaml`, so the lockfile half is gating: it must be staged with the commit.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/e2ee/manager.test.ts
import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalKeyBinding } from '@ponter/shared';
import { TerminalE2ee } from '@ponter/terminal-core';
import { E2eeSession } from '../../src/e2ee/manager.js';

const SESSION_ID = 'sess-abc';

// The agent's own WS2 identity: Ed25519, published as the RAW 32-byte form.
const { privateKey: agentPrivate, publicKey: agentPublic } = generateKeyPairSync('ed25519');
const agentPublicRaw = Buffer.from(
  (agentPublic.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('base64');
const agentIdentity = {
  publicKeyBase64: agentPublicRaw,
  sign: (bytes: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(bytes), agentPrivate)),
};

// The peer's identity (the browser's). DELIBERATELY a different key from the
// agent's: the agent verifies the peer's hello, it never signs it. A fixture that
// reuses `agentPrivate` for both sides passes even when the verifier accepts its
// own signatures, which is the failure mode this whole task is about.
const { privateKey: peerPrivate, publicKey: peerPublic } = generateKeyPairSync('ed25519');
const peerPublicRaw = Buffer.from(
  (peerPublic.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('base64');

// A third key, for the wrong-signer must-error control.
const { privateKey: otherPrivate } = generateKeyPairSync('ed25519');

function peerHello(bindingFor?: (ecdhPublicKey: string) => string, signer = peerPrivate) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdhPublicKey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString(
    'base64',
  );
  const message = bindingFor ? bindingFor(ecdhPublicKey) : canonicalKeyBinding(ecdhPublicKey);
  const signature = nodeSign(null, Buffer.from(message), signer).toString('base64');
  return { terminalId: 't1', ecdhPublicKey, signature };
}

describe('E2eeSession', () => {
  it('produces an ack carrying its ephemeral ECDH key and a signature', async () => {
    const result = await E2eeSession.acceptHello(agentIdentity, SESSION_ID, peerHello(), peerPublicRaw);
    expect(Buffer.from(result!.ack.ecdhPublicKey, 'base64').length).toBeGreaterThan(0);
    expect(result!.ack.signature.length).toBeGreaterThan(0);
  });

  it('returns null when the peer signing key is not 32 raw bytes', async () => {
    // `peer_signing_public_key_raw: &[u8; 32]` (e2ee.rs:203) is a length check the
    // type system cannot make in TS. An SPKI DER key is 44 bytes; letting one
    // through would import as the wrong key shape and reject every real hello.
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      Buffer.from('short').toString('base64'),
    );
    expect(result).toBeNull();
  });

  it('derives a session on a valid hello and round-trips a frame', async () => {
    const result = await E2eeSession.acceptHello(agentIdentity, SESSION_ID, peerHello(), peerPublicRaw);
    expect(result).not.toBeNull();
    const sealed = await result!.session.encrypt(Buffer.from('payload'));
    expect(Buffer.from(await result!.session.decrypt(sealed)).toString()).toBe('payload');
  });

  it('rejects a mis-signed hello and yields no session', async () => {
    const hello = peerHello(() => 'a different binding');
    const result = await E2eeSession.acceptHello(agentIdentity, SESSION_ID, hello, peerPublicRaw);
    expect(result).toBeNull();
  });

  it('rejects a hello signed by the wrong peer key', async () => {
    const hello = peerHello(undefined, otherPrivate);
    const result = await E2eeSession.acceptHello(agentIdentity, SESSION_ID, hello, peerPublicRaw);
    expect(result).toBeNull();
  });

  it('round-trips an EMPTY plaintext frame', async () => {
    // The Rust refused a 28-byte frame (12 IV + 16 tag) on decrypt while its own
    // encrypt produced exactly that for []. @ponter/crypto accepts it and returns
    // an empty buffer; that is the behaviour this port keeps, because it is the
    // one that round-trips.
    const result = (await E2eeSession.acceptHello(agentIdentity, SESSION_ID, peerHello(), peerPublicRaw))!;
    const sealed = await result.session.encrypt(new Uint8Array(0));
    expect(sealed).toHaveLength(28);
    expect(await result.session.decrypt(sealed)).toEqual(new Uint8Array(0));
  });

  it('rejects a tampered frame', async () => {
    const result = (await E2eeSession.acceptHello(agentIdentity, SESSION_ID, peerHello(), peerPublicRaw))!;
    const sealed = await result.session.encrypt(Buffer.from('secret'));
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(result.session.decrypt(tampered)).rejects.toThrow();
  });

  it('cross-side: decrypts frames encrypted by the browser under the same sessionId', async () => {
    // The ONLY assertion that can catch a wrong HKDF salt. A self-round-trip
    // encrypts and decrypts through one EncryptionManager derived from one salt,
    // so it is a mirror: it stays green under ANY salt, including a wrong one.
    // Here two independent parties derive the key from their own private half,
    // so `sessionId` is the only value that can make the GCM tag authenticate.
    const ecdh = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )) as CryptoKeyPair;
    const browserSigningKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(peerPrivate.export({ type: 'pkcs8', format: 'der' }) as Buffer),
      'Ed25519',
      false,
      ['sign'],
    );
    const agentSigningKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(agentPublicRaw, 'base64'),
      'Ed25519',
      true,
      ['verify'],
    );
    const browser = new TerminalE2ee({
      ecdhPrivateKey: ecdh.privateKey,
      ecdhPublicKey: ecdh.publicKey,
      signingPrivateKey: browserSigningKey,
      peerSigningPublicKey: agentSigningKey,
      sessionId: SESSION_ID,
    });

    const hello = await browser.buildHello('t1');
    const result = await E2eeSession.acceptHello(agentIdentity, SESSION_ID, hello, peerPublicRaw);
    expect(result).not.toBeNull();
    await browser.handleAck(result!.ack);

    const encryptedByBrowser = await browser.encrypt(Buffer.from('terminal keystroke'));
    expect(Buffer.from(await result!.session.decrypt(encryptedByBrowser)).toString()).toBe(
      'terminal keystroke',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/e2ee/manager.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/e2ee/manager.ts
import {
  buildSessionKey,
  generateUserKeyPair,
  importSigningPublicKeyRaw,
  type EncryptionManager,
} from '@ponter/crypto';
import { canonicalKeyBinding, WS1_TERMINAL_INFO } from '@ponter/shared';
import type { AgentIdentity } from '../identity/store.js';

export { WS1_TERMINAL_INFO };

export interface E2eeHello {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}

export interface E2eeAck {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}

/**
 * Answerer-side WS1 terminal E2EE, porting `E2eeSession` from `apps/agent/src/e2ee.rs`.
 *
 * **There is no `begin` step, and that is deliberate.** The agent is the
 * answerer: the browser sends `terminal-e2ee-hello` first, and the Rust's
 * `accept_hello` (`e2ee.rs:198-220`) generates our ephemeral key *inside* the
 * call, after verifying the peer, returning the session and the signed ack
 * together. An `AgentE2ee` that pre-allocated a pending session in one call and
 * armed it in another carried three states nothing could distinguish (never
 * begun / begun-unarmed / armed) and an ordering nobody enforced.
 *
 * **The signature is verified before the session key is derived, and the session
 * object does not exist until it verifies** — the Rust's doc comment states the
 * reason: "a session that exists is always a session that may encrypt".
 */
export class E2eeSession {
  private constructor(private readonly manager: EncryptionManager) {}

  /**
   * Verify the peer's hello, derive the session key, and return our signed ack.
   *
   * `sessionId` is a **parameter, with no default**: it comes off the wire with
   * the session being negotiated and is the HKDF salt (`@ponter/crypto`'s
   * `buildSessionKey`; Rust `e2ee.rs:220`). A defaulted salt is a silent seam
   * break — the agent arms, reports success, and then fails every GCM tag
   * because the browser derived under its real session id. Required is the only
   * safe shape.
   *
   * `peerSigningPublicKeyRawBase64` is the **raw 32-byte** Ed25519 key the offer
   * carried (Rust `&[u8; 32]`, `lib.rs:1250-1258`), not SPKI DER.
   *
   * Fail-closed: a bad signature, a malformed key or a failed import returns
   * `null`. The caller then stays plaintext and sends no ack.
   */
  static async acceptHello(
    identity: AgentIdentity,
    sessionId: string,
    hello: E2eeHello,
    peerSigningPublicKeyRawBase64: string,
  ): Promise<{ session: E2eeSession; ack: E2eeAck } | null> {
    try {
      const raw = Buffer.from(peerSigningPublicKeyRawBase64, 'base64');
      if (raw.length !== 32) return null;

      // 1. Our ephemeral keypair, generated ONCE: the private half derives the
      //    session key and the public half goes out in the ack, and those must be
      //    the same key or the browser derives a different secret.
      //
      //    This sits *before* the verify because `buildSessionKey` needs our
      //    private half as an input — the Rust verifies first and generates
      //    second (`e2ee.rs:210-216`). The divergence is safe and deliberate: an
      //    ephemeral keypair is a throwaway that touches no state and escapes
      //    nothing until an ack is returned, and the property the Rust's ordering
      //    protects — "a session that exists is always a session that may
      //    encrypt" — is kept because `E2eeSession` is constructed only after
      //    `buildSessionKey` resolves, and `buildSessionKey` throws when the
      //    binding does not verify.
      //
      //    Nothing about the binding is built locally: the verified string is
      //    `canonicalKeyBinding(ecdhPublicKey)` and the HKDF salt is
      //    `sessionId`, the two values the browser and the Rust also use.
      const keyPair = await generateUserKeyPair();
      const manager = await buildSessionKey({
        myEcdhPrivateKey: keyPair.privateKey,
        peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
        peerBindingSignature: hello.signature,
        peerSigningPublicKey: await importSigningPublicKeyRaw(peerSigningPublicKeyRawBase64),
        sessionId,
      });

      // 2. Build our signed ack so the browser can derive the identical key.
      const ackSignature = identity.sign(
        new TextEncoder().encode(canonicalKeyBinding(keyPair.publicKeySpkiBase64)),
      );
      const ack: E2eeAck = {
        terminalId: hello.terminalId,
        ecdhPublicKey: keyPair.publicKeySpkiBase64,
        signature: Buffer.from(ackSignature).toString('base64'),
      };

      return { session: new E2eeSession(manager), ack };
    } catch {
      return null;
    }
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return this.manager.encrypt(plaintext);
  }

  async decrypt(framed: Uint8Array): Promise<Uint8Array> {
    return this.manager.decrypt(framed);
  }
}
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/e2ee
./packages/crypto/node_modules/.bin/vitest run
./node_modules/.bin/prettier --write apps/agent/src/e2ee apps/agent/test/e2ee
git add apps/agent/src/e2ee apps/agent/test/e2ee apps/agent/package.json pnpm-lock.yaml
git commit -m "feat(agent): port the WS1 terminal E2EE answerer handshake"
```

**TEST-INTEGRITY declaration:** one new file, **8 new `it()` / 12 new `expect()`**.

The before→after is **not** a +1/+1 net. Enumerated by name, because a net figure
is what hides a removal:

| test | pre | post |
|---|---|---|
| `produces an ack carrying its ephemeral ECDH key and a signature` | 2 | 2 |
| `arms no session before a peer hello arrives` | 1 | — **removed** |
| `arms the session after a valid hello and round-trips a frame` | 2 | 2, **renamed** to `derives a session on a valid hello and round-trips a frame` |
| `rejects a mis-signed hello and yields no session` | 2 | **1** — lost its `isArmed(false)` assertion |
| `rejects a hello for a terminal that was never begun` | 1 | — **removed** |
| `round-trips an EMPTY plaintext frame` | 2 | 2 |
| `rejects a tampered frame` | 1 | 1 |
| `returns null when the peer signing key is not 32 raw bytes` | — | 1 **added** |
| `rejects a hello signed by the wrong peer key` | — | 1 **added** |
| `cross-side: decrypts frames encrypted by the browser under the same sessionId` | — | 2 **added** |

So **`it()`: −2 / +3, and `expect()`: −3 / +4** — a net +1/+1 that arrives from
unequal movements, not from one addition. `11 − 3 + 4 = 12` and `7 − 2 + 3 = 8`.

The three removals are all the same class, and each is named with its reason:

- **Two whole tests go: `arms no session before a peer hello arrives` and
  `rejects a hello for a terminal that was never begun`.** Both pinned states the
  Rust cannot have. `isArmed` does not exist on `E2eeSession` — the Rust's
  `accept_hello` is a static constructor returning `(Self, E2eeAck)`
  (`e2ee.rs:198-203`), so "created but not armed" is not a representable state and
  asserting `isArmed === false` asserted the *retired shape*, not the contract.
  The second pinned terminal-id-begun validation that the Rust never performs:
  `accept_hello` never inspects `hello.terminal_id` for validity, it only echoes it
  into the ack (`e2ee.rs:222`). These are the test-asserts-the-bug class, not
  coverage given up.
- **One assertion goes from a surviving test:
  `expect(e2ee.isArmed('t1')).toBe(false)` in `rejects a mis-signed hello`.**
  Same reason, one level down — with no arming state, `result === null` *is* the
  fail-closed assertion, and it is still there.

What replaces them is stronger on the two properties those tests could never
prove. **Added and worth raising:** the 32-byte key-shape rejection (the Rust's
`&[u8; 32]` is a type-level guarantee TS does not have), and the wrong-peer-key
must-error control — the pre-repair fixture signed with the **agent's own** key,
so its "mis-signed hello" test varied only the message string and could never show
signature verification works. The third addition is the cross-side `TerminalE2ee`
round trip, the only assertion that can distinguish the correct HKDF salt from any
other: the pre-repair fence's round trips went through a single
`EncryptionManager`, so it stayed green when the salt was replaced with
`'WRONG-SALT'` (measured: 7/7 passing).

Ports `e2ee.rs`'s `accept_hello_derives_and_round_trips` and
`a_mis_signed_hello_is_rejected_and_yields_no_session`. The six primitive tests do
**not** port — `@ponter/crypto` owns them and is gating (D4). Two are **new**: the
empty-plaintext round trip (the divergence ruling) and the 32-byte key-shape
rejection. Two more are must-error controls a fail-closed port needs: the
wrong-signer hello, and the cross-side salt seam.

---

### Task 8: The werift peer — ICE config, payload type, track order, data-channel gate

**Files:**
- Create: `apps/agent/src/session/peer.ts`
- Create: `apps/agent/src/session/ice.ts`
- Test: `apps/agent/test/session/peer.test.ts`, `apps/agent/test/session/ice.test.ts`

**Interfaces:**
- Consumes: `IceServerEntry` (Task 4); `IceCandidateSignal`; werift's `RTCPeerConnection`.
- Produces:
  - `function mapIceServers(entries: IceServerEntry[], stunFallback: string): RTCIceServer[]`
  - `function isUnusableTurnTcp(url: string): boolean`
  - `function selectH264PayloadType(codecs: { mimeType: string; payloadType: number }[]): number | null`
  - `function requiredH264PayloadType(codecs): number` — throws `'the desktop sender has no negotiated H.264 codec'`
  - `function narrowMlineIndex(raw: unknown): number | null` — `null` for out-of-u16-range and negatives
  - `function h264Mode1Codec(offerSdp: string): { mimeType; payloadType; parameters? } | null` — the browser's H.264 `packetization-mode=1` entry; `null` when absent (an absent `packetization-mode` is mode **0**)
  - `class SessionPeer { answer(offerSdp, opts): Promise<{ answerSdp; sender: RTCRtpSenderLike | null }> }` — **the returned `sender` is Task 19's `RtpSenderSink`**; `answer()` performs the R-S3 re-point and throws for a desktop offer with no mode-1 H.264 entry

- [ ] **Step 1: Write the failing ICE + payload-type tests**

```ts
// apps/agent/test/session/ice.test.ts
import { describe, expect, it } from 'vitest';
import {
  isUnusableTurnTcp,
  mapIceServers,
  narrowMlineIndex,
  requiredH264PayloadType,
  selectH264PayloadType,
} from '../../src/session/ice.js';

describe('isUnusableTurnTcp', () => {
  it('matches only turn: URLs with transport=tcp', () => {
    expect(isUnusableTurnTcp('turn:turn.example.com:3478?transport=tcp')).toBe(true);
    expect(isUnusableTurnTcp('turn:turn.example.com:3478?transport=udp')).toBe(false);
    expect(isUnusableTurnTcp('turns:turn.example.com:5349?transport=tcp')).toBe(false);
    expect(isUnusableTurnTcp('stun:stun.example.com:19302')).toBe(false);
  });
});

describe('mapIceServers', () => {
  it('maps a STUN-only entry with no credentials', () => {
    expect(mapIceServers([{ urls: ['stun:h:3478'] }], '')).toEqual([
      { urls: ['stun:h:3478'] },
    ]);
  });

  it('maps a TURN entry with its credential pair', () => {
    expect(
      mapIceServers([{ urls: ['turn:h:3478?transport=udp'], username: 'u', credential: 'c' }], ''),
    ).toEqual([{ urls: ['turn:h:3478?transport=udp'], username: 'u', credential: 'c' }]);
  });

  it('drops a TURN/TCP url and keeps the UDP sibling', () => {
    expect(
      mapIceServers(
        [
          {
            urls: ['turn:h:3478?transport=udp', 'turn:h:3478?transport=tcp'],
            username: 'u',
            credential: 'c',
          },
        ],
        '',
      ),
    ).toEqual([{ urls: ['turn:h:3478?transport=udp'], username: 'u', credential: 'c' }]);
  });

  it('drops an entry left with no usable urls', () => {
    expect(mapIceServers([{ urls: ['turn:h:3478?transport=tcp'] }], '')).toEqual([]);
  });

  it('keeps a Cloudflare-style turns url untouched', () => {
    const url = 'turns:turn.cloudflare.com:5349?transport=udp';
    expect(mapIceServers([{ urls: [url] }], '')).toEqual([{ urls: [url] }]);
  });

  it('defaults absent credentials to an empty string', () => {
    expect(mapIceServers([{ urls: ['turn:h'] }], '')).toEqual([{ urls: ['turn:h'], username: '', credential: '' }]);
  });

  it('falls back to the configured STUN url only when nothing was pushed', () => {
    expect(mapIceServers([], 'stun:fallback:3478')).toEqual([{ urls: ['stun:fallback:3478'] }]);
  });

  it('lets the pushed entries win over the configured STUN url', () => {
    expect(mapIceServers([{ urls: ['stun:pushed:3478'] }], 'stun:fallback:3478')).toEqual([
      { urls: ['stun:pushed:3478'] },
    ]);
  });
});

describe('selectH264PayloadType', () => {
  it('picks H.264 even when VP8 is offered first', () => {
    expect(
      selectH264PayloadType([
        { mimeType: 'video/VP8', payloadType: 96 },
        { mimeType: 'video/rtx', payloadType: 97 },
        { mimeType: 'video/H264', payloadType: 102 },
        { mimeType: 'video/H264', payloadType: 127 },
      ]),
    ).toBe(102);
  });

  it('matches the mime type case-insensitively', () => {
    expect(selectH264PayloadType([{ mimeType: 'video/h264', payloadType: 102 }])).toBe(102);
  });

  it('returns null when no H.264 was negotiated', () => {
    expect(selectH264PayloadType([{ mimeType: 'video/VP8', payloadType: 96 }])).toBeNull();
  });

  it('takes the first H.264 entry, not the lowest payload type', () => {
    expect(
      selectH264PayloadType([
        { mimeType: 'video/H264', payloadType: 127 },
        { mimeType: 'video/H264', payloadType: 102 },
      ]),
    ).toBe(127);
  });
});

describe('requiredH264PayloadType', () => {
  it('throws a named error instead of returning null', () => {
    expect(() => requiredH264PayloadType([{ mimeType: 'video/VP8', payloadType: 96 }])).toThrow(
      /no negotiated H\.264 codec/,
    );
  });
});

describe('narrowMlineIndex', () => {
  it('accepts 0 and 65535', () => {
    expect(narrowMlineIndex(0)).toBe(0);
    expect(narrowMlineIndex(65535)).toBe(65535);
  });

  it('rejects negatives and anything above u16', () => {
    expect(narrowMlineIndex(-1)).toBeNull();
    expect(narrowMlineIndex(65536)).toBeNull();
  });

  it('rejects a non-integer', () => {
    expect(narrowMlineIndex(1.5)).toBeNull();
    expect(narrowMlineIndex('0')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `ice.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/session/ice.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/session/ice.ts
import type { IceServerEntry } from '../signalling/messages.js';

export interface RtcIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * The agent has no TURN-over-TCP transport, so a `turn:` URL advertising
 * `transport=tcp` is unusable and must be removed rather than passed through:
 * werift would accept the entry, fail the allocation, and the ICE failure would
 * look like a network problem. `turns:` is deliberately **not** matched — its
 * TCP form is a TLS variant the port does support, and the test pins that.
 */
export function isUnusableTurnTcp(url: string): boolean {
  return url.startsWith('turn:') && url.includes('transport=tcp');
}

/**
 * The server pushes ICE configuration on connect; the CLI's `--stun` is only a
 * fallback for the case where none was pushed (B10). Pushed-wins is the Rust's
 * behaviour and matters for a self-hosted deployment whose coturn is not the
 * one baked into the default config.
 */
export function mapIceServers(entries: IceServerEntry[], stunFallback: string): RtcIceServer[] {
  const mapped: RtcIceServer[] = [];
  for (const entry of entries) {
    const urls = entry.urls.filter((url) => !isUnusableTurnTcp(url));
    if (urls.length === 0) continue;
    const server: RtcIceServer = { urls };
    if (entry.username != null || entry.credential != null) {
      server.username = entry.username ?? '';
      server.credential = entry.credential ?? '';
    }
    mapped.push(server);
  }
  if (mapped.length === 0 && stunFallback !== '') return [{ urls: [stunFallback] }];
  return mapped;
}

/**
 * The **negotiated** H.264 payload type (B27).
 *
 * `codecs[0].payloadType` is wrong whenever the browser offers VP8 first, which
 * Chrome does. The list order is the offer's order and the first H.264 entry
 * wins — not the lowest payload number, which is why the test pins 127 over 102
 * when 127 comes first.
 */
export function selectH264PayloadType(
  codecs: readonly { mimeType: string; payloadType: number }[],
): number | null {
  const match = codecs.find((codec) => codec.mimeType.toLowerCase() === 'video/h264');
  return match ? match.payloadType : null;
}

export function requiredH264PayloadType(
  codecs: readonly { mimeType: string; payloadType: number }[],
): number {
  const payloadType = selectH264PayloadType(codecs);
  if (payloadType === null) throw new Error('the desktop sender has no negotiated H.264 codec');
  return payloadType;
}

/**
 * `sdpMLineIndex` is a u16 on the wire; the Rust narrowed it at the boundary
 * and rejected `-1`/`65535+` as a typed error rather than a malformed frame.
 * JSON gives us a number of unbounded range and possibly a non-integer, so the
 * narrowing has to be explicit.
 */
export function narrowMlineIndex(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > 65535) return null;
  return raw;
}
```

- [ ] **Step 3: Write the failing peer test, then implement `peer.ts`**

```ts
// apps/agent/test/session/peer.test.ts
import { describe, expect, it, vi } from 'vitest';
import { h264Mode1Codec, SessionPeer } from '../../src/session/peer.js';

/**
 * Minimal Chrome-shaped H.264 offers. Only the lines `h264Mode1Codec` reads are
 * here — `a=rtpmap:` and `a=fmtp:` — because these tests exercise THIS task's
 * parsing, not werift's negotiation. Package-internal, so the offers are
 * inlined rather than imported from `@ponter/webrtc-core`'s test fixtures.
 */
const MODE1_FIRST = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 102 104',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  '',
].join('\r\n');

const MODE0_FIRST = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 104 102',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  '',
].join('\r\n');

/** An offer with H.264, but no mode-1 entry at all. */
const MODE0_ONLY = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 104',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  '',
].join('\r\n');

describe('h264Mode1Codec', () => {
  it('picks the mode-1 entry even when the mode-0 entry comes first', () => {
    expect(h264Mode1Codec(MODE0_FIRST)).toEqual({
      mimeType: 'video/H264',
      payloadType: 102,
      parameters:
        'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    });
  });

  it('returns the whole fmtp string as parameters, so the caller can echo it', () => {
    expect(h264Mode1Codec(MODE1_FIRST)?.parameters).toBe(
      'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    );
  });

  it('treats an ABSENT packetization-mode as mode 0 and returns null', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      '',
    ].join('\r\n');
    // RFC 6184 §8.1: the default is 0. Reading absence as mode 1 would select
    // an entry the browser is not depacketizing as mode 1 — R-S3 defeated on
    // exactly the peers it exists to protect.
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('returns null for an H.264 entry with no fmtp line at all', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/90000',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('returns null when the offer carries no H.264', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('parses an LF-only offer as well as a CRLF one', () => {
    expect(h264Mode1Codec(MODE0_FIRST.replace(/\r\n/g, '\n'))?.payloadType).toBe(102);
  });

  it('does not match a non-90000 H.264 clock rate as video/H264', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/45000',
      'a=fmtp:102 packetization-mode=1',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });
});

function fakePeerFactory() {
  const calls: string[] = [];
  const sender = {
    codec: undefined,
    selectNegotiatedCodec: vi.fn(() => {
      calls.push('selectNegotiatedCodec');
    }),
    writeRtp: vi.fn(),
  };
  const peer = {
    addTrack: vi.fn(() => {
      calls.push('addTrack');
      return sender;
    }),
    setRemoteDescription: vi.fn(async () => {
      calls.push('setRemoteDescription');
    }),
    createAnswer: vi.fn(async () => {
      calls.push('createAnswer');
      return { sdp: 'v=0 answer', type: 'answer' as const };
    }),
    setLocalDescription: vi.fn(async () => {
      calls.push('setLocalDescription');
    }),
    close: vi.fn(async () => {}),
  };
  return { peer, sender, calls };
}

const TRACK = { track: { id: 'video' } };

describe('SessionPeer.answer', () => {
  it('attaches the desktop track before setRemoteDescription', async () => {
    const { peer, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(calls.indexOf('addTrack')).toBeLessThan(calls.indexOf('setRemoteDescription'));
  });

  /**
   * The ordering that R-S3 depends on, and the reason this test asserts the
   * call sequence rather than the result: `selectNegotiatedCodec` throws
   * "was not negotiated" before `setRemoteDescription` has populated the
   * transceiver's codec list, and does nothing useful for the emitted SDP
   * after `createAnswer` has already built the m-line from it.
   */
  it('re-points the sender after setRemoteDescription and before createAnswer', async () => {
    const { peer, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(calls).toEqual([
      'addTrack',
      'setRemoteDescription',
      'selectNegotiatedCodec',
      'createAnswer',
      'setLocalDescription',
    ]);
  });

  it('re-points at the payload type parsed out of the offer', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(sender.selectNegotiatedCodec).toHaveBeenCalledWith({
      mimeType: 'video/H264',
      payloadType: 102,
      parameters:
        'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    });
  });

  it('returns the sender, so the desktop loop has something to write RTP to', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    const result = await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(result.sender).toBe(sender);
    expect(result.answerSdp).toBe('v=0 answer');
  });

  it('throws rather than answering when the offer has no mode-1 H.264 entry', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    await expect(
      session.answer(MODE0_ONLY, { desktop: true, track: TRACK }),
    ).rejects.toThrow(/no H\.264 entry with packetization-mode=1/);
    // The re-point must NOT have happened: selecting the mode-0 entry would
    // make the failure invisible instead of loud.
    expect(sender.selectNegotiatedCodec).not.toHaveBeenCalled();
  });

  it('throws when a desktop session is answered with no track', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'control' });
    await expect(session.answer(MODE0_FIRST, { desktop: true })).rejects.toThrow(
      /no outbound track/,
    );
  });

  it('answers a non-desktop session without attaching a track or re-pointing', async () => {
    const { peer, sender, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    const result = await session.answer(MODE1_FIRST, { desktop: false });
    expect(calls).not.toContain('addTrack');
    expect(sender.selectNegotiatedCodec).not.toHaveBeenCalled();
    expect(result.sender).toBeNull();
  });
});

describe('SessionPeer.handleDataChannel', () => {
  it('closes a data channel with the wrong label', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    const wrong = { label: async () => 'control', close: vi.fn(async () => {}) };
    await session.handleDataChannel(wrong);
    expect(wrong.close).toHaveBeenCalled();
  });

  it('accepts a data channel with the expected label', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    const right = { label: async () => 'terminal', close: vi.fn(async () => {}) };
    await session.handleDataChannel(right);
    expect(right.close).not.toHaveBeenCalled();
    expect(session.channel).toBe(right);
  });

  it('closes a SECOND channel even when its label is right', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    await session.handleDataChannel({ label: async () => 'terminal', close: vi.fn(async () => {}) });
    const second = { label: async () => 'terminal', close: vi.fn(async () => {}) };
    await session.handleDataChannel(second);
    expect(second.close).toHaveBeenCalled();
  });

  it('drops an unlabelled channel without closing it', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    const bad = {
      label: async () => {
        throw new Error('no label');
      },
      close: vi.fn(async () => {}),
    };
    await expect(session.handleDataChannel(bad)).resolves.toBeUndefined();
    expect(bad.close).not.toHaveBeenCalled();
  });

  it('closes a channel with no code argument, as this API has none', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, { acceptedLabel: 'terminal' });
    const wrong = { label: async () => 'nope', close: vi.fn(async () => {}) };
    await session.handleDataChannel(wrong);
    expect(wrong.close).toHaveBeenCalledWith();
  });
});
```

Run: `./apps/agent/node_modules/.bin/vitest run test/session/peer.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/session/peer.ts
import type { RTCRtpSenderLike } from '@ponter/webrtc-core';

export interface PeerLike {
  /**
   * Attach the outbound track. Returns the sender — the SAME handle whose
   * `writeRtp` the desktop loop calls, which is why `answer()` returns it.
   * Plan 1 Task 2's `RTCRtpSenderLike` is the real type; this is the slice.
   * werift's `addTrack` is synchronous (`peerConnection.js:981`), so the
   * return is not awaited here — but a mock may return a promise, and `await`
   * covers both.
   */
  addTrack?(track: unknown, stream?: unknown): RTCRtpSenderLike | Promise<RTCRtpSenderLike>;
  setRemoteDescription(desc: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: 'answer'; sdp: string }>;
  setLocalDescription(desc: { type: 'answer'; sdp: string }): Promise<void>;
  close(): Promise<void>;
}

/**
 * **R-S3 is a method on the SENDER, not on the peer connection.**
 *
 * `RTCPeerConnectionLike` has no `selectNegotiatedCodec` (`types.ts:78-127`);
 * the adapter attaches it to the `RTCRtpSenderLike` its `addTrack` returns
 * (`adapters/werift.ts:338`). An earlier draft of this task put it on
 * `PeerLike` and called it as `this.peer.selectNegotiatedCodec(...)`, which
 * would have been `undefined` at runtime — the re-point silently skipped, the
 * sender left on the browser's mode-0 entry, and every frame depacketized
 * wrongly with no error anywhere. This is the third time a per-task seam in
 * this plan has been guessed at a layer above where it lives; the rule is to
 * read the adapter, never to infer the shape from the method's name.
 */

/**
 * Find the browser's H.264 `packetization-mode=1` entry in an offer.
 *
 * This is R-S3's input. It parses the offer's `a=rtpmap:`/`a=fmtp:` pairs and
 * returns the first H.264 entry whose fmtp explicitly carries
 * `packetization-mode=1`. Returns `null` when the browser offered no such
 * entry, in which case no re-point is possible and the caller treats that as a
 * hard failure for a desktop session: the packetizer emits mode-1 framing and a
 * mode-0-only peer cannot decode it.
 *
 * An **absent** `packetization-mode` is mode 0, not mode 1 — RFC 6184 §8.1
 * states the default is 0. Treating absence as mode 1 would silently select a
 * non-existent mode-1 entry and defeat R-S3 on exactly the peers it protects.
 */
export function h264Mode1Codec(offerSdp: string): {
  mimeType: string;
  payloadType: number;
  parameters?: string;
} | null {
  const lines = offerSdp.split(/\r\n|\n/);
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+) (H264)\/90000$/i.exec(line);
    if (!rtpmap) continue;
    const payloadType = Number(rtpmap[1]);
    const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${payloadType} `));
    const parameters = fmtp ? fmtp.slice(`a=fmtp:${payloadType} `.length) : '';
    // RFC 6184 §8.1: `packetization-mode` defaults to 0, but every real H.264
    // offer carries it explicitly. An absent key means mode 0 by the letter of
    // the RFC — do NOT treat absent as mode 1.
    const mode = /(?:^|;)packetization-mode=(\d+)/.exec(parameters);
    if (mode && mode[1] === '1') {
      return { mimeType: 'video/H264', payloadType, parameters };
    }
  }
  return null;
}

export interface DataChannelLike {
  label(): Promise<string>;
  close(): Promise<void>;
}

export interface SessionPeerOptions {
  acceptedLabel: string;
}

/**
 * The answerer half of one session.
 *
 * **Track before `setRemoteDescription`, always** (B12). `addTrack` creates the
 * transceiver and therefore the m-line; adding it after the remote description
 * exists means the offer's video m-line is answered `inactive` and the browser
 * never receives a track. There is no error anywhere — the video is simply
 * black — which is why `answer()` enforces the order internally instead of
 * leaving it to the caller, and why the test asserts the call order rather than
 * the result.
 *
 * The data-channel gate (B13) closes a wrong-label channel immediately and
 * swallows the close error: the peer is hostile or buggy, and a failed close is
 * not something the agent can act on. A second channel with the *right* label is
 * also closed — one session has exactly one channel.
 *
 * `close()` takes no code. The Rust API had none either (DCEP teardown is
 * unparameterised), so inventing a 4000-series code here would be a protocol
 * claim the transport cannot honour.
 */
export class SessionPeer {
  channel: DataChannelLike | null = null;

  constructor(
    private readonly peer: PeerLike,
    private readonly options: SessionPeerOptions,
  ) {}

  async answer(
    offerSdp: string,
    opts: { desktop: boolean; track?: { track: unknown; stream?: unknown } },
  ): Promise<{ answerSdp: string; sender: RTCRtpSenderLike | null }> {
    // B12: the track is attached BEFORE setRemoteDescription. `addTrack` is what
    // creates the transceiver and therefore the offer's video m-line; doing it
    // after means the m-line is answered `inactive` and the browser gets no
    // video — silently, with no error anywhere.
    let sender: RTCRtpSenderLike | null = null;
    if (opts.desktop) {
      if (!opts.track) {
        throw new Error('a desktop session was answered with no outbound track to send');
      }
      sender = await this.peer.addTrack?.(opts.track.track, opts.track.stream);
      if (!sender) {
        throw new Error('the peer connection has no addTrack; it cannot answer a desktop session');
      }
    }
    await this.peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });

    // R-S3: re-point the sender at the browser's H.264 `packetization-mode=1`
    // entry, and do it HERE — after `setRemoteDescription`, before
    // `createAnswer`.
    //
    //   - It must be after `setRemoteDescription`: that call is what runs
    //     `prepareSend` and assigns `transceiver.codecs` from the offer
    //     (transceiverManager.js:276-277), so before it there is nothing
    //     negotiated to select from and `selectNegotiatedCodec` would throw
    //     "was not negotiated".
    //   - It must be before `createAnswer`: that call builds the answer's
    //     `m=video` payload-type order from `transceiver.codecs`
    //     (sdpManager.js:90-100). Re-pointing afterwards leaves the emitted SDP
    //     advertising the old order while the sender writes the new payload
    //     type — a mismatch the browser resolves by dropping the packets.
    //
    // The entry comes from the OFFER, parsed by `h264Mode1Codec` — the adapter
    // exposes senders, not the transceiver's codec list, so there is no
    // accessor to ask.
    if (sender) {
      const mode1 = h264Mode1Codec(offerSdp);
      if (!mode1) {
        // The packetizer only emits mode-1 framing (single-NAL / STAP-A /
        // FU-A). A mode-0-only peer cannot decode any of it. Failing here is
        // the only place this is visible at all: the connection would come up
        // healthy and the video would simply be black.
        throw new Error(
          'the desktop offer carries no H.264 entry with packetization-mode=1; the packetizer cannot serve this peer',
        );
      }
      sender.selectNegotiatedCodec(mode1);
    }

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return { answerSdp: answer.sdp, sender };
  }

  async handleDataChannel(channel: DataChannelLike): Promise<void> {
    let label: string;
    try {
      label = await channel.label();
    } catch {
      return;
    }
    if (label !== this.options.acceptedLabel) {
      await channel.close().catch(() => undefined);
      return;
    }
    if (this.channel !== null) {
      await channel.close().catch(() => undefined);
      return;
    }
    this.channel = channel;
  }
}
```

- [ ] **Step 4: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/session/ice.test.ts test/session/peer.test.ts
./node_modules/.bin/prettier --write apps/agent/src/session/{ice,peer}.ts apps/agent/test/session/{ice,peer}.test.ts
git add apps/agent/src/session apps/agent/test/session
git commit -m "feat(agent): add the werift answerer, ICE mapping and data-channel gate"
```

**TEST-INTEGRITY declaration:** two new files, **36 new `it()` / 48 new `expect()`** (`ice.test.ts` 17/23, `peer.test.ts` 19/25). Ports all 16 `rtc.rs` tests except `answer_advertises_e2ee_only_when_offer_proposed_it` (that becomes Task 14's B55 assertion, `advertisesE2ee`) and `reporting_estimator_publishes_its_initial_target` (moves to Task 19's runtime).

The count is 36, not the 22 an earlier draft of this declaration claimed. That draft predated the R-S3 repair and was never re-derived against the block: the 16-port arithmetic was carried in the prose while `h264Mode1Codec`'s seven parsing tests and `answer()`'s seven R-S3 tests were written underneath it. The same error class — a count written from a story about the task rather than from the task's own `it()` lines — is what produced the `api.rs` 12/8 split corrected in R3. Every declaration in this plan is now counted, not recalled.

**New coverage this task owes and now carries** (seven tests, all in the `SessionPeer.answer` and `h264Mode1Codec` blocks) — none of which the Rust could have had, because there was no `h264Mode1Codec` and no re-point:
- the re-point's **position in the call sequence** (`addTrack → setRemoteDescription → selectNegotiatedCodec → createAnswer → setLocalDescription`). This is the load-bearing one: before `setRemoteDescription` the selection throws "not negotiated", and after `createAnswer` the emitted SDP still advertises the old payload-type order;
- the payload type actually selected, parsed from the offer rather than from an adapter accessor;
- `answer()` returning the sender, so Task 19's `sendRtp` has a `writeRtp` to call;
- a hard throw — and **no re-point** — when the offer has no mode-1 entry;
- a hard throw when a desktop session is answered with no track;
- absent `packetization-mode` read as **mode 0** (RFC 6184 §8.1), which is the difference between R-S3 working and R-S3 selecting a non-existent entry.

---

### Task 9: The shell allowlist

**Files:**
- Create: `apps/agent/src/terminal/shell-policy.ts`
- Test: `apps/agent/test/terminal/shell-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const UNIX_SHELL_FLOOR: readonly string[]`
  - `function loadShellPolicy(options: { configured: string; etcShells?: string }): ShellPolicy`
  - `class ShellPolicy { resolveClientShell(requested: string): string }` — throws `ShellRefusedError` with the Rust's exact messages.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/terminal/shell-policy.test.ts
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadShellPolicy } from '../../src/terminal/shell-policy.js';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ponter-shell-'));
  const allowed = join(dir, 'allowed.sh');
  writeFileSync(allowed, '#!/bin/sh\n');
  chmodSync(allowed, 0o755);
  return { dir, allowed };
}

describe('ShellPolicy.resolveClientShell', () => {
  it('resolves an allowlisted executable to its canonical path', () => {
    const { allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(policy.resolveClientShell(allowed)).toBe(allowed);
  });

  it('refuses a relative path', () => {
    const { allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell('bin/sh')).toThrow(/is not an absolute path/);
  });

  it('refuses a path that does not exist', () => {
    const { dir, allowed } = scratch();
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(join(dir, 'missing'))).toThrow(/cannot be resolved/);
  });

  it('refuses a directory', () => {
    const { dir, allowed } = scratch();
    const nested = join(dir, 'sub');
    mkdirSync(nested);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(nested)).toThrow(/is not a file/);
  });

  it('refuses a non-executable file', () => {
    const { allowed } = scratch();
    const plain = join(allowed, '..', 'plain.sh');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(plain)).toThrow(/is not executable/);
  });

  it('checks the executable bit BEFORE allowlist membership', () => {
    // A 0644 file that is also absent from the allowlist must fail as
    // "not executable": reporting "not in the allowlist" would send the user to
    // edit a config file that would not fix the problem.
    const { dir, allowed } = scratch();
    const plain = join(dir, 'plain.sh');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(plain)).toThrow(/is not executable/);
  });

  it('refuses an executable that is not in the allowlist', () => {
    const { dir, allowed } = scratch();
    const outside = join(dir, 'outside.sh');
    writeFileSync(outside, '#!/bin/sh\n');
    chmodSync(outside, 0o755);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(outside)).toThrow(/is not in the shell allowlist/);
  });

  it('accepts a symlink that resolves to an allowlisted target', () => {
    const { dir, allowed } = scratch();
    const link = join(dir, 'link.sh');
    symlinkSync(allowed, link);
    const policy = loadShellPolicy({ configured: allowed });
    expect(policy.resolveClientShell(link)).toBe(allowed);
  });

  it('refuses a symlink that resolves outside the allowlist', () => {
    const { dir, allowed } = scratch();
    const target = join(dir, 'target.sh');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const link = join(dir, 'link.sh');
    symlinkSync(target, link);
    const policy = loadShellPolicy({ configured: allowed });
    expect(() => policy.resolveClientShell(link)).toThrow(/is not in the shell allowlist/);
  });

  it('always allows the configured shell, even one outside the floor', () => {
    const { dir, allowed } = scratch();
    const custom = join(dir, 'custom.sh');
    writeFileSync(custom, '#!/bin/sh\n');
    chmodSync(custom, 0o755);
    const policy = loadShellPolicy({ configured: custom });
    expect(policy.resolveClientShell(custom)).toBe(custom);
    expect(policy.resolveClientShell(allowed)).toBe(allowed);
  });

  it('allows entries listed in the supplied /etc/shells content', () => {
    const { dir } = scratch();
    const extra = join(dir, 'extra.sh');
    writeFileSync(extra, '#!/bin/sh\n');
    chmodSync(extra, 0o755);
    const policy = loadShellPolicy({
      configured: extra,
      etcShells: `# comment\n\n${extra}\n`,
    });
    expect(policy.resolveClientShell(extra)).toBe(extra);
  });

  it('treats a missing /etc/shells as an empty list rather than an error', () => {
    const { allowed } = scratch();
    expect(() => loadShellPolicy({ configured: allowed, etcShells: '' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/terminal/shell-policy.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/terminal/shell-policy.ts
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * The four shells that exist on a stock POSIX host. The floor is not a
 * convenience: without it, a container with no `/etc/shells` would have an empty
 * allowlist and the terminal feature would be silently dead.
 */
export const UNIX_SHELL_FLOOR: readonly string[] = [
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/sh',
  '/usr/bin/bash',
];

export class ShellRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellRefusedError';
  }
}

export interface ShellPolicyOptions {
  /** `AGENT_SHELL` / `$SHELL`. Always allowed — the operator chose it. */
  configured: string;
  /** Contents of `/etc/shells`, or `''` when the file is absent or unreadable. */
  etcShells?: string;
}

function canonicalise(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function etcShellsEntries(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Which shells a peer is allowed to spawn (B36, B37 — B38 is the
 * operator's own shell, resolved at config time in `config.ts`).
 *
 * Two properties the Rust established and this keeps:
 *
 * - **Canonical on both sides of the comparison.** A symlink to an allowlisted
 *   shell is accepted; a symlink pointing anywhere else is refused. Comparing
 *   strings would accept `/tmp/evil -> /bin/sh` under a `/tmp/evil` entry and
 *   refuse the same shell through a legitimate link.
 * - **Order matters: executable bit before allowlist membership.** A 0644 file
 *   outside the allowlist fails as "not executable"; telling the user to edit
 *   the allowlist would not fix it.
 */
export class ShellPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(options: ShellPolicyOptions) {
    const allowed = new Set<string>();
    for (const candidate of [
      options.configured,
      ...UNIX_SHELL_FLOOR,
      ...etcShellsEntries(options.etcShells ?? ''),
    ]) {
      const resolved = canonicalise(candidate);
      if (resolved) allowed.add(resolved);
    }
    this.allowed = allowed;
  }

  /**
   * Resolve a peer-requested shell, or throw with the reason.
   *
   * The messages are the Rust's, because they reach the browser as the
   * `terminal-error` detail and the web UI shows them verbatim.
   */
  resolveClientShell(requested: string): string {
    if (!isAbsolute(requested)) {
      throw new ShellRefusedError(`${requested} is not an absolute path`);
    }
    const resolved = canonicalise(requested);
    if (resolved === null) {
      throw new ShellRefusedError(`${requested} cannot be resolved`);
    }
    if (!statSync(resolved).isFile()) {
      throw new ShellRefusedError(`${requested} is not a file`);
    }
    try {
      accessSync(resolved, constants.X_OK);
    } catch {
      throw new ShellRefusedError(`${requested} is not executable`);
    }
    if (!this.allowed.has(resolved)) {
      throw new ShellRefusedError(`${requested} is not in the shell allowlist`);
    }
    return resolved;
  }
}

/**
 * Windows has no allowlist: the operator's configured shell is the only
 * candidate, and there is no `/etc/shells`. The PowerShell probe order
 * (`pwsh` → `powershell` → `cmd.exe`) is resolved at config time by
 * `resolveShell` in `config.ts` (Task 1), because it picks the *operator's*
 * shell, not a peer-requested one. This module's job is the POSIX policy,
 * which is a different question: which shells a *peer* may ask for.
 */
export function loadShellPolicy(options: ShellPolicyOptions): ShellPolicy {
  return new ShellPolicy(options);
}

/** Reads `/etc/shells`, treating every failure as "no extra entries". */
export function readEtcShells(): string {
  try {
    return readFileSync('/etc/shells', 'utf8');
  } catch {
    return '';
  }
}
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/terminal/shell-policy.test.ts
./node_modules/.bin/prettier --write apps/agent/src/terminal/shell-policy.ts apps/agent/test/terminal/shell-policy.test.ts
git add apps/agent/src/terminal apps/agent/test/terminal
git commit -m "feat(agent): port the POSIX shell allowlist with its resolution order"
```

**TEST-INTEGRITY declaration:** one new file, **12 new `it()` / 13 new `expect()`**. Ports all 10 `shell_policy.rs` tests, plus two **new**: the executable-bit-before-allowlist ordering (present in code, untested in Rust) and the empty-`/etc/shells` case. `two_paths_that_resolve_to_the_same_file_are_one_entry` ports as the symlink-accept case, since the TS canonicalises into a `Set` and therefore cannot hold two entries.

---

### Task 10: The file sandbox

**Files:**
- Create: `apps/agent/src/files/sandbox.ts`
- Modify: `packages/shared/src/types/files.ts` (add the `FILES_ERROR_CODES` value export), `packages/shared/src/types/index.ts` (re-export it from the **value** block) — `apps/agent/package.json` already declared `@ponter/shared` as of Task 1, so the Step 3 install produces no manifest or lockfile diff
- Test: `apps/agent/test/files/sandbox.test.ts`

**Interfaces:**
- Consumes: `FilesErrorCode` from `@ponter/shared` — **the shared union, not a local one** (R11). This is a precondition of Task 11's crossing test: the port's bare action-result code must be typed by the shared union, or the repair reproduces §B-12f's "two independent lists" defect *inside* the port.
- Produces:
  - `class FilesRoot { static open(root: string): FilesRoot; resolveExisting(wire: string): string; resolveParentForCreate(wireDir: string, name: string): string }`
  - `class SandboxError extends Error { code: FilesErrorCode }`
  - `const FILES_ERROR_CODES: Record<FilesErrorCode, true>` in `packages/shared` — **a runtime value**, so a test can enumerate the 16 codes (R12)

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/files/sandbox.test.ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesRoot, SandboxError } from '../../src/files/sandbox.js';

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'ponter-files-'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'a.txt'), 'hello');
  return dir;
}

function code(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return (error as SandboxError).code;
  }
}

describe('FilesRoot.resolveExisting', () => {
  it('resolves an empty path to the root itself', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveExisting('')).toBe(dir);
  });

  it('resolves a nested relative path', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveExisting('docs/a.txt')).toBe(join(dir, 'docs', 'a.txt'));
  });

  it('rejects a NUL byte', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs\0/a.txt'))).toBe('INVALID_PATH');
  });

  it('rejects a backslash on every platform, not only Windows', () => {
    // The Rust checks this unconditionally because a Windows-authored client
    // sends `docs\a.txt` and a POSIX host would otherwise treat it as one
    // filename containing a backslash.
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs\\a.txt'))).toBe('INVALID_PATH');
  });

  it('rejects an absolute path', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('/etc/passwd'))).toBe('INVALID_PATH');
  });

  it('rejects an empty component', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs//a.txt'))).toBe('INVALID_PATH');
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs/'))).toBe('INVALID_PATH');
  });

  it('rejects a "." component', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('./docs/a.txt'))).toBe('INVALID_PATH');
  });

  it('lets ".." through and then rejects the escape by containment', () => {
    // ".." is not an INVALID_PATH: it is legal, and canonicalize resolves it
    // first. The rejection comes from the containment check, which is why the
    // two errors are different and both must exist.
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('docs/../..'))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('rejects a symlink that resolves outside the root', () => {
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), 'ponter-outside-'));
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(dir, 'escape'));
    expect(code(() => FilesRoot.open(dir).resolveExisting('escape/secret'))).toBe(
      'PATH_OUTSIDE_ROOT',
    );
  });

  it('accepts a symlink that stays inside the root', () => {
    const dir = root();
    symlinkSync(join(dir, 'docs'), join(dir, 'alias'));
    expect(FilesRoot.open(dir).resolveExisting('alias/a.txt')).toBe(join(dir, 'docs', 'a.txt'));
  });

  it('uses component-wise containment, not string prefix', () => {
    const dir = root();
    const sibling = `${dir}2`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x'), 'x');
    symlinkSync(sibling, join(dir, 'sibling'));
    expect(code(() => FilesRoot.open(dir).resolveExisting('sibling/x'))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('reports NOT_FOUND for a missing path', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveExisting('nope'))).toBe('NOT_FOUND');
  });
});

describe('FilesRoot.resolveParentForCreate', () => {
  it('resolves a valid parent and name', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveParentForCreate('docs', 'b.txt')).toBe(
      join(dir, 'docs', 'b.txt'),
    );
  });

  it('treats an empty directory as the root', () => {
    const dir = root();
    expect(FilesRoot.open(dir).resolveParentForCreate('', 'b.txt')).toBe(join(dir, 'b.txt'));
  });

  it('rejects a name containing a slash, a backslash, a NUL, or a dot', () => {
    const dir = root();
    for (const name of ['a/b', 'a\\b', 'a\0b', '.', '..', '']) {
      expect(code(() => FilesRoot.open(dir).resolveParentForCreate('docs', name))).toBe(
        'INVALID_PATH',
      );
    }
  });

  it('rejects a parent that is a file', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(dir).resolveParentForCreate('docs/a.txt', 'b'))).toBe(
      'NOT_A_DIRECTORY',
    );
  });
});

describe('FilesRoot.open', () => {
  it('rejects a root that does not exist', () => {
    expect(code(() => FilesRoot.open(join(tmpdir(), 'definitely-not-here')))).toBe('NOT_FOUND');
  });

  it('rejects a root that is a file', () => {
    const dir = root();
    expect(code(() => FilesRoot.open(join(dir, 'docs', 'a.txt')))).toBe('NOT_A_DIRECTORY');
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/files/sandbox.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/files/sandbox.ts
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import type { FilesErrorCode } from '@ponter/shared';

/**
 * **R11: the shared union, re-exported, not redeclared.** The Rust had one
 * `FilesErrorCode` and the browser has one (`packages/shared/src/types/files.ts`
 * `:98-114`); a second literal here would be byte-identical today and drift
 * silently tomorrow, because nothing relates the two. `export type` rather
 * than a fresh declaration, so a consumer that imports it from `sandbox.js`
 * still compiles and `tsc` still catches a code the shared union rejects.
 *
 * The re-export keeps this module's existing import surface while making the
 * shared package the only definition.
 */
export type { FilesErrorCode };

export class SandboxError extends Error {
  constructor(
    readonly code: FilesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export function errnoToCode(error: unknown): FilesErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'EEXIST') return 'FILE_EXISTS';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOTDIR') return 'NOT_A_DIRECTORY';
  if (code === 'EISDIR') return 'NOT_A_DIRECTORY';
  return 'IO_ERROR';
}

/**
 * The sandbox (B44), in the Rust's exact seven-step order.
 *
 * Order is load-bearing, not stylistic:
 *
 * 1. NUL, 2. backslash, 3. absolute, 4. component-wise join — the cheap textual
 * rejections come first so a hostile client cannot make the agent touch the
 * filesystem before the path is known to be well-formed.
 *
 * `..` is **allowed through step 4** and resolved by `realpath` in step 6. That
 * is deliberate and is why `..` produces `PATH_OUTSIDE_ROOT` rather than
 * `INVALID_PATH`: rejecting it textually would refuse legitimate
 * `docs/../a.txt`, while resolving it and then checking containment catches the
 * escape and the legitimate case with the same code path.
 *
 * Containment is **component-wise**, not a string prefix: `/srv/files2` must not
 * be inside `/srv/files`, and `startsWith` would say it is.
 *
 * `realpath` also resolves symlinks, which is the only check that catches a link
 * planted inside the sandbox pointing anywhere else.
 */
export class FilesRoot {
  private constructor(readonly root: string) {}
  static open(root: string): FilesRoot {
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `files root ${root} is not resolvable`);
    }
    if (!statSync(canonical).isDirectory()) {
      throw new SandboxError('NOT_A_DIRECTORY', `files root ${root} is not a directory`);
    }
    try {
      // The Rust probes `read_dir` so an unreadable root closes the gate at
      // startup rather than at the first listing (ADR-32). `stat` is not a
      // substitute: it succeeds on a mode-000 directory the agent owns, which
      // is exactly the case the probe exists for.
      readdirSync(canonical);
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `files root ${root} is not readable`);
    }
    return new FilesRoot(canonical);
  }

  resolveExisting(wirePath: string): string {
    const joined = this.joinWire(wirePath);
    let canonical: string;
    try {
      canonical = realpathSync(joined);
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `cannot resolve ${wirePath}`);
    }
    this.ensureContained(canonical, wirePath);
    return canonical;
  }

  resolveParentForCreate(wireDir: string, name: string): string {
    if (name === '' || name === '.' || name === '..') {
      throw new SandboxError('INVALID_PATH', 'name is not a valid file name');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new SandboxError('INVALID_PATH', 'name must not contain a path separator');
    }
    const parent = this.resolveExisting(wireDir);
    if (!statSync(parent).isDirectory()) {
      throw new SandboxError('NOT_A_DIRECTORY', `${wireDir} is not a directory`);
    }
    // The target is NOT canonicalised: it does not exist yet.
    return join(parent, name);
  }

  private joinWire(wirePath: string): string {
    if (wirePath.includes('\0')) throw new SandboxError('INVALID_PATH', 'path contains a NUL');
    if (wirePath.includes('\\')) {
      throw new SandboxError('INVALID_PATH', 'backslash is not a POSIX path separator');
    }
    if (isAbsolute(wirePath)) throw new SandboxError('INVALID_PATH', 'path must be relative');
    if (wirePath === '') return this.root;

    let current = this.root;
    for (const component of wirePath.split('/')) {
      if (component === '') {
        throw new SandboxError('INVALID_PATH', 'empty path component');
      }
      if (component === '.') throw new SandboxError('INVALID_PATH', 'dot path component');
      current = join(current, component);
    }
    return current;
  }

  private ensureContained(canonical: string, wirePath: string): void {
    if (canonical === this.root) return;
    // The separator is appended **only when the root does not already end in
    // one**. `AGENT_FILES_ROOT=/` canonicalises to `/`, and `/` + `/` is `//`,
    // which no path but `//` itself starts with — so the unconditional form
    // rejects everything under a root of `/` with `PATH_OUTSIDE_ROOT`
    // (fail-closed: a usability bug, not an escape). Appending unconditionally
    // is the same trap for any root that names a filesystem root.
    const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (!canonical.startsWith(prefix)) {
      throw new SandboxError('PATH_OUTSIDE_ROOT', `${wirePath} resolves outside the files root`);
    }
  }
}
```

- [ ] **Step 3: Add the shared dependency (R11) and the codes guard (R12)**

**Ordering, stated so the build steps cannot be run out of sequence.** R11 and
R12 both land **here**, in Task 10, and both are **preconditions of R13** —
Task 11's crossing test, which drives each of R12's fifteen discriminating keys
through the real `FileClient` and enumerates them with
`Object.keys(FILES_ERROR_CODES)`:
- without **R12**, that enumeration has nothing to enumerate (a type-only
  `Record` has no runtime keys) and the test does not compile;
- without **R11**, the port's bare action-failure code is typed by a local
  union that relates to nothing, so the test would pin two lists that drift
  independently — §B-12f's defect, moved inside the port.

Task 10 must therefore be executed and committed before Task 11's Step 5.
R13 itself lands in Task 11 and is **not** re-specified here; this step exists
only to make its two inputs real.

**R12 first, because R11's import needs the value to exist.** `FilesErrorCode`
is a type-only union today, so nothing can enumerate the 16 codes at runtime.
`FILES_ERROR_CODES` is a `Record<FilesErrorCode, true>`: the mapped type makes an
**omission** a `TS2741` and a **bogus key** a `TS2353`, which the bare union
does not catch (the union guards spellings only). It goes in a **source file**,
not a `.test.ts`, so it is caught by the gating `typecheck` step
(`ci-node.yml:86`) rather than by `@ponter/shared`'s own `continue-on-error`
test step.

```ts
// packages/shared/src/types/files.ts — appended below the `FilesErrorCode` union
/**
 * The exhaustiveness guard the Rust's 12-case literal table could not be.
 *
 * Exported as a **value**, not a type: Task 11's crossing test enumerates it
 * with `Object.keys(FILES_ERROR_CODES)`, and a type-only record has no runtime
 * shape to enumerate. One artefact, two duties — completeness guard and
 * enumeration source — which is why R12 is a precondition of that test rather
 * than a parallel item.
 */
export const FILES_ERROR_CODES: Record<FilesErrorCode, true> = {
  PATH_OUTSIDE_ROOT: true,
  INVALID_PATH: true,
  NOT_FOUND: true,
  NOT_A_FILE: true,
  NOT_A_DIRECTORY: true,
  FILE_EXISTS: true,
  FILE_TOO_LARGE: true,
  TRANSFER_BUSY: true,
  TRANSFER_UNKNOWN: true,
  TRANSFER_TIMEOUT: true,
  IO_ERROR: true,
  BAD_FRAME: true,
  RESUME_INVALID: true,
  DIR_NOT_EMPTY: true,
  PERMISSION_DENIED: true,
  QUEUE_FULL: true,
};
```

The barrel line goes in `packages/shared/src/types/index.ts`'s **value** block
(`:33-37`, the one that re-exports `BINARY_TYPE_*`), **added to the existing
list** — not a new statement beside it, and **not** the `export type` block at
`:38-68`, which would be `TS1205` ("cannot be used with `export type`"). Without
this line the constant exists and is unreachable: `packages/shared`'s `exports`
is `{".": "./src/index.ts"}`, so `types/index.ts` is the only route out.

```ts
export {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
  BINARY_HEADER_LEN,
  FILES_ERROR_CODES,
} from './files.js';
```

**Then R11's dependency, as one command.** An earlier draft asserted that
`apps/agent` did not declare `@ponter/shared` (claiming 0 hits in
`apps/agent/package.json`). That claim was stale: `@ponter/shared` was already
declared (`"@ponter/shared": "workspace:*"`) and present in `pnpm-lock.yaml` as
of Task 1 (`9cc4c65`). Running the prescribed command below is therefore an
idempotent no-op and produces **no diff** in `apps/agent/package.json` or
`pnpm-lock.yaml` — which is why landed commit `411e632` correctly contains no
manifest or lockfile blob. The command is kept for idempotence:

```bash
pnpm --filter @ponter/agent-node add --workspace @ponter/shared
```

**R11's guarantee is correct and it is not a gate, and that must be stated
rather than implied.** No CI job typechecks `@ponter/agent-node` at all: the
only `typecheck` run is `ci-node.yml:86` (`turbo run typecheck
--filter='!@ponter/agent-node'`), and `apps/agent/**` is absent from the
workflow's `paths:`. So a broken import here is green locally and invisible in
CI. The **lockfile** half is gating (`ci-node.yml:78` runs `pnpm install
--frozen-lockfile`, and `paths:` includes `packages/**` and `pnpm-lock.yaml`),
which is why the install must run before the commit. The Plan-3 handoff is the
path plus dropping the `!@ponter/agent-node` filter from `:83`, `:86` and `:108`.

- [ ] **Step 4: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/files/sandbox.test.ts
./node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json
./node_modules/.bin/prettier --write apps/agent/src/files/sandbox.ts apps/agent/test/files/sandbox.test.ts packages/shared/src/types/files.ts packages/shared/src/types/index.ts
git add apps/agent/src/files apps/agent/test/files \
        packages/shared/src/types/files.ts packages/shared/src/types/index.ts
git commit -m "feat(agent): port the files sandbox on the shared error union"
```

**Both paths outside `apps/agent/src` and `apps/agent/test` must be in that
`git add`.** `packages/shared/src/types/files.ts` and `index.ts` are staged by
no other step in any plan, and leaving them out leaves `FILES_ERROR_CODES` in
the working tree only — Task 11's fence would then import a name that does not
exist on `main`, and the failure is invisible because nothing in CI typechecks
the port's package. (`apps/agent/package.json` and `pnpm-lock.yaml` produce no
diff because `@ponter/shared` was already present in the workspace manifest).

**TEST-INTEGRITY declaration:** one new file, **18 new `it()` / 19 new `expect()`**. Ports `path_policy_rejects_dotdot_escape`, `path_policy_rejects_absolute`, `path_policy_rejects_empty_components_and_dots`, `path_policy_rejects_symlink_escape`, `path_policy_rejects_prefix_confusion`, `upload_create_path_validates_parent_and_name`, `root_resolution_fails_when_missing_not_a_dir_or_unreadable`. **New:** the NUL and backslash rejections as separate cases (the Rust tested them inside one `path_policy_*` test), and the inside-the-root symlink acceptance, which the Rust had no positive case for.

**Declared open gap (unreadable-root test):** While the declaration cites
`root_resolution_fails_when_missing_not_a_dir_or_unreadable` (`files.rs:3258`),
the Rust test actually has **three** arms: missing path (`NotFound`), file not a
directory (`NotADirectory`), and mode-000 unreadable directory
(`PermissionDenied`). The ported fence (`describe('FilesRoot.open')` at
`:3895-3904`) ports only the first two and has **no unreadable-root test**.
Measured consequence: reverting production `readdirSync` back to the vacuous
`statSync` leaves the fence **18/18 green**, meaning the fence does not pin the
probe that `sandbox.ts:83` implements. The test cannot be added here without
changing the landed and declared count (**18 `it()` / 19 `expect()`**); it is
recorded as an open gap with the Rust citation (`files.rs:3258`) for a later task
or follow-up suite to own and pin against `EACCES`.

**Known limitation carried into Plan 3's docs:** a TOCTOU window exists between `realpath` and the later `open` — a symlink swapped in that gap escapes. The Rust has the same window and does not close it. Closing it needs per-component `openat` with `O_NOFOLLOW`, which Node cannot do without a native call. Record it; do not attempt a partial mitigation that reads as a guarantee.

---

### Task 11: The files wire protocol and transfer state machine

**Files:**
- Create: `apps/agent/src/files/protocol.ts`
- Create: `apps/agent/src/files/session.ts`
- Modify: `apps/agent/package.json` (add `@ponter/file-core` as a devDependency), `packages/file-core/package.json` (add the `exports` map), `pnpm-lock.yaml` (regenerated by the install in Step 5)
- Test: `apps/agent/test/files/protocol.test.ts`, `apps/agent/test/files/session.test.ts`, `apps/agent/test/files/action-result.test.ts`

**Interfaces:**
- Consumes: `FilesRoot`, `SandboxError` (Task 10), `FilesErrorCode` from `@ponter/shared` (Task 10's R11), `DataChannelMessage` from `@ponter/shared`.
- Produces:
  - `const FILE_CHUNK_BYTES = 32768`, `const FILE_WINDOW_CHUNKS = 64`, `const FILES_IDLE_TIMEOUT_MS = 30_000`, `const ACK_FREQUENCY_CHUNKS = 16`, `const ACK_FLUSH_INTERVAL_MS = 20`, `const FILE_MAX_BYTES = 1024 ** 3`, `const MAX_LIST_ENTRIES = 4096`, `const PART_SUFFIX = '.ponter-part'`
  - `function encodeDownloadChunk(transferId: string, chunkIndex: number, payload: Uint8Array): Uint8Array`
  - `function decodeUploadChunk(frame: Uint8Array): { transferId: string; chunkIndex: number; payload: Uint8Array }`
  - `function totalChunks(size: number): number`, `function expectedChunkLen(size: number, index: number): number`
  - `function partName(name: string): string`
  - `function frameFiles(payload: FilesFrame, timestamp: number): DataChannelMessage<FilesFrame>` — **R1**, the outbound envelope
  - `const FILES_INBOUND_TYPES` (12 entries), `type FilesInboundType`, `function decodeFilesFrame(message): … | null` — **R6**, the inbound decode gate
  - `type FieldKind`, `interface InboundShape`, `const INBOUND_FIELDS: Record<FilesInboundType, InboundShape>` (12 types / **32 fields**), `function matchesKind(value, kind)`, `function inboundShapeValid(message): boolean` — **the wire type contract**, added by Task 22 (landed `2e3f763`). `INBOUND_FIELDS` is a `Record` whose key is `FilesInboundType`, so a thirteenth type joins the enumeration and fails `tsc` until it has a shape; that is the property the comment cannot enforce.
  - `class FilesSession { handle(message); checkIdle(); flushAcks(); acceptBinaryChunk(frame); dispose() }` — `noteChunk()` and `takePendingAck()` are **private** and split per **R7**

- [ ] **Step 1: Write the failing protocol test**

```ts
// apps/agent/test/files/protocol.test.ts
import { describe, expect, it } from 'vitest';
import {
  decodeUploadChunk,
  encodeDownloadChunk,
  expectedChunkLen,
  frameFiles,
  partName,
  totalChunks,
} from '../../src/files/protocol.js';
import { SandboxError } from '../../src/files/sandbox.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('chunk arithmetic', () => {
  it('counts the last partial chunk', () => {
    expect(totalChunks(0)).toBe(0);
    expect(totalChunks(1)).toBe(1);
    expect(totalChunks(32768)).toBe(1);
    expect(totalChunks(32769)).toBe(2);
  });

  it('returns a full chunk except the last', () => {
    expect(expectedChunkLen(65536, 0)).toBe(32768);
    expect(expectedChunkLen(65536, 1)).toBe(32768);
    expect(expectedChunkLen(65537, 2)).toBe(1);
  });
});

describe('the binary frame', () => {
  it('round-trips through the 25-byte header', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeDownloadChunk(ID, 7, payload);
    expect(frame).toHaveLength(25 + 4);
    expect(frame[0]).toBe(0x01);
    expect(Buffer.from(frame.slice(17, 25)).readBigUInt64BE()).toBe(7n);
  });

  it('encodes the id as 16 raw UUID bytes, not ASCII', () => {
    const frame = encodeDownloadChunk(ID, 0, new Uint8Array(0));
    expect(frame.slice(1, 17)).toEqual(Buffer.from('0f8fad5bd9cb469fa16570867728950e', 'hex'));
  });

  it('decodes an upload frame as type 0x02', () => {
    const frame = encodeDownloadChunk(ID, 3, new Uint8Array([9]));
    frame[0] = 0x02;
    const decoded = decodeUploadChunk(frame);
    expect(decoded.transferId).toBe(ID);
    expect(decoded.chunkIndex).toBe(3);
    expect(decoded.payload).toEqual(new Uint8Array([9]));
  });

  it('rejects a truncated header', () => {
    expect(() => decodeUploadChunk(new Uint8Array(24))).toThrow(SandboxError);
  });

  it('rejects a payload above the chunk cap', () => {
    expect(() => decodeUploadChunk(new Uint8Array(25 + 32769))).toThrow(/exceeds/);
  });

  it('accepts a payload of exactly the cap', () => {
    expect(() => decodeUploadChunk(new Uint8Array(25 + 32768))).not.toThrow();
  });
});

describe('partName', () => {
  it('appends the resume suffix as a sibling', () => {
    expect(partName('report.pdf')).toBe('report.pdf.ponter-part');
  });
});

describe('frameFiles — the outbound envelope (R1)', () => {
  it('wraps a JSON frame as { type, channel, payload, timestamp }', () => {
    const frame = { type: 'files-list-result', requestId: 'r-1', entries: [] };
    expect(frameFiles(frame, 1_700_000_000_000)).toEqual({
      type: 'files-list-result',
      channel: 'files',
      payload: { type: 'files-list-result', requestId: 'r-1', entries: [] },
      timestamp: 1_700_000_000_000,
    });
  });

  it('nests the fields instead of leaving them as siblings', () => {
    // The defect this pins: the plan's frames were flat, the browser reads
    // `msg.payload`, and `packages/webrtc-core/src/data-channel.ts:33-38`
    // swallows the resulting `TypeError` in a bare `catch {}`. So a flat frame
    // is not a wrong answer — it is a promise that never settles.
    const framed = frameFiles({ type: 'files-error', code: 'BAD_FRAME' }, 0) as unknown as Record<string, unknown>;
    expect(framed).not.toHaveProperty('code'); // the field moved into `payload`
    expect(framed.payload).toMatchObject({ code: 'BAD_FRAME' });
  });

  it('pins channel to "files" for every frame', () => {
    expect(frameFiles({ type: 'files-error', code: 'BAD_FRAME' }, 0).channel).toBe('files');
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `protocol.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/files/protocol.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/files/protocol.ts
import type { DataChannelMessage } from '@ponter/shared';
import { SandboxError } from './sandbox.js';

export const FILE_CHUNK_BYTES = 32_768;
export const FILE_WINDOW_CHUNKS = 64;
export const FILES_IDLE_TIMEOUT_MS = 30_000;
export const ACK_FREQUENCY_CHUNKS = 16;
export const ACK_FLUSH_INTERVAL_MS = 20;
export const FILE_MAX_BYTES = 1024 ** 3;
export const MAX_LIST_ENTRIES = 4096;
export const PART_SUFFIX = '.ponter-part';

export const DOWNLOAD_CHUNK = 0x01;
export const UPLOAD_CHUNK = 0x02;

const BINARY_HEADER_LEN = 25;
const TRANSFER_ID_LEN = 16;

/** `[1B type][16B id][8B big-endian index][payload]` — 25 bytes of header. */
export function totalChunks(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

export function expectedChunkLen(size: number, index: number): number {
  const remaining = size - index * FILE_CHUNK_BYTES;
  return Math.min(FILE_CHUNK_BYTES, Math.max(0, remaining));
}

function transferIdTo16(transferId: string): Uint8Array {
  const hex = transferId.replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return new Uint8Array(Buffer.from(hex, 'hex'));
  // Test-only affordance the Rust also had: a non-UUID id becomes its first 16
  // ASCII bytes, NUL-padded. Production ids are always UUIDs.
  const out = new Uint8Array(TRANSFER_ID_LEN);
  Buffer.from(transferId, 'utf8').copy(Buffer.from(out.buffer), 0, 0, TRANSFER_ID_LEN);
  return out;
}

function transferIdFrom16(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function encodeDownloadChunk(
  transferId: string,
  chunkIndex: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(BINARY_HEADER_LEN + payload.length);
  frame[0] = DOWNLOAD_CHUNK;
  frame.set(transferIdTo16(transferId), 1);
  frame.set(new Uint8Array(Buffer.alloc(8)), 17);
  Buffer.from(frame.buffer).writeBigUInt64BE(BigInt(chunkIndex), 17);
  frame.set(payload, BINARY_HEADER_LEN);
  return frame;
}

/**
 * The inbound binary frame (B42). The type byte is **not** validated here: the
 * Rust routed by first byte at the dispatcher and only `0x02` reaches this
 * decoder, so validating it twice would produce two different error paths for
 * the same hostile input.
 */
export function decodeUploadChunk(frame: Uint8Array): {
  transferId: string;
  chunkIndex: number;
  payload: Uint8Array;
} {
  if (frame.length < BINARY_HEADER_LEN) {
    throw new SandboxError('BAD_FRAME', 'binary frame header truncated');
  }
  if (frame.length > BINARY_HEADER_LEN + FILE_CHUNK_BYTES) {
    throw new SandboxError('BAD_FRAME', 'binary frame payload exceeds chunk cap');
  }
  const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    transferId: transferIdFrom16(frame.slice(1, 17)),
    chunkIndex: Number(view.readBigUInt64BE(17)),
    payload: frame.slice(BINARY_HEADER_LEN),
  };
}

export function partName(name: string): string {
  return `${name}${PART_SUFFIX}`;
}

/**
 * **R1: the outbound envelope, and why the plan's flat frames were a silent
 * hang rather than a visible bug.**
 *
 * The Rust builds every JSON frame through `frame_files`
 * (`apps/agent/src/files.rs:660`, with `channel: FILES_CHANNEL` at `:678`):
 * `{ type, channel: 'files', payload, timestamp }`. The plan emitted **flat**
 * frames — `{ type, requestId, path, entries, truncated }` with the fields as
 * siblings of `type`. Measured over Task 11's span: `channel` → 0 occurrences,
 * `timestamp` → 0, and `frame_files|frameFiles` → 1 (the retire clause's own
 * prose).
 *
 * The failure this produces is worth stating exactly, because it is invisible
 * in dev: the browser reads `msg.payload` (`packages/file-core/src/client.ts`,
 * `handleMessage`), so on a flat frame `payload` is `undefined` and
 * `payload.requestId` throws a `TypeError` — which
 * `packages/webrtc-core/src/data-channel.ts:33-38` swallows in the bare
 * `catch {}` that opens **before** its typed-handler loop. The remaining
 * handlers for that message are skipped, and `list()` / `mkdir()` /
 * `delete()`'s promise **never settles**: no resolve, no reject, no
 * `FilesError`, no unhandled rejection. There is no error to find because
 * nothing throws where anyone can see it.
 *
 * So the envelope is required, and it must be `DataChannelMessage` from
 * `@ponter/shared` (`packages/shared/src/types/webrtc.ts:9-14`) rather than a
 * local shape, so a drift in the shared type is a `tsc` error here.
 *
 * **Binary frames are deliberately not wrapped.** The Rust's `frame_files` is
 * the JSON path; chunk frames go out through `encodeDownloadChunk` and the
 * browser's raw handler reads them as bytes. Wrapping them would put a
 * `Uint8Array` inside a JSON string.
 *
 * `timestamp` is a parameter rather than an internal `Date.now()` so the
 * builder stays pure and the tests can pin it — the same reason every other
 * clock in this task is injected.
 */
export function frameFiles(payload: FilesFrame, timestamp: number): DataChannelMessage<FilesFrame> {
  return {
    type: typeof payload === 'object' && !(payload instanceof Uint8Array) ? payload.type : 'files-binary',
    channel: 'files',
    payload,
    timestamp,
  };
}

/**
 * `RemoteFile.modifiedAt` is an RFC 3339 UTC string (`files.rs:141-161`), not an
 * epoch number, and the value is always normalized to end in `Z` — the wire
 * type in `packages/shared/src/types/files.ts:6-13` declares `modifiedAt:
 * string`, and `apps/web`'s `formatModified` parses it as one.
 *
 * Seconds, not milliseconds: `mtimeMs` truncated. A directory's `mtimeMs` can
 * carry a fractional part that would otherwise leak into the string.
 */
export function rfc3339Utc(epochMs: number): string {
  const d = new Date(Math.floor(epochMs / 1000) * 1000);
  return `${d.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}
```

- [ ] **Step 3: Write the failing session test**

```ts
// apps/agent/test/files/session.test.ts
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesRoot } from '../../src/files/sandbox.js';
import { FILES_IDLE_TIMEOUT_MS } from '../../src/files/protocol.js';
import type { FilesFrame } from '../../src/files/session.js';
import {
  FILES_INBOUND_TYPES,
  FilesSession,
  decodeFilesFrame,
  resumeOffsetMatches,
  type RemoteFileWire,
} from '../../src/files/session.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '11111111-2222-3333-4444-555555555555';

function session() {
  const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
  writeFileSync(join(dir, 'a.bin'), Buffer.alloc(100_000, 7));
  return { dir, s: new FilesSession(FilesRoot.open(dir), () => 0) };
}

/**
 * The `type` of a JSON frame, or a marker for the two non-JSON kinds. A
 * `FilesFrame` is `string | Uint8Array | {type, …}`, so neither
 * `typeof f !== 'string'` nor `typeof f === 'string' ? f : f.type` narrows
 * enough for `tsc` under `strict`.
 */
function frameType(f: FilesFrame): string {
  if (typeof f === 'string') return '<<text>>';
  if (f instanceof Uint8Array) return '<<binary>>';
  return f.type;
}

describe('list', () => {
  /** The one frame `files-list` returns, narrowed to its wire shape. */
  function listResult(out: FilesFrame[]) {
    return out[0] as unknown as {
      type: string;
      requestId: string;
      truncated: boolean;
      entries: RemoteFileWire[];
    };
  }

  // Ports `list_returns_entries_sorted_dirs_first` (files.rs:2703). The sort
  // assertions are the point: `localeCompare` on this fixture would also put
  // the dir first, so the name-order half is what discriminates — byte-wise
  // puts `a.txt` before `b.txt`, and would put `B.txt` before `a.txt`.
  it('lists entries sorted directories-first, then name byte-wise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    mkdirSync(join(dir, 'zz-dir'));
    writeFileSync(join(dir, 'b.txt'), 'bb');
    writeFileSync(join(dir, 'a.txt'), 'a');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({ type: 'files-list', requestId: 'r-1', path: '' });
    expect(out).toHaveLength(1);
    const result = listResult(out);
    expect(result.type).toBe('files-list-result');
    expect(result.requestId).toBe('r-1');
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(['zz-dir', 'a.txt', 'b.txt']);
    expect(result.entries[0].isDirectory).toBe(true);
    expect(result.entries[0].path).toBe('zz-dir');
    expect(result.entries[1].size).toBe(1);
    expect(result.entries[1].isDirectory).toBe(false);
    expect(result.entries[1].path).toBe('a.txt');
    // The wire type declares `modifiedAt: string` and always ends in `Z`.
    expect(result.entries[1].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  // Ports `list_on_a_file_is_not_a_directory` (files.rs:2730). This is the test
  // that catches `readdirSync` bypassing `errnoToCode`: without the mapping in
  // `list()` itself, Node's `ENOTDIR` reaches `handle()`'s generic catch and
  // the wire code becomes `IO_ERROR`.
  it('reports NOT_A_DIRECTORY when listing a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    writeFileSync(join(dir, 'f.txt'), 'x');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({ type: 'files-list', requestId: 'r-1', path: 'f.txt' });
    expect(JSON.stringify(out)).toContain('NOT_A_DIRECTORY');
  });

  // Ports `list_cap_truncates_at_4096_with_the_flag` (files.rs:2740).
  it('truncates at the cap and sets the flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ponter-list-'));
    for (let i = 0; i < 4097; i++) writeFileSync(join(dir, `f${String(i).padStart(4, '0')}`), '');
    const s = new FilesSession(FilesRoot.open(dir), () => 0);

    const out = s.handle({ type: 'files-list', requestId: 'r-1', path: '' });
    const result = listResult(out);
    expect(result.entries).toHaveLength(4096);
    expect(result.truncated).toBe(true);
    expect(result.entries[0].name).toBe('f0000');
    expect(result.entries[4095].name).toBe('f4095');
  });
});

describe('download', () => {
  it('emits begin, then exactly the 64-chunk window, then waits for acks', () => {
    const { s } = session();
    const out = s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    expect(frameType(out[0]!)).toBe('files-download-begin');
    expect(out.filter((f) => typeof f !== 'string')).toHaveLength(64);
  });

  it('completes an empty file with begin then end', () => {
    const { dir, s } = session();
    writeFileSync(join(dir, 'empty'), '');
    const out = s.handle({ type: 'files-download', transferId: ID, path: 'empty' });
    expect(out.map(frameType)).toContain('files-download-end');
  });

  it('refuses a second download in the same direction', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    const out = s.handle({ type: 'files-download', transferId: ID2, path: 'a.bin' });
    expect(JSON.stringify(out)).toContain('TRANSFER_BUSY');
  });

  it('drops a download whose ack claims more chunks than were sent', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    const out = s.handle({ type: 'files-download-ack', transferId: ID, nextChunkIndex: 65 });
    expect(JSON.stringify(out)).toContain('BAD_FRAME');
    expect(JSON.stringify(s.handle({ type: 'files-download', transferId: ID2, path: 'a.bin' }))).not.toContain(
      'TRANSFER_BUSY',
    );
  });

  it('ignores a duplicate or regressive ack without erroring', () => {
    const { s } = session();
    s.handle({ type: 'files-download', transferId: ID, path: 'a.bin' });
    s.handle({ type: 'files-download-ack', transferId: ID, nextChunkIndex: 10 });
    const out = s.handle({ type: 'files-download-ack', transferId: ID, nextChunkIndex: 10 });
    expect(JSON.stringify(out)).not.toContain('files-error');
  });
});

describe('upload', () => {
  it('writes the file and removes the .part on success', () => {
    const { dir, s } = session();
    const size = 40_000;
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'up.bin', size });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768, 1).toString('base64'),
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(size - 32_768, 1).toString('base64'),
    });
    const out = s.handle({ type: 'files-upload-end', transferId: ID });
    expect(JSON.stringify(out)).toContain('files-upload-complete');
    expect(readFileSync(join(dir, 'up.bin')).length).toBe(size);
    expect(() => statSync(join(dir, 'up.bin.ponter-part'))).toThrow();
  });

  it('batches acks, flushing on the 16th chunk', () => {
    const { s } = session();
    const size = 32_768 * 20;
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'b.bin', size });
    let acks = 0;
    for (let i = 1; i < 20; i += 1) {
      const out = s.handle({
        type: 'files-upload-chunk',
        transferId: ID,
        chunkIndex: i,
        totalChunks: 20,
        data: Buffer.alloc(32_768).toString('base64'),
      });
      acks += out.filter((f) => frameType(f) === 'files-upload-ack').length;
    }
    expect(acks).toBe(1);
  });

  it('rejects a chunk with the wrong index', () => {
    const { s } = session();
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'c.bin', size: 65_536 });
    const out = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    expect(JSON.stringify(out)).toContain('BAD_FRAME');
  });

  it('rejects upload-end before the last chunk', () => {
    const { s } = session();
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'd.bin', size: 65_536 });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    expect(JSON.stringify(s.handle({ type: 'files-upload-end', transferId: ID }))).toContain(
      'BAD_FRAME',
    );
  });

  it('refuses a name that already exists', () => {
    const { s } = session();
    const out = s.handle({
      type: 'files-upload-begin',
      transferId: ID,
      path: '',
      name: 'a.bin',
      size: 10,
    });
    expect(JSON.stringify(out)).toContain('FILE_EXISTS');
  });
});

describe('resume', () => {
  // The wire value is pinned here because Rust never pinned it: `files.rs:40-45`
  // says the constant is "pinned by [`FILES_IDLE_TIMEOUT_MS`] and its own
  // assertion", and no such assertion exists (`awk 'NR>=2287' files.rs | grep
  // FILES_IDLE_TIMEOUT` is empty; the test module starts at :2287).
  //
  // Only the literal `30_000` is asserted. "The prod timeout equals the
  // constant" is NOT asserted, because in TS both sides are the same symbol —
  // `expect(FILES_IDLE_TIMEOUT_MS).toBe(FILES_IDLE_TIMEOUT_MS)` cannot fail.
  // Rust could assert the equivalent because it has two symbols that diverge
  // under `cfg(test)` (`FILES_IDLE_TIMEOUT` shrinks to 50 ms so tests need not
  // sleep 30 s); TS has one and reaches the same end by injecting `now()`.
  it('pins the idle timeout to the wire value', () => {
    expect(FILES_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  it('requires the .part length to equal the resume offset exactly', () => {
    expect(resumeOffsetMatches(65_536, 2)).toBe(true);
    expect(resumeOffsetMatches(65_535, 2)).toBe(false);
    expect(resumeOffsetMatches(0, 0)).toBe(true);
    expect(resumeOffsetMatches(1, 0)).toBe(false);
  });

  it('answers an unapproved resume with a resume-ack, never an error frame', () => {
    const { s } = session();
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'e.bin', size: 65_536 });
    s.handle({ type: 'files-pause', transferId: ID, direction: 'upload' });
    const out = s.handle({
      type: 'files-resume',
      transferId: ID,
      path: 'ignored',
      direction: 'upload',
      fromChunkIndex: 5,
    });
    const ack = out.find((f) => frameType(f) === 'files-resume-ack');
    expect(ack).toBeDefined();
    expect(JSON.stringify(ack)).toContain('"approved":false');
  });

  // Ports `paused_state_survives_idle_timeout` (files.rs:3834): pause, push the
  // clock past the deadline, and assert `checkIdle()` emits nothing and the
  // slot survives. Rust forces the deadline into the past directly; TS advances
  // the injected clock, which reaches the same state without touching internals.
  it('paused transfers do not time out', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'f.bin', size: 65_536 });
    s.handle({ type: 'files-pause', transferId: ID, direction: 'upload' });
    now = 60_000;
    expect(JSON.stringify(s.checkIdle())).not.toContain('TRANSFER_TIMEOUT');
  });

  it('kills a stalled transfer at the idle timeout', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-xfer-'));
    writeFileSync(join(dir, 'g.bin'), Buffer.alloc(100_000));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({ type: 'files-download', transferId: ID, path: 'g.bin' });
    now = 30_000;
    expect(JSON.stringify(s.checkIdle())).toContain('TRANSFER_TIMEOUT');
  });
});

describe('cancel', () => {
  it('removes the .part file and stops the upload', () => {
    const { dir, s } = session();
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'h.bin', size: 65_536 });
    s.handle({ type: 'files-cancel', transferId: ID });
    expect(() => statSync(join(dir, 'h.bin.ponter-part'))).toThrow();
  });

  it('is idempotent for an unknown id and emits no error', () => {
    const { s } = session();
    expect(s.handle({ type: 'files-cancel', transferId: ID2 })).toEqual([]);
  });
});

describe('decode — all twelve inbound shapes (R6)', () => {
  // The Rust's `decode_round_trips_every_browser_to_agent_type`
  // (`files.rs:2433-2481`) named the enumeration in its title and covered
  // **7 of 12**: list, download, upload-begin, upload-chunk, upload-end,
  // cancel, download-ack. It had no `files-mkdir`, `files-rename`,
  // `files-delete`, `files-pause` or `files-resume` — and two of the five it
  // omitted are exactly the two the port read the wrong field names for. That
  // is why the field-name defect was invisible on both sides.
  //
  // The list is imported rather than spelled here, so a type added to
  // `FILES_INBOUND_TYPES` without a case here fails the length assertion
  // instead of being silently untested — which is the defect, one level up.
  it('covers every declared inbound type, and the list is twelve long', () => {
    expect(FILES_INBOUND_TYPES).toHaveLength(12);
    expect(new Set(FILES_INBOUND_TYPES).size).toBe(12);
  });

  it.each(FILES_INBOUND_TYPES)('routes %s through decode to its arm', (type) => {
    const { s } = session();
    // A decoded frame reaches an arm; an undecodable one never does. The
    // discrimination is the **shape** of the answer, not merely that something
    // came back: every one of the twelve known types answers with at least one
    // frame, while an unknown type answers `[]`.
    expect(decodeFilesFrame({ type })).not.toBeNull();
    expect(Array.isArray(s.handle({ type }))).toBe(true);
  });

  it('drops a type outside the twelve instead of reaching an arm', () => {
    // The positive control for the loop above: if `decodeFilesFrame` returned
    // its argument unchanged, this case would pass too and the loop would
    // prove nothing about the gate.
    const { s } = session();
    expect(decodeFilesFrame({ type: 'files-explode' })).toBeNull();
    expect(s.handle({ type: 'files-explode' })).toEqual([]);
  });
});

describe('mkdir and rename field names (R5)', () => {
  it('creates in the named directory, not the root', () => {
    const { dir, s } = session();
    mkdirSync(join(dir, 'docs'));
    const out = s.handle({ type: 'files-mkdir', requestId: 'r-1', dir: 'docs', name: 'new' });
    // The bug: `message.path` is `undefined` on this frame, `String(undefined
    // ?? '')` is `''`, and `resolveExisting('')` is the root — so the
    // directory appeared at the root and the frame still said `success: true`.
    expect(statSync(join(dir, 'docs', 'new')).isDirectory()).toBe(true);
    expect(out[0]).toMatchObject({ type: 'files-action-result', success: true });
  });

  it('reports FILE_EXISTS, not IO_ERROR, when the directory is already there (R10)', () => {
    // `mkdirSync` throws `EEXIST`, which is not a `SandboxError`; without the
    // mapping on this path the generic catch turned it into `IO_ERROR`, and
    // with a bare-code contract that wrong code is shipped rather than
    // swallowed. The Rust returns `FILE_EXISTS` (`files.rs:873-883`).
    const { dir, s } = session();
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'docs', 'taken'));
    const out = s.handle({ type: 'files-mkdir', requestId: 'r-1', dir: 'docs', name: 'taken' });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: false,
      error: 'FILE_EXISTS',
    });
    // And the failure arm carries no `path` — the four fields the browser reads.
    expect(out[0]).not.toHaveProperty('path');
  });

  it('reads the wire\'s oldPath and newPath', () => {
    const { dir, s } = session();
    writeFileSync(join(dir, 'docs', 'a.txt'), 'x');
    const out = s.handle({
      type: 'files-rename',
      requestId: 'r-1',
      oldPath: 'docs/a.txt',
      newPath: 'docs/b.txt',
    });
    // Under the old names `from` and `toPath` were `undefined` and `toName`
    // was the **string** `"undefined"`, so every UI rename went to
    // `<root>/undefined` and threw `EINVAL` → `IO_ERROR`.
    expect(statSync(join(dir, 'docs', 'b.txt')).isFile()).toBe(true);
    expect(out[0]).toMatchObject({ type: 'files-action-result', success: true });
  });

  it('refuses to rename the sandbox root', () => {
    // The guard `remove` already had and `rename` did not (`files.rs:964-970`
    // returns `PermissionDenied`, "cannot rename sandbox root"). It becomes
    // reachable exactly when R5 lands: with the wire's real names, `oldPath:
    // ''` resolves to the canonical root and reaches `renameSync`.
    const { s } = session();
    const out = s.handle({ type: 'files-rename', requestId: 'r-1', oldPath: '', newPath: 'x' });
    expect(out[0]).toMatchObject({
      type: 'files-action-result',
      success: false,
      error: 'PERMISSION_DENIED',
    });
  });
});

describe('the ack split (R7, R8)', () => {
  it('flushes on the 20 ms tick an ack the chunk path did not take', () => {
    // The case the Rust's split makes possible and the plan's collapse made
    // impossible: a chunk arrives below the frequency threshold and the tick
    // interval has elapsed. `noteChunk()` returns the predicate (false here);
    // `flushAcks()` takes unconditionally and emits.
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-ack-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'k.bin', size: 32_768 * 20 });
    now = 20;
    const chunk = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 20,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    // Once the interval has elapsed the chunk path's own predicate fires, so
    // the discriminating case is the tick: it must be able to take an ack the
    // frequency rule alone would have held back.
    expect(frameType(chunk[0]!)).toBe('files-upload-ack');
    // Nothing is pending after that flush — which is exactly why the tick
    // cannot be a second copy of the chunk path.
    expect(s.flushAcks()).toEqual([]);
  });

  it('takes unconditionally on the tick even when the frequency rule says no', () => {
    let now = 0;
    const dir = mkdtempSync(join(tmpdir(), 'ponter-ack-'));
    const s = new FilesSession(FilesRoot.open(dir), () => now);
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'l.bin', size: 32_768 * 20 });
    const chunk = s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 20,
      data: Buffer.alloc(32_768).toString('base64'),
    });
    // Below both thresholds: no ack yet, and one is pending.
    expect(chunk).toEqual([]);
    now = 20;
    const flushed = s.flushAcks();
    expect(frameType(flushed[0]!)).toBe('files-upload-ack');
    expect(flushed[0]).toMatchObject({ nextChunkIndex: 1 });
  });

  it('emits the final ack before files-upload-complete', () => {
    // The Rust returns `vec![final_ack, complete]` (`files.rs:1734`). The order
    // is the contract: the ack carries the last index the sender waits on, and
    // a browser that saw `complete` first has already torn down that state.
    const { s } = session();
    const size = 40_000;
    s.handle({ type: 'files-upload-begin', transferId: ID, path: '', name: 'm.bin', size });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 0,
      totalChunks: 2,
      data: Buffer.alloc(32_768, 1).toString('base64'),
    });
    s.handle({
      type: 'files-upload-chunk',
      transferId: ID,
      chunkIndex: 1,
      totalChunks: 2,
      data: Buffer.alloc(size - 32_768, 1).toString('base64'),
    });
    const out = s.handle({ type: 'files-upload-end', transferId: ID });
    expect(out.map(frameType)).toEqual(['files-upload-ack', 'files-upload-complete']);
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement `session.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/files/session.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/files/session.ts
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { SandboxError, errnoToCode } from './sandbox.js';
import type { FilesRoot } from './sandbox.js';
import {
  ACK_FLUSH_INTERVAL_MS,
  ACK_FREQUENCY_CHUNKS,
  FILE_MAX_BYTES,
  FILE_WINDOW_CHUNKS,
  FILES_IDLE_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  PART_SUFFIX,
  decodeUploadChunk,
  encodeDownloadChunk,
  expectedChunkLen,
  partName,
  rfc3339Utc,
  totalChunks,
} from './protocol.js';

export { FILES_IDLE_TIMEOUT_MS };

/**
 * The wire shape of one entry, exactly `RemoteFile` from
 * `packages/shared/src/types/files.ts:6-13`. Declared here rather than
 * imported so `apps/agent` does not depend on the browser's package; the two
 * must stay identical and `files.e2e.test.ts` is what catches a drift.
 */
export interface RemoteFileWire {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

export type FilesFrame =
  | string
  | Uint8Array
  | { type: string; [key: string]: unknown };

/**
 * The twelve browser→agent shapes, in the Rust's own order
 * (`FilesInbound`, `files.rs:489-504`).
 *
 * This list is the **decode** boundary, and it exists as a value because the
 * alternative — twelve `case` labels with no enumeration anywhere — is exactly
 * how the Rust ended up testing 7 of its 12 arms: `decode_round_trips_every_
 * browser_to_agent_type` named the enumeration in its title and covered list,
 * download, upload-begin, upload-chunk, upload-end, cancel and download-ack,
 * omitting `mkdir`, `rename`, `delete`, `pause` and `resume`. Two of the five
 * it omitted are the two the port read the wrong field names for.
 */
export const FILES_INBOUND_TYPES = [
  'files-list',
  'files-download',
  'files-download-ack',
  'files-upload-begin',
  'files-upload-chunk',
  'files-upload-end',
  'files-pause',
  'files-resume',
  'files-cancel',
  'files-mkdir',
  'files-delete',
  'files-rename',
] as const;

export type FilesInboundType = (typeof FILES_INBOUND_TYPES)[number];

const INBOUND = new Set<string>(FILES_INBOUND_TYPES);

/**
 * The JSON kind the Rust requires for one inbound field (`files.rs:279-600`).
 *
 * `u64` is `serde_json`'s unsigned 64-bit integer; `direction` is the
 * `FilesDirection` enum, which deserializes from the strings `"download"` and
 * `"upload"` and nothing else (`files.rs:347-373`).
 */
type FieldKind = 'string' | 'u64' | 'bool' | 'direction';

interface InboundShape {
  readonly required: Readonly<Record<string, FieldKind>>;
  readonly optional: Readonly<Record<string, FieldKind>>;
}

/**
 * **The wire type system the Rust had, and this port did not.**
 *
 * The Rust decodes every inbound payload with `serde_json::from_value` into a
 * struct of typed fields (`files.rs:582-600`). A field of the wrong JSON kind —
 * or a missing required field — fails the **whole frame**, which
 * `lib.rs:1969-1975` answers as `BAD_FRAME`. The port's decode checked only that
 * `type` was one of twelve names, and each handler then coerced
 * (`String(...)`, `Number(...)`, `Boolean(...)`), so the type system was gone.
 * What that cost, measured rather than argued:
 *
 * - `Boolean("false")` is `true`, so `files-delete` with `recursive: "false"`
 *   selected `rmSync(..., { recursive: true })` and **deleted the tree**.
 * - `Number("abc")` is `NaN`, and `NaN > FILE_MAX_BYTES` is false, so a
 *   non-numeric `size` walked past the only limit on upload size — a `u64`
 *   cannot hold `NaN`, so the Rust has no equivalent.
 * - `String(undefined)` is `"undefined"`, so a `files-upload-begin` with no
 *   `name` created a file called `undefined.ponter-part`.
 *
 * This table is that contract, and it is why `dispatch` never sees a coerced
 * value. It is keyed by `FilesInboundType`, so a type added to
 * `FILES_INBOUND_TYPES` tomorrow without a shape here is a `tsc` error rather
 * than an arm that skips validation.
 *
 * **Two oracle properties the check must respect**, both measured against the
 * Rust (`ORACLE.txt` in the Task 22 probe):
 *
 * 1. `serde` does **not** deny unknown fields — `deny_unknown_fields` has 0
 *    occurrences in `files.rs`. An extra key is ignored, so this validator
 *    checks the named fields and ignores everything else. Rejecting unknown
 *    keys would refuse frames the Rust accepts: a new divergence introduced by
 *    the fix.
 * 2. `Option<T>` accepts an explicit `null` — the oracle measures
 *    `recursive = null` as ACCEPTED (then `unwrap_or(false)` takes the
 *    non-recursive arm). So for an **optional** field, absent and `null` are
 *    both fine, and a present non-null value must still be the right kind.
 *    `recursive: "false"` is `BAD_FRAME`; `recursive: null` is not.
 */
export const INBOUND_FIELDS: Record<FilesInboundType, InboundShape> = {
  'files-list': {
    required: { requestId: 'string', path: 'string' },
    optional: {},
  },
  'files-download': {
    required: { transferId: 'string', path: 'string' },
    optional: {},
  },
  'files-download-ack': {
    required: { transferId: 'string', nextChunkIndex: 'u64' },
    optional: {},
  },
  'files-upload-begin': {
    required: {
      transferId: 'string',
      path: 'string',
      name: 'string',
      size: 'u64',
    },
    optional: {},
  },
  'files-upload-chunk': {
    required: {
      transferId: 'string',
      chunkIndex: 'u64',
      totalChunks: 'u64',
      data: 'string',
    },
    optional: {},
  },
  'files-upload-end': {
    required: { transferId: 'string' },
    optional: {},
  },
  'files-pause': {
    required: { transferId: 'string', direction: 'direction' },
    optional: {},
  },
  'files-resume': {
    required: {
      transferId: 'string',
      path: 'string',
      direction: 'direction',
      fromChunkIndex: 'u64',
    },
    optional: {},
  },
  'files-cancel': {
    required: {},
    optional: { requestId: 'string', transferId: 'string' },
  },
  'files-mkdir': {
    required: { requestId: 'string', dir: 'string', name: 'string' },
    optional: {},
  },
  'files-delete': {
    required: { requestId: 'string', path: 'string' },
    optional: { recursive: 'bool' },
  },
  'files-rename': {
    required: { requestId: 'string', oldPath: 'string', newPath: 'string' },
    optional: {},
  },
};

const DIRECTIONS = new Set<string>(['download', 'upload']);

function matchesKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'direction':
      return typeof value === 'string' && DIRECTIONS.has(value);
    // `u64` rejects a string, a non-integral number, a negative number, `NaN`,
    // `Infinity`, `null`, an array and an object. `Number.isSafeInteger` is the
    // honest bound: `serde_json`'s `u64` is 64-bit, `MAX_SAFE_INTEGER` is the
    // closest a double gets, and the browser never declares a size above
    // `FILE_MAX_BYTES`, so no real payload meets the narrower limit.
    case 'u64':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        Number.isSafeInteger(value) &&
        value >= 0
      );
  }
}

/**
 * The per-type field-shape check, answering what `serde_json::from_value`
 * would: every required field present and of its declared kind, every optional
 * field absent / `null` / of its declared kind, extra keys ignored.
 */
export function inboundShapeValid(message: {
  type: string;
  [key: string]: unknown;
}): boolean {
  const shape = INBOUND_FIELDS[message.type as FilesInboundType];
  if (shape === undefined) return false;
  for (const [field, kind] of Object.entries(shape.required)) {
    if (!matchesKind(message[field], kind)) return false;
  }
  for (const [field, kind] of Object.entries(shape.optional)) {
    const value = message[field];
    // `Option<T>`: absent or explicit `null` are both ACCEPTED by the oracle.
    if (value === undefined || value === null) continue;
    if (!matchesKind(value, kind)) return false;
  }
  return true;
}

/**
 * The three arms whose failures answer on `files-action-result`. Kept beside
 * the decode list because both are claims about the same twelve names, and a
 * reader checking one should not have to hunt for the other.
 */
const ACTION_TYPES = new Set<string>(['files-mkdir', 'files-delete', 'files-rename']);

/**
 * The inbound decode step, and the only way into `dispatch`.
 *
 * Returning `null` for an unrecognised `type` is **half** the contract, and the
 * half that is not about payloads: `dispatch` switches on the *decoded*
 * discriminant, so a type this function rejects cannot reach an arm. Routing
 * dispatch through the decoder rather than testing them separately is what
 * makes the decode test evidence about dispatch — a test that called a decoder
 * nothing used would prove the decoder knows twelve names and nothing else.
 *
 * **This function is a name check, not a shape check.** It answers "is this one
 * of the twelve?"; `inboundShapeValid` answers "is the payload the shape that
 * name promises?" — that is the other half. They stay separate because their
 * failure modes differ and the Rust keeps them separate: an unknown `type` is
 * warn-and-ignore (`decode_files_frame` → `Ok(None)` → `[]`), while a known
 * `type` with a bad payload is `BAD_FRAME` (`Err` → the error frame). Merging
 * them would turn a frame this agent does not understand into an error the peer
 * must handle.
 */
export function decodeFilesFrame(
  message: { type: string; [key: string]: unknown },
): ({ type: FilesInboundType } & { [key: string]: unknown }) | null {
  if (!INBOUND.has(message.type)) return null;
  return message as { type: FilesInboundType } & { [key: string]: unknown };
}

/**
 * Resume requires the `.part` length to equal the resume offset **exactly**.
 * No truncation and no tolerance: a `.part` that is a byte short would leave a
 * hole that `write+append` can never fill, and a byte long would silently
 * duplicate a byte into the finished file.
 */
export function resumeOffsetMatches(partBytes: number, fromChunkIndex: number): boolean {
  return partBytes === fromChunkIndex * 32_768;
}

interface DownloadState {
  transferId: string;
  sent: number;
  acked: number;
  total: number;
  size: number;
  buffer: Buffer;
  paused: boolean;
  deadline: number;
}

interface UploadState {
  transferId: string;
  nextChunk: number;
  written: number;
  total: number;
  size: number;
  partPath: string;
  /** The host path. Filesystem calls only — **never** put this on the wire. */
  destPath: string;
  /** The wire-relative destination, from `join_rel` (`files.rs:2069-2075`). */
  destRel: string;
  lastAcked: number;
  pendingAck: number | null;
  lastAckAt: number;
  paused: boolean;
  deadline: number;
}

/**
 * One session's file transfers (B42/B43/B45/B46).
 *
 * Two shape decisions worth stating:
 *
 * - **One slot per direction, and the window applies to downloads only.** The
 *   Rust gated only `DownloadState`; uploads are ungated because the browser is
 *   the trusted side and a gate there would need a browser-side counterpart —
 *   a protocol change, not a port.
 * - **The window is 64 chunks, not 16.** A stale comment in the Rust said 16;
 *   the constant, the gate and four tests all said 64. The code wins.
 *
 * Every rejection is a frame, never a throw out of `handle`: a bad path must not
 * end the session, which is exactly what "fail-soft" means here.
 */
export class FilesSession {
  private download: DownloadState | null = null;
  private upload: UploadState | null = null;

  constructor(
    private readonly root: FilesRoot,
    private readonly now: () => number,
  ) {}

  handle(message: { type: string; [key: string]: unknown }): FilesFrame[] {
    // The decode step is the gate, not a sibling of `dispatch`: a type outside
    // the twelve never reaches a `case`. Returning `[]` rather than throwing
    // keeps the Rust's behaviour — an unknown `type` is dropped by the
    // dispatcher's `_ =>` arm, not turned into an error frame.
    const decoded = decodeFilesFrame(message);
    if (decoded === null) return [];
    try {
      // The name is legal; now the payload must be the shape that name
      // promises. Thrown **inside this try** on purpose: the catch below is
      // what routes an action frame to `files-action-result` and everything
      // else to `files-error`, using the *original* `message` for the id
      // extraction. A check placed above the `try` would have to re-implement
      // that routing — and would get it wrong for exactly the three action
      // frames, which are the ones a bad payload is most likely to name.
      if (!inboundShapeValid(decoded)) {
        throw new SandboxError('BAD_FRAME', 'the frame could not be decoded');
      }
      return this.dispatch(decoded);
    } catch (error) {
      const code = error instanceof SandboxError ? error.code : errnoToCode(error);
      // **R10: the failure path, stated in one place.** The three actions
      // answer on `files-action-result` with `success: false`; everything else
      // (list, transfer lifecycle) answers on `files-error`. Routing action
      // failures through `files-error` — which is what the plan did — sends an
      // unchecked code to a frame that does not validate it (see
      // `actionFailure`).
      if (ACTION_TYPES.has(message.type)) return [this.actionFailure(message, code)];
      return [this.errorFrame(message, code, (error as Error).message)];
    }
  }

  /** Called from a 1 s tick. */
  checkIdle(): FilesFrame[] {
    const now = this.now();
    const out: FilesFrame[] = [];
    if (this.download && !this.download.paused && this.download.deadline <= now) {
      out.push({ type: 'files-error', transferId: this.download.transferId, code: 'TRANSFER_TIMEOUT', message: 'transfer timed out' });
      this.download = null;
    }
    if (this.upload && !this.upload.paused && this.upload.deadline <= now) {
      // `timeout_frame(direction, transfer_id)` (`files.rs:1259-1270`) sets the
      // id in **both** directions. The download arm above is naturally correct
      // because its state is still in hand; the upload arm has to read the id
      // *before* `discardUpload` clears it.
      //
      // An id-less frame is **not** a hang — measured: the handle stays pending,
      // then the client's own 30 s timer (`client.ts:328`) rejects it with a
      // locally minted `TRANSFER_TIMEOUT`. The damage is two other things. The
      // `files-error` arm only routes to a transfer when the frame carries its
      // id (`client.ts:637-641`), so the entry is never deleted from
      // `client.transfers`: measured, the map still holds it after the local
      // timeout, one dead entry per timed-out upload, for the life of the
      // connection. And the rejection the caller sees is the client's own
      // message rather than the agent's frame, so any other agent-side code is
      // lost. An id-less error also falls through to the `requestId` arms and
      // the `onError` listeners (`:643-660`), reporting an unsolicited error
      // that belongs to no request.
      const { transferId } = this.upload;
      this.discardUpload(this.upload);
      this.upload = null;
      out.push({ type: 'files-error', transferId, code: 'TRANSFER_TIMEOUT', message: 'transfer timed out' });
    }
    return out;
  }

  /**
   * **R7: `noteChunk()` returns the predicate; `takePendingAck()` takes
   * unconditionally; `flushAcks()` re-applies no gate.**
   *
   * The Rust separates **when** from **what**: `note_chunk()` returns the
   * predicate (`files.rs:1165-1172`), `take_pending_ack()` takes
   * unconditionally (`:1173-1180`), the chunk path uses `if`
   * (`:1651-1656`) and the tick path takes unconditionally
   * (`:1717-1719`). The plan collapsed both into one `pendingAckFrame()`, so
   * `flushAcks()` re-evaluated the gate the chunk path had just evaluated —
   * a decorative 20 ms tick that could not change anything. Worse, the
   * collapse makes one case **impossible to express**: a chunk that is due on
   * the frequency rule but not on the interval rule, or the reverse. With the
   * split, the chunk path flushes when the predicate says so and the tick
   * flushes whatever is pending regardless.
   *
   * Both paths read the **same injected clock**. The Rust used monotonic
   * `elapsed()`; the port injects `now()` and keeps it injected — a real timer
   * here would make the ack tests sleep and would put a production clock
   * inside a class whose whole design is that time is a parameter.
   */
  private noteChunk(): boolean {
    const state = this.upload;
    if (!state) return false;
    state.pendingAck = state.nextChunk;
    return (
      state.pendingAck - state.lastAcked >= ACK_FREQUENCY_CHUNKS ||
      this.now() - state.lastAckAt >= ACK_FLUSH_INTERVAL_MS
    );
  }

  /** Takes whatever is pending, with **no** gate. Called from the 20 ms tick. */
  private takePendingAck(): FilesFrame[] {
    const state = this.upload;
    if (!state || state.pendingAck === null) return [];
    const nextChunkIndex = state.pendingAck;
    state.lastAcked = nextChunkIndex;
    state.pendingAck = null;
    state.lastAckAt = this.now();
    return [{ type: 'files-upload-ack', transferId: state.transferId, nextChunkIndex }];
  }

  /** Called from a 20 ms tick so a low-rate upload still acks promptly. */
  flushAcks(): FilesFrame[] {
    return this.takePendingAck();
  }

  /**
   * **The handlers below coerce (`String(...)`, `Number(...)`,
   * `Boolean(...)`), and that is correct — read this before "fixing" one.**
   *
   * Every value reaching an arm has already passed `inboundShapeValid`, so
   * `message.size` is a `u64`-shaped number, `message.recursive` a boolean or
   * `null`, `message.name` a string. The coercion is the *narrowing* between
   * `unknown` and the handler's own parameter type, not a validation. Two
   * consequences worth knowing:
   *
   * - `String(message.path ?? '')` on a field the table declares required: the
   *   `?? ''` is now unreachable for a missing key (the boundary refuses) but
   *   still meaningful for a legal empty string, which is the wire's "root".
   * - `Boolean(message.recursive)` after the boundary sees `true`, `false`,
   *   `null` or absent — all four of which it maps correctly. Removing the
   *   boundary would make every one of these lines a bug again at once, which
   *   is why the table is keyed by `FilesInboundType` and checked by `tsc`.
   *
   * `acceptBinaryChunk` is outside this: binary frames never enter `handle()`
   * and never see this table (`data-channels.ts:263` routes them straight to
   * `acceptBinaryChunk`). Their boundary is `decodeUploadChunk`
   * (`protocol.ts:86`), which has its own `BAD_FRAME` throws for a truncated
   * header and an over-cap payload. "The decode boundary is validated" is a
   * claim about the **JSON** path only; stating it without this paragraph is
   * the kind of over-read that makes a later reader trust the binary path for
   * a check it does not perform.
   */
  private dispatch(message: { type: FilesInboundType; [key: string]: unknown }): FilesFrame[] {
    switch (message.type) {
      case 'files-list':
        return this.list(message);
      case 'files-download':
        return this.startDownload(message);
      case 'files-download-ack':
        return this.ackDownload(message);
      case 'files-upload-begin':
        return this.beginUpload(message);
      case 'files-upload-chunk':
        return this.chunkUpload(message);
      case 'files-upload-end':
        return this.endUpload(message);
      case 'files-pause':
        return this.pause(message);
      case 'files-resume':
        return this.resume(message);
      case 'files-cancel':
        this.cancel(message);
        return [];
      case 'files-mkdir':
        return this.mkdir(message);
      case 'files-delete':
        return this.remove(message);
      case 'files-rename':
        return this.rename(message);
      default:
        return [];
    }
  }

  private errorFrame(message: { [key: string]: unknown }, code: string, text: string): FilesFrame {
    return {
      type: 'files-error',
      ...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
      ...(typeof message.transferId === 'string' ? { transferId: message.transferId } : {}),
      code,
      message: text,
    };
  }

  /**
   * `MAX_LIST_ENTRIES` truncates **and sets `truncated`**, rather than refusing.
   * A directory with 4 096 entries is normal; refusing to list it would make the
   * browser's file manager unusable on exactly the machines people use for file
   * transfer. The flag is what stops the UI claiming it showed everything.
   *
   * The wire shape is `RemoteFile` (`packages/shared/src/types/files.ts:6-13`,
   * unchanged since Week 10): `{name, path, size, isDirectory, modifiedAt}`.
   * Every field is carried through, not renamed — `apps/web`'s FilesView reads
   * `isDirectory`, `path` and `modifiedAt` directly, and
   * `packages/webrtc-core/test/e2e/files.e2e.test.ts:123,127` asserts
   * `isDirectory`.
   */
  private list(message: { [key: string]: unknown }): FilesFrame[] {
    const rel = String(message.path ?? '');
    const path = this.root.resolveExisting(rel);
    // A file where a directory was expected is NOT_A_DIRECTORY; other failures
    // are IO_ERROR. `readdirSync` is the call that raises it, so the mapping
    // happens here rather than in `handle()`'s generic catch.
    let names: Dirent[];
    try {
      names = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `listing \`${rel}\``);
    }
    const entries: RemoteFileWire[] = names.map((entry) => {
      // A per-entry stat failure fails the whole list (spec §6.1): a
      // half-listed directory is worse than an error.
      const stat = statSync(join(path, entry.name));
      // `metadata.len()` is a real number for a directory too — the wire type
      // declares `size: number`, not `number | null`.
      return {
        name: entry.name,
        path: rel === '' ? entry.name : `${rel}/${entry.name}`,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modifiedAt: rfc3339Utc(stat.mtimeMs),
      };
    });
    // Deterministic order (spec §2.5): directories first, then name
    // byte-wise. Sort BEFORE truncating — `read_dir` order is arbitrary.
    entries.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')),
    );
    const truncated = entries.length > MAX_LIST_ENTRIES;
    return [
      {
        type: 'files-list-result',
        requestId: message.requestId,
        path: rel,
        entries: entries.slice(0, MAX_LIST_ENTRIES),
        truncated,
      },
    ];
  }

  private startDownload(message: { [key: string]: unknown }): FilesFrame[] {
    const transferId = String(message.transferId);
    const resolved = this.root.resolveExisting(String(message.path ?? ''));
    const stat = statSync(resolved);
    if (stat.isDirectory()) throw new SandboxError('NOT_A_FILE', 'not a file');
    if (stat.size > FILE_MAX_BYTES) throw new SandboxError('FILE_TOO_LARGE', 'file too large');
    if (this.download) throw new SandboxError('TRANSFER_BUSY', 'a download is already in flight');
    const total = totalChunks(stat.size);
    const out: FilesFrame[] = [
      {
        type: 'files-download-begin',
        transferId,
        name: resolved.split('/').pop(),
        path: String(message.path),
        size: stat.size,
        totalChunks: total,
      },
    ];
    if (total === 0) {
      out.push({ type: 'files-download-end', transferId });
      return out;
    }
    const state: DownloadState = {
      transferId,
      sent: 0,
      acked: 0,
      total,
      size: stat.size,
      buffer: readFileSync(resolved),
      paused: false,
      deadline: this.now() + FILES_IDLE_TIMEOUT_MS,
    };
    this.download = state;
    out.push(...this.pump(state));
    return out;
  }

  private pump(state: DownloadState): FilesFrame[] {
    const frames: FilesFrame[] = [];
    while (state.sent < state.total && state.sent - state.acked < FILE_WINDOW_CHUNKS) {
      const start = state.sent * 32_768;
      frames.push(
        encodeDownloadChunk(
          state.transferId,
          state.sent,
          state.buffer.subarray(start, start + expectedChunkLen(state.size, state.sent)),
        ),
      );
      state.sent += 1;
    }
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    return frames;
  }

  private ackDownload(message: { [key: string]: unknown }): FilesFrame[] {
    const state = this.download;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such download');
    }
    const next = Number(message.nextChunkIndex);
    if (next > state.sent) {
      this.download = null;
      throw new SandboxError('BAD_FRAME', 'ack ahead of what was sent');
    }
    if (next <= state.acked) return [];
    state.acked = next;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    if (state.paused) return [];
    const frames = this.pump(state);
    if (state.acked >= state.total) {
      this.download = null;
      frames.push({ type: 'files-download-end', transferId: state.transferId });
    }
    return frames;
  }

  private beginUpload(message: { [key: string]: unknown }): FilesFrame[] {
    const size = Number(message.size);
    if (size > FILE_MAX_BYTES) throw new SandboxError('FILE_TOO_LARGE', 'file too large');
    if (this.upload) throw new SandboxError('TRANSFER_BUSY', 'an upload is already in flight');
    const name = String(message.name);
    const dirWire = String(message.path ?? '');
    const dest = this.root.resolveParentForCreate(dirWire, name);
    try {
      statSync(dest);
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    const partPath = `${dest}${PART_SUFFIX}`;
    try {
      closeSync(openSync(partPath, 'wx', 0o600));
    } catch {
      // A stale .part is removed once and retried once; a second failure is real.
      unlinkSync(partPath);
      closeSync(openSync(partPath, 'wx', 0o600));
    }
    const transferId = String(message.transferId);
    this.upload = {
      transferId,
      nextChunk: 0,
      written: 0,
      total: totalChunks(size),
      size,
      partPath,
      destPath: dest,
      // `join_rel` (`files.rs:2069-2075`): the **wire** path, not the host path.
      // `''` + name for the root, `dir/name` otherwise. `destPath` stays for the
      // filesystem calls; only these two wire values may leave the agent.
      destRel: dirWire === '' ? name : `${dirWire}/${name}`,
      lastAcked: 0,
      pendingAck: null,
      lastAckAt: this.now(),
      paused: false,
      deadline: this.now() + FILES_IDLE_TIMEOUT_MS,
    };
    // **The begin is answered with the first cumulative ack** (`files.rs:1623-1627`,
    // spec §6.1). Not an optimisation: the browser's transfer pump is driven from
    // `onAck` alone (`packages/file-core/src/transfer.ts:164-177`), so a begin
    // that answers nothing means no chunk is ever sent and every upload hangs
    // until the 30 s idle timeout.
    return [{ type: 'files-upload-ack', transferId, nextChunkIndex: 0 }];
  }

  /**
   * `total` is `null` for the binary form, which carries no total: the JSON
   * `files-upload-chunk` repeats `totalChunks` on every chunk, the binary frame
   * has no room for it. Passing a sentinel (or `-1`) here and comparing anyway
   * would reject **every** binary chunk — the check must be skipped, not
   * satisfied.
   */
  private acceptChunk(
    transferId: string,
    chunkIndex: number,
    total: number | null,
    payload: Uint8Array,
  ): void {
    const state = this.upload;
    if (!state || state.transferId !== transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
    }
    if (total !== null && total !== state.total) {
      throw new SandboxError('BAD_FRAME', 'total chunk count changed');
    }
    if (chunkIndex !== state.nextChunk) throw new SandboxError('BAD_FRAME', 'chunk index out of order');
    if (payload.length !== expectedChunkLen(state.size, chunkIndex)) {
      throw new SandboxError('BAD_FRAME', 'chunk length does not match');
    }
    const fd = openSync(state.partPath, 'a');
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    state.nextChunk += 1;
    state.written += payload.length;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
  }

  private chunkUpload(message: { [key: string]: unknown }): FilesFrame[] {
    try {
      const payload = Buffer.from(String(message.data ?? ''), 'base64');
      this.acceptChunk(
        String(message.transferId),
        Number(message.chunkIndex),
        Number(message.totalChunks),
        payload,
      );
    } catch (error) {
      if (this.upload) this.discardUpload(this.upload);
      this.upload = null;
      throw error;
    }
    // R7: the chunk path evaluates the predicate and flushes only if it says
    // so. The tick path (`flushAcks`) does not re-ask.
    return this.noteChunk() ? this.takePendingAck() : [];
  }

  /** Called by the binary dispatcher for a `0x02` frame. */
  acceptBinaryChunk(frame: Uint8Array): FilesFrame[] {
    const decoded = decodeUploadChunk(frame);
    try {
      this.acceptChunk(decoded.transferId, decoded.chunkIndex, null, decoded.payload);
    } catch (error) {
      if (this.upload) this.discardUpload(this.upload);
      this.upload = null;
      throw error;
    }
    return this.noteChunk() ? this.takePendingAck() : [];
  }

  private endUpload(message: { [key: string]: unknown }): FilesFrame[] {
    const state = this.upload;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
    }
    if (state.nextChunk !== state.total || state.written !== state.size) {
      this.discardUpload(state);
      this.upload = null;
      throw new SandboxError('BAD_FRAME', 'upload ended before the last chunk');
    }
    const fd = openSync(state.partPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    /**
     * `link` then `unlink`, not `rename`. `rename` would silently overwrite a
     * destination that appeared during the transfer — and the `FILE_EXISTS`
     * check happened at `beginUpload`, minutes earlier for a 1 GiB file. `link`
     * fails with `EEXIST` instead, which is the behaviour the Rust had and the
     * only one that cannot lose someone else's file.
     */
    try {
      linkSync(state.partPath, state.destPath);
    } catch {
      this.discardUpload(state);
      this.upload = null;
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    }
    unlinkSync(state.partPath);
    this.upload = null;
    /**
     * **R8: the final ack precedes the complete frame, in that order.**
     *
     * The Rust returns `vec![final_ack, complete]` (`files.rs:1734`); the plan
     * returned complete only. The order is the contract, not a convenience:
     * the ack carries the last `nextChunkIndex` the sender is waiting on, and
     * a browser that sees `files-upload-complete` first has already torn down
     * the transfer state the ack addresses. `state.nextChunk` is final here
     * because `endUpload` refuses to run unless every chunk arrived, so the
     * ack is built from the same numbers the complete frame carries.
     */
    return [
      {
        type: 'files-upload-ack',
        transferId: state.transferId,
        nextChunkIndex: state.nextChunk,
      },
      {
        type: 'files-upload-complete',
        transferId: state.transferId,
        // **Both derive from `destRel`.** `files.rs:2281` emits `state.dest_rel`
        // and nothing else; an earlier draft put `state.destPath` on the wire,
        // which sends the agent host's absolute path to the browser — the
        // sandbox root's location, in every upload-complete frame. `name` is
        // the last wire component, not the host basename, so the two agree even
        // when the sandbox root is a symlinked path.
        name: state.destRel.split('/').pop(),
        path: state.destRel,
        size: state.size,
      },
    ];
  }

  private pause(message: { [key: string]: unknown }): FilesFrame[] {
    if (message.direction === 'download' && this.download) {
      this.download.paused = true;
      return [
        {
          type: 'files-pause-ack',
          transferId: this.download.transferId,
          ackedChunkIndex: this.download.acked,
          bytesTransferred: this.download.acked * 32_768,
        },
      ];
    }
    if (message.direction === 'upload' && this.upload) {
      this.upload.paused = true;
      return [
        {
          type: 'files-pause-ack',
          transferId: this.upload.transferId,
          ackedChunkIndex: this.upload.nextChunk,
          bytesTransferred: this.upload.nextChunk * 32_768,
        },
      ];
    }
    throw new SandboxError('TRANSFER_UNKNOWN', 'no such transfer');
  }

  private resume(message: { [key: string]: unknown }): FilesFrame[] {
    const from = Number(message.fromChunkIndex);
    if (message.direction === 'upload') {
      const state = this.upload;
      if (!state || state.transferId !== message.transferId) {
        throw new SandboxError('TRANSFER_UNKNOWN', 'no such upload');
      }
      if (!state.paused) {
        return [{ type: 'files-resume-ack', transferId: state.transferId, approved: false, fromChunkIndex: from, reason: 'transfer is not paused' }];
      }
      const partBytes = statSync(state.partPath).size;
      if (!resumeOffsetMatches(partBytes, from)) {
        return [
          {
            type: 'files-resume-ack',
            transferId: state.transferId,
            approved: false,
            fromChunkIndex: from,
            reason: `.part is ${partBytes} bytes, resume offset would land at ${from * 32_768} bytes`,
          },
        ];
      }
      state.paused = false;
      state.nextChunk = from;
      state.lastAcked = from;
      state.pendingAck = null;
      state.lastAckAt = this.now();
      return [{ type: 'files-resume-ack', transferId: state.transferId, approved: true, fromChunkIndex: from }];
    }
    const state = this.download;
    if (!state || state.transferId !== message.transferId) {
      throw new SandboxError('TRANSFER_UNKNOWN', 'no such download');
    }
    if (!state.paused) {
      return [{ type: 'files-resume-ack', transferId: state.transferId, approved: false, fromChunkIndex: from, reason: 'transfer is not paused' }];
    }
    state.sent = from;
    state.acked = from;
    state.paused = false;
    state.deadline = this.now() + FILES_IDLE_TIMEOUT_MS;
    return [
      { type: 'files-resume-ack', transferId: state.transferId, approved: true, fromChunkIndex: from },
      ...this.pump(state),
    ];
  }

  private cancel(message: { [key: string]: unknown }): void {
    if (this.upload && this.upload.transferId === message.transferId) {
      this.discardUpload(this.upload);
      this.upload = null;
    }
    if (this.download && this.download.transferId === message.transferId) {
      this.download = null;
    }
  }

  /**
   * Called on peer-connection teardown. Removes any in-flight `.part` so a
   * half-received upload does not sit in the sandbox looking like a file the
   * user might open. Both slots are cleared **before** any filesystem work, so a
   * throwing `unlinkSync` cannot leave a stale state that a later message
   * resumes into.
   */
  dispose(): void {
    const upload = this.upload;
    const download = this.download;
    this.upload = null;
    this.download = null;
    if (upload) this.discardUpload(upload);
    void download;
  }

  /**
   * **R5: the wire's field names, not the Rust's.**
   *
   * `FilesMkdirRequest` (`packages/shared/src/types/files.ts:154-158`) is
   * `{ requestId, dir, name }`. The Rust's handler reads `request.dir` too
   * (`files.rs:537-541`), so the plan's `message.path` was wrong against
   * **both** sources of truth — and wrong silently: `String(undefined ?? '')`
   * is `''`, which `resolveExisting` resolves to the root, so every mkdir
   * landed in the sandbox root instead of the named directory and returned a
   * success frame.
   *
   * **R10(a): the `EEXIST` mapping has to be on THIS path, not merely to exist
   * in the file.** `mkdirSync` over an existing path throws `EEXIST`
   * (errno −17), which is **not** a `SandboxError`; `errnoToCode` does map it
   * (`:3738`) but its call sites are `:3773`, `:3783`, `:3794`, `:4911`,
   * `:5051` and `:5452` — none of them here. So the catch-only path turned a duplicate
   * mkdir into `IO_ERROR`, and with a bare-code contract that wrong code would
   * be **shipped** rather than swallowed. The Rust checks existence first and
   * returns `FILE_EXISTS` (`files.rs:873-883`); mapping the throw reaches the
   * same code without a TOCTOU window between the check and the call.
   */
  private mkdir(message: { [key: string]: unknown }): FilesFrame[] {
    const target = this.root.resolveParentForCreate(String(message.dir ?? ''), String(message.name));
    try {
      mkdirSync(target);
    } catch (error) {
      throw new SandboxError(errnoToCode(error), `mkdir ${String(message.dir ?? '')}/${String(message.name)}`);
    }
    return [this.actionResult(message, target)];
  }

  /**
   * `files-delete` honours `recursive`, as the Rust does (ADR-40,
   * `files.rs:911-951`): the root refusal comes first, then
   * `if recursive { remove_dir_all }`, else the read-dir-and-`DirNotEmpty` arm.
   * A non-recursive call on a non-empty directory is refused with
   * `DIR_NOT_EMPTY` so the caller must say what it means. The web UI sends
   * `recursive: true` for every folder delete, so a port that always took the
   * non-recursive arm fails every folder delete outright.
   *
   * **The root refusal sits above both arms**, and it is not implied by the
   * field names: `rmSync(root, { recursive: true })` would delete the whole
   * sandbox in one message. `remove` and `rename` both compare the canonical
   * *string* against `this.root.root` — comparing against the `FilesRoot`
   * object would be always-false and would let a peer delete the root itself.
   *
   * An earlier draft of this plan argued the opposite ("`rm -r` is **not**
   * offered"), which contradicted the owner's 2026-10-22 ruling that
   * `recursive` is honoured exactly as Rust's `remove_dir_all` honours it. It
   * was a security-shaped reason to keep a defect, and it is recorded here so
   * the next reader does not re-derive it as a design choice.
   *
   * **`Boolean(message.recursive)` below is a coercion, and it stays — but it
   * is no longer reachable with a non-boolean.** Task 22 (`2e3f763`) put
   * `inboundShapeValid` between `decodeFilesFrame` and `dispatch`, and its
   * `'files-delete'` entry declares `recursive` as an optional `bool`. So
   * `recursive: "false"` is refused at the boundary as `BAD_FRAME` and never
   * arrives here; only a real boolean or an absent/`null` value does. The
   * idiom is deliberately not "fixed" to `message.recursive === true`: doing
   * so would restore the fail-open behaviour that the boundary now prevents,
   * for the sake of a validation the boundary already performed. Two guards,
   * one contract — the boundary rejects the wrong kind, this line picks the
   * arm for the right one.
   */
  private remove(message: { [key: string]: unknown }): FilesFrame[] {
    const target = this.root.resolveExisting(String(message.path ?? ''));
    if (target === this.root.root) {
      throw new SandboxError('PERMISSION_DENIED', 'the files root itself cannot be deleted');
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      if (Boolean(message.recursive)) {
        rmSync(target, { recursive: true });
      } else {
        try {
          rmdirSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
            throw new SandboxError('DIR_NOT_EMPTY', 'the directory is not empty');
          }
          throw error;
        }
      }
    } else {
      unlinkSync(target);
    }
    return [this.actionResult(message, target)];
  }

  /**
   * **R5, part two: the wire's names AND the root refusal the port lost.**
   *
   * `FilesRenameRequest` (`packages/shared/src/types/files.ts:166-170`) is
   * `{ requestId, oldPath, newPath }`. The plan read `from` / `toPath` /
   * `toName`, none of which the wire carries, so all three were `undefined`:
   * `from` resolved to the root, `toPath` to the root, and `toName` to the
   * **string** `"undefined"` — the rename went to `<root>/undefined` and threw
   * `EINVAL` → `IO_ERROR` for every UI rename.
   *
   * The root guard is the **second** half and it is not implied by the field
   * names. `remove` already refuses the root (`:5468-5470`, comparing the
   * canonical *string* so the comparison is not always-false); `rename` has no
   * such check, and the Rust does (`files.rs:964-970` returns
   * `PermissionDenied`, "cannot rename sandbox root"). Under the broken names
   * the missing guard was masked — `from` was always `''` and the failure came
   * out as `IO_ERROR` for an unrelated reason. **With the wire's real names
   * `rename('', 'x')` resolves `''` to the canonical root and reaches
   * `renameSync`**, so fixing the names without adding the guard swaps one
   * wrong code for another. Containment still holds the destination inside the
   * root, so this is a wrong code plus a missing refusal, not an escape — but
   * `IO_ERROR` where the Rust produces `PERMISSION_DENIED` is a contract
   * break, and the guard is the behaviour the Rust pinned.
   */
  private rename(message: { [key: string]: unknown }): FilesFrame[] {
    const from = this.root.resolveExisting(String(message.oldPath ?? ''));
    // The same comparison `remove` makes, for the same reason: two canonical
    // strings, never the `FilesRoot` object (which would be always-false).
    if (from === this.root.root) {
      throw new SandboxError('PERMISSION_DENIED', 'the files root itself cannot be renamed');
    }
    // `newPath` is a full relative path on the wire, not a directory plus a
    // name. Splitting it here keeps `resolveParentForCreate` — which rejects a
    // name containing a separator — as the single place a create-target is
    // validated.
    const slash = String(message.newPath ?? '').lastIndexOf('/');
    const parentDir = slash === -1 ? '' : String(message.newPath).slice(0, slash);
    const name = slash === -1 ? String(message.newPath ?? '') : String(message.newPath).slice(slash + 1);
    const to = this.root.resolveParentForCreate(parentDir, name);
    try {
      statSync(to);
      throw new SandboxError('FILE_EXISTS', 'destination already exists');
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    renameSync(from, to);
    return [this.actionResult(message, to)];
  }

  private actionResult(message: { [key: string]: unknown }, path: string): FilesFrame {
    // `path` is a canonical absolute path; the wire carries it relative to the
    // root. `this.root` is the `FilesRoot`, so the comparison and the slice
    // both go through `.root` (the canonical string).
    const prefix = this.root.root;
    return {
      type: 'files-action-result',
      requestId: message.requestId,
      action: String(message.type).replace('files-', ''),
      success: true,
      // Declared divergence, not an oversight: neither the Rust's
      // `FilesActionResult` (`files.rs:564-570`) nor the shared type
      // (`packages/shared/src/types/files.ts:172-177`) carries a `path` on an
      // action result. The browser never reads it (`payload.path` on this
      // frame: 0 hits), and `FilesFrame` is `{ type: string; [key: string]:
      // unknown }`, so `tsc` cannot catch it either. Kept for logging, and
      // recorded here so the next reader does not mistake it for the contract.
      // **The failure arm below must not carry it.**
      path: path === prefix ? '' : path.slice(prefix.length + 1),
    };
  }

  /**
   * **R10: the failure arm, and the code it carries.**
   *
   * The Rust routes an action failure through `files-action-result` with
   * `success: false` and a **prefixed** string (`"FILE_EXISTS: …"`); the
   * browser's `isFilesErrorCode` never matches that, so on `main` every failed
   * action degrades to `BAD_FRAME`. The plan had no failure arm at all and
   * routed failures through `files-error` instead. **Neither artefact is the
   * right answer, and the port takes the combination of both:** the Rust's
   * *frame*, carrying the browser's *bare code*.
   *
   * Why `files-action-result` and not `files-error`, stated because the
   * distinction is a validation asymmetry rather than a style preference:
   * `files-action-result` **validates** the code it carries
   * (`client.ts:566-571`, `isFilesErrorCode` else `BAD_FRAME`), while
   * `files-error` casts the payload unchecked (`client.ts:631-636`). An unknown
   * code crossing on `files-error` arrives intact, the store maps it through
   * `fileErrorMessage` into a 17-key `Record` whose exhaustiveness is a
   * compile-time property only, the lookup returns `undefined`, and
   * `FilesView.vue:268`'s `v-if="tab.fileError"` treats that as falsy — so the
   * error banner **disappears entirely** rather than showing a wrong message.
   * `files-action-result` cannot produce that outcome, because the array
   * rejects what it does not know.
   *
   * The code comes from the `SandboxError`'s own `code` field — the port has
   * the bare code in hand at the throw site and parses nothing. `error` is set
   * **only when `success` is false**, so the success frame keeps the shape it
   * had.
   */
  private actionFailure(message: { [key: string]: unknown }, code: FilesErrorCode): FilesFrame {
    return {
      type: 'files-action-result',
      requestId: message.requestId,
      action: String(message.type).replace('files-', ''),
      success: false,
      // The BARE code — `'FILE_EXISTS'`, never `'FILE_EXISTS: …'`.
      error: code,
      // No `path`: the failure arm's shape is the four fields the browser
      // reads (`requestId`, `success`, `error`, plus the type's `action`).
    };
  }

  private discardUpload(state: UploadState): void {
    try {
      unlinkSync(state.partPath);
    } catch {
      /* a missing .part is the desired end state */
    }
  }
}

/** Tears a session down: both slots cleared, any `.part` removed. */
export function teardown(session: FilesSession): void {
  session.dispose();
}
```

- [ ] **Step 5: Write the `files-action-result` crossing test**

This test crosses the port and the browser, so it is the one test in Task 11
that gets a file of its own. It must drive the **real** `FileClient` and import
the **real** harness — `makeFakeManager` from `@ponter/file-core/test/helpers`.
A hand-rolled fake manager, or a local copy of the browser's code list,
re-implements the thing under test inside the test, and passes when the real
list disagrees. The 16 keys come from `FILES_ERROR_CODES` in `@ponter/shared`
(R11 and R12), not from a literal in this file.

Before it resolves, `apps/agent/package.json` gains `@ponter/file-core` as a
**devDependency** — a test-only consumer of a browser package, the correct
dependency direction — and `packages/file-core`'s `exports` gains **both** `"."`
**and** `"./test/helpers"` (a subpath-only map makes every bare
`@ponter/file-core` import unresolvable: measured, 21 `vue-tsc` errors in
`apps/web`).

**Then install, in this step — the manifest edit alone does not resolve
anything.** `pnpm-lock.yaml` must be regenerated because CI installs with
`--frozen-lockfile` (`ci-node.yml:78`), but a regenerated lockfile is not by
itself a link: the new `@ponter/file-core` entry stays absent from
`apps/agent/node_modules` until an install runs. Measured on the resolution
matrix (`.superpowers/probes/b12g-task11-staging-gap-v2/`, S3): with the dependency
declared *and* the `exports` map applied, `tsc` still reports
`TS2307: Cannot find module '@ponter/file-core/test/helpers'` until the install
runs. So this step declares the dependency, applies the `exports` map, and
installs:

```bash
pnpm --filter @ponter/agent-node add -D --workspace @ponter/file-core
```

`pnpm add` rewrites `apps/agent/package.json`, regenerates `pnpm-lock.yaml`,
and links `apps/agent/node_modules/@ponter/file-core` — all four edits the rest
of this task depends on, in one command. (`--workspace` is what keeps the spec
on the `workspace:` protocol rather than reaching for the registry.)

```ts
// apps/agent/test/files/action-result.test.ts
import { FILES_ERROR_CODES, type FilesErrorCode } from '@ponter/shared';
import { FileClient } from '@ponter/file-core';
import { makeFakeManager } from '@ponter/file-core/test/helpers';

const CODES = Object.keys(FILES_ERROR_CODES) as FilesErrorCode[];

it.each(CODES.filter((c) => c !== 'BAD_FRAME'))(
  'the browser accepts the port-emitted %s',
  async (code) => {
    const fake = makeFakeManager();
    const client = new FileClient('ag-1', fake.manager);
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: false,
      error: code,               // the BARE code, as the port emits it
    });
    await expect(promise).rejects.toMatchObject({ code });   // not BAD_FRAME
  },
);

// `BAD_FRAME` is both a member of the 16 and the client's fallback
// (`client.ts:566-571`), so the iteration above CANNOT discriminate it:
// accepted and defaulted both reject with code === 'BAD_FRAME'. Measured —
// an array with BAD_FRAME removed still passes all 16 (probe
// ../b12g-n7-vacuity/, mutant B). So the fallback is pinned separately:
it('an unknown code degrades to BAD_FRAME', async () => {
  const fake = makeFakeManager();
  const client = new FileClient('ag-1', fake.manager);
  const promise = client.mkdir('docs', 'new');
  const frame = fake.sent.at(-1);
  fake.emit('files-action-result', {
    requestId: frame?.payload.requestId,
    action: 'mkdir',
    success: false,
    error: 'NOT_A_CODE',
  });
  await expect(promise).rejects.toMatchObject({ code: 'BAD_FRAME' });
});
```

**`BAD_FRAME` is carved out of the loop on purpose, and that is a declared
limit, not an oversight.** It is both a member of the 16 and the client's own
fallback (`client.ts:566-571`), so accepted and defaulted reject identically
and the loop cannot tell them apart — measured, an array with `BAD_FRAME`
removed still passes all 16. The honest count is **15 discriminating + 1
non-discriminating + 1 fallback assertion**, never "16/16 covered".

**This test does not gate until Plan 3 lands.** `apps/agent/**` is absent from
`ci-node.yml`'s `paths:`, and the gating test run excludes
`@ponter/agent-node` (`:105-111`), so a test in the port's package is green
locally and invisible in CI. Record the local run in the report; the Plan-3
handoff is the path plus dropping the filters.

- [ ] **Step 6: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/files/protocol.test.ts test/files/session.test.ts test/files/action-result.test.ts
./node_modules/.bin/prettier --write apps/agent/src/files/protocol.ts apps/agent/src/files/session.ts apps/agent/test/files/*.test.ts
git add apps/agent/src/files apps/agent/test/files \
        apps/agent/package.json packages/file-core/package.json pnpm-lock.yaml
git commit -m "feat(agent): port the files protocol and transfer state machine"
```

**All three manifest paths must be in that `git add`, not just the source and
test directories.** Step 5 edits three files that live outside them, and
`packages/file-core/package.json` is staged by **no** other step in any plan —
Plan 1, 2, or 3 — so if it is left out here it is never committed anywhere and
the `exports` hardening is silently dropped. The failure is invisible: with no
`exports` field the import still resolves, so the test stays green for the
accidental reason and nothing goes red (probe
`.superpowers/probes/b12g-task11-staging-gap/`).

**TEST-INTEGRITY declaration:** **three** new test files, **42 new `it()` / 84
new `expect()`** — a movement of **30 → 42** and **61 → 84** against the
paragraph as R13 left it, with the naive token count moving **62 → 85**. Count
both figures **inside the fenced test snippets only** — the same axis the
audit's B-1 compares against, and every fence counted here is in this task
(Step 1, Step 3, Step 5). 84 is the count with the fences' comments stripped;
the naive count returns 85 because
`expect(FILES_IDLE_TIMEOUT_MS).toBe(FILES_IDLE_TIMEOUT_MS)` appears once — in a
comment explaining why that assertion **cannot fail** in TypeScript and is
therefore not written. Counting it would book an assertion the plan
deliberately does not make.

**The B-12g repair adds twelve `it()` and twenty-three `expect()` — thirteen
test blocks, because R6's `it.each` is a thirteenth that the fence recipe does
not count — and this fence now contains an `it.each`, so the six-number rule
applies.** R6's decode test iterates the twelve declared types with `it.each`,
which the fence recipe (`(?<![.$])\bit\s*\(`) **cannot see**: `\bit\s*\(` needs
a `(` after `it`, and `it.each(` puts a `.` there. So the fence count and the
call-site count diverge, and a declaration that reported one without the other
would under-report R6's executed cases by 11 — the fence counts **1** `it`
there, and the loop runs **12**.

| counter | number | before → after | how it is obtained |
|---|---|---|---|
| `it()` | **fence** | **30 → 42** | the audit's recipe over the fences — **blind to `it.each(`** |
| `it()` | call sites | 31 → **44** | `it.each(` + `it(` — what a reader sees |
| `it()` | runtime reporter cases | 45 → **69** | session's `it.each` reports 12 cases where the recipe sees 1; `action-result.test.ts` keeps R13's 15 + 1 |
| `expect()` | **fence (comments stripped)** | **61 → 84** | the recipe; every added `expect(` is literal |
| `expect()` | call sites | 61 → **84** | same value here — `expect(` is never wrapped |
| `expect()` | runtime executions | 75 → **120** | session's loop body holds **two** `expect(`, each run 12 times instead of once (+22) |
| naive token count | — | 62 → **85** | the stripped total plus the one commented-out assertion |

**42 is the number that lands; 44 must not be written as the headline.** Audit
B-1 compares *declared* against *fence actual*, so a declaration reading 44
books a Δ of +2 and re-creates the defect this section exists to close. The
call-site and runtime figures are stated beside it, not instead of it.

The thirteen added test blocks — twelve of which the fence recipe counts — each
with its reason:

| test | covers | `it()` | `expect()` |
|---|---|---|---|
| `covers every declared inbound type, and the list is twelve long` | R6 | 1 | 2 |
| `routes %s through decode to its arm` (`it.each` over 12) | R6 | 0 fence / 1 call site / 12 runtime | 2 fence / 2 / 24 |
| `drops a type outside the twelve instead of reaching an arm` | R6's control | 1 | 2 |
| `creates in the named directory, not the root` | R5 | 1 | 2 |
| `reports FILE_EXISTS, not IO_ERROR, when the directory is already there` | R10(a) | 1 | 2 |
| `reads the wire's oldPath and newPath` | R5 | 1 | 2 |
| `refuses to rename the sandbox root` | R5's second half | 1 | 1 |
| `flushes on the 20 ms tick an ack the chunk path did not take` | R7 | 1 | 2 |
| `takes unconditionally on the tick even when the frequency rule says no` | R7 | 1 | 3 |
| `emits the final ack before files-upload-complete` | R8 | 1 | 1 |
| `wraps a JSON frame as { type, channel, payload, timestamp }` | R1 | 1 | 1 |
| `nests the fields instead of leaving them as siblings` | R1 | 1 | 2 |
| `pins channel to "files" for every frame` | R1 | 1 | 1 |
| **total** | | **12 fence / 13 call sites** | **23** |

Per file, on that same fence axis: `protocol.test.ts` **12 `it()` / 22
`expect()`** (was 9 / 18; R1's three envelope cases) and `session.test.ts`
**29 / 60** (was 20 / 41; R5, R6, R7, R8) are the two files of new work, and
`action-result.test.ts` **1 / 2** is **untouched** — it stays in the table
only so the per-file tally stays complete; R13 is already landed and this
repair does not add to it. The
2 call sites and 16 runtime cases for each of that file's two counters are
R13's and are carried forward, not re-derived. 12 + 29 + 1 = 42; 22 + 60 + 2 =
84; naive 22 + 61 + 2 = 85.

**R6 is the item that makes the other defects impossible to repeat, and it is
stated as coverage rather than as a new test.** The Rust's
`decode_round_trips_every_browser_to_agent_type` (`files.rs:2433-2481`) named
the enumeration in its title and asserted **7 of 12** shapes — no `mkdir`, no
`rename`, no `delete`, no `pause`, no `resume`. Two of the five it omitted are
exactly the two whose field names the port got wrong, which is why that defect
was invisible on **both** sides. `FILES_INBOUND_TYPES` now exists as a value, so
the loop and the length assertion fail together if a type is added without a
case — the enumeration is checked against itself rather than against a number
someone typed.

Ports 26 of `files.rs`'s 65 tests — those covering the wire surface, the
window, ack batching, resume
alignment, cancel, idle, and the three `list_*` tests. The remaining **39** are
either Rust-internal helpers (`rfc3339_formats_epoch_seconds_utc`,
`test_transfer_id_codec_*`, the seven `path_policy_*` /
`upload_create_path_*` tests Task 10 already owns, and the pure `total_chunks` /
`expected_chunk_len` / frame-cap arithmetic) or per-platform filesystem races
(`finalize_race_losing_path_is_file_exists`, `stale_part_is_removed_and_retried_once`,
`test_janitor_cleans_stale_part_files`). **The counts are per-test-name, derived
from the two fences, not from a split estimated by subtraction.** The previous
"24 of 65 / 41 remaining" partition was unauditable — it named one of the 24 and
described the rest — and the repair is a *partition* repair, not a relabel: the
41's stated criterion ("Rust-internal helpers … or per-platform filesystem
races") does not cover `paused_state_survives_idle_timeout` (`files.rs:3834`),
which exercises a wire-surface idle behaviour and therefore belonged to neither
list. It is now counted among the 26 ports.

### The five retired-test verdicts (R9), recorded in full

The retire clause classified five Rust tests as *"Rust-internal helpers"*.
**Two of those verdicts are right and three are wrong**, and the category —
named after what a function *is* — cannot tell you what a test *protects*. A
re-derivation that reported five problems where two are correct would read as
uncalibrated, so all five are recorded here with their reasons, including the
two that stand.

**Correctly retired — recorded, not restored:**

| test | where | why the retirement stands |
|---|---|---|
| `error_code_spellings_are_pinned` | `files.rs:2357` | The TS `FilesErrorCode` union turns a misspelling into a `TS2820`. A literal table re-porting 12 of 16 spellings is strictly weaker than the union that rejects all 16 — and R12's `Record` closes the completeness half the union cannot. |
| `test_transfer_id_codec_roundtrips_dashed_uuid` | `files.rs` | The transfer id is **unobservable outside the module**: it is encoded into 16 raw bytes and decoded back inside the frame codec, so no caller can see the difference a regression would make. The binary-frame round-trip test in `protocol.test.ts` covers the observable half. |

**Wrongly retired — restored by this repair:**

1. **`frame_files_wraps_the_envelope` (`:2484-2500`).** Retired as a
   *"Rust-internal helper"* — but it asserts `channel`, `payload` nesting and
   `timestamp`, and **the browser is the observer of every one of those three**.
   It is the test whose absence let the plan emit flat frames, and flat frames
   are the silent hang described in R1. The successor is `frameFiles` plus the
   three envelope cases in `protocol.test.ts`.
2. **`decode_guard_never_errors_on_foreign_frames` (`:2388`).** The ADR-09
   foreign-channel drop is a **fifth** consequence of the frame-to-wire hole,
   not an internal helper: the Rust drops a misfiled frame
   (`files.rs:590-592`), and R2's inbound arm restores the guard. The successor
   is `drops a frame whose wire channel does not match the label`.
   **The comment shape is the trap here** — this test's comment (`:2389`) uses
   the same *"wire contract"* reasoning as `error_code_spellings_are_pinned`'s
   (`:2358`) and reaches the **opposite** verdict. **The rule decides, not the
   comment.**
3. **`test_error_code_str_mapping` (`:3506`).** It is the **second half of a
   wire-contract pin**: with `error_code_spellings_are_pinned`'s 12 cases it
   makes **14 of 16**, and it pins `RESUME_INVALID` and `QUEUE_FULL` — two codes
   the spellings test does not mention. The successor is R12's `Record` guard
   over the shared union, which covers all 16 in both directions; a re-port of
   the literal table would be the weaker artefact, which is why the retirement
   of the *literal* is right and the retirement of the *pin* was not.

**What this changes in the partition:** `decode_guard_*` and
`frame_files_wraps_the_envelope` leave the 39 and re-home as **restored
coverage with named successors** (R2 and R1). `test_error_code_str_mapping`
likewise leaves the 39 and its obligation is discharged by R12, not by a test
in this task. `error_code_spellings_are_pinned` and
`test_transfer_id_codec_roundtrips_dashed_uuid` **stay in the 39** with their
reasons recorded above rather than being re-derived as gaps.

**The remaining 36** of the 39 are unchanged: the seven `path_policy_*` /
`upload_create_path_*` tests Task 10 owns, the pure arithmetic, and the three
per-platform filesystem races.

Declared **retirements** for Plan 3's R-entry: `files-download-chunk` as a JSON
outbound type (dead in Rust, never emitted — no browser can depend on it);
`QUEUE_FULL` (never produced); and the `decode_*` guards' `#[allow(dead_code)]`
TS counterparts, which do not exist — **but the guard *test* is not part of this
retirement**, because R2 above restores its behaviour. The four `decode_*`
names are retired as *tests over helpers that do not exist*; the
**channel-drop behaviour** they guarded is restored in the router, where the
guard now lives.

**Three additions, each declared as new rather than counted as a port:**

1. **`pins the idle timeout to the wire value`** — `expect(FILES_IDLE_TIMEOUT_MS).toBe(30_000)`.
   The Rust comment at `files.rs:40-45` claims the constant is "pinned by its own
   assertion" and no such assertion exists (the test module starts at `:2287`;
   nothing past it references `FILES_IDLE_TIMEOUT`). **Only the literal is
   asserted.** The earlier declaration promised "the prod timeout equals it" as
   well; that assertion is *vacuous* in TS and has been dropped, because TS has
   one constant used identically by production and tests, so
   `expect(X).toBe(X)` cannot fail. Rust could assert the equivalent because it
   has **two** symbols diverging under `cfg(test)` — `FILES_IDLE_TIMEOUT` shrinks
   to 50 ms so tests need not sleep 30 s. **TS needs no such divergence: it
   injects `now()`, which is the design difference the declaration now names
   instead of implying.**
2. **`lists entries sorted directories-first, then name byte-wise`** — the sort
   is `Buffer.compare` on UTF-8 bytes, matching `files.rs:1336-1340`. `localeCompare`
   is ICU-dependent and would also put the fixture's dir first, so the *name*
   half is what discriminates.
3. **`reports NOT_A_DIRECTORY when listing a file`** — this is the test that
   catches `readdirSync` bypassing `errnoToCode`. Without the mapping inside
   `list()`, Node's `ENOTDIR` reaches `handle()`'s generic catch and the wire code
   becomes `IO_ERROR` while the Rust emits `NOT_A_DIRECTORY`.

**One test renamed, not removed:** `paused transfers do not time out` exists in
the fence and is correctly named, but the previous declaration called it *new*.
It is a **port** of `paused_state_survives_idle_timeout` (`files.rs:3834`), which
pauses, forces `deadline` into the past, and asserts `checkIdle()` returns empty
with the slot still `Some`. The TS fence does the same through the injected
clock. Counted among the 26 ports.

**Two fence repairs the tests depend on** (no count change on their own):
`FilesRoot.list()` now builds the wire shape `{name, path, size, isDirectory,
modifiedAt}` rather than `{name, kind, size|null, modifiedEpochMs}` — the Rust
`RemoteFile` (`files.rs:286-292`), `packages/shared/src/types/files.ts:6-13`, and
`apps/web`'s FilesView all agree on the former, and only the plan disagreed.
`rfc3339Utc` is added to `protocol.ts` and `errnoToCode` is exported from
`sandbox.ts` so `list()` can use them.

---

### Task 12: The PTY

**Files:**
- Create: `apps/agent/src/terminal/pty.ts`
- Test: `apps/agent/test/terminal/pty.test.ts`

**Interfaces:**
- Consumes: `ShellPolicy` (Task 9); constants.
- Produces:
  - `const MAX_PTY_CHUNK = 16 * 1024`, `const MAX_SESSIONS = 10`
  - `interface PtyHost { spawn(file, args, opts): PtyProcess }` — the `node-pty` seam
  - `class PtyManager { create(opts): Promise<void>; resize(id, cols, rows): void; write(id, bytes): void; close(id): Promise<void>; onData(cb): void; onExit(cb): void }`

- [ ] **Step 0: Install `node-pty` — including the build allowlist**

Run, from the repo root:

```bash
pnpm --filter @ponter/agent-node add node-pty@1.2.0-beta.15
```

Then add **both** entries to `pnpm-workspace.yaml`'s `allowBuilds:` block, next to `better-sqlite3`:

```yaml
  # node-pty runs `node scripts/prebuild.js || node-gyp rebuild` on install.
  # Allow the build: on Windows the prebuilt binary is the only way to get a
  # working ConPTY, and there is no prebuild at all for some targets.
  node-pty: true
```

Two things this step exists to prevent, both of which present as "the module is missing at runtime" rather than as an install error:

- **`allowBuilds` is not optional.** pnpm 12 blocks postinstall scripts by default. Without the entry the dependency resolves and `import('node-pty')` succeeds far enough to typecheck, but the native binding is never built — which fails only in the packaged app.
- **The version is not a caret, and it is `beta.15` rather than `1.1.0` stable for a build reason.** `npm view node-pty dist-tags` gives `latest: 1.1.0`, `beta: 1.2.0-beta.15`; every `1.2.0-*` publish is a prerelease. **1.1.0 ships prebuilds for darwin-arm64/x64 and win32-arm64/x64 only — no Linux** — so on Linux it falls through to `node-gyp rebuild` and needs a full C++ toolchain on every path (CI, Docker, user installs). ADR-78 makes Linux a first-class target, so the beta line is the right one: `beta.12` and `beta.15` both ship `linux-x64` and `linux-arm64` prebuilts. The `encoding` behaviour this task depends on was measured identical on 1.1.0, `beta.12` and `beta.15` (`CustomWriteStream.write` is byte-identical source across all three), and `typings/node-pty.d.ts` is byte-identical between the two betas, so `beta.12 → beta.15` is a drop-in, and so are the `install`/`postinstall` scripts (`node scripts/prebuild.js || node-gyp rebuild`, `node scripts/post-install.js` — identical in 1.1.0, `beta.12` and `beta.15`), so one `allowBuilds` entry covers any of them. Take `beta.15` for the two Windows pty fixes it carries over `beta.12`: a `std::mutex` around `ptyHandles` plus `ptyCounter` as `std::atomic<int>` in `src/win/conpty.cc`, and a `windowsTerminal.js` `_agent.onError` handler without which a failed ConPTY connect leaves the terminal object alive forever and the supervisor never learns the session died. Re-measure before moving off `beta.15`.

Verify the binding actually loaded before writing any code:

```bash
node -e "const p=require('node-pty'); console.log(require('node-pty/package.json').version, typeof p.spawn)"
```

Expected: `1.2.0-beta.15 function`. If this throws, stop — the rest of the task cannot run.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/terminal/pty.test.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SESSIONS, PtyManager } from '../../src/terminal/pty.js';

function fakeHost() {
  const spawned: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const procs: (EventEmitter & { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> })[] = [];
  const host = {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ file, args, opts });
      const emitter = new EventEmitter();
      // The fake stands in for `IPty`, so it exposes the **same two members**
      // the real host does — `onData` / `onExit` — and routes them through
      // `emit` so the fence can fire an event. A fake that exposed `on`
      // instead would typecheck against the seam it no longer matches, and
      // the mismatch would only surface against a real `node-pty`.
      const p = Object.assign(emitter, {
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        pid: 1000 + procs.length,
        onData: (cb: (chunk: string | Buffer) => void) => { emitter.on('data', cb); },
        onExit: (cb: (event: { exitCode?: number }) => void) => { emitter.on('exit', cb); },
      });
      procs.push(p);
      return p;
    },
  };
  return { host, spawned, procs };
}

describe('PtyManager.create', () => {
  it('spawns with the documented TERM and LANG', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    expect(spawned[0].opts).toMatchObject({
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: expect.objectContaining({ TERM: 'xterm-256color', LANG: 'C.UTF-8' }),
      // Bytes, not text: a utf8-decoding host loses 0xff before base64 runs.
      encoding: null,
    });
  });

  it('is idempotent per terminal id', async () => {
    const { host, spawned } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    expect(spawned).toHaveLength(1);
  });

  it('refuses an 11th session with session-limit-reached', async () => {
    const { host } = fakeHost();
    const manager = new PtyManager(host);
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({ terminalId: `t${i}`, shell: '/bin/sh', cols: 80, rows: 24 });
    }
    await expect(
      manager.create({ terminalId: 'overflow', shell: '/bin/sh', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'session-limit-reached' });
  });

  it('frees a slot when a session exits', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      await manager.create({ terminalId: `t${i}`, shell: '/bin/sh', cols: 80, rows: 24 });
    }
    procs[0].emit('exit', { exitCode: 0 });
    await expect(
      manager.create({ terminalId: 'after-exit', shell: '/bin/sh', cols: 80, rows: 24 }),
    ).resolves.toBeUndefined();
  });
});

describe('PtyManager output', () => {
  it('base64-encodes arbitrary bytes without a UTF-8 round trip', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const frames: { terminalId: string; data: string }[] = [];
    manager.onData((f) => frames.push(f));
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    procs[0].emit('data', Buffer.from([0x00, 0xff, 0xc3]));
    expect(frames[0].data).toBe(Buffer.from([0x00, 0xff, 0xc3]).toString('base64'));
  });

  it('splits more than 16 KiB of output into two frames', async () => {
    // The Rust's `chunk_boundaries` promised this and never exercised it: it
    // built one synthesized frame per length and asserted length equality. This
    // is a real chunking assertion, made against the manager's own splitter.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const frames: { terminalId: string; data: string }[] = [];
    manager.onData((f) => frames.push(f));
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    procs[0].emit('data', Buffer.alloc(16 * 1024 + 100, 0x41));
    expect(frames).toHaveLength(2);
    expect(Buffer.from(frames[0].data, 'base64').length).toBe(16 * 1024);
    expect(Buffer.from(frames[1].data, 'base64').length).toBe(100);
  });

  it('emits terminal-exit with the reaped code', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const exits: { terminalId: string; exitCode: number | null }[] = [];
    manager.onExit((e) => exits.push(e));
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    procs[0].emit('exit', { exitCode: 3 });
    expect(exits).toEqual([{ terminalId: 't1', exitCode: 3 }]);
  });

  it('reports an unavailable exit code as null', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    const exits: { terminalId: string; exitCode: number | null }[] = [];
    manager.onExit((e) => exits.push(e));
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    procs[0].emit('exit', {});
    expect(exits[0].exitCode).toBeNull();
  });
});

describe('PtyManager.write', () => {
  it('hands the host the same bytes it was given', async () => {
    // `bytes.toString('utf8')` would look right here and pass a naive test,
    // because 'echo' is valid UTF-8. The input below is not: 0xff and 0xfe are
    // invalid UTF-8 leads, and the utf8 round trip turns each into U+FFFD
    // (`ef bf bd`). ADR-10 says the payload is bytes.
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    manager.write('t1', Buffer.from([0x41, 0xff, 0xfe, 0x42]));
    const passed = procs[0].write.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(passed)).toBe(true);
    expect(passed.equals(Buffer.from([0x41, 0xff, 0xfe, 0x42]))).toBe(true);
  });

  it('drops input for an unknown terminal instead of throwing', () => {
    const { host } = fakeHost();
    const manager = new PtyManager(host);
    expect(() => manager.write('nope', Buffer.from('x'))).not.toThrow();
  });

  it('resizes an existing terminal and ignores an unknown one', async () => {
    const { host, procs } = fakeHost();
    const manager = new PtyManager(host);
    await manager.create({ terminalId: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    manager.resize('t1', 120, 40);
    expect(procs[0].resize).toHaveBeenCalledWith(120, 40);
    expect(() => manager.resize('nope', 1, 1)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/terminal/pty.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/terminal/pty.ts
import type { ShellPolicy } from './shell-policy.js';

export const MAX_PTY_CHUNK = 16 * 1024;
export const MAX_SESSIONS = 10;
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * The `node-pty` seam, written against the surface `IPty` actually declares
 * (`typings/node-pty.d.ts:117-190`): `onData` / `onExit`, not EventEmitter's
 * `on`.
 *
 * **This is not a style choice and an earlier draft of this plan had it
 * wrong.** `Terminal.prototype.on` delegates to a private `_socket` and is
 * **absent from `IPty`'s declared type**, so a seam built on `on` cannot be
 * satisfied by the real host at all — it needs a cast to typecheck, and that
 * cast hides a runtime defect. `Terminal.prototype.emit` passes the event's
 * payload as **positional argument 0** (`lib/terminal.js:147-156`), while the
 * `_onExit` wrapper is what turns the positional args into
 * `{ exitCode, signal }` (`:93`). An EventEmitter-shaped handler reading
 * `event?.exitCode` therefore gets `undefined` on every real exit and reports
 * `null`. That is precisely what the plan's own fence observed as `[-1]` and
 * its `as never` cast kept out of `tsc`'s reach.
 *
 * `IEvent<T>` is `(listener: (e: T) => any): IDisposable` (`:212-214`), so the
 * callback shapes below are the host's own, not invented here.
 */
export interface PtyProcess {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: string | Buffer) => void): void;
  onExit(cb: (event: { exitCode?: number }) => void): void;
}

/** The `node-pty` seam. Tests supply a fake so no shell is ever spawned. */
export interface PtyHost {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      /**
       * **Must be `null`.** `node-pty`'s default is `'utf8'`, which puts the
       * master fd into text mode (`_socket.setEncoding(encoding)`): a byte
       * that is not valid UTF-8 arrives at `onData` already replaced by
       * U+FFFD, and the original byte is unrecoverable. ADR-10 makes the
       * terminal payload bytes, not text, and B40 ports it — so the host
       * adapter that supplies the real `node-pty` must pass `encoding: null`
       * and the manager must never convert before base64.
       */
      encoding: null;
    },
  ): PtyProcess;
}

export interface PtyCreateOptions {
  terminalId: string;
  shell: string;
  cols: number;
  rows: number;
  /** Resolved through `ShellPolicy` before it reaches here. */
  policy?: ShellPolicy;
}

export class PtyError extends Error {
  constructor(
    readonly code: 'pty-spawn-failed' | 'session-limit-reached',
    message: string,
  ) {
    super(message);
    this.name = 'PtyError';
  }
}

interface Session {
  process: PtyProcess;
}

/**
 * PTY sessions (B39–B41).
 *
 * Four details that are not obvious:
 *
 * - **Output is base64 of raw bytes, never a UTF-8 decode.** A chunk boundary can
 *   land mid-codepoint; decoding to a string and re-encoding would corrupt it,
 *   and a terminal sending `0xff` would throw outright. The browser's `atob`
 *   handles it because the split happens at base64 length, not code unit.
 * - **The bytes are only raw if the host says so.** `node-pty` defaults to
 *   `encoding: 'utf8'`, which decodes the master fd to a string *before* this
 *   class ever sees it — the corruption then happened upstream and base64
 *   cannot recover it. That is why `PtyHost.spawn` takes `encoding: null`.
 * - **Chunking is 16 KiB of raw bytes per frame.** Above that, `writeSync`-style
 *   framing exceeds the SCTP message size the browser accepts.
 * - **The exit code is reaped from the process's own `exit` event, not inferred
 *   from a zero-length read.** `node-pty` gives us the event, so the Rust's
 *   slave-end dance (drop it so `read()` returns `Ok(0)`) has no analogue here —
 *   there is no slave handle to hold. That whole class of bug does not port.
 *
 * The 10-session cap is agent-side and load-bearing: each session is a process
 * with a pty; a peer that opens sessions in a loop would exhaust the host.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private dataHandler: ((frame: { terminalId: string; data: string }) => void) | null = null;
  private exitHandler: ((frame: { terminalId: string; exitCode: number | null }) => void) | null =
    null;

  constructor(private readonly host: PtyHost) {}

  onData(cb: (frame: { terminalId: string; data: string }) => void): void {
    this.dataHandler = cb;
  }

  onExit(cb: (frame: { terminalId: string; exitCode: number | null }) => void): void {
    this.exitHandler = cb;
  }

  async create(options: PtyCreateOptions): Promise<void> {
    if (this.sessions.has(options.terminalId)) return;
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new PtyError('session-limit-reached', 'the agent already has 10 terminal sessions');
    }
    // **The allowlist is consulted before a process exists**, as the Rust does
    // (`lib.rs:1372-1400`): a peer-supplied shell is untrusted input, and
    // checking it after `spawn` would already have executed it. The policy
    // throws `ShellRefusedError` with the Rust's own wording; it is re-thrown
    // as `pty-spawn-failed`, which is the frame the Rust sends for a refused
    // shell too ("reuse the pinned spawn-failure frame … a third wire code
    // would change a contract for no reader's benefit").
    //
    // An earlier draft declared `policy?: ShellPolicy` on the options and never
    // read it, so any client-supplied shell spawned. `policy` is **optional at
    // the seam and mandatory in production**: `runtime.ts` is where a manager is
    // constructed, and it must always pass one. The two test cells below pin
    // both halves — that a refused shell never reaches `spawn`, and that the
    // **canonical path the policy resolved** is what spawns.
    const shell = options.policy ? this.resolveShell(options.policy, options.shell) : options.shell;
    let process_: PtyProcess;
    try {
      process_ = this.host.spawn(shell, [], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' } as Record<string, string>,
        // Bytes, not text. See the `encoding` note on `PtyHost.spawn`.
        encoding: null,
      });
    } catch (error) {
      throw new PtyError('pty-spawn-failed', (error as Error).message);
    }
    // With `encoding: null` a real `node-pty` emits Buffers. The `string` half
    // is tolerated only so a fake host cannot smuggle in a lossy decode
    // silently: `Buffer.from(string)` is the utf8 round trip this code exists
    // to avoid, so the string branch is a bug in the host adapter, not a
    // supported input — which is why the real host must pass `encoding: null`.
    //
    // **Subscribe before registering the slot.** Registering first leaks a slot
    // forever if a subscription throws: the map keeps an entry nothing will
    // ever delete, so the agent silently offers 9 sessions instead of 10 for
    // the rest of its life. On a throw, kill the spawned process — leaving it
    // running unobserved is the second half of the same defect — and report the
    // same `pty-spawn-failed` an unwireable spawn reports.
    try {
      process_.onData((chunk: string | Buffer) => {
        this.emitChunks(options.terminalId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      process_.onExit((event: { exitCode?: number }) => {
        this.emitExit(options.terminalId, process_, event);
      });
    } catch (error) {
      try {
        process_.kill();
      } catch {
        // The process is already unusable; a failing kill changes nothing.
      }
      throw new PtyError('pty-spawn-failed', (error as Error).message);
    }
    this.sessions.set(options.terminalId, { process: process_ });
  }

  private resolveShell(policy: ShellPolicy, requested: string): string {
    try {
      return policy.resolveClientShell(requested);
    } catch (error) {
      throw new PtyError('pty-spawn-failed', `shell refused: ${(error as Error).message}`);
    }
  }

  /**
   * **Only this process may free the slot.** `close()` drops the map entry but
   * cannot unsubscribe, so an old process's exit handler outlives it; a reused
   * id would then be deleted by a stranger's death, silencing a live terminal
   * the browser still shows.
   *
   * The exit is still **reported** either way. Rust reports the exit and only
   * guards the eviction; a port that also swallowed the event would hide a real
   * terminal death from the browser, which is the worse half of the defect.
   */
  private emitExit(terminalId: string, process_: PtyProcess, event: { exitCode?: number }): void {
    if (this.sessions.get(terminalId)?.process === process_) this.sessions.delete(terminalId);
    this.exitHandler?.({
      terminalId,
      exitCode: typeof event?.exitCode === 'number' ? event.exitCode : null,
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.process.resize(cols, rows);
  }

  write(terminalId: string, bytes: Uint8Array): void {
    // Pass the Buffer through. `Buffer.from(bytes).toString('utf8')` — the
    // obvious spelling — is a lossy round trip for any byte input that is not
    // valid UTF-8, and it is the *inbound* half of the same defect as the
    // `encoding` note on `PtyHost.spawn`. Measured: writing `41 ff fe 42` that
    // way reaches the child as `41 ef bf bd ef bf bd 42`.
    this.sessions.get(terminalId)?.process.write(Buffer.from(bytes));
  }

  async close(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    session.process.kill();
  }

  private emitChunks(terminalId: string, buffer: Buffer): void {
    for (let offset = 0; offset < buffer.length; offset += MAX_PTY_CHUNK) {
      const slice = buffer.subarray(offset, offset + MAX_PTY_CHUNK);
      this.dataHandler?.({ terminalId, data: slice.toString('base64') });
    }
  }
}
```

- [ ] **Step 3: Add the one test that needs a real PTY**

```ts
// apps/agent/test/terminal/pty-real.test.ts
import { describe, expect, it } from 'vitest';
import { PtyManager } from '../../src/terminal/pty.js';

describe('a real shell', () => {
  it('echoes, then delivers terminal-exit after the child exits', async () => {
    const { spawn } = await import('node-pty');
    const manager = new PtyManager({ spawn: spawn as never });
    const data: string[] = [];
    const exits: number[] = [];
    manager.onData((f) => data.push(f.data));
    manager.onExit((e) => exits.push(e.exitCode ?? -1));
    await manager.create({ terminalId: 't', shell: '/bin/sh', cols: 80, rows: 24 });
    manager.write('t', Buffer.from('echo PONTER_E2E\n'));
    await new Promise((r) => setTimeout(r, 300));
    expect(Buffer.concat(data.map((d) => Buffer.from(d, 'base64'))).toString()).toContain(
      'PONTER_E2E',
    );
    manager.write('t', Buffer.from('exit 7\n'));
    await new Promise((r) => setTimeout(r, 300));
    expect(exits).toEqual([7]);
  });
});
```

- [ ] **Step 4: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/terminal/pty.test.ts test/terminal/pty-real.test.ts
./node_modules/.bin/prettier --write apps/agent/src/terminal/pty.ts apps/agent/test/terminal/pty*.test.ts
git add apps/agent/src/terminal apps/agent/test/terminal apps/agent/package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(agent): add the node-pty manager with 16 KiB base64 chunking"
```

**TEST-INTEGRITY declaration:** two new files, **12 new `it()` / 17 new `expect()`**. (An earlier draft of this line said **18** `expect()`; the `it()` figure was always right. Recounted on committed blob `50dcc9e` — `pty.test.ts` 11 `it()` / 15 `expect()` + `pty-real.test.ts` 1 / 2 — the whole population, since both files are new in that commit and have no predecessor at `50dcc9e^`. The 18 is the same error class this plan corrected in Task 4 and R3: a count written from a story about the task rather than from the task's own lines.) Ports `frame_round_trip_preserves_arbitrary_bytes`, `resize_message_round_trip`, `frame_pty_exit_produces_valid_envelope`, `plaintext_frame_is_byte_identical_to_today`, `outbound_terminal_data_carries_raw_bytes`, `pty_echo_round_trip`. `chunk_boundaries` is **replaced, not ported**: the Rust test's name promised chunking it never exercised — its body synthesized a single frame and asserted `decoded.len() == len`, which is not the property the name claims. The TS test drives real output through the splitter and asserts two frames of 16 KiB and 100 bytes, each ≤ 16 KiB. Ruling: **code wins, the phantom is not ported**, and this is not a weakening — the Rust test asserted less than its name promised, so the TS asserts strictly more. The splitter itself is **not** a new behaviour invented here: B40 (`spec:604`) states 16 KiB chunks as the wire contract. The Rust met that contract, but at its **read site** rather than at its framer — `start_reader` allocates `vec![0u8; MAX_PTY_CHUNK]` (`pty.rs:392`) and hands on `buf[..n]` (`:397`), so `read()` could never return more than the buffer held; `frame_pty_output` (`pty.rs:141-143`) is length-agnostic by design, which is why the spec's `pty.rs:22,123-143` citation does not show the bound. `node-pty` has no such buffer: measured against 1.2.0-beta.12, 8 MiB of output arrived in 2 555 events with the largest at **18 433 bytes**, so framing one event per frame would exceed the size B40 states. `emitChunks` is therefore how the port keeps a bound the Rust got for free from its input source — not a repair of a broken contract, and not an invention. Plan 3's T8 records the disposition. Three are **new**: the 10-session cap (present in Rust, untested — `PtyManager` limit at `lib.rs:1241`), the slot freeing on exit, and `hands the host the same bytes it was given`, which pins that `write()` does not utf8-round-trip the inbound bytes (`41 ff fe 42` must reach the child intact, not as `41 ef bf bd ef bf bd 42`). The Rust's `ignores_a_foreign_channel` does not port — channel filtering lives in the data-channel router (Task 18), not the pty.

**Ruling on the two control characters, and why they are here rather than in the audit.** The `encoding: null` requirement and the `write(Buffer)` shape are **not** test-count changes dressed as fixes — they are the two halves of one defect in this task's own fences, found by running the real `node-pty` (1.2.0-beta.12) rather than reading it: with the default `encoding: 'utf8'`, `onData` delivers a **string** and `0xff` arrives already replaced by U+FFFD, so `emitChunks`'s base64 is faithfully encoding corrupted bytes; and `write(Buffer.from(bytes).toString('utf8'))` turns an inbound `41 ff fe 42` into `41 ef bf bd ef bf bd 42` at the child. ADR-10 and B40 both say the payload is bytes. Deviating either way would be silent data loss on a channel the product already ships.

---

### Task 13: The static-frame skip and the timing ring

**Files:**
- Create: `apps/agent/src/desktop/static-skip.ts`
- Create: `apps/agent/src/desktop/timing-ring.ts`
- Test: `apps/agent/test/desktop/static-skip.test.ts`, `apps/agent/test/desktop/timing-ring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RawFrame { width: number; height: number; rgba: Uint8Array; seq: number }`
  - `function frameSignature(frame: RawFrame): bigint`
  - `class StaticFrameSkip { constructor(fps: number); shouldSkip(frame): boolean; reset(): void }`
  - `function statsDueWhileSkipping(lastAtMs: number, nowMs: number): boolean`
  - `class FrameTimingRing { constructor(capacity: number); record(...): void; medians(): { captureMsP50: number; encodeMsP50: number } | null; orderedSamples(): FrameSample[] }`

- [ ] **Step 1: Write the failing static-skip test**

```ts
// apps/agent/test/desktop/static-skip.test.ts
import { describe, expect, it } from 'vitest';
import {
  StaticFrameSkip,
  frameSignature,
  statsDueWhileSkipping,
} from '../../src/desktop/static-skip.js';

function frame(width: number, height: number, fill: number, seq = 0) {
  return { width, height, rgba: new Uint8Array(width * height * 4).fill(fill), seq };
}

describe('frameSignature', () => {
  it('is equal for identical pixels with a different seq', () => {
    expect(frameSignature(frame(4, 4, 9, 0))).toBe(frameSignature(frame(4, 4, 9, 1)));
  });

  it('distinguishes geometry even with identical pixels', () => {
    expect(frameSignature(frame(4, 4, 9))).not.toBe(frameSignature(frame(8, 2, 9)));
  });

  it('detects a single changed byte', () => {
    const a = frame(4, 4, 9);
    const b = frame(4, 4, 9);
    b.rgba[7] = 10;
    expect(frameSignature(a)).not.toBe(frameSignature(b));
  });

  it('folds the trailing bytes when the length is not a multiple of 8', () => {
    // 3x1 RGBA = 12 bytes: one 8-byte word plus a 4-byte tail. A hashing scheme
    // that ignored the tail would call these identical.
    const a = { width: 3, height: 1, rgba: new Uint8Array(12), seq: 0 };
    const b = { width: 3, height: 1, rgba: new Uint8Array(12), seq: 0 };
    b.rgba[11] = 1;
    expect(frameSignature(a)).not.toBe(frameSignature(b));
  });
});

describe('StaticFrameSkip', () => {
  it('lets a changed frame through', () => {
    const skip = new StaticFrameSkip(30);
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false);
    expect(skip.shouldSkip(frame(4, 4, 2))).toBe(false);
  });

  it('skips repeats up to fps then forces one encode', () => {
    const skip = new StaticFrameSkip(30);
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false); // baseline
    const decisions: boolean[] = [];
    for (let i = 0; i < 32; i += 1) decisions.push(skip.shouldSkip(frame(4, 4, 1)));
    // 30 skips, then the 31st repeat is forced through, then skips resume.
    expect(decisions.slice(0, 30).every(Boolean)).toBe(true);
    expect(decisions[30]).toBe(false);
    expect(decisions[31]).toBe(true);
  });

  it('keeps the keepalive a FRAME count, not a wall clock', () => {
    // The cap is `round(fps)`, evaluated only on skipped frames. A stream that
    // stalls never advances the counter, which is exactly the Rust behaviour
    // and is why "1 s" is a consequence rather than the rule.
    const slow = new StaticFrameSkip(1);
    slow.shouldSkip(frame(4, 4, 1));
    expect(slow.shouldSkip(frame(4, 4, 1))).toBe(false);
  });

  it('reset forces the next frame through', () => {
    const skip = new StaticFrameSkip(30);
    skip.shouldSkip(frame(4, 4, 1));
    for (let i = 0; i < 5; i += 1) skip.shouldSkip(frame(4, 4, 1));
    skip.reset();
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false);
  });

  it('rounds a fractional fps and never yields a cap of zero', () => {
    const skip = new StaticFrameSkip(0.4);
    skip.shouldSkip(frame(4, 4, 1));
    expect(skip.shouldSkip(frame(4, 4, 1))).toBe(false);
  });
});

describe('statsDueWhileSkipping', () => {
  it('fires once per second', () => {
    expect(statsDueWhileSkipping(0, 999)).toBe(false);
    expect(statsDueWhileSkipping(0, 1000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `static-skip.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/static-skip.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/static-skip.ts
export interface RawFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
  seq: number;
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * A 64-bit FNV-1a hash over the pixel buffer and geometry — a faithful port of
 * the Rust's **single-accumulator** loop.
 *
 * The Rust's doc comment calls this "4-lane"; the code is one lane (there is a
 * single `hash` variable and no lane combining anywhere). The comment is
 * recorded as wrong rather than reproduced: writing a comment that claims four
 * lanes over a one-lane loop is exactly the kind of stale claim that made this
 * port necessary.
 *
 * Three details decide whether a port behaves the same:
 *
 * - **8-byte words, native endianness.** The Rust used `u64::from_ne_bytes`, so
 *   the machine's byte order is part of the hash. Node reads little-endian on
 *   every platform the agent ships on; matching that is what keeps skip
 *   behaviour identical, and a mismatch would only cost an extra encode.
 * - **The tail is folded one byte at a time**, not zero-padded into a word.
 * - **Geometry is XORed, not multiplied**: `(width << 32) | height`.
 *
 * `seq` is deliberately excluded: a repeated *pixel buffer* with a new sequence
 * number is still identical, and hashing the seq would defeat the whole skip.
 */
export function frameSignature(frame: RawFrame): bigint {
  let hash = FNV_OFFSET_BASIS;
  const bytes = frame.rgba;
  const words = Math.floor(bytes.length / 8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words; i += 1) {
    hash ^= view.getBigUint64(i * 8, true);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  for (let i = words * 8; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  hash ^= (BigInt(frame.width) << 32n) | BigInt(frame.height);
  return hash & MASK64;
}

/**
 * The static-frame skip (B22).
 *
 * The keepalive is a **frame count** of `round(fps)`, not a wall-clock second.
 * The Rust's comment said "one second of frames" and the code said
 * `(fps.round()).max(1)`; the code is right and the comment described the common
 * case. Counting frames matters because the loop only ticks when the capture
 * source produces a frame — a stalled source would never reach a wall-clock
 * deadline either, and a counting cap forces an encode exactly `fps` skips after
 * the last real one.
 *
 * The forced-through frame becomes the new reference, because `last` is assigned
 * before the decision. That is what keeps a long static screen from alternating
 * between two hashes.
 */
export class StaticFrameSkip {
  private readonly maxConsecutiveSkips: number;
  private last: bigint | null = null;
  private consecutiveSkips = 0;

  constructor(fps: number) {
    this.maxConsecutiveSkips = Math.max(1, Math.round(fps));
  }

  shouldSkip(frame: RawFrame): boolean {
    const signature = frameSignature(frame);
    const identical = this.last === signature;
    this.last = signature;
    if (!identical) {
      this.consecutiveSkips = 0;
      return false;
    }
    if (this.consecutiveSkips >= this.maxConsecutiveSkips) {
      this.consecutiveSkips = 0;
      return false;
    }
    this.consecutiveSkips += 1;
    return true;
  }

  reset(): void {
    this.last = null;
    this.consecutiveSkips = 0;
  }
}

export function statsDueWhileSkipping(lastStatsAtMs: number, nowMs: number): boolean {
  return nowMs - lastStatsAtMs >= 1000;
}
```

- [ ] **Step 3: Write the failing timing-ring test**

```ts
// apps/agent/test/desktop/timing-ring.test.ts
import { describe, expect, it } from 'vitest';
import { FrameTimingRing } from '../../src/desktop/timing-ring.js';

describe('FrameTimingRing', () => {
  it('reports no medians for an empty ring', () => {
    expect(new FrameTimingRing(32).medians()).toBeNull();
  });

  it('takes the middle value for an odd count', () => {
    const ring = new FrameTimingRing(32);
    for (const ms of [5, 1, 3]) ring.record(ms, 0, ms, 0);
    expect(ring.medians()?.encodeMsP50).toBe(3);
  });

  it('averages the two middle values for an even count', () => {
    const ring = new FrameTimingRing(32);
    for (const ms of [1, 2, 3, 4]) ring.record(ms, 0, ms, 0);
    expect(ring.medians()?.encodeMsP50).toBe(2.5);
  });

  it('keeps only the last `capacity` samples', () => {
    const ring = new FrameTimingRing(4);
    for (let i = 1; i <= 10; i += 1) ring.record(i, 0, i, 0);
    expect(ring.orderedSamples().map((s) => s.seq)).toEqual([7, 8, 9, 10]);
  });

  it('returns wrapped samples oldest to newest, not in slot order', () => {
    const ring = new FrameTimingRing(3);
    for (let i = 1; i <= 5; i += 1) ring.record(i, i * 1000, 1, 1);
    const seqs = ring.orderedSamples().map((s) => s.seq);
    expect(seqs).toEqual([3, 4, 5]);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('carries the camelCase wire fields', () => {
    const ring = new FrameTimingRing(1);
    ring.record(42, 1_700_000_000_000, 7, 3);
    expect(JSON.parse(JSON.stringify(ring.orderedSamples()))[0]).toEqual({
      seq: 42,
      captureEpochMs: 1_700_000_000_000,
      encodeMs: 7,
    });
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement `timing-ring.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/timing-ring.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/timing-ring.ts
export interface FrameSample {
  seq: number;
  captureEpochMs: number;
  encodeMs: number;
}

/**
 * The last N encoded frames' timing (B24).
 *
 * Both medians are **telemetry only**: they reach the wire as `captureMsP50` /
 * `encodeMsP50` and never feed the sustain ladder, which reads the single
 * frame's `encode_time`. A port that fed the median to the ladder would
 * downgrade far more slowly, because a median smooths over exactly the stalls
 * the ladder exists to catch.
 *
 * `orderedSamples` matters for the wire: the ring's internal storage is
 * circular, so `slice(0, len)` returns slot order once it has wrapped. The
 * browser plots `captureEpochMs` and expects monotonicity, so the samples are
 * concatenated from the head.
 */
export class FrameTimingRing {
  private readonly samples: FrameSample[] = [];
  private readonly captureMs: number[] = [];
  private head = 0;

  constructor(private readonly capacity: number) {}

  record(seq: number, captureEpochMs: number, encodeMs: number, captureMs: number): void {
    const sample: FrameSample = { seq, captureEpochMs, encodeMs };
    if (this.samples.length < this.capacity) {
      this.samples.push(sample);
      this.captureMs.push(captureMs);
      return;
    }
    this.samples[this.head] = sample;
    this.captureMs[this.head] = captureMs;
    this.head = (this.head + 1) % this.capacity;
  }

  medians(): { captureMsP50: number; encodeMsP50: number } | null {
    if (this.samples.length === 0) return null;
    return {
      captureMsP50: median(this.captureMs),
      encodeMsP50: median(this.samples.map((s) => s.encodeMs)),
    };
  }

  orderedSamples(): FrameSample[] {
    if (this.samples.length < this.capacity) return [...this.samples];
    return [...this.samples.slice(this.head), ...this.samples.slice(0, this.head)];
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
```

- [ ] **Step 5: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/desktop/static-skip.test.ts test/desktop/timing-ring.test.ts
./node_modules/.bin/prettier --write apps/agent/src/desktop/{static-skip,timing-ring}.ts apps/agent/test/desktop/{static-skip,timing-ring}.test.ts
git add apps/agent/src/desktop apps/agent/test/desktop
git commit -m "feat(agent): add the static-frame skip and the frame timing ring"
```

**TEST-INTEGRITY declaration:** two new files, **16 new `it()` / 22 new `expect()`**. Ports `static_frame_skip_detects_identical_pixels`, `…lets_a_changed_frame_through`, `…detects_a_single_pixel_change`, `…respects_the_one_second_keepalive`, `…reset_forces_the_next_frame_through`, `frame_signature_distinguishes_dimensions`, `stats_due_while_skipping_fires_once_per_second`, `test_frame_timing_ring_p50_calculation`, `test_frame_timing_ring_capture_ms_p50_median`, `timing_snapshot_is_none_for_an_empty_ring`, `ordered_samples_are_strictly_monotonic_when_wrapped`. **New:** the trailing-byte fold (the Rust test never exercised the `len % 8` path) and the fractional-fps cap.

---

### Task 14: Offer identity proof verification

**Files:**
- Create: `apps/agent/src/session/identity-proof.ts`
- Test: `apps/agent/test/session/identity-proof.test.ts`

**Interfaces:**
- Consumes: `normalizeFingerprint` and `parseSdpFingerprint` from `@ponter/shared` (**reuse, not port** — D-per-P3 §4: the TS already normalises the full `a=fingerprint:` line, where the Rust splits it across two functions), `canonicalProofMessage` for the message string, and `type SignalMessage` for the offer shape it validates — narrowed to the `offer` arm rather than re-declared, so a drift in the shared union is a `tsc` error here. **`@ponter/shared` has no verifier** — it exports the message builder only, and both peers build the string themselves. Signature verification is `node:crypto`'s, wrapped in this module, over the **raw 32-byte** key the offer carries: `createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })` over the raw bytes, then `verify(null, message, key, signature)`. **Not** `{ format: 'der', type: 'spki' }` — that shape is 44 bytes and the wire value is 32, so an SPKI import throws `Failed to read asymmetric key` on every genuine offer and the module's own `catch` would report it as `BAD_SIGNATURE`. The OKP-JWK form is chosen over `webcrypto.subtle.importKey('raw', …)` for one reason: the latter is async and would re-type `verifyOfferIdentity`, which the Rust has sync (`verify_offer_identity -> Result<()>`, `lib.rs:989`; `verify_proof` over `UnparsedPublicKey`, `identity.rs:105`). Measured both ways in `.superpowers/probes/t14-ba-repair/`.
- Produces:
  - `type OfferMessage = Extract<SignalMessage, { type: 'offer' }>` — the local name for the arm this module validates. **Defined here, not imported**: the plan has no `OfferMessage` anywhere else, and `@ponter/shared` does not export one (its type is `SignalOffer`, carried inside `SignalMessage`'s offer arm at `packages/shared/src/types/signaling.ts:44`). An earlier draft imported it from `./messages.js`, a module this plan never creates — `src/session/messages.ts` does not exist, and `vitest` erases `import type` so the fence stayed green over it. Task 4's `signalling/messages.ts` is a different directory and does not re-export that name either.
  - `class OfferIdentityError extends Error { code: 'NO_PROOF' | 'NO_SIGNING_KEY' | 'MALFORMED_FINGERPRINT' | 'FINGERPRINT_MISMATCH' | 'BAD_SIGNATURE' }`
  - `function verifyOfferIdentity(offer: OfferMessage, sessionId: string): void`
  - `function advertisesE2ee(offer: OfferMessage): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/session/identity-proof.test.ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalProofMessage } from '@ponter/shared';
import { describe, expect, it } from 'vitest';
import { advertisesE2ee, verifyOfferIdentity } from '../../src/session/identity-proof.js';

const SESSION = 'sess-abc';
const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  `a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89`,
  '',
].join('\r\n');
const FINGERPRINT = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const SDP_SHA256 = createHash('sha256').update(SDP, 'utf8').digest('hex');

function keypair() {
  // The wire form is the browser's `publicKeyRawBase64` — **raw 32 bytes**
  // (`apps/web/src/stores/auth.ts:226,296`, set from `exportSigningPublicKeyRaw`,
  // `packages/crypto/src/index.ts:307`), relayed verbatim by the server
  // (`apps/server/src/routes/signal.ts:106-117`) and decoded into `[u8; 32]` by
  // the Rust (`apps/agent/src/lib.rs:1250-1258`). Deriving it the SPKI way
  // (`export({ type: 'spki', format: 'der' })`, 44 bytes) is what made this
  // fence certify its own bug: it exercised a shape no peer ever sends.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return {
    privateKey,
    userSigningPublicKey: raw.toString('base64'),
  };
}

function offerWith(overrides: Record<string, unknown> = {}) {
  const { privateKey, userSigningPublicKey } = keypair();
  const message = canonicalProofMessage({
    role: 'offerer',
    sessionId: SESSION,
    sdpSha256Hex: SDP_SHA256,
    fingerprint: FINGERPRINT,
  });
  const signature = sign(null, Buffer.from(message), privateKey).toString('base64');
  return {
    type: 'offer',
    data: {
      sdp: SDP,
      userSigningPublicKey,
      proof: { fingerprint: FINGERPRINT, signature },
      capabilities: ['e2ee'],
      ...overrides,
    },
  } as never;
}

describe('verifyOfferIdentity', () => {
  it('accepts a correctly signed offer', () => {
    expect(() => verifyOfferIdentity(offerWith(), SESSION)).not.toThrow();
  });

  it('refuses an offer carrying no proof', () => {
    expect(() => verifyOfferIdentity(offerWith({ proof: undefined }), SESSION)).toThrow(
      /carries no identity proof/,
    );
  });

  it('refuses an offer carrying no user signing key', () => {
    expect(() =>
      verifyOfferIdentity(offerWith({ userSigningPublicKey: undefined }), SESSION),
    ).toThrow(/carries no user signing key/);
  });

  it('refuses a malformed SDP fingerprint before touching the proof', () => {
    const offer = offerWith({ sdp: 'v=0\r\na=fingerprint:nonsense\r\n' }) as never;
    expect(() => verifyOfferIdentity(offer, SESSION)).toThrow(/fingerprint/);
  });

  it('refuses a proof fingerprint that disagrees with the SDP', () => {
    const other = FINGERPRINT.replace('AB', 'AF');
    const offer = offerWith({ proof: { fingerprint: other, signature: 'AA==' } }) as never;
    expect(() => verifyOfferIdentity(offer, SESSION)).toThrow(/does not match/);
  });

  it('refuses a signature over a different session id', () => {
    expect(() => verifyOfferIdentity(offerWith(), 'sess-other')).toThrow(/signature/i);
  });

  it('refuses a tampered SDP', () => {
    const offer = offerWith() as never as { data: { sdp: string } };
    offer.data.sdp = SDP.replace('v=0', 'v=1');
    expect(() => verifyOfferIdentity(offer as never, SESSION)).toThrow(/signature/i);
  });

  it('distinguishes the mismatch code from the bad-signature code', () => {
    // Callers need to tell them apart: a fingerprint mismatch is a client bug,
    // a bad signature is either a stale key or an attacker. One error message
    // for both sends the user to the wrong fix.
    const mismatch = (() => {
      try {
        verifyOfferIdentity(
          offerWith({ proof: { fingerprint: FINGERPRINT.replace('AB', 'AF'), signature: 'AA==' } }) as never,
          SESSION,
        );
        return 'OK';
      } catch (error) {
        return (error as { code: string }).code;
      }
    })();
    expect(mismatch).toBe('FINGERPRINT_MISMATCH');
  });
});

describe('advertisesE2ee', () => {
  it('is true when the offer proposed e2ee', () => {
    expect(advertisesE2ee(offerWith())).toBe(true);
  });

  it('is false when the offer did not', () => {
    expect(advertisesE2ee(offerWith({ capabilities: [] }))).toBe(false);
  });

  it('does not treat an absent capability list as consent', () => {
    expect(advertisesE2ee(offerWith({ capabilities: undefined }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/session/identity-proof.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/session/identity-proof.ts
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalProofMessage, parseSdpFingerprint, type SignalMessage } from '@ponter/shared';

/**
 * The arm of the shared signal union this module validates. Defined by
 * narrowing — `verbatimModuleSyntax` keeps the type import erased, and a change
 * to the shared `offer` shape becomes a `tsc` error here rather than a silent
 * widening. There is no `OfferMessage` in `@ponter/shared` and none in this
 * plan's Task 4 `signalling/messages.ts`; the name is local by design.
 */
export type OfferMessage = Extract<SignalMessage, { type: 'offer' }>;

export type OfferIdentityFailure =
  | 'NO_PROOF'
  | 'NO_SIGNING_KEY'
  | 'MALFORMED_FINGERPRINT'
  | 'FINGERPRINT_MISMATCH'
  | 'BAD_SIGNATURE';

export class OfferIdentityError extends Error {
  constructor(
    readonly code: OfferIdentityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OfferIdentityError';
  }
}

/**
 * Verifies who sent an offer (B8), in the Rust's five ordered steps.
 *
 * **The agent's own identity is not an input.** `verify_offer_identity` took one
 * and never read it (`_identity`): an agent cannot know a user's key in advance,
 * so the signature is checked against the key the offer carries. The parameter
 * is dropped rather than ported as an unused argument.
 *
 * That the key is carried *in the offer* means this proves **possession of the
 * private key matching the claimed public key**, and that the claim is bound to
 * this SDP and this session. Establishing that the key belongs to the account is
 * WS2's job (`resolvePeerIdentity`, and the TOFU store the web client keeps) —
 * not this function's, and not something to imply by naming.
 *
 * Order matters for the error the caller sees: a malformed SDP fingerprint fails
 * before any signature work, so a client with a broken SDP gets "fingerprint"
 * rather than "signature".
 */
export function verifyOfferIdentity(offer: OfferMessage, sessionId: string): void {
  const data = offer.data as {
    sdp?: string;
    userSigningPublicKey?: string;
    proof?: { fingerprint?: string; signature?: string };
  };
  if (!data.proof) {
    throw new OfferIdentityError('NO_PROOF', 'offer carries no identity proof');
  }
  if (!data.userSigningPublicKey) {
    throw new OfferIdentityError('NO_SIGNING_KEY', 'offer carries no user signing key');
  }
  if (typeof data.sdp !== 'string') {
    throw new OfferIdentityError('MALFORMED_FINGERPRINT', 'offer carries no SDP');
  }
  const sdpFingerprint = parseSdpFingerprint(data.sdp);
  const proofFingerprint = data.proof.fingerprint;
  if (typeof proofFingerprint !== 'string' || proofFingerprint !== sdpFingerprint) {
    throw new OfferIdentityError(
      'FINGERPRINT_MISMATCH',
      'the proof fingerprint does not match the SDP fingerprint',
    );
  }
  const message = canonicalProofMessage({
    role: 'offerer',
    sessionId,
    sdpSha256Hex: createHash('sha256').update(data.sdp, 'utf8').digest('hex'),
    fingerprint: sdpFingerprint,
  });
  const ok = verifyMessage(data.userSigningPublicKey, data.proof.signature ?? '', message);
  if (!ok) {
    throw new OfferIdentityError('BAD_SIGNATURE', 'the offer identity signature is invalid');
  }
}

/**
 * Ed25519 verify over a base64 **raw 32-byte** public key and a base64 signature.
 *
 * `data.userSigningPublicKey` is the browser's `publicKeyRawBase64`
 * (`apps/web/src/stores/auth.ts:226,296`), relayed verbatim by the server
 * (`apps/server/src/routes/signal.ts:106-117`) and decoded into `[u8; 32]` by the
 * Rust (`apps/agent/src/lib.rs:1250-1258`). It is **not** SPKI DER: an SPKI key is
 * 44 bytes, and `createPublicKey({ format: 'der', type: 'spki' })` over 32 raw
 * bytes throws `Failed to read asymmetric key` — which the `catch` below would
 * turn into `BAD_SIGNATURE`, rejecting every genuine offer.
 *
 * Stays **synchronous** so `verifyOfferIdentity` stays a sync function, matching
 * the Rust (`verify_offer_identity -> Result<()>`, `lib.rs:989`): `createPublicKey`
 * accepts an OKP JWK whose `x` is exactly the raw key in base64url. The 32-byte
 * length check is explicit because a 44-byte SPKI value would otherwise reach the
 * JWK path and fail there with a less legible error.
 *
 * `@ponter/shared` exports the **message builder**, not a verifier — it is
 * platform-neutral and both peers build the string themselves. Verification is
 * `node:crypto`'s, wrapped here because `crypto.verify` throws on a malformed key
 * and a hostile offer is exactly where that would happen. **A throw is a failed
 * signature**, never an escaping exception.
 */
function verifyMessage(
  publicKeyRawBase64: string,
  signatureBase64: string,
  message: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyRawBase64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * B55: the answer advertises E2EE **iff** the offer proposed it. An offer that
 * omits `capabilities` is not consent — advertising anyway would let a peer that
 * never asked for encryption be told it is getting some.
 */
export function advertisesE2ee(offer: OfferMessage): boolean {
  const capabilities = (offer.data as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && capabilities.includes('e2ee');
}
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/session/identity-proof.test.ts
./node_modules/.bin/tsc --noEmit -p apps/agent/tsconfig.json
./node_modules/.bin/prettier --write apps/agent/src/session/identity-proof.ts apps/agent/test/session/identity-proof.test.ts
git add apps/agent/src/session apps/agent/test/session
git commit -m "feat(agent): verify the offer identity proof before answering"
```

`tsc` is **not** redundant with `vitest` here and its absence is why this task shipped a
fence that did not compile. `vitest` transpiles without typechecking: it erases every
`import type` at run time, so an unresolvable type import runs green. This task's earlier
draft imported `OfferMessage` from `./messages.js` — a module the plan never creates —
and stayed 11/11 because nothing ever typechecked it. The fence axis is four-way (runs /
counts / **typechecks** / non-vacuous control); this line is the third. `apps/agent` is
excluded from CI's typecheck jobs, so a missing `tsc` here is not caught later either.

**TEST-INTEGRITY declaration:** one new file, **11 new `it()` / 11 new `expect()`**. Ports `verify_offer_identity`'s five failure modes as five tests plus the happy path, `carries_an_identity_proof`, `proof_is_optional_for_backward_shapes` and `parses_and_normalizes_sdp_fingerprint`'s assertion (as a *consumer* of `@ponter/shared`, per B9's reuse ruling — the normalisation itself is already tested there and is not duplicated). **New:** the code-level distinction between `FINGERPRINT_MISMATCH` and `BAD_SIGNATURE` (the Rust had one error type and lost that distinction at the boundary), and the `advertisesE2ee` absent-capabilities case.

The raw-32 repair (fixture key shape, `verifyMessage`'s import path, and the Interfaces prescription) is **count-neutral by construction**: **11 / 11 before → 11 / 11 after, zero assertions added, removed, moved or rewritten**. No test name, no `expect()` line and no assertion kind changed — `keypair()` returns a different *shape* under the same property name, and `verifyMessage` imports that shape. Measured four ways on the extracted fence in `.superpowers/probes/t14-ba-repair/`: 11/11 vitest green, `tsc` exit 0, counts 11/11 by anchor regex, and the **must-error control** — the repaired fence run against the pre-repair SPKI implementation — goes **red on the happy path** (`expected [Function] to not throw an error but 'OfferIdentityError: the offer identity signature is invalid' was thrown`), 1 failed / 10 passed. That last axis is what makes the count meaningful: a count-preserving repair that the old bug still passes would have been a no-op.

The `OfferMessage` repair (import line, the `offer`-arm narrowing, and the `tsc` gate) is **also count-neutral**: **11 / 11 before → 11 / 11 after**, measured on the same extracted fence with **no stub module supplied** — the earlier measurements at `.superpowers/probes/t14-ba-repair/fence/` passed only because that probe created a `messages.ts` the plan does not define, which is why it could not see this defect. Re-measured without one: `tsc -p tsconfig.json` exit 0 and vitest 11/11, and the **positive control** — the same invocation over the pre-repair import — exits 2 with `TS2307: Cannot find module './messages.js'`. Zero test names, zero `expect()` lines, zero assertion kinds moved. Evidence: `.superpowers/probes/t14-ba-repair/no-stub/`.

---

### Task 15: Input decode, clamp and rate limit

**Files:**
- Create: `apps/agent/src/input/decode.ts`
- Test: `apps/agent/test/input/decode.test.ts`

**Interfaces:**
- Consumes: `AGENT_ALLOW_INPUT` via Task 1's config.
- Produces:
  - `const INPUT_RATE_LIMIT_HZ = 120`
  - `type InputEvent` — the wire union, mirroring `DesktopInput` (`@ponter/shared`, `desktop.ts:68-87`): five `kind`s, **normalized** pointer coordinates, `seq?` on the three pointer kinds.
  - `interface InputSource` — `{ x, y, width, height }`, the rect `desktop-sources` publishes (`DesktopSourceInfo`, `desktop.ts:11-27`).
  - `interface InputInjector` — the port of the Rust's `InputInjector` trait (`input.rs:62-68`): `pointerMove`, `pointerButton`, `wheel`, `key`, `text`.
  - `function clamp01(value: number): number`
  - `function decodeInput(bytes: ArrayBuffer | Uint8Array): InputEvent | null`
  - `function toAbsolute(nx: number, ny: number, source: InputSource): { x: number; y: number }`
  - `function applyInput(event: InputEvent, source: InputSource, injector: InputInjector, now: number): number | null` — the port of `apply_if_allowed`; returns the applied event's `seq ?? null`.
  - `function bindInputApply(deps): (event: InputEvent, now: number) => number | null` — the shape Task 18's `deps.input.apply` asks for, with the live source rect and injector bound at construction.
  - `class InputLimiter { constructor(allow: boolean); admit(now: number): boolean; dropped(): number }` — the port of `InputRateLimiter::allow` (`input.rs:141-152`); the window is `floor(now / 1000)`, and a closed gate refuses **without** any rate accounting. `dropped()` is a declared agent-side addition (the Rust has no counter) and counts rate-limit refusals only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/input/decode.test.ts
import { describe, expect, it, vi } from 'vitest';
import { InputLimiter, applyInput, bindInputApply, clamp01, decodeInput, toAbsolute } from '../../src/input/decode.js';
import type { InputEvent, InputInjector, InputSource } from '../../src/input/decode.js';

/**
 * Fixtures carry the `DataChannelMessage` envelope
 * (`packages/webrtc-core/src/data-channel.ts:74-88`), exactly as the browser sends
 * via `sendJson('control', 'desktop-input', event)`.
 */
const frame = (payload: unknown, channel = 'control', type = 'desktop-input') =>
  new TextEncoder().encode(JSON.stringify({ channel, type, payload, timestamp: 0 }));

/** A counting double, the Rust test's `CountingInjector` (`input.rs:756-770`). */
function double(fail?: keyof InputInjector): InputInjector & { calls: string[] } {
  const calls: string[] = [];
  const ok = (name: string) => () => {
    calls.push(name);
    if (name === fail) throw new Error('injected failure');
  };
  return {
    calls,
    pointerMove: ok('pointerMove'),
    pointerButton: ok('pointerButton'),
    wheel: ok('wheel'),
    key: ok('key'),
    text: ok('text'),
  };
}

/** The 1080p monitor rect `desktop-sources` publishes (`DesktopSourceInfo.x/y`). */
const source: InputSource = { x: 100, y: 50, width: 1920, height: 1080 };

/**
 * Fixtures are the payload `sendControl('desktop-input', event)` sends
 * (`desktop-core/src/client.ts:452,467`): the `kind`-tagged `DesktopInput`
 * itself, never a `type`-tagged flat frame.
 */
describe('clamp01', () => {
  it('clamps into [0,1]', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('maps NaN to 0 rather than propagating it', () => {
    // Rust's f64::clamp panics on NaN and the agent used `clamp` inside a
    // `catch_unwind`; JS `Math.min/max` propagate NaN, which would reach the
    // injector. Both are handled here by one explicit rule.
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('keeps the endpoints', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('decodeInput', () => {
  it('decodes pointer-move with normalized coordinates', () => {
    expect(decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.25 }))).toEqual({
      kind: 'pointer-move',
      x: 0.5,
      y: 0.25,
    });
  });

  it('carries the browser-assigned seq through untouched', () => {
    // The decoder decodes; it does not own seq. `applyInput` echoes it back
    // (ADR-47), so it must arrive here intact.
    expect(decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 42 }))).toEqual({
      kind: 'pointer-move',
      x: 0.5,
      y: 0.5,
      seq: 42,
    });
    // And it is absent when the wire omitted it — `Key`/`Text` never carry one.
    expect(decodeInput(frame({ kind: 'wheel', dx: 1, dy: -1, x: 0.5, y: 0.5 }))).toEqual({
      kind: 'wheel',
      dx: 1,
      dy: -1,
      x: 0.5,
      y: 0.5,
    });
  });

  it('decodes pointer-button with pressed as a boolean, not a kind split', () => {
    expect(decodeInput(frame({ kind: 'pointer-button', button: 'left', pressed: true, x: 0.1, y: 0.1 }))).toEqual({
      kind: 'pointer-button',
      button: 'left',
      pressed: true,
      x: 0.1,
      y: 0.1,
    });
    expect(decodeInput(frame({ kind: 'pointer-button', button: 'right', pressed: false, x: 0, y: 0 }))).toEqual({
      kind: 'pointer-button',
      button: 'right',
      pressed: false,
      x: 0,
      y: 0,
    });
  });

  it('decodes wheel with the real dx/dy fields', () => {
    // `deltaX`/`deltaY` are the plan's invention; the wire is `dx`/`dy`
    // (`desktop.ts:78-85`, `input.rs:90-97`).
    expect(decodeInput(frame({ kind: 'wheel', dx: -1, dy: 3, x: 0.5, y: 0.5 }))).toEqual({
      kind: 'wheel',
      dx: -1,
      dy: 3,
      x: 0.5,
      y: 0.5,
    });
  });

  it('decodes key with code, pressed and modifiers — no key name, no down/up kind', () => {
    expect(
      decodeInput(frame({ kind: 'key', code: 'KeyA', pressed: true, modifiers: { ctrl: true, alt: false, shift: false, meta: false } })),
    ).toEqual({
      kind: 'key',
      code: 'KeyA',
      pressed: true,
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
    });
  });

  it('decodes the text kind the earlier draft lacked entirely', () => {
    // Multi-byte on purpose: the `text` kind carries a JS string through
    // `TextDecoder`, and a fixture with only ASCII would not catch a decoder
    // that dropped or mangled continuation bytes.
    const multiByte = '\u65e5\u672c\u8a9e'; // 3 chars, 9 UTF-8 bytes
    expect(decodeInput(frame({ kind: 'text', text: multiByte }))).toEqual({ kind: 'text', text: multiByte });
  });

  it('returns null for an unknown kind instead of throwing', () => {
    expect(decodeInput(frame({ kind: 'hover' }))).toBeNull();
    expect(decodeInput(frame({ type: 'something-else' }))).toBeNull();
  });

  it('rejects a crypted `{ data }` payload deterministically, not accidentally', () => {
    // When the desktop E2EE session is armed, the browser sends the payload
    // `{ data: <base64> }` (`desktop-core/src/client.ts:484-494`). A crypted
    // frame must not half-parse as an event: the fields it does carry
    // (`data`) match nothing, and the drop is a `null` either way — but the
    // test pins that it stays a null after the shape settles, so the
    // decrypt-before-decode owner (the follow-up register) cannot be
    // replaced by a silent partial decode.
    expect(decodeInput(frame({ data: 'AQID' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(decodeInput(new TextEncoder().encode('{not json'))).toBeNull();
  });

  it('returns null for an unknown mouse button', () => {
    expect(decodeInput(frame({ kind: 'pointer-button', button: 'thumb', pressed: true, x: 0, y: 0 }))).toBeNull();
  });

  it('does not validate geometry at decode — that moved to applyInput', () => {
    // The Rust decodes at `input.rs:180-245` with no rect in sight; the rect
    // enters at the application site (`apply_if_allowed`, `input.rs:267`).
    // A zero/absent rect is `applyInput`'s concern.
    expect(decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5 }))).not.toBeNull();
  });

  it('rejects a payload-level frame lacking the envelope wrapper (must-fail control)', () => {
    // Port fidelity: the wire contract is the DataChannelMessage envelope, exactly as
    // `decode_desktop_input` (`input.rs:180-198`) expects. A bare payload frame must
    // fail decode deterministically so the router-decoder seam cannot silently drift.
    const flatPayload = new TextEncoder().encode(JSON.stringify({ kind: 'pointer-move', x: 0.5, y: 0.5 }));
    expect(decodeInput(flatPayload)).toBeNull();
  });

  it('rejects an envelope with wrong channel or wrong type', () => {
    expect(decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5 }, 'terminal', 'desktop-input'))).toBeNull();
    expect(decodeInput(frame({ kind: 'pointer-move', x: 0.5, y: 0.5 }, 'control', 'desktop-select'))).toBeNull();
  });
});

describe('toAbsolute', () => {
  const source: InputSource = { x: 100, y: 50, width: 1920, height: 1080 };

  it('maps the endpoints to source.x + round(n * width) — x + width, NOT width-1', () => {
    // `input.rs:745-751` pins this exactly: `to_absolute(0.0,0.0)` is the
    // origin and `to_absolute(1.0,1.0)` is `x + width / y + height`. The
    // earlier draft clamped to `extent - 1` and justified it with a comment
    // that misquoted both the Rust (which does not clamp to width-1) and the
    // injector (which clamps to [0, display_width] at
    // `portal/injector.rs:37-42` — it never refuses).
    expect(toAbsolute(0, 0, source)).toEqual({ x: 100, y: 50 });
    expect(toAbsolute(1, 1, source)).toEqual({ x: 100 + 1920, y: 50 + 1080 });
  });

  it('maps a mid-frame point with the nonzero origin the Rust test pins', () => {
    // `input.rs:745-751`: source.x=100, width=1920 -> 0.5 lands at 1060.
    expect(toAbsolute(0.5, 0.5, source)).toEqual({ x: 100 + 960, y: 50 + 540 });
  });
});

describe('applyInput', () => {
  it('maps through the source rect and injects a pointer move', () => {
    const injector = double();
    const seq = applyInput({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 7 }, source, injector, 0);
    expect(injector.calls).toEqual(['pointerMove']);
    expect(seq).toBe(7);
  });

  it('moves before button/wheel so the click lands on the intended point', () => {
    // The Rust's `apply_if_allowed` does `pointer_move` then
    // `pointer_button`/`wheel` for the anchored kinds (`input.rs:291-308`).
    const injector = double();
    applyInput({ kind: 'pointer-button', button: 'left', pressed: true, x: 0.1, y: 0.1, seq: 9 }, source, injector, 0);
    expect(injector.calls).toEqual(['pointerMove', 'pointerButton']);
    applyInput({ kind: 'wheel', dx: 1, dy: 0, x: 0.1, y: 0.1 }, source, injector, 0);
    expect(injector.calls).toEqual(['pointerMove', 'pointerButton', 'pointerMove', 'wheel']);
  });

  it('injects key and text with no move and no seq', () => {
    const injector = double();
    expect(applyInput({ kind: 'key', code: 'KeyA', pressed: true, modifiers: { ctrl: false, alt: false, shift: false, meta: false } }, source, injector, 0)).toBeNull();
    expect(injector.calls).toEqual(['key']);
    expect(applyInput({ kind: 'text', text: 'x' }, source, injector, 0)).toBeNull();
    expect(injector.calls).toEqual(['key', 'text']);
  });

  it('returns null — not a throw — when the injector fails, after any partial move', () => {
    // Fail-soft (`input.rs:316-331`): an injector error drops the frame and
    // the session continues. For pointer-button the move has already happened;
    // the button is the step that fails.
    const injector = double('pointerButton');
    expect(applyInput({ kind: 'pointer-button', button: 'left', pressed: true, x: 0.1, y: 0.1, seq: 3 }, source, injector, 0)).toBeNull();
    expect(injector.calls).toEqual(['pointerMove', 'pointerButton']);
  });
});

describe('bindInputApply — the seam Task 18 consumes', () => {
  it('closes over source and injector at construction; apply takes only (event, now)', () => {
    // The router holds no geometry, so the implementation must carry it. This
    // is the Rust's `apply_if_allowed(allow_input, raw, &current_source,
    // injector, now_ms)` with the rect and injector bound at construction
    // (`input.rs:267-273`). `now` is the envelope-timestamp seam ADR-44 logs.
    const injector = double();
    const apply = bindInputApply({ allow: true, source, injector });
    const seq = apply({ kind: 'pointer-move', x: 0.5, y: 0.5, seq: 11 } as InputEvent, 1234);
    expect(seq).toBe(11);
    expect(injector.calls).toEqual(['pointerMove']);
  });

  it('drops everything when the gate is closed, and the limiter never sees the budget spent', () => {
    const injector = double();
    const apply = bindInputApply({ allow: false, source, injector });
    expect(apply({ kind: 'pointer-move', x: 0.5, y: 0.5 } as InputEvent, 1)).toBeNull();
    expect(injector.calls).toEqual([]);
  });
});

describe('InputLimiter', () => {
  it('admits everything when input is enabled and under 120 Hz', () => {
    // The fixture starts mid-window and crosses a wall-clock second (990 ms
    // steps into window 1 at the third call). Starting at t=0 — the original
    // fixture — is the single instant where a wrong window anchoring is
    // invisible, so it must not be the only phase the fence exercises.
    let now = 990;
    const limiter = new InputLimiter(true);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.admit(now)).toBe(true);
      now += 9;
    }
  });

  it('drops events beyond 120 per fixed 1-second window and counts them', () => {
    // The Rust used a FIXED window that resets every second, not a sliding one:
    // 120 events are allowed in [0,1000) and another 120 in [1000,2000),
    // regardless of how they cluster. A sliding window would smooth this and is
    // a different policy; do not "improve" it.
    const limiter = new InputLimiter(true);
    let admitted = 0;
    for (let i = 0; i < 200; i += 1) if (limiter.admit(0)) admitted += 1;
    expect(admitted).toBe(120);
    expect(limiter.dropped()).toBe(80);
    expect(limiter.admit(1000)).toBe(true);
  });

  it('admits a fresh burst at every wall-clock second, not every 1000 ms since the first call', () => {
    // The discriminating anchor fixture (measurement case C): 120 frames at
    // t=5500 fill window 5; t=6000 is window 6 — a new wall-clock second — so
    // the count resets and two more frames are admitted although only 500 ms
    // have elapsed. An elapsed-since-first-call anchoring (windowStart=5500)
    // still has a full window at t=6000 and refuses both. `floor(now/1000)` is
    // the Rust's euclidean window index (`input.rs:142`).
    const limiter = new InputLimiter(true);
    let admitted = 0;
    for (let i = 0; i < 120; i += 1) if (limiter.admit(5_500)) admitted += 1;
    expect(admitted).toBe(120);
    expect(limiter.admit(6_000)).toBe(true);
    expect(limiter.admit(6_001)).toBe(true);
  });

  it('refuses every frame when the gate is closed, and does no rate accounting', () => {
    // The Rust never consults the limiter when allow_input is false
    // (`lib.rs:2430` sits inside `if allow_input`; the else branch just logs
    // and continues, `:2471-2473`), so a refusal while disabled is not a
    // rate-limit event: nothing is counted and the window never moves. The
    // landed fence asserted the opposite twice — one test named "does not
    // count a refusal" whose assertion was `dropped() === 1` — a
    // self-contradicting pair whose two halves both passed. `dropped()` counts
    // rate-limit refusals only, and is a declared agent-side addition, not a
    // port: `InputRateLimiter` has no drop counter.
    const limiter = new InputLimiter(false);
    expect(limiter.admit(0)).toBe(false);
    expect(limiter.admit(5_000)).toBe(false);
    expect(limiter.dropped()).toBe(0);
  });

  it('admits without decoding — it takes a timestamp, not an event', () => {
    // The ordering property, at the type level: `admit(now)` cannot depend on
    // a decoded event because it never receives one. The Rust runs this cap
    // before `decode_desktop_input` (`lib.rs:2428-2434`).
    const limiter = new InputLimiter(true);
    expect(limiter.admit(0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/input/decode.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/input/decode.ts
export const INPUT_RATE_LIMIT_HZ = 120;

/**
 * One input event, **the wire's own union** (`DesktopInput`,
 * `packages/shared/src/types/desktop.ts:68-87`, mirrored by the Rust's
 * `DesktopInputWire`, `input.rs:75-107`).
 *
 * The wire frame arrives as the `DataChannelMessage` envelope
 * (`{ channel: 'control', type: 'desktop-input', payload, timestamp }`),
 * exactly as `decode_desktop_input` (`input.rs:180-198`) expects. The decoder
 * receives the raw frame bytes, verifies `channel === 'control'` and
 * `type === 'desktop-input'`, and unwraps `envelope.payload`. Inside the
 * payload, the discriminator is the `kind` tag, **kebab-case** — matching
 * serde's internally-tagged enum (`#[serde(tag = "kind", rename_all = "kebab-case")]`,
 * `input.rs:73-74`).
 *
 * Coordinates are **normalized 0..1 within the streamed source** and stay
 * that way: the Rust's decoder clamps them (`clamp01`, `input.rs:197-222`)
 * and the normalized→absolute mapping happens at the **application site**
 * with the live rect (`to_absolute`, `input.rs:247-257`, called from
 * `apply_if_allowed`). Mapping here would need a rect the decoder does not
 * have, and the previous version's guess (`extent - 1`) contradicted the
 * pinned endpoint test at `input.rs:745-751`.
 *
 * `seq` is carried through **untouched** where the wire carries it — the
 * pointer kinds only (`Key`/`Text` have none, `input.rs:98-106`). The decoder
 * does not own it; `applyInput` echoes it back for the cursor latency meter
 * (ADR-47).
 */
export type InputEvent =
  | { kind: 'pointer-move'; x: number; y: number; seq?: number }
  | {
      kind: 'pointer-button';
      button: 'left' | 'middle' | 'right';
      pressed: boolean;
      x: number;
      y: number;
      seq?: number;
    }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number; seq?: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/** The keyboard modifier state the `key` kind carries (`desktop.ts:55-60`). */
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * The capture rect the mapping needs: the `x`/`y` origin and the `width`/
 * `height` of the streamed source. This is the geometry `desktop-sources`
 * publishes (`DesktopSourceInfo`, `desktop.ts:11-27`) and the only place the
 * real wiring can get it — which is why `applyInput` takes it as a parameter
 * rather than `decodeInput` guessing one.
 */
export interface InputSource {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The platform seam, the port of the Rust's `InputInjector` trait
 * (`input.rs:62-68`). One platform implementation sits behind it; tests use a
 * counting double. Each call returns nothing and throws on failure, which is
 * the fail-soft signal `applyInput` turns into a `null`.
 */
export interface InputInjector {
  pointerMove(x: number, y: number): void;
  pointerButton(button: 'left' | 'middle' | 'right', pressed: boolean): void;
  wheel(dx: number, dy: number): void;
  key(code: string, pressed: boolean, modifiers: KeyModifiers): void;
  text(text: string): void;
}

/**
 * `Math.min(Math.max(v, 0), 1)` with NaN forced to 0.
 *
 * Written out rather than using a helper so the NaN rule is visible: `NaN`
 * compared with `>` and `<` is false on both sides, so a naive clamp silently
 * returns `NaN` and the injector receives it. Rust's `f64::clamp` *panics* on
 * NaN, which the agent turned into a dropped frame via `catch_unwind`
 * (`input.rs:155-161`); the explicit branch reproduces the drop without the
 * unwind.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Map a normalized point to absolute source pixels — the Rust's `to_absolute`
 * (`input.rs:247-257`): `abs = source.x + round(n * dimension)`.
 *
 * **`x + width`, not `width - 1`.** The pinned endpoint test
 * (`input.rs:745-751`) asserts `to_absolute(1.0, 1.0) == (source.x + 1920,
 * source.y + 1080)` for a 1920×1080 source at origin (100, 50). The earlier
 * draft clamped to `extent - 1` and justified it with a comment claiming the
 * Rust clamped to `width-1` and the injector refused out-of-bounds outright —
 * **both halves false**: the Rust does not clamp to `width-1`, and the portal
 * injector *clamps* to `[0, display_width]` rather than refusing
 * (`portal/injector.rs:37-42`). The right edge is reachable because the source
 * rectangle is half-open, and the injector is what bounds it.
 *
 * `clamp01` is applied to the fraction first, so an out-of-range or NaN input
 * cannot overflow the rect even though the decoder already clamped it — this
 * function is pure and must not depend on its caller for that.
 */
export function toAbsolute(nx: number, ny: number, source: InputSource): { x: number; y: number } {
  return {
    x: source.x + Math.round(clamp01(nx) * source.width),
    y: source.y + Math.round(clamp01(ny) * source.height),
  };
}

const BUTTONS = new Set(['left', 'middle', 'right']);

/**
 * Decodes one `desktop-input` payload (B28–B30) — the port of
 * `decode_desktop_input` (`input.rs:180-245`).
 *
 * **The wire frame is an envelope:** `DataChannelMessage`
 * (`{ channel: 'control', type: 'desktop-input', payload, timestamp }`),
 * exactly as `decode_desktop_input` (`input.rs:187-191`) validates. The decoder
 * receives the raw frame bytes, verifies `channel === 'control'` and
 * `type === 'desktop-input'`, unwraps `envelope.payload`, and decodes the event.
 *
 * **Decode before inject, always.** The Rust decoded the JSON first and only
 * then called into the platform injector, so an unknown message could never
 * reach an FFI boundary with unvalidated fields. Every rejection here is a
 * `null` — an input frame that does not parse is dropped, never surfaced as an
 * error, because a hostile peer must not be able to elicit a response by
 * sending garbage.
 *
 * **Inside the payload, the discriminator is `kind`,** exactly as serde's
 * internally-tagged enum works (`#[serde(tag = "kind", rename_all = "kebab-case")]`,
 * `input.rs:73-74`): an unknown `kind` is a decode error, which is this
 * function's `null`. The plan's previous vocabulary (`input-pointer` etc. on a
 * `type` field) has **zero producers anywhere** on either side of the wire.
 *
 * **A crypted payload is rejected deterministically.** With the desktop E2EE
 * session armed the browser sends `{ data: <base64> }` as `payload` instead of
 * the event (`desktop-core/src/client.ts:484-494`), and the Rust decrypts
 * **before** decode (`lib.rs:2413-2427`, fail-closed). Nothing in this plan
 * owns that decryption yet, so a crypted frame must not be able to half-parse
 * into an event: it has no `kind`, so it falls out of the `switch` as `null`.
 * The `{ data }` shape is named in the test so the drop is pinned rather than
 * incidental, and the missing owner is recorded in the follow-up register.
 */
export function decodeInput(bytes: ArrayBuffer | Uint8Array): InputEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof (bytes as Uint8Array).byteLength === 'number'
        ? new TextDecoder().decode(bytes as Uint8Array)
        : new TextDecoder().decode(new Uint8Array(bytes as ArrayBuffer)),
    );
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.channel !== 'control' || envelope.type !== 'desktop-input') return null;
  if (typeof envelope.payload !== 'object' || envelope.payload === null) return null;
  const message = envelope.payload as Record<string, unknown>;

  switch (message.kind) {
    case 'pointer-move': {
      if (typeof message.x !== 'number' || typeof message.y !== 'number') return null;
      return { kind: 'pointer-move', x: clamp01(message.x), y: clamp01(message.y), ...seqOf(message) };
    }
    case 'pointer-button': {
      if (typeof message.button !== 'string' || !BUTTONS.has(message.button)) return null;
      if (typeof message.pressed !== 'boolean') return null;
      if (typeof message.x !== 'number' || typeof message.y !== 'number') return null;
      return {
        kind: 'pointer-button',
        button: message.button as 'left' | 'middle' | 'right',
        pressed: message.pressed,
        x: clamp01(message.x),
        y: clamp01(message.y),
        ...seqOf(message),
      };
    }
    case 'wheel': {
      // The real field names: `dx`/`dy` (`desktop.ts:78-85`, `input.rs:90-97`).
      if (typeof message.dx !== 'number' || typeof message.dy !== 'number') return null;
      if (typeof message.x !== 'number' || typeof message.y !== 'number') return null;
      return {
        kind: 'wheel',
        dx: message.dx,
        dy: message.dy,
        x: clamp01(message.x),
        y: clamp01(message.y),
        ...seqOf(message),
      };
    }
    case 'key': {
      // `code` + `pressed` + `modifiers`; there is no `key` name and no
      // down/up `kind` split on this wire (`desktop.ts:86`, `input.rs:98-103`).
      if (typeof message.code !== 'string' || typeof message.pressed !== 'boolean') return null;
      return {
        kind: 'key',
        code: message.code,
        pressed: message.pressed,
        modifiers: modifiersOf(message.modifiers),
      };
    }
    case 'text': {
      if (typeof message.text !== 'string') return null;
      return { kind: 'text', text: message.text };
    }
    default:
      return null;
  }
}

/** `{ seq }` when the wire carried one, `{}` otherwise — `skip_serializing_if`'s inverse. */
function seqOf(message: Record<string, unknown>): { seq?: number } {
  return typeof message.seq === 'number' ? { seq: message.seq } : {};
}

/** The modifier struct, defaulting every field the wire omitted (`KeyModifiers: Default`). */
function modifiersOf(raw: unknown): KeyModifiers {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    ctrl: m.ctrl === true,
    alt: m.alt === true,
    shift: m.shift === true,
    meta: m.meta === true,
  };
}

/**
 * Apply one event to the injector — the port of `apply_if_allowed`
 * (`input.rs:267-333`).
 *
 * This is where the normalized→absolute mapping lives, because this is where
 * the geometry is: the Rust passes `&current_source` in and calls
 * `to_absolute` per event (`input.rs:287-308`). Returns the applied event's
 * `seq` when the wire carried one, `null` when the event was not applied
 * (injector error) — the Rust's `Ok(()) => Some(seq)` / `Err => None`
 * (`input.rs:316-331`). The caller continues the session either way; an
 * injector failure is never fatal.
 *
 * **The gate is not here.** `apply_if_allowed`'s `allow_input` first argument
 * and its rate cap are the caller's, because the Rust runs both **before**
 * decoding (`lib.rs:2427-2434`) — see `bindInputApply` and the router arm.
 *
 * **Move before click.** `pointer-button` and `wheel` issue a `pointerMove`
 * first so the click or scroll lands on the intended point, exactly as the
 * Rust does (`input.rs:291-308`).
 *
 * `now` is the ADR-44 logging seam (`delta_ms = now_ms - envelope_timestamp`,
 * `input.rs:320-325`). The plan's decoder does not yet return the envelope
 * timestamp, so it is accepted and unused; it is in the signature so the seam
 * does not have to change when the timestamp is threaded through.
 */
export function applyInput(
  event: InputEvent,
  source: InputSource,
  injector: InputInjector,
  _now: number,
): number | null {
  try {
    switch (event.kind) {
      case 'pointer-move': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        return event.seq ?? null;
      }
      case 'pointer-button': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        injector.pointerButton(event.button, event.pressed);
        return event.seq ?? null;
      }
      case 'wheel': {
        const p = toAbsolute(event.x, event.y, source);
        injector.pointerMove(p.x, p.y);
        injector.wheel(event.dx, event.dy);
        return event.seq ?? null;
      }
      case 'key':
        injector.key(event.code, event.pressed, event.modifiers);
        return null;
      case 'text':
        injector.text(event.text);
        return null;
    }
  } catch {
    // Fail-soft: an injector error drops the frame and the session continues
    // (`input.rs:328-331`). The partial walk above is deliberate — a click
    // whose move succeeded and whose button failed has still moved.
    return null;
  }
}

/**
 * Bind `applyInput` to the live source rect and injector, producing the
 * `(event, now) => number | null` seam Task 18's router consumes.
 *
 * The router holds **no geometry** — it should not, it is a wire dispatcher —
 * so the implementation that closes over the rect and the injector is built
 * where they exist. This is the Rust's shape with the two arguments bound at
 * construction instead of per call (`apply_if_allowed(allow_input, raw,
 * &current_source, injector, now_ms)`, `input.rs:267-273`), and it is how
 * `current_source` and the lazily created `injector` are hoisted in
 * `lib.rs:2435-2462`.
 *
 * `allow` is the operator's gate, folded in here rather than as a separate
 * seam: a closed gate means every event is not-applied, which is what `null`
 * already means. The rate cap is **not** here — it runs before decode (see
 * `InputLimiter`), so by the time an event reaches this function it has
 * already been admitted.
 *
 * `now` is the ADR-44 logging seam: the Rust logs `delta_ms = now_ms -
 * envelope_timestamp` on the success path (`input.rs:320-325`). The envelope
 * timestamp is not decoded yet (the plan's decoder returns the event alone),
 * so it is carried through unused; it is in the signature because the seam must
 * not drift when the timestamp is threaded through.
 */
export function bindInputApply(deps: {
  allow: boolean;
  source: InputSource;
  injector: InputInjector;
}): (event: InputEvent, now: number) => number | null {
  return (event, now) => {
    if (!deps.allow) return null;
    return applyInput(event, deps.source, deps.injector, now);
  };
}

/**
 * The 120 Hz admission cap (B34), the port of `InputRateLimiter::allow`
 * (`input.rs:124-152`).
 *
 * **The gate and the cap run BEFORE decode, not after.** The Rust's inbound
 * arm (`lib.rs:2427-2434`) checks `allow_input`, then `input_limiter.allow(now)`,
 * and only then calls `apply_if_allowed` — which is what decodes and injects.
 * Its own comment says so: *"cap AFTER decrypt and the Gate-A check, **BEFORE
 * decode/inject**"* (`lib.rs:2428-2430`). The reason is the point: this is a
 * DoS control, so it must sit in front of the JSON parser, not behind it. The
 * plan's earlier version put `accept(decode(bytes))` first, which spent the
 * parse on work the cap existed to refuse, and its `accept(_event)` signature
 * could not express the gate-before-decode order at all. Hence `admit(now)`:
 * no event, no bytes, just the decision.
 *
 * **The closed gate is a refusal with no rate accounting.** The Rust never
 * consults the limiter when `allow_input` is false — `lib.rs:2430` sits inside
 * `if allow_input { … } else { log; continue }` (`:2471-2473`) — so a host with
 * input disabled does **no rate accounting at all**: no window movement, no
 * count, no drop. The landed version checked `allow` here and incremented its
 * drop counter on the refusal, which its own doc said was wrong; that inverted
 * the Rust and pinned a self-contradicting pair of tests (one named "does not
 * count a refusal" whose assertion was `dropped() === 1`). So: `allow` is
 * carried and checked, but a closed-gate refusal returns before any counting —
 * `dropped()` therefore counts **rate-limit** refusals only, and is a declared
 * agent-side addition, not a port (`InputRateLimiter` has no drop counter).
 *
 * The window is **fixed**, reset per whole second (`window = floor(now/1000)`,
 * the euclidean division at `input.rs:142`), not sliding: 120 events are
 * admitted in `[0, 1000)` and another 120 in `[1000, 2000)` regardless of
 * clustering. A sliding window would smooth this and is a different policy;
 * do not "improve" it.
 */
export class InputLimiter {
  private windowIndex = Number.NaN;
  private count = 0;
  private droppedCount = 0;

  constructor(private readonly allow: boolean) {}

  /** `allow(now_ms)` from `input.rs:141`. `true` iff the frame may be parsed. */
  admit(now: number): boolean {
    if (!this.allow) return false;
    const window = Math.floor(now / 1000);
    if (window !== this.windowIndex) {
      this.windowIndex = window;
      this.count = 0;
    }
    if (this.count >= INPUT_RATE_LIMIT_HZ) {
      this.droppedCount += 1;
      return false;
    }
    this.count += 1;
    return true;
  }

  dropped(): number {
    return this.droppedCount;
  }
}
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/input/decode.test.ts
./node_modules/.bin/prettier --write apps/agent/src/input/decode.ts apps/agent/test/input/decode.test.ts
git add apps/agent/src/input apps/agent/test/input
git commit -m "feat(agent): decode, clamp and rate-limit peer input"
```

**TEST-INTEGRITY declaration — revised by the MAJOR-2 repair (2026-10-24), re-counted by the MAJOR-5 item 5 repair, and updated for the envelope seam repair:** the
first landed version declared **16 new `it()` / 25 new `expect()`** for a file
whose vocabulary (`input-pointer`/`input-key`/`input-wheel` on a `type` field,
`deltaX`/`deltaY`, `kind: 'down'/'up'`, `key: 'A'`) has **zero producers
anywhere** on the wire. The fence was rewritten to the real `kind`-tagged
union (`desktop.ts:68-87`), and updated to decode the `DataChannelMessage` envelope with a must-fail bare payload control and channel/type rejection tests: **29 `it()` / 51 `expect()`** (was
27 / 48 before the seam repair; was 16 / 25 originally; +13 `it()`, +26 `expect()`). All `it(` and `expect(` occurrences are
literal; no `it.each(` in the file, so all three axes coincide (29/29/29,
51/51/51). What the rewrite adds beyond the ported behaviours: the `text`
kind (the earlier `InputEvent` lacked it entirely), the `seq`-carried /
`seq`-absent pair, the `{ data }` crypted-payload rejection (the E2EE owner
gap — see the follow-up register), the zero-geometry guard's **removal** from
decode (geometry belongs to `applyInput`), `toAbsolute`'s endpoint pins
(`0.0 → x`, `1.0 → x + width` — the earlier draft clamped to `extent - 1`,
which the Rust's own test at `input.rs:745-751` contradicts), `applyInput`'s
move-before-click order and its fail-soft injector-error path, and
`bindInputApply`'s closure over the live rect. `InputLimiter` no longer takes
a clock (`admit(now)` — the cap runs **before** decode, so it takes a
timestamp, not an event; see its own comment and MAJOR-5's ruling).

**`InputLimiter`'s own `describe` block: 4 `it()` / 9 `expect()` before → 5 `it()` / 11 `expect()` after (MAJOR-5 item 5).** The three axes it was wrong on, each now asserted: (a) the window anchor — `floor(now/1000)`, pinned by a fixture that crosses a wall-clock boundary at a non-zero phase (120 frames at `t=5500`, then admissions at `t=6000`; an elapsed-since-first-call anchoring refuses them); (b) a closed gate performs **no rate accounting** — the landed fence pinned the opposite **twice**, in a self-contradicting pair (`drops everything when input is not allowed` asserted `dropped() === 1`, and `does not count a refusal as a rate-limit drop when input is disabled` asserted `dropped() === 1` as well; the second's name and assertion cannot both be right). They are now one test asserting `dropped() === 0`, which is what `lib.rs:2430`'s `if allow_input` guard means; (c) the signature — `admit(now)` takes no event, so the cap can run before the parser. `dropped()` itself has no Rust counterpart (`InputRateLimiter` has no counter) and is declared here as an **agent-side addition** whose count is rate-limit refusals only, not a port.

---

### Task 16: The sustain ladder

**Files:**
- Create: `apps/agent/src/desktop/sustain.ts`
- Test: `apps/agent/test/desktop/sustain.test.ts`

**Interfaces:**
- Consumes: `ProfileId` / `DesktopProfile` from `@ponter/shared`.
- Produces:
  - `const SUSTAIN_FRAMES = 30`
  - `const SUSTAIN_LADDER: Record<ProfileId, ProfileId | null>`
  - `class SustainLadder { constructor(profile: ProfileId, budgetMs: number); noteFrame(encodeMs: number): ProfileId | null; noteBitrateChange(bitrate: number): void; current(): ProfileId; consecutive(): number }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/desktop/sustain.test.ts
import { describe, expect, it } from 'vitest';
import { SUSTAIN_FRAMES, SustainLadder } from '../../src/desktop/sustain.js';

describe('the ladder', () => {
  it('downgrades 1080p60 to 720p60 after 30 over-budget frames', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1) expect(ladder.noteFrame(40)).toBeNull();
    expect(ladder.noteFrame(40)).toBe('720p60');
  });

  it('needs a STRICTLY greater encode time', () => {
    // Exactly on budget is on budget. A `>=` here would downgrade a stream that
    // is meeting its target every frame.
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES * 2; i += 1) expect(ladder.noteFrame(16.7)).toBeNull();
  });

  it('resets the counter on any single on-budget frame', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < 29; i += 1) ladder.noteFrame(40);
    expect(ladder.consecutive()).toBe(29);
    expect(ladder.noteFrame(10)).toBeNull();
    expect(ladder.consecutive()).toBe(0);
  });

  it('walks the whole ladder down to the floor and stops', () => {
    const steps: string[] = [];
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let rung = 0; rung < 4; rung += 1) {
      for (let i = 0; i < SUSTAIN_FRAMES; i += 1) {
        const next = ladder.noteFrame(40);
        if (next) steps.push(next);
      }
    }
    expect(steps).toEqual(['720p60', '720p30']);
    expect(ladder.current()).toBe('720p30');
  });

  it('has 720p30 as the floor, so its successor is null', () => {
    const ladder = new SustainLadder('720p30', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
    expect(ladder.consecutive()).toBe(0);
  });

  it('sends 1080p30 to 720p30 in one step', () => {
    const ladder = new SustainLadder('1080p30', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1) ladder.noteFrame(40);
    expect(ladder.noteFrame(40)).toBe('720p30');
  });
});

describe('noteBitrateChange', () => {
  it('re-opens the latch above the floor so the stream can climb back', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p60');
    ladder.noteBitrateChange(8_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES - 1; i += 1) ladder.noteFrame(40);
    expect(ladder.noteFrame(40)).toBe('720p30');
  });

  it('does nothing at the floor', () => {
    const ladder = new SustainLadder('1080p60', 16.7);
    for (let i = 0; i < SUSTAIN_FRAMES * 4; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
    ladder.noteBitrateChange(8_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p30');
  });

  it('updates neither the budget nor the next rung', () => {
    // A bitrate change re-opens the latch and nothing else. Recomputing the
    // budget from the new bitrate would make the ladder's threshold depend on
    // the client's bandwidth, which is the opposite of what it measures.
    const ladder = new SustainLadder('1080p60', 16.7);
    ladder.noteBitrateChange(20_000_000);
    for (let i = 0; i < SUSTAIN_FRAMES; i += 1) ladder.noteFrame(40);
    expect(ladder.current()).toBe('720p60');
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/sustain.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/sustain.ts
import type { ProfileId } from '@ponter/shared';

export const SUSTAIN_FRAMES = 30;

/**
 * The downgrade path. `1080p30 -> 720p30` skips `720p60` deliberately: a source
 * already running at 30 fps cannot gain anything from a 60 fps target, so the
 * only useful move is down in resolution.
 */
export const SUSTAIN_LADDER: Record<ProfileId, ProfileId | null> = {
  '1080p60': '720p60',
  '720p60': '720p30',
  '1080p30': '720p30',
  '720p30': null,
};

/**
 * Quality degradation under sustained load (B18/B23).
 *
 * The input is the **single frame's** `encode_time`, not the p50 from the
 * timing ring. That is not an oversight in the Rust and it is not one here: the
 * ladder exists to catch a stall the moment it happens, and a median over 32
 * frames would not move until 17 frames had already been late.
 *
 * The budget comparison is **strictly greater**, and any on-budget frame resets
 * the run to zero. Both are load-bearing: a `>=` downgrades a stream that is
 * exactly meeting its target, and a non-resetting counter would let 15 bad
 * frames either side of a good one still trigger.
 */
export class SustainLadder {
  private profile: ProfileId;
  private consecutive = 0;

  constructor(
    profile: ProfileId,
    private readonly budgetMs: number,
  ) {
    this.profile = profile;
  }

  noteFrame(encodeMs: number): ProfileId | null {
    if (encodeMs <= this.budgetMs) {
      this.consecutive = 0;
      return null;
    }
    this.consecutive += 1;
    if (this.consecutive < SUSTAIN_FRAMES) return null;
    this.consecutive = 0;
    const next = SUSTAIN_LADDER[this.profile];
    if (next === null) return null;
    this.profile = next;
    return next;
  }

  /**
   * A bitrate retarget re-opens the latch, unless the ladder is already at the
   * floor. It changes neither `budgetMs` nor the next rung.
   */
  noteBitrateChange(_bitrate: number): void {
    if (SUSTAIN_LADDER[this.profile] === null) return;
    this.consecutive = 0;
  }

  current(): ProfileId {
    return this.profile;
  }

  consecutive(): number {
    return this.consecutive;
  }
}
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/desktop/sustain.test.ts
./node_modules/.bin/prettier --write apps/agent/src/desktop/sustain.ts apps/agent/test/desktop/sustain.test.ts
git add apps/agent/src/desktop apps/agent/test/desktop
git commit -m "feat(agent): port the 30-frame sustain ladder"
```

**TEST-INTEGRITY declaration:** one new file, **9 new `it()` / 16 new `expect()`**. Ports `sustain_monitor_downgrades_once_and_never_oscillates`, `sustain_monitor_resets_the_streak_on_an_on_budget_frame`, `sustain_monitor_never_downgrades_from_the_floor`, `sustain_monitor_reopens_only_above_the_floor` (all `desktop.rs:3363-3420`), plus `downgrade_ladder_is_monotonic_in_pixels_per_second` and `a_1080p60_monitor_demotes_to_720p60_first` for the ladder walk. **New:** the strict-inequality case (the Rust tested only clearly-over-budget values) and the "updates neither budget nor rung" assertion, which the Rust's `sustain_monitor_reopens_only_above_the_floor` does not pin — it asserts the latch alone.

An earlier draft cited six names under a `sustain_ladder_*` scheme that appears nowhere in `apps/agent/src`; the real tests are named `sustain_monitor_*`. The counts above are unchanged by the rename, because the renamed rows were always about the same six behaviours.

**Divergence recorded, not fixed:** the Rust created its sustain ticker once and never rebuilt it, so samples continued to arrive on the old interval after a downgrade. That is a wiring concern, handled in Task 19.

---

### Task 17: Desktop control decode and outbound frames

**Files:**
- Create: `apps/agent/src/desktop/control.ts`
- Create: `apps/agent/src/desktop/frames.ts`
- Test: `apps/agent/test/desktop/control.test.ts`, `apps/agent/test/desktop/frames.test.ts`

**Interfaces:**
- Consumes: `ProfileId`, `DesktopProfile`; and — for the frames — the canonical wire types from `@ponter/shared` (`DataChannelMessage`, `DesktopStats`, `DesktopCursorPayload`, `DesktopSourceInfo`, `DesktopSourcesPayload`), which is where the browser's own parser reads them.
- Produces:
  - `const MIN_BITRATE = 250_000`, `const MAX_BITRATE = 20_000_000`
  - `function clampBitrate(bps: number): number`
  - `function decodeStreamControl(bytes): StreamControl | null` → `{ kind: 'pause' } | { kind: 'resume' } | { kind: 'stop' } | { kind: 'bitrate'; bitrate: number } | { kind: 'quality'; profile: ProfileId }`
  - `function decodeDesktopSelect(bytes): { kind: 'monitor'; id: string } | { kind: 'window'; id: string } | { kind: 'test' } | null`
  - `function buildStatsFrame(stats: DesktopStats, timestamp: number): string` → `DataChannelMessage<DesktopStats>` on `channel: 'control'`
  - `function buildCursorFrame(cursor: DesktopCursorPayload, timestamp: number): string` → `DataChannelMessage<DesktopCursorPayload>` on `channel: 'control'`
  - `function buildSourcesFrame(sources: DesktopSourceInfo[], inputEnabled: boolean, peerVerified: boolean, cursorInFrame: boolean, timestamp: number): string` → `DataChannelMessage<DesktopSourcesPayload>` on `channel: 'control'`
  - `function gopForFps(fps: number): number`

- [ ] **Step 1: Write the failing control test**

```ts
// apps/agent/test/desktop/control.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_BITRATE,
  MIN_BITRATE,
  clampBitrate,
  decodeDesktopSelect,
  decodeStreamControl,
  gopForFps,
} from '../../src/desktop/control.js';

const frame = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));

describe('clampBitrate', () => {
  it('clamps to [250 kbps, 20 Mbps]', () => {
    expect(clampBitrate(1_000_000)).toBe(1_000_000);
    expect(clampBitrate(1)).toBe(MIN_BITRATE);
    expect(clampBitrate(Number.MAX_SAFE_INTEGER)).toBe(MAX_BITRATE);
  });

  it('rounds to an integer', () => {
    expect(clampBitrate(1_000_000.6)).toBe(1_000_001);
  });
});

describe('decodeStreamControl', () => {
  it('decodes the four control kinds', () => {
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'pause' }))).toEqual({ kind: 'pause' });
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'resume' }))).toEqual({ kind: 'resume' });
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'stop' }))).toEqual({ kind: 'stop' });
  });

  it('clamps a bitrate inside the decode, not at the call site', () => {
    // The clamp has to live here: three call sites exist (initial apply, live
    // retarget, resume) and a clamp at one of them is a clamp at none.
    const control = decodeStreamControl(
      frame({ type: 'stream-control', action: 'set-bitrate', bitrate: 99_000_000 }),
    );
    expect(control).toEqual({ kind: 'bitrate', bitrate: MAX_BITRATE });
  });

  it('decodes a quality change', () => {
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'set-quality', profile: '720p30' }))).toEqual({
      kind: 'quality',
      profile: '720p30',
    });
  });

  it('rejects an unknown profile instead of defaulting', () => {
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'set-quality', profile: '4k120' }))).toBeNull();
  });

  it('rejects an unknown action and malformed JSON', () => {
    expect(decodeStreamControl(frame({ type: 'stream-control', action: 'explode' }))).toBeNull();
    expect(decodeStreamControl(new TextEncoder().encode('nope'))).toBeNull();
  });
});

describe('decodeDesktopSelect', () => {
  it('decodes monitor, window and test sources', () => {
    expect(decodeDesktopSelect(frame({ type: 'desktop-select', source: { kind: 'monitor', id: '1' } }))).toEqual({
      kind: 'monitor',
      id: '1',
    });
    expect(decodeDesktopSelect(frame({ type: 'desktop-select', source: { kind: 'window', id: '0x40' } }))).toEqual({
      kind: 'window',
      id: '0x40',
    });
    expect(decodeDesktopSelect(frame({ type: 'desktop-select', source: { kind: 'test' } }))).toEqual({ kind: 'test' });
  });

  it('rejects a monitor with no id', () => {
    expect(decodeDesktopSelect(frame({ type: 'desktop-select', source: { kind: 'monitor' } }))).toBeNull();
  });
});

describe('gopForFps', () => {
  it('is two seconds of frames, never zero', () => {
    expect(gopForFps(60)).toBe(120);
    expect(gopForFps(30)).toBe(60);
    expect(gopForFps(0.2)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `control.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/control.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/control.ts
import type { ProfileId } from '@ponter/shared';

export const MIN_BITRATE = 250_000;
export const MAX_BITRATE = 20_000_000;

const PROFILES = new Set<ProfileId>(['1080p60', '1080p30', '720p60', '720p30']);

export type StreamControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'bitrate'; bitrate: number }
  | { kind: 'quality'; profile: ProfileId };

export type DesktopSource =
  | { kind: 'monitor'; id: string }
  | { kind: 'window'; id: string }
  | { kind: 'test' };

export function clampBitrate(bps: number): number {
  return Math.round(Math.min(Math.max(bps, MIN_BITRATE), MAX_BITRATE));
}

function parse(bytes: ArrayBuffer | Uint8Array): Record<string, unknown> | null {
  try {
    const text =
      bytes instanceof Uint8Array
        ? new TextDecoder().decode(bytes)
        : new TextDecoder().decode(new Uint8Array(bytes));
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `StreamControl` decode (B20/B62).
 *
 * The bitrate clamp lives **in the decoder**, not at the call site. There are
 * three places a bitrate arrives: the initial apply, a live retarget, and the
 * post-resume re-apply. A clamp at any one of them is a clamp at none, and the
 * encoder's own limits are what turn an out-of-range value into a hard failure.
 */
export function decodeStreamControl(bytes: ArrayBuffer | Uint8Array): StreamControl | null {
  const message = parse(bytes);
  if (!message || message.type !== 'stream-control') return null;
  switch (message.action) {
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
    case 'stop':
      return { kind: 'stop' };
    case 'set-bitrate':
      if (typeof message.bitrate !== 'number' || !Number.isFinite(message.bitrate)) return null;
      return { kind: 'bitrate', bitrate: clampBitrate(message.bitrate) };
    case 'set-quality':
      if (typeof message.profile !== 'string' || !PROFILES.has(message.profile as ProfileId)) return null;
      return { kind: 'quality', profile: message.profile as ProfileId };
    default:
      return null;
  }
}

export function decodeDesktopSelect(bytes: ArrayBuffer | Uint8Array): DesktopSource | null {
  const message = parse(bytes);
  if (!message || message.type !== 'desktop-select') return null;
  const source = message.source;
  if (typeof source !== 'object' || source === null) return null;
  const value = source as Record<string, unknown>;
  if (value.kind === 'test') return { kind: 'test' };
  if (value.kind !== 'monitor' && value.kind !== 'window') return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  return { kind: value.kind, id: value.id };
}

/** Two seconds of frames, rounded, floored at 1. */
export function gopForFps(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}
```

- [ ] **Step 3: Write the failing frames test**

```ts
// apps/agent/test/desktop/frames.test.ts
import type { DesktopSourceInfo } from '@ponter/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCursorFrame,
  buildSourcesFrame,
  buildStatsFrame,
} from '../../src/desktop/frames.js';

const parse = (text: string) => JSON.parse(text);

describe('buildStatsFrame', () => {
  it('emits the DataChannelMessage envelope on the control channel', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 4_000_000,
        },
        12_345,
      ),
    );
    expect(frame.type).toBe('desktop-stats');
    expect(frame.channel).toBe('control');
    expect(frame.timestamp).toBe(12_345);
  });

  it('carries the stats fields the browser requires', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 4_000_000,
        },
        1,
      ),
    );
    expect(frame.payload).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 4_000_000,
    });
  });

  it('rounds the two p50s to one decimal place', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1280,
          height: 720,
          fps: 30,
          targetBitrateBps: 1,
          encodeMsP50: 7.25,
          captureMsP50: 3.04,
        },
        1,
      ),
    );
    expect(frame.payload.encodeMsP50).toBe(7.3);
    expect(frame.payload.captureMsP50).toBe(3);
  });

  it('omits every absent optional stats field', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1920,
          height: 1080,
          fps: 30,
          targetBitrateBps: 6_000_000,
        },
        1,
      ),
    );
    for (const key of [
      'status',
      'frameSeq',
      'captureMsP50',
      'encodeMsP50',
      'frameSamples',
    ]) {
      expect(key in frame.payload).toBe(false);
    }
  });

  it('carries the optional stats fields when they are set, and omits only the unset one', () => {
    const frame = parse(
      buildStatsFrame(
        {
          width: 1280,
          height: 720,
          fps: 30,
          targetBitrateBps: 4_000_000,
          status: {
            kind: 'quality-downgraded',
            detail: '720p (quality downgraded)',
          },
          frameSeq: 42,
          encodeMsP50: 11,
          frameSamples: [{ seq: 42, captureEpochMs: 1000, encodeMs: 11 }],
        },
        3,
      ),
    );
    expect(frame.payload.status).toEqual({
      kind: 'quality-downgraded',
      detail: '720p (quality downgraded)',
    });
    expect(frame.payload.frameSeq).toBe(42);
    expect(frame.payload.frameSamples).toEqual([
      { seq: 42, captureEpochMs: 1000, encodeMs: 11 },
    ]);
    expect('captureMsP50' in frame.payload).toBe(false);
  });
});

describe('buildCursorFrame', () => {
  it('emits the envelope with x, y, visible and seq', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0.25,
          y: 0.75,
          visible: true,
          seq: 7,
        },
        1_700_000_000,
      ),
    );
    expect(frame).toMatchObject({
      type: 'desktop-cursor',
      channel: 'control',
      timestamp: 1_700_000_000,
      payload: {
        x: 0.25,
        y: 0.75,
        visible: true,
        seq: 7,
      },
    });
  });

  it('omits shape when the cursor has none', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: false,
          seq: 1,
        },
        1,
      ),
    );
    expect('shape' in frame.payload).toBe(false);
  });

  it('emits the shape record when one is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: true,
          seq: 0,
          shape: {
            png: 'iVBORw0KGgo=',
            hotspotX: 4,
            hotspotY: 8,
            serial: 42,
          },
        },
        1,
      ),
    );
    expect(frame.payload.shape).toEqual({
      png: 'iVBORw0KGgo=',
      hotspotX: 4,
      hotspotY: 8,
      serial: 42,
    });
  });

  it('stamps lastInputSeq on the wire when one is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 100,
          y: 200,
          visible: true,
          seq: 1,
          lastInputSeq: 3,
        },
        1,
      ),
    );
    expect(frame.payload).toMatchObject({ lastInputSeq: 3 });
  });

  it('omits lastInputSeq from the wire when none is set', () => {
    const frame = parse(
      buildCursorFrame(
        {
          x: 0,
          y: 0,
          visible: false,
          seq: 1,
        },
        1,
      ),
    );
    expect('lastInputSeq' in frame.payload).toBe(false);
  });
});

describe('buildSourcesFrame', () => {
  it('emits the DesktopSourcesPayload shape', () => {
    const frame = parse(buildSourcesFrame([], true, true, true, 7));
    expect(frame.type).toBe('desktop-sources');
    expect(frame.channel).toBe('control');
    expect(frame.timestamp).toBe(7);
    expect(frame.payload).toMatchObject({
      sources: [],
      inputEnabled: true,
      peerVerified: true,
      cursorInFrame: true,
    });
  });

  it('renders inputEnabled, peerVerified and cursorInFrame in both directions', () => {
    const t = parse(buildSourcesFrame([], true, true, true, 1));
    expect(t.payload.inputEnabled).toBe(true);
    expect(t.payload.peerVerified).toBe(true);
    expect(t.payload.cursorInFrame).toBe(true);

    const f = parse(buildSourcesFrame([], false, false, false, 1));
    expect(f.payload.inputEnabled).toBe(false);
    expect(f.payload.peerVerified).toBe(false);
    expect(f.payload.cursorInFrame).toBe(false);
  });

  it('carries every DesktopSourceInfo field with the camelCase spelling', () => {
    const source: DesktopSourceInfo = {
      id: 'test:0',
      kind: 'monitor',
      name: 'Test pattern',
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: true,
      default: true,
    };
    const frame = parse(buildSourcesFrame([source], true, true, true, 1));
    expect(frame.payload.sources[0]).toEqual(source);
    expect('scale_factor' in frame.payload.sources[0]).toBe(false);
  });

  it('carries multi-entry sources including windows and monitors', () => {
    const monitor: DesktopSourceInfo = {
      id: 'monitor:0',
      kind: 'monitor',
      name: 'Display 1',
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: true,
      default: true,
    };
    const window: DesktopSourceInfo = {
      id: 'window:123',
      kind: 'window',
      name: 'Terminal',
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      scaleFactor: 1.0,
      rotation: 0.0,
      isPrimary: false,
      default: false,
    };
    const frame = parse(
      buildSourcesFrame([monitor, window], true, true, true, 1),
    );
    expect(frame.payload.sources).toHaveLength(2);
    expect(frame.payload.sources[0]).toEqual(monitor);
    expect(frame.payload.sources[1]).toEqual(window);
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement `frames.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/frames.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/frames.ts
import type {
  DataChannelMessage,
  DesktopCursorPayload,
  DesktopSourceInfo,
  DesktopSourcesPayload,
  DesktopStats,
} from '@ponter/shared';

/**
 * TS-only divergence from Rust: the Rust serialises f32 p50s unrounded (7.25 -> 7.25);
 * the builder emits 7.3. Neither captureMsP50 nor encodeMsP50 has any reader in
 * packages/desktop-core/src or apps/web/src (where readers are targetBitrateBps, width,
 * height, status.kind, status.detail). The divergence is unobservable to readers
 * and kept to avoid moving green cells for measurement noise.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Stats frame builder. Mirrors Rust `frame_desktop_stats` (desktop.rs:2147).
 *
 * Optional fields (`status`, `frameSeq`, `captureMsP50`, `encodeMsP50`, `frameSamples`)
 * are omitted when unset via conditional spread, matching Rust's `skip_serializing_if`.
 */
export function buildStatsFrame(
  stats: DesktopStats,
  timestamp: number,
): string {
  const payload: DesktopStats = {
    width: stats.width,
    height: stats.height,
    fps: stats.fps,
    targetBitrateBps: stats.targetBitrateBps,
    ...(stats.status !== undefined ? { status: stats.status } : {}),
    ...(stats.frameSeq !== undefined ? { frameSeq: stats.frameSeq } : {}),
    ...(stats.captureMsP50 !== undefined
      ? { captureMsP50: round1(stats.captureMsP50) }
      : {}),
    ...(stats.encodeMsP50 !== undefined
      ? { encodeMsP50: round1(stats.encodeMsP50) }
      : {}),
    ...(stats.frameSamples !== undefined
      ? { frameSamples: stats.frameSamples }
      : {}),
  };
  return JSON.stringify({
    type: 'desktop-stats',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopStats>);
}

/**
 * Cursor frame builder. Mirrors Rust `frame_desktop_cursor` (desktop.rs:2093).
 *
 * `shape` and `lastInputSeq` carry `skip_serializing_if = "Option::is_none"`
 * in Rust (desktop.rs:2175-2179), so both fields are omitted from the wire
 * when unset — the builder below uses conditional spread, never writing
 * `undefined` or `null`.
 */
export function buildCursorFrame(
  cursor: DesktopCursorPayload,
  timestamp: number,
): string {
  const payload: DesktopCursorPayload = {
    x: cursor.x,
    y: cursor.y,
    visible: cursor.visible,
    seq: cursor.seq,
    ...(cursor.lastInputSeq !== undefined
      ? { lastInputSeq: cursor.lastInputSeq }
      : {}),
    ...(cursor.shape !== undefined ? { shape: cursor.shape } : {}),
  };
  return JSON.stringify({
    type: 'desktop-cursor',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopCursorPayload>);
}

/**
 * Desktop sources frame builder. Mirrors Rust `frame_desktop_sources` (desktop.rs:2066).
 *
 * Takes `inputEnabled`, `peerVerified`, and `cursorInFrame` flags as parameters and
 * renders each in both directions so that the wire format accurately reflects the
 * admission and capture state.
 */
export function buildSourcesFrame(
  sources: DesktopSourceInfo[],
  inputEnabled: boolean,
  peerVerified: boolean,
  cursorInFrame: boolean,
  timestamp: number,
): string {
  const payload: DesktopSourcesPayload = {
    sources,
    inputEnabled,
    peerVerified,
    cursorInFrame,
  };
  return JSON.stringify({
    type: 'desktop-sources',
    channel: 'control',
    payload,
    timestamp,
  } satisfies DataChannelMessage<DesktopSourcesPayload>);
}
```

- [ ] **Step 5: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/desktop/control.test.ts test/desktop/frames.test.ts
./node_modules/.bin/prettier --write apps/agent/src/desktop/{control,frames}.ts apps/agent/test/desktop/{control,frames}.test.ts
git add apps/agent/src/desktop apps/agent/test/desktop
git commit -m "feat(agent): decode stream control and build the desktop frames"
```

**TEST-INTEGRITY declaration:** two new files, **17 new `it()` / 29 new `expect()`** — **15 / 27** as the previous revision landed it, **17 / 29** after the ADR-47 seq-echo repair (+2 `it()`, +2 `expect()`, both in `frames.test.ts`: the `lastInputSeq` set case and the `lastInputSeq` omitted case; `control.test.ts` is unchanged at 10 / 19, `frames.test.ts` goes 5 / 8 → 7 / 10).

**Task 25 supersedes the `frames.test.ts` figures above.** When the builders moved to the `DataChannelMessage` wire format, the frames fence was rewritten and then extended by a test-only fix round: `frames.test.ts` now stands at **14 `it()` / 31 `expect()`**, so this task's two test files stand at **24 `it()` / 52 `expect()`** on the committed blobs (`control.test.ts` 10 / 21 + `frames.test.ts` 14 / 31). The full per-cell accounting is in `### Task 25`; nothing was deleted or skipped (`.skip` / `.only` / `.todo` = 0 throughout), and the four pre-wire cells were replaced with their wire equivalents.

One drift predates Task 25 and is recorded here rather than silently re-based: the landed `control.test.ts` carries **21** `expect()` against this fence's **19**, because the empty-source-id guard (`value.id === ''`) landed with Task 17 — asserted in both polarities, missing-key and empty-string — and the fence text was not updated at the time. The fence below still shows the single missing-key case, and the explicit `from '@ponter/shared'` type import the frames fence now needs.

**Ports:** `decode_control_reads_a_desktop_select`, `decode_control_reads_and_clamps_a_desktop_bitrate`, `decode_control_ignores_another_channel_and_an_unknown_type`, `decode_control_rejects_a_malformed_select_payload` (`desktop.rs:2951-3030`), `gop_frames_are_two_seconds_of_the_profile_fps`, `gop_frames_never_collapse_to_zero` (`desktop.rs:2479-2500`), `stream_profile_rejects_an_unknown_name` (`lib.rs:3354`), `frame_desktop_stats_uses_the_camel_case_wire_shape` (`desktop.rs:3146`) and `frame_desktop_cursor_includes_shape_when_some_and_omits_when_none` (`desktop.rs:3789`). **New:** the unknown-action and malformed-JSON cases as one test (the Rust covers the unknown *type* case inside `…ignores_another_channel_and_an_unknown_type`, not an unknown action), the one-decimal rounding of both p50s, and the sources frame shape.

**ADR-47's echo declared (MAJOR-2/2d).** `buildCursorFrame` now carries `lastInputSeq?: number` and stamps it on the wire as `lastInputSeq` — the browser's latency meter reads that field, so without it the one-way-latency display is dead on arrival. **Omitted when absent**, mirroring the Rust's `skip_serializing_if = "Option::is_none"` (`desktop.rs:2176-2177`) and its two cursor-frame tests (`desktop.rs:3730-3763` asserts `p["lastInputSeq"] == 3`; `desktop.rs:3766-3786` asserts the field is **absent** when `None`) — the two new tests are those two, and the absent case asserts the key is **not in** the payload rather than that it is `null`, because "absent" and "null" are different on this wire. The **runtime owns the single mutable holder** for the echoed value, the way the Rust's hoisted `Arc<AtomicU64>` does (`lib.rs:2304-2312`, stored by the control task at `:2468`); the cursor loop reads it, and that wiring stays with Task 19's desktop session loop, which this commit does not touch.

An earlier draft cited `clamps_bitrate_to_the_supported_range`, `decodes_stream_control_variants`, `decodes_desktop_select_variants`, `rejects_an_unknown_profile`, `gop_is_two_seconds_of_frames`, `stats_frame_field_names` and `cursor_frame_includes_shape_when_hidden` — seven names that appear nowhere in `apps/agent/src`. They were plausible re-spellings of the ported behaviours, which is why they read as a parity claim while describing no test that exists.

---

### Task 18: The data-channel router

**Files:**
- Create: `apps/agent/src/session/data-channels.ts`
- Test: `apps/agent/test/session/data-channels.test.ts`

**Interfaces:**
- Consumes: `PtyManager` (Task 12), `FilesSession` (Task 11), `clampBitrate` (Task 17), `decodeInput` / `InputLimiter` / `bindInputApply` / `InputEvent` (Task 15); `frameFiles` (Task 11); `MAX_DATA_CHANNEL_FRAME_BYTES` (Task 3). Task 17's `decodeStreamControl` / `decodeDesktopSelect` are **not** consumed — their vocabulary is not the wire's (see `dispatchDesktop`'s note, and the follow-up register entry it names).
- Produces:
  - `const CHANNEL_LABELS = { terminal: 'terminal', files: 'files', control: 'control' } as const` — the three labels a peer actually opens (`WebRTCChannelType` minus `'desktop'`, which is the capability/RTP media label, not a data channel; and without `input`/`cursor`, which exist nowhere).
  - `class DataChannelRouter { constructor(deps); attach(channel): void; detach(label): void; send(label, frame): void }`
  - `type RouterDeps` — the five handlers plus `send` and `now`, each injectable. `deps.input` is `{ admit, decode, apply }` (MAJOR-5).

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent/test/session/data-channels.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_LABELS, DataChannelRouter } from '../../src/session/data-channels.js';
import type { InputEvent } from '../../src/input/decode.js';

function fakeChannel(label: string) {
  const handlers: Record<string, ((arg: never) => void)[]> = {};
  return {
    label,
    readyState: 'open',
    on: (event: string, cb: (arg: never) => void) => {
      (handlers[event] ??= []).push(cb);
      // The unsubscribe `RouterChannel.on` promises. Removing by identity is
      // what `detach`'s fix consumes; a fake that returns `undefined` would
      // make the detach test pass for the wrong reason again.
      return () => {
        const list = handlers[event] ?? [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    send: vi.fn(),
    close: vi.fn(),
    emit: (event: string, arg?: unknown) => {
      for (const cb of handlers[event] ?? []) cb(arg as never);
    },
    handlerCount: (event: string) => (handlers[event] ?? []).length,
  };
}

function router(overrides: Record<string, unknown> = {}) {
  const deps = {
    terminal: { write: vi.fn(), resize: vi.fn(), close: vi.fn(), create: vi.fn() },
    files: { handle: vi.fn(() => []), acceptBinaryChunk: vi.fn(() => []) },
    desktop: { onControl: vi.fn(), onSelect: vi.fn() },
    input: {
      // The Rust's three-stage input path, in its real order (`lib.rs:2427-2469`):
      // admit (gate + rate cap) → decode → apply. `admit` takes a timestamp and
      // never sees an event, which is what makes the order enforceable.
      admit: vi.fn(() => true),
      decode: vi.fn((): InputEvent | null => ({ kind: 'pointer-move', x: 0.5, y: 0.5 })),
      apply: vi.fn(() => null),
    },
    send: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  // No `as never`: `deps` is the shape `RouterDeps` asks for, so the test
  // compiles against the real interface — that is the type-check that would
  // have caught `send` existing only as mocks (MAJOR-2).
  return { deps, r: new DataChannelRouter(deps) };
}

/**
 * Every browser-originated frame carries the `DataChannelMessage` envelope —
 * `webrtc-core`'s `sendJson` builds it for every channel — so the fixtures are
 * envelopes too. A flat fixture would now be dropped by R2's channel guard,
 * which is the behaviour the tests below assert on purpose.
 */
function envelope(channel: string, type: string, payload: Record<string, unknown> = {}) {
  return new TextEncoder().encode(JSON.stringify({ type, channel, payload, timestamp: 0 }));
}

describe('the label gate', () => {
  it('accepts each of the three served labels', () => {
    for (const label of Object.values(CHANNEL_LABELS)) {
      const { r } = router();
      const channel = fakeChannel(label);
      expect(() => r.attach(channel)).not.toThrow();
      expect(channel.close).not.toHaveBeenCalled();
    }
  });

  it('closes an unknown label with no code argument', () => {
    // Neither werift's `close()` nor the Rust's took a code. Passing one would
    // compile against a wider type and do nothing at runtime.
    const { r } = router();
    const channel = fakeChannel('admin');
    r.attach(channel);
    expect(channel.close).toHaveBeenCalledWith();
  });

  it('closes a SECOND channel with an already-registered label', () => {
    // Two `terminal` channels means two peers, or one confused one. Keeping both
    // would deliver output to whichever the browser happened to bind.
    const { r } = router();
    const first = fakeChannel('terminal');
    const second = fakeChannel('terminal');
    r.attach(first);
    r.attach(second);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledWith();
  });

  it('drops a channel whose label throws, without closing it', () => {
    const { r } = router();
    const channel = {
      // The annotation is required: a getter whose body always throws infers
      // `void`, which is not assignable to `RouterChannel.label: string`.
      get label(): string {
        throw new Error('not ready');
      },
      close: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    expect(() => r.attach(channel)).not.toThrow();
    expect(channel.close).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('routes a terminal-data frame to the pty by terminalId, as bytes', () => {
    // Ruling 1: the browser's only inbound terminal write is
    // `sendJson('terminal', 'terminal-data', { terminalId, data: base64 })`
    // (`terminal-core/src/client.ts:179,189`), and the Rust decodes
    // STANDARD base64 (`pty.rs:181-198`) before the pty sees it. `bHM=` is
    // "ls"; the write receives the **bytes**, not the base64 text.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    channel.emit('message', envelope('terminal', 'terminal-data', { terminalId: 't1', data: 'bHM=' }));
    expect(deps.terminal.write).toHaveBeenCalledWith('t1', new Uint8Array([0x6c, 0x73]));
  });

  it('drops a terminal-data frame with no terminalId rather than guessing a session', () => {
    // A terminal channel carries several pty sessions; `write` needs the id.
    // This is the dropped-frame's positive control for the test above.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    channel.emit('message', envelope('terminal', 'terminal-data', { data: 'bHM=' }));
    expect(deps.terminal.write).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('routes a files binary 0x02 frame to the files session', () => {
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const binary = new Uint8Array(26);
    binary[0] = 0x02;
    channel.emit('message', binary);
    expect(deps.files.acceptBinaryChunk).toHaveBeenCalledWith(binary);
  });

  it('routes a files JSON frame to the files session', () => {
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    // R2: the session receives the **unwrapped payload**, not the envelope.
    channel.emit('message', envelope('files', 'files-list', { path: '' }));
    expect(deps.files.handle).toHaveBeenCalledWith({ path: '', type: 'files-list' });
  });

  it('sends whatever the files session returns, wrapped in the envelope, through the channel', () => {
    const { deps, r } = router({ files: { handle: () => [{ type: 'files-error', code: 'BAD_FRAME' }], acceptBinaryChunk: () => [] } });
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', envelope('files', 'files-list', { path: '' }));
    // R1: a flat frame is what produced the silent hang. The framed shape is
    // `{ type, channel: 'files', payload, timestamp }`. The wrap happens in
    // `emit`, the write happens in the router's own `send` — so the observable
    // is the channel's `send`, not `deps.send` (which is the test seam the
    // runtime binds; MAJOR-2).
    expect(deps.send).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'files-error',
        channel: 'files',
        payload: { type: 'files-error', code: 'BAD_FRAME' },
        timestamp: 1_700_000_000_000,
      }),
    );
  });

  it('leaves a binary chunk frame unwrapped on the way out', () => {
    // `frameFiles` is the JSON path; a chunk frame is `Uint8Array` and the
    // browser's raw handler reads it as bytes. Wrapping it would put a
    // `Uint8Array` inside a JSON string. The **inbound** fixture is the
    // binary upload chunk itself (`0x02`, `packages/shared/src/types/
    // files.ts:121`, `BINARY_TYPE_UPLOAD_CHUNK`) — a JSON envelope cannot
    // reach `acceptBinaryChunk`, so emitting one here would test the wrong
    // arm; the outbound frame the session returns is the chunk and it must
    // reach the channel untouched.
    const binary = new Uint8Array(25 + 4);
    binary[0] = 0x02;
    const { deps, r } = router({ files: { handle: () => [], acceptBinaryChunk: () => [binary] } });
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', binary);
    expect(deps.send).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(binary);
  });

  it('drops a frame whose wire channel does not match the label', () => {
    // R2: the Rust drops a misfiled frame (`files.rs:590-592`). Without this
    // the plan handled a `files-list` filed under `terminal` as a files frame.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', envelope('terminal', 'files-list', { path: '' }));
    expect(deps.files.handle).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('drops a frame that carries no envelope at all', () => {
    // A flat frame is not this contract's sender: every browser channel goes
    // through `sendJson`, which emits the envelope.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    channel.emit('message', new TextEncoder().encode('{"type":"files-list","path":""}'));
    expect(deps.files.handle).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('drops an inbound frame over the data-channel cap without decoding it', () => {
    // R4: `MAX_DATA_CHANNEL_FRAME_BYTES` was pinned at `:1105` and enforced
    // nowhere. 64 KiB + 1 is above the SCTP message cap the browser also
    // enforces, so a conforming peer could not have sent it.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const huge = new Uint8Array(64 * 1024 + 1);
    huge[0] = 0x02;
    channel.emit('message', huge);
    expect(deps.files.acceptBinaryChunk).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('accepts an inbound frame exactly at the cap', () => {
    // The positive control for the test above: without it, a cap of `0` would
    // pass the "drops an oversized frame" case just as well.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    const atCap = new Uint8Array(64 * 1024);
    atCap[0] = 0x02;
    channel.emit('message', atCap);
    expect(deps.files.acceptBinaryChunk).toHaveBeenCalledWith(atCap);
  });

  it('routes desktop-select and desktop-bitrate on the control channel', () => {
    // BLOCKING-2: the browser sends both on `control` —
    // `sendJson('control', 'desktop-select', { sourceId })` and
    // `sendJson('control', 'desktop-bitrate', { bitrateBps })`
    // (`desktop-core/src/client.ts:423-430`). `sourceId` is the scheme string
    // the Rust carries verbatim (`desktop.rs:2951-2962`), and the bitrate is
    // clamped at this boundary with Task 17's clamp (the Rust clamps inside
    // `decode_control` too, `desktop.rs:2015-2019`).
    const { deps, r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit('message', envelope('control', 'desktop-select', { sourceId: 'window:0x4a00007' }));
    expect(deps.desktop.onSelect).toHaveBeenCalledWith('window:0x4a00007');
    channel.emit('message', envelope('control', 'desktop-bitrate', { bitrateBps: 99_000_000 }));
    expect(deps.desktop.onControl).toHaveBeenCalledWith({ kind: 'bitrate', bitrate: 20_000_000 });
    channel.emit('message', envelope('control', 'desktop-bitrate', { bitrateBps: 3_000_000 }));
    expect(deps.desktop.onControl).toHaveBeenCalledWith({ kind: 'bitrate', bitrate: 3_000_000 });
  });

  it('closes an unknown label the browser never opens — including a real label from the shared type this port does not serve', () => {
    // `'desktop'` is the capability string and the RTP media label
    // (`packages/shared/src/types/webrtc.ts:7` lists it), not a data channel
    // any peer opens — the browser opens only `terminal`, `control`, `files`
    // (`terminal.ts:544`, `:937`, `:1128`). If a peer ever offered one, the
    // Rust would refuse it too (`rtc.rs:663-689` closes any label that is not
    // the session's accepted one), so closing is the ported behaviour.
    const { r } = router();
    const channel = fakeChannel('desktop');
    r.attach(channel);
    expect(channel.close).toHaveBeenCalledWith();
  });

  it('runs admit before decode before apply, on the control channel', () => {
    // MAJOR-5: the order is the DoS property and it is the Rust's. The gate and
    // the rate cap run BEFORE the JSON parser (`lib.rs:2428-2430` — *"cap
    // AFTER decrypt and the Gate-A check, BEFORE decode/inject"*), then
    // `apply_if_allowed` decodes and injects (`input.rs:277-286`). The earlier
    // version of this test asserted `['decode']` and called that "the order
    // the Rust established" — backwards on both counts. `decode` returns a real
    // event here so the third stage is reached: a `null` decode would stop the
    // chain and the assertion could not tell "apply runs third" from "apply
    // never runs".
    const order: string[] = [];
    const { r } = router({
      input: {
        admit: () => {
          order.push('admit');
          return true;
        },
        decode: () => {
          order.push('decode');
          return { kind: 'pointer-move', x: 0.5, y: 0.5 };
        },
        apply: () => {
          order.push('apply');
          return 7;
        },
      },
    });
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit('message', envelope('control', 'desktop-input', { kind: 'pointer-move', x: 0.5, y: 0.5 }));
    expect(order).toEqual(['admit', 'decode', 'apply']);
  });

  it('never decodes a frame the cap refused — admit alone is the only witness', () => {
    // The discriminating half. A test that only runs admit-true cannot tell
    // "admit is first" from "admit is called at all"; with `admit` refusing,
    // decode and apply must not run — the frame is dropped before the parser.
    const order: string[] = [];
    const { r } = router({
      input: {
        admit: () => {
          order.push('admit');
          return false;
        },
        decode: () => {
          order.push('decode');
          return null;
        },
        apply: () => {
          order.push('apply');
          return null;
        },
      },
    });
    const channel = fakeChannel('control');
    r.attach(channel);
    channel.emit('message', envelope('control', 'desktop-input', { kind: 'pointer-move', x: 0.5, y: 0.5 }));
    expect(order).toEqual(['admit']);
  });

  it('logs and ignores a corrupt JSON frame on any channel', () => {
    const { deps, r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    expect(() => channel.emit('message', new TextEncoder().encode('{oops'))).not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('detach removes the handlers so a late message is ignored', () => {
    // MAJOR-3's restored discriminating fixture. The gate must be **satisfied**
    // — `type` on the envelope, an object payload — so the frame reaches the
    // dispatch arm, and the assertion then measures `detach` and nothing else:
    // with the landed code (which kept the handler), this same fixture produces
    // writes=1 after detach; with the fix, 0. The type is `terminal-data`
    // because `terminal-input` has no producer anywhere on the wire.
    const { deps, r } = router();
    const channel = fakeChannel('terminal');
    r.attach(channel);
    r.detach('terminal');
    channel.emit('message', envelope('terminal', 'terminal-data', { terminalId: 't1', data: 'eA==' }));
    expect(deps.terminal.write).not.toHaveBeenCalled();
    expect(channel.handlerCount('message')).toBe(0);
  });

  it('send() writes through to the attached channel and warns when the channel is absent', () => {
    // MAJOR-2's production `send`. The positive control for the absent case:
    // with the channel attached the JSON string reaches `channel.send`
    // (werift accepts `Buffer | string`); detached, the frame is warned and
    // dropped rather than thrown into the caller's loop.
    const { deps, r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    r.send('files', { type: 'files-error', code: 'BAD_FRAME' });
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: 'files-error', code: 'BAD_FRAME' }));
    r.detach('files');
    r.send('files', { type: 'files-error', code: 'BAD_FRAME' });
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('send() hands a binary frame to the channel untouched', () => {
    // The binary half of `send`: an upload-chunk frame that comes back out
    // (download path) must not be JSON-stringified.
    const { r } = router();
    const channel = fakeChannel('files');
    r.attach(channel);
    r.send('files', new Uint8Array([0x01, 2, 3]));
    expect(channel.send).toHaveBeenCalledWith(new Uint8Array([0x01, 2, 3]));
  });

  it('send() does not double-encode an already-serialised frame (MAJOR-3)', () => {
    // Task 17's builders return `JSON.stringify(…)`, so this is the shape that
    // actually reaches `send()` on the control channel. The assertion is the
    // reader's operation, not "was called": the browser parses exactly once
    // (`webrtc-core/src/data-channel.ts:36`) and gates on
    // `typeof parsed.type === 'string'`. Double-encoding makes `parsed` the
    // *string* of the JSON, so `parsed.type` is `undefined` and every
    // `desktop-*` frame is dropped by the browser with no error at either end.
    // `parsed` must be an object, and its `type` must survive.
    const { r } = router();
    const channel = fakeChannel('control');
    r.attach(channel);
    const frame = JSON.stringify({ type: 'desktop-stats', data: { fps: 30 } });
    r.send('control', frame);
    const wire = channel.send.mock.calls[0]?.[0] as string;
    const parsed: unknown = JSON.parse(wire);
    expect(typeof parsed).toBe('object');
    expect((parsed as Record<string, unknown>).type).toBe('desktop-stats');
    // And the string is on the wire unmodified, not re-wrapped.
    expect(wire).toBe(frame);
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement**

Run: `./apps/agent/node_modules/.bin/vitest run test/session/data-channels.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/session/data-channels.ts
import { MAX_DATA_CHANNEL_FRAME_BYTES } from '../signalling/constants.js';
import { frameFiles } from '../files/protocol.js';
import type { FilesFrame } from '../files/session.js';
import { clampBitrate } from '../desktop/control.js';
// Task 15's wire union. The import is **load-bearing, not cosmetic**: without
// it, `InputEvent` below resolves to the DOM global of the same name (`lib`
// includes `DOM`), and `RouterDeps.input` silently declares the browser's
// event type instead of the agent's. The typecheck caught this only because
// the test fence imported the real one and the two disagreed.
import type { InputEvent } from '../input/decode.js';

/**
 * The three labels this port serves, named after the wire (`WebRTCChannelType`
 * is `terminal | desktop | files | control`, `packages/shared/src/types/
 * webrtc.ts:7`).
 *
 * **Which channel carries what**, measured from the browser's own openers —
 * `apps/web/src/stores/terminal.ts` opens exactly `['terminal']` (`:544`),
 * `['control']` (`:937`) and `['files']` (`:1128`), and `connection.ts:160-165`
 * creates one data channel per requested label:
 *
 * - **`terminal`** — pty create/data/resize/close inbound; `terminal-data` and
 *   `terminal-exit` outbound (both base64-carried `terminalId`-routed frames).
 * - **`files`** — the files JSON vocabulary inbound and outbound, plus the
 *   binary upload-chunk frames (`bytes[0] === 0x02`).
 * - **`control`** — the desktop session's **only** data channel (the Rust says
 *   so verbatim at `lib.rs:2511`): `desktop-select`, `desktop-bitrate` and
 *   `desktop-input` inbound; `desktop-sources`, `desktop-stats`,
 *   `desktop-cursor` and `desktop-e2ee-ack` outbound.
 *
 * `'desktop'` is **not** served and **not** in this map on purpose: on the wire
 * it is the capability string and the RTP media label (`DESKTOP_LABEL` in the
 * offer's capabilities, the m-line for the video track) — a name, not a data
 * channel. No peer opens a `'desktop'` data channel; the Rust registers only
 * `terminal`, `control`, `desktop`, `files` as label constants and selects
 * `CONTROL_LABEL` for `SessionMode::Desktop` (`rtc.rs:73`, `lib.rs:1122-1126`).
 *
 * `input` and `cursor` **do not exist** on the wire: `grep` for
 * `createDataChannel('input')` and `createDataChannel('cursor')` returns zero
 * across the repo, and the Rust registers neither. Input rides `control` as
 * `desktop-input` (`desktop-core/src/client.ts:452,467`; `input.rs:189` gates
 * on `channel == "control"` **and** `type == "desktop-input"`). Cursor updates
 * ride `control` as outbound `desktop-cursor` frames. This map therefore needs
 * no internal discriminant wider than the wire labels — the wire type is
 * already the dispatch key.
 */
export const CHANNEL_LABELS = {
  terminal: 'terminal',
  files: 'files',
  control: 'control',
} as const;

export type ChannelLabel = (typeof CHANNEL_LABELS)[keyof typeof CHANNEL_LABELS];

const KNOWN = new Set<string>(Object.values(CHANNEL_LABELS));

/**
 * The slice of a werift data channel this module needs.
 *
 * werift's real channel has two message surfaces — the `onMessage` **Event**
 * (`channel.onMessage.subscribe(fn)` → `{ unSubscribe }`,
 * `werift/lib/common/src/event.d.ts:14-17`) and the `onmessage` **property**
 * (`channel.onmessage = fn`, werift's own EventTarget emulation) — and only
 * the Event's `subscribe` returns an unsubscribe. The adapter (Plan 1,
 * `packages/webrtc-core/src/adapters/werift.ts:56-66`) wraps `onMessage`
 * behind `onMessage(handler)` and keeps the handler in a closure, so it cannot
 * unsubscribe either. `RouterChannel` therefore asks for the unsubscribe
 * **directly**: the Plan-3 adapter work is expected to expose
 * `on('message', cb) → () => void` by returning the werift `unSubscribe`
 * handle (or removing the handler from its own list, exactly as the fake
 * below does). `detach` is only as real as that return value.
 */
export interface RouterChannel {
  readonly label: string;
  on(event: 'message', cb: (data: ArrayBuffer | Uint8Array | string) => void): () => void;
  close(): void;
  /**
   * The outbound half of the same channel. The real adapters already declare
   * exactly this signature — `packages/webrtc-core/src/adapters/werift.ts:42`
   * and `browser.ts:21` both have `send(data: string | ArrayBuffer |
   * Uint8Array): void` — so declaring it here is stating the contract the
   * transport already satisfies, not inventing a shape. It was missing from
   * this interface, which is why the fence did not compile: `send()` called
   * `channel.send(...)` on a type that had no such member.
   */
  send(data: string | ArrayBuffer | Uint8Array): void;
}

export interface RouterDeps {
  /**
   * The pty seam, shaped as `PtyManager` really is (Task 12): `write` takes
   * the **terminal id and bytes**, not a bare string — a terminal channel
   * carries several sessions, and `terminal-data`'s payload routes them.
   */
  terminal: {
    write(terminalId: string, bytes: Uint8Array): void;
    resize(terminalId: string, cols: number, rows: number): void;
  };
  files: {
    handle(message: { type: string; [key: string]: unknown }): unknown[];
    acceptBinaryChunk(frame: Uint8Array): unknown[];
  };
  desktop: {
    onControl(control: unknown): void;
    onSelect(source: unknown): void;
  };
  /**
   * The input seam, in the order the Rust runs it: **admit → decode → apply**
   * (`lib.rs:2427-2469`).
   *
   * - `admit(now)` is the port of `InputRateLimiter::allow` (`input.rs:141`),
   *   with the operator gate folded in the way `apply_if_allowed`'s first
   *   parameter is. It takes a **timestamp**, not an event — it must run
   *   before decode, so it cannot depend on a decoded event. A closed gate is
   *   a refusal with **no rate accounting** (MAJOR-5 item 5b: the Rust never
   *   reaches the limiter when `allow_input` is false, `lib.rs:2430`), and the
   *   window is the Rust's `floor(now / 1000)` wall-clock index, not elapsed
   *   time since the first call (item 5a).
   * - `decode(bytes)` is Task 15's `decodeInput`; it returns a normalized
   *   `InputEvent` or `null`.
   * - `apply(event, now)` is the bound `applyInput` (`bindInputApply`): it
   *   closes over the live source rect and injector, maps normalized →
   *   absolute, injects, and returns the applied event's `seq ?? null`.
   *
   * The router holds **no geometry**: the rect is the one `desktop-sources`
   * publishes (`DesktopSourceInfo.x/y/width/height`, `desktop.ts:11-27`) and
   * it belongs to the desktop session, not to a wire dispatcher.
   */
  input: {
    admit(now: number): boolean;
    decode(bytes: Uint8Array): InputEvent | null;
    apply(event: InputEvent, now: number): number | null;
  };
  send(label: ChannelLabel, frame: unknown): void;
  logger: { warn(message: string): void };
  /** Injected so the envelope's `timestamp` is pinnable. Defaults to `Date.now`. */
  now?: () => number;
}

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The label gate and per-channel dispatch (B13).
 *
 * Three behaviours the Rust established and this keeps:
 *
 * - **One channel per label.** A second `terminal` channel is closed
 *   immediately. Two open `terminal` channels would deliver pty output to
 *   whichever the browser bound last, and the operator would see an apparently
 *   dead terminal.
 * - **`close()` takes no code argument.** Neither werift nor the Rust API
 *   accepts one; passing one compiles against a wider type and does nothing.
 * - **A `label()` that throws drops the channel without closing it.** werift
 *   throws when the SCTP stream is not yet ready; the channel is then not ours
 *   to close, and calling `close()` on it corrupts the peer connection.
 *
 * Input is **decoded before** the limiter and the injector: an undecodable frame
 * must not reach a platform FFI call, and must not consume rate-limit budget.
 */
export class DataChannelRouter {
  private readonly attached = new Map<string, RouterChannel>();
  /** The unsubscribe `attach` registered, keyed by label — `detach`'s teardown. */
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(private readonly deps: RouterDeps) {}

  attach(channel: RouterChannel): void {
    let label: string;
    try {
      label = channel.label;
    } catch {
      return;
    }
    if (!KNOWN.has(label)) {
      channel.close();
      return;
    }
    if (this.attached.has(label)) {
      channel.close();
      return;
    }
    this.attached.set(label, channel);
    // `on` returns the unsubscribe (the test fake's `handlerCount` reads the
    // same map); keeping it is what makes `detach` real rather than bookkeeping.
    this.unsubscribers.set(label, channel.on('message', (data) => this.handle(label as ChannelLabel, data)));
  }

  /**
   * Removes the listener **and** the channel. Deleting the map entry alone
   * stopped nothing — the handler `attach` registered stayed on the channel and
   * kept delivering late frames after `detach`, which is the defect this
   * version fixes (measured: E2 with a gate-satisfying fixture reached
   * `write` after `detach`). The unsubscribe runs first so a frame already
   * dispatched on this tick's queue still finds `attached` gone.
   */
  detach(label: ChannelLabel): void {
    this.unsubscribers.get(label)?.();
    this.unsubscribers.delete(label);
    this.attached.delete(label);
  }

  private handle(label: ChannelLabel, data: ArrayBuffer | Uint8Array | string): void {
    const bytes = toBytes(data);

    /**
     * **R4: the inbound cap, on every channel, before any decode.**
     *
     * Three caps exist in this plan and none was consulted here.
     * `MAX_INBOUND_FRAME_BYTES` is enforced only on the signalling path (via
     * `guardSize()`; its three call sites are all in `signalling/inbound.ts`),
     * `MAX_DATA_CHANNEL_FRAME_BYTES` is **pinned but unenforced** (asserted at
     * `:1105`, consumed nowhere), and `MAX_FRAME_BYTES` (`:6133`) has no caller
     * at all. `MAX_DATA_CHANNEL_FRAME_BYTES` is the right one for a data
     * channel: it is the SCTP message cap the browser also enforces, and a
     * frame above it could not have arrived over a conforming channel.
     *
     * **Scope: every channel, not only files.** B-12g §1.5 scoped the cap to
     * the files path; this check runs for `terminal` and `control` too, and
     * that broadening is deliberate and declared here. An SCTP message cap is
     * per-channel by construction — a 64 KiB+1 "terminal-data" frame is exactly
     * as impossible as an oversized chunk — so gating it on `label === 'files'`
     * would re-arm the same unenforced-cap hole on the other two channels.
     * Authority did not forbid it; it just did not ask for it.
     *
     * **Drop, do not error.** The Rust's inbound path never answered an
     * oversized frame: the SCTP layer refused it before the handler ran, so
     * the peer is the side that learns. Emitting a `files-error` here would
     * describe a frame the agent did not accept as if it had parsed it far
     * enough to know what it was.
     */
    if (bytes.length > MAX_DATA_CHANNEL_FRAME_BYTES) {
      this.deps.logger.warn(`dropped a ${bytes.length}-byte ${label} frame over the cap`);
      return;
    }

    if (label === CHANNEL_LABELS.files && !(typeof data === 'string') && bytes[0] === 0x02) {
      this.emit(this.deps.files.acceptBinaryChunk(bytes));
      return;
    }

    /**
     * **Input on the control channel: substring guard + admit BEFORE decode.**
     *
     * Input rides the control channel (ADR-26, input.rs:189, lib.rs:2411).
     * In Rust (`lib.rs:2406-2469`), inbound bytes receive a substring check
     * `text.contains("\"desktop-input\"")` before the gate (`allow_input`) and
     * the rate cap (`input_limiter.allow()`), and only then calls `apply_if_allowed`
     * which calls `decode_desktop_input` (the single full JSON parse).
     *
     * Gating on the substring pre-filter here preserves the DoS protection
     * without double-parsing: `admit()` runs BEFORE `decode(bytes)`, so a frame
     * refused by the limiter or closed gate never spends a JSON parse, and
     * non-input control frames bypass this block entirely.
     *
     * The return value of `apply` is the applied event's `seq` (ADR-47) or `null`
     * when the injector refused it; the runtime stores it in the holder
     * `buildCursorFrame` reads. This router does not own that holder.
     */
    if (label === CHANNEL_LABELS.control) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(bytes);
      if (text.includes('"desktop-input"')) {
        if (!this.deps.input.admit((this.deps.now ?? Date.now)())) return;
        const event = this.deps.input.decode(bytes);
        if (event === null) return;
        this.deps.input.apply(event, (this.deps.now ?? Date.now)());
        return;
      }
    }

    const parsed = parseJson(bytes);
    if (parsed === null) {
      this.deps.logger.warn(`dropped a malformed ${label} frame`);
      return;
    }

    /**
     * **R2: unwrap the envelope, read `type` off the envelope, merge it into
     * the body.**
     *
     * The wire frame is `{ channel, type, payload, timestamp }` with `type` a
     * **sibling** of `payload`, never a member of it: `webrtc-core`'s
     * `sendJson` builds exactly that for every channel
     * (`packages/webrtc-core/src/data-channel.ts:74-88`), and the Rust reads
     * the same shape (`files.rs:589-596` matches `envelope.r#type`, then
     * deserialises `envelope.payload` into a struct with no `type` field).
     * The body the session receives therefore carries `type` first and the
     * payload's own fields after — `{ type, ...payload }` — which is the shape
     * Task 11's `list()` reads (`message.path`) and `decodeFilesFrame()`
     * reads (`message.type`) off the **same object**.
     *
     * `type` is spread **first** so a payload that happens to carry its own
     * `type` cannot shadow the envelope's: the envelope's `type` is the wire
     * fact, a payload's would be unverified body data.
     *
     * The Rust drops a misfiled frame — `files.rs:590-592`:
     * `if envelope.channel != FILES_CHANNEL { return Ok(None); }`. The plan
     * handed `parseJson(bytes)` straight to the session and switched on
     * `message.type`, so a frame whose `type` is `files-list` but whose
     * `channel` is `terminal` was handled as a files frame. `attach` reads
     * `channel.label` — the **transport's** label, not the wire's field — so
     * the Rust's guard had no TS counterpart at all.
     *
     * The browser always emits this envelope (`webrtc-core`'s `sendJson`
     * builds it for every channel) but never reads it inbound: `file-core`
     * destructures `{ type, payload }` only and `webrtc-core` validates
     * `parsed.type` only. So the guard is **hardening the port lost**, not a
     * defence against a browser that would otherwise break.
     *
     * A frame with **no** `channel` field is treated as misfiled and dropped:
     * every browser-originated frame carries one, so its absence means the
     * sender is not this contract's sender.
     */
    const envelope = parsed as { type?: unknown; channel?: unknown; payload?: unknown };
    if (envelope.channel !== label) {
      this.deps.logger.warn(`dropped a ${label} frame filed under channel ${String(envelope.channel)}`);
      return;
    }
    if (typeof envelope.type !== 'string') {
      this.deps.logger.warn(`dropped a ${label} frame with no envelope type`);
      return;
    }
    const message =
      typeof envelope.payload === 'object' && envelope.payload !== null
        ? { type: envelope.type, ...(envelope.payload as Record<string, unknown>) }
        : null;
    if (message === null) {
      this.deps.logger.warn(`dropped a ${label} frame with no object payload`);
      return;
    }

    switch (label) {
      case CHANNEL_LABELS.terminal: {
        // **Ruling 1: the terminal vocabulary is `terminal-data`, not
        // `terminal-input`.** The browser's only inbound terminal write is
        // `sendJson('terminal', 'terminal-data', { terminalId, data:
        // uint8ArrayToBase64(bytes) })` (`terminal-core/src/client.ts:179,189`),
        // and the Rust's decoder matches exactly that: `decode_pty_input_with_id`
        // (`pty.rs:181-198`) gates `channel == "terminal" && type ==
        // "terminal-data"`, then STANDARD-decodes `payload.data` and returns
        // `(terminal_id, bytes)`. The plan's previous arm read `message.data`
        // as a plain string and had no terminalId — bytes would have been the
        // base64 **text**, and one channel's stream would have gone to one
        // implicit pty. `terminal-input` has **no producer anywhere** — it now
        // appears in this document only inside comments recording its
        // retirement (no fence constructs one) — so the
        // type is retired here rather than kept as a dead alternative.
        if (message.type !== 'terminal-data') return;
        const { terminalId, data } = message as { terminalId?: unknown; data?: unknown };
        if (typeof terminalId !== 'string' || typeof data !== 'string') return;
        try {
          this.deps.terminal.write(terminalId, new Uint8Array(Buffer.from(data, 'base64')));
        } catch {
          // Non-standard base64 (`Buffer` is lenient where Rust's STANDARD is
          // strict) or a malformed payload: drop, never throw into the channel.
        }
        return;
      }
      case CHANNEL_LABELS.files: {
        this.emit(this.deps.files.handle(message));
        return;
      }
      case CHANNEL_LABELS.control: {
        this.dispatchDesktop(message);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Desktop JSON control on the `control` channel, dispatched by the **real
   * wire types**.
   *
   * The browser sends `sendJson('control', 'desktop-select', { sourceId })`
   * and `sendJson('control', 'desktop-bitrate', { bitrateBps })`
   * (`desktop-core/src/client.ts:423-430`) — there is no `stream-control` type
   * on the wire, and `sourceId` is the **scheme string** the Rust carries
   * verbatim: `desktop.rs:1986-1988` deserialises `{ source_id }` (camelCase)
   * into `StreamControl::SourceSwap(message.source_id)` and the test at
   * `:2951-2962` pins `{"sourceId": "window:0x4a00007"}` →
   * `SourceSwap("window:0x4a00007")`. So `onSelect` receives the raw id
   * string — `monitor:1` / `window:<id>` / `test:0` — and the scheme split
   * stays with the consumer (`source_for`, `desktop.rs:922-948`, splits the
   * same scheme), exactly where the Rust puts it.
   *
   * **Byte source, stated: neither the envelope bytes nor a re-serialisation.**
   * The body is already parsed (`message`); the two real types are decoded
   * here. The comment this replaces claimed the decoders read the top-level
   * frame; they never did — and handing them the envelope's bytes made every
   * decode return `null`, because the envelope's `type` is not a field of the
   * body they match.
   *
   * **Task 17 must follow.** Its `decodeStreamControl` / `decodeDesktopSelect`
   * port (`:7587-7639`) reads a vocabulary the browser never sends —
   * `stream-control`/`action` and `source: { kind, id }`. Re-porting those two
   * decoders to the real vocabulary (`desktop-select { sourceId }`,
   * `desktop-bitrate { bitrateBps }`) is **Task 17's own change** and is out of
   * scope here (its fence is untouched). Until it lands, this boundary decodes
   * the two real types itself and reuses only Task 17's `clampBitrate` — the
   * one piece that is already right, and the same clamp the Rust runs inside
   * `decode_control` (`desktop.rs:2016-2019`). `desktop-input` does not come
   * through here at all: the router's own arm runs **admit → decode → apply**
   * before any dispatch, which is the Rust's real order — the operator gate,
   * then the 120 Hz cap, then `apply_if_allowed` (which is what calls
   * `decode_desktop_input` and injects), `lib.rs:2413-2469`. The landed
   * comment said "decoded before the limiter and the injector — the order the
   * Rust established", which inverted the Rust and put the JSON parse in front
   * of the DoS control that exists to bound it (MAJOR-5). `desktop-e2ee-hello`
   * also
   * arrives on `control` (`desktop-core/src/client.ts:257`); answering it is
   * the e2ee wiring's job, unfenced here, so an unknown type is dropped the
   * way the Rust's `_ => Ok(None)` arm drops it.
   */
  private dispatchDesktop(message: Record<string, unknown>): void {
    if (message.type === 'desktop-select') {
      if (typeof message.sourceId !== 'string') {
        this.deps.logger.warn('dropped a desktop-select frame with no sourceId');
        return;
      }
      this.deps.desktop.onSelect(message.sourceId);
      return;
    }
    if (message.type === 'desktop-bitrate') {
      if (typeof message.bitrateBps !== 'number' || !Number.isFinite(message.bitrateBps)) {
        this.deps.logger.warn('dropped a desktop-bitrate frame with no bitrateBps');
        return;
      }
      this.deps.desktop.onControl({ kind: 'bitrate', bitrate: clampBitrate(message.bitrateBps) });
    }
  }

  /**
   * **R1, the outbound half.** Every JSON frame the files session returns goes
   * out wrapped in `DataChannelMessage`; binary chunk frames go out untouched.
   *
   * `frameFiles` is called **here**, at the boundary, and not inside
   * `FilesSession`. The session is a state machine that answers in frames; the
   * router is the thing that knows what a data channel carries. Putting the
   * wrap in the session would make every session test assert an envelope its
   * subject does not own, and would leave the desktop path — which also emits
   * JSON on a data channel — without one.
   */
  private emit(frames: unknown[]): void {
    const now = this.deps.now ?? Date.now;
    for (const frame of frames ?? []) {
      this.send(CHANNEL_LABELS.files, frame instanceof Uint8Array || typeof frame === 'string' ? frame : frameFiles(frame as FilesFrame, now()));
    }
  }

  /**
   * **R1's `send` half: the production implementation `deps.send` never had.**
   *
   * **The router owns the channel lookup** — `attached` is the map `attach`
   * maintains, so a send goes to the one open channel for that label without a
   * second registry anywhere. `deps.send` exists for the **tests** (and for
   * whatever process wiring finally owns the transport): it is the seam, this
   * method is the real producer, and Task 19's runtime binds the two by
   * constructing the router over deps whose `send` is `router.send`.
   *
   * **An absent channel is warned and dropped, never thrown.** The sending
   * side has no request to answer — a frame queued for a channel that has
   * closed (the browser tab navigating away, the peer connection failing) has
   * no consumer left, and throwing out of a channel callback would kill the
   * pump loop the frame came from. The Rust agrees by construction: its send
   * site (`lib.rs:1839-1848`) logs `files frame send failed` at debug and
   * breaks the pump, it does not propagate into the session.
   */
  send(label: ChannelLabel, frame: unknown): void {
    const channel = this.attached.get(label);
    if (!channel) {
      this.deps.logger.warn(`dropped a ${label} frame with no open channel`);
      return;
    }
    if (frame instanceof Uint8Array) {
      channel.send(frame);
      return;
    }
    // An already-serialised frame goes to the wire as-is. `emit()` above
    // passes strings through untouched (`typeof frame === 'string' ? frame :
    // frameFiles(…)`), and Task 17's builders all return `JSON.stringify(…)`,
    // so without this branch every `desktop-stats` / `desktop-cursor` /
    // `desktop-sources` frame is encoded a second time: the browser's typed
    // listener parses once (`webrtc-core/src/data-channel.ts:34-41`), gets a
    // string, gates on `typeof parsed.type === 'string'`, and never fires —
    // a silent drop on both ends (MAJOR-3).
    if (typeof frame === 'string') {
      channel.send(frame);
      return;
    }
    channel.send(JSON.stringify(frame));
  }
}

/**
 * `clampBitrate` comes from Task 17's module (`../desktop/control.js`). The
 * plan's earlier draft deferred the import behind a CommonJS `require()` —
 * apps/agent is `"type": "module"`, so that `require` never existed at
 * runtime. A static import is the honest shape: the router is attached to
 * every peer, including peers that never open a control channel, but an
 * import is not a branch — the module loads with everything else, and its
 * `clampBitrate` is the one piece of Task 17 this boundary reuses as-is. The
 * two wire decoders it ships are not on the wire the browser speaks (see
 * `dispatchDesktop`'s note) and are not used here.
 */
```

- [ ] **Step 3: Run green, format, commit**

```bash
./apps/agent/node_modules/.bin/vitest run test/session/data-channels.test.ts
./node_modules/.bin/prettier --write apps/agent/src/session/data-channels.ts apps/agent/test/session/data-channels.test.ts
git add apps/agent/src/session apps/agent/test/session
git commit -m "feat(agent): route peer data channels behind the label gate"
```

**TEST-INTEGRITY declaration:** one new file, **23 new `it()` / 40 new `expect()`** —
**17 / 25** as the B-12g repair landed it, **21 / 36** after the R1–R12
follow-up, **23 / 40** after the MAJOR-3 + MAJOR-5 repair (was **12 / 17**
before B-12g; the deltas below carry that figure forward rather than
re-deriving it). All twenty-three are **new**, none ported. An earlier draft claimed six of them as ports (`rejects_an_unknown_channel_label`, `rejects_a_second_channel_with_the_same_label`, `drops_a_channel_whose_label_errors`, `dispatches_terminal_input`, `dispatches_files_frames`, `dispatches_desktop_control`). None of those six names exists in `apps/agent/src`, and neither behaviour they describe has a Rust test: the label gate (`on_data_channel`, `rtc.rs:663-689`) has no test at all, and the only inbound router (`route_inbound`, `lib.rs:2739`) has none either. This is the reason the counts matter — a declaration that claims six ports under-reports new coverage and over-reports parity in the direction that survives review.

On the six-number axes: fence **23 `it()`** / call sites **23** (no `it.each(` in this file — the recipe is not blind to anything here) / runtime **23**; `expect()` fence **40** / call sites **40** / runtime **40**. Every `expect(` in the fence is a single literal occurrence, so all three axes coincide.

**The B-12g repair added five `it()` and eight `expect()`, carried unchanged:**

| test | covers | `it()` | `expect()` |
|---|---|---|---|
| `leaves a binary chunk frame unwrapped on the way out` | R1's outbound half (the JSON path only) | 1 | 2 |
| `drops a frame whose wire channel does not match the label` | R2 inbound | 1 | 2 |
| `drops a frame that carries no envelope at all` | R2's absence case | 1 | 2 |
| `drops an inbound frame over the data-channel cap without decoding it` | R4 | 1 | 2 |
| `accepts an inbound frame exactly at the cap` | R4's **positive control** | 1 | 1 |
| **total** | | **5** | **8** (`leaves…` gained 1: it now also asserts `deps.send` was **not** called) |

**This follow-up adds four `it()` and changes the fence's object set — the deltas:**

| test | covers | status | `expect()` movement |
|---|---|---|---|
| `routes a terminal-data frame to the pty by terminalId, as bytes` | Ruling 1 | **replaces** `routes a frame to the pty` (fixture changed: type, payload, asserted argument) | 1 → 1 |
| `drops a terminal-data frame with no terminalId rather than guessing a session` | Ruling 1's **positive control for the drop** | **new** | +2 |
| `routes desktop-select and desktop-bitrate on the control channel` | BLOCKING-2 + Ruling 2/3 | **replaces** `routes desktop control and select frames to their handlers` (label `desktop`→`control`, types `stream-control`→`desktop-bitrate`, payload shape, asserted values; now 3 asserts) | 2 → 3 |
| `closes an unknown label the browser never opens — including a real label from the shared type this port does not serve` | BLOCKING-2's `'desktop'` ruling | **replaces** membership in the five-label loop (the loop now walks three labels; this pins `'desktop'` is closed, the inverse of the loop) | +1 (new test) |
| `decodes input BEFORE the limiter and the injector, on the control channel` | BLOCKING-2's input routing | **replaced by this repair** — see the MAJOR-5 rows below; the landed fixture moved (`input`/`input-pointer` → `control`/`desktop-input`) but kept the wrong order | 1 → 1 |
| `detach removes the handlers so a late message is ignored` | MAJOR-3 | **same `it()` count**, fixture restored to a **gate-satisfying** frame (`terminal-data` with `terminalId`), and a second assertion added (`handlerCount` = 0) | 1 → 2 |
| `send() writes through to the attached channel and warns when the channel is absent` | MAJOR-2 | **new** | +3 |
| `send() hands a binary frame to the channel untouched` | MAJOR-2's binary half | **new** | +1 |
| `sends whatever the files session returns…` and `leaves a binary chunk frame…` | MAJOR-2's consequence | observable moved from `deps.send` to **`channel.send`** (the write is the router's own `send` now); each gained the `deps.send` not-called assertion | 1→2 each |
| `send() does not double-encode an already-serialised frame (MAJOR-3)` | MAJOR-3 | **new** — reads what the browser's single `JSON.parse` yields (an object), not "`channel.send` was called" | +3 |
| `runs admit before decode before apply, on the control channel` | MAJOR-5 items 1-2 | **replaces** `decodes input BEFORE the limiter and the injector…` — the order is the Rust's real one (`lib.rs:2413-2465`), and `decode` returns a real event so `apply` is reached | 1 → 1 |
| `never decodes a frame the cap refused — admit alone is the only witness` | MAJOR-5 item 2's **discriminating** half | **new** — without it the first test cannot tell "admit is first" from "admit ran" | +1 |

**MAJOR-3 declared:** the `detach` fixture in the landed repair emitted a payload with no `type`, so the (inverted) gate dropped the frame before `detach` was consulted — the test passed for a reason unrelated to `detach` (measured by the probe: E2 with a gate-satisfying fixture reached `write` after `detach`; E3 without `detach` also reached it, so the gate was the only thing making E1 pass). The pre-existing `detach` — `this.attached.delete(label)` with the listener left registered — is fixed here because **this commit's fixture change is what hid it**: `attach` now stores the unsubscribe `on` returns and `detach` calls it before deleting the entry. The fixture is an envelope that satisfies the gate **and** reaches the arm (`terminal-data` with `terminalId` and base64 `data`), not the flat frame, which is no longer this contract's shape. Before → after for that file's fixture: 0 writes after `detach` (for the wrong reason) → 0 writes after `detach` (because the listener is gone — `handlerCount('message')` is now asserted to be 0), and the mutant control (a router that keeps the handler) fails both assertions.

**MAJOR-2 declared:** `send` is now a **public method of the router** — the channel lookup is `attached` (the map `attach` maintains), an absent channel is **warned and dropped, never thrown**, and `emit` routes through it. `deps.send` remains in `RouterDeps` as the seam (the test fake and any future transport owner implement it), and the construction site in the test fence builds `new DataChannelRouter(deps)` **without `as never`** — the type system now sees a complete `RouterDeps`. Whole-document `as never`: **61 → 42** counted outside this paragraph, of which **56 → 36** are real casts — the rest is four English past-tense phrases (one test name, one string literal inside an assertion, two prose sentences) and two fence comments (Task 12's "No `as never` casts", Task 18's "No `as never`"). This paragraph mentions it four times more, so the file total is 46. Twenty casts went and none were added, all in Task 18's two fences: the router construction site, eighteen `attach`-site occurrences (sixteen plain calls and two inside an assertion callback), and the `requireDesktopClamp` return. Task 8/12/14/15/19's casts (12/1/6/5/11) are other tasks' seams, untouched.

**BLOCKING-2 declared:** `CHANNEL_LABELS` is now `{ terminal, files, control }`. `'desktop'` is the capability string and the RTP media label — no peer opens it as a data channel, and the shared type's membership does not make it one; `input`/`cursor` never existed anywhere on the wire. The loop test walks **three** labels, and the new `'desktop'` case pins that a channel with that label is closed — the Rust's `refusing unexpected channel` behaviour (`rtc.rs:663-689`), not silently-routed traffic.

**Ruling 1 declared:** the terminal arm's type is `terminal-data` with a base64 `data` field and a `terminalId` router; `terminal-input` has no producer — before this repair its only two occurrences in the document were the two `envelope('terminal', 'terminal-input', …)` fixtures in the test fence, and both are now `terminal-data` fixtures (the remaining `terminal-input` strings are comments recording the retirement). `RouterDeps.terminal` is shaped as `PtyManager` really is (`write(terminalId, bytes)`, Task 12), not the plan's old string write.

**Ruling 2/3 declared:** `dispatchDesktop` dispatches by the real wire types (`desktop-select` `{ sourceId }`, `desktop-bitrate` `{ bitrateBps }`), reuses only Task 17's `clampBitrate`, and **Task 17's own fence is untouched** — its `decodeStreamControl`/`decodeDesktopSelect` port the wrong vocabulary (`stream-control`/`action`, `source: { kind, id }`) and that re-port is Task 17's change, noted here so the plan carries the obligation.

**Desktop outbound frames — the follow-up register entry (MAJOR-2 addendum, extended 2026-10-24).** Task 17's fence is untouched by this repair, so the obligations below are carried here rather than fixed. They are one class: **Task 17's builders, their own fence, and the browser disagree, and only the browser is the authority.** The probe `.superpowers/probes/b12g-send-stringify-pm/` (`test/frame-shape.test.ts`, `test/payload-fields.test.ts`) measures all of it; Task 17's fence passes 5/5 against its own builders, which is the point — they agree with each other and not with the reader.

1. **The builders produce no envelope.** *(CLOSED by Task 25, `95fd96c` + `833e6c1`.)* At the time this entry was written, `buildStatsFrame` / `buildCursorFrame` / `buildSourcesFrame` returned `{ type, data }`. The Rust builds a full `DataChannelMessage` — `{ type, channel, payload, timestamp }` (`desktop.rs:2048-2085`, `:2093-2101`) — and the browser reads `msg.payload` (`desktop-core/src/client.ts:268-330`). Task 25 re-ported all three builders onto the envelope; `send()`'s string branch (MAJOR-3) only stopped the *double-encoding* and never wrapped the frame, which is why the builders own it.
2. **The payload vocabularies are a third vocabulary.** *(CLOSED by Task 25 for all three frames; the table below is the record of what was measured at BASE.)* Measured gates:

   | frame | the plan sent (BASE) | the browser requires | source |
   |---|---|---|---|
   | `desktop-stats` | `{ seq, fps, bitrate, encodeMsP50, captureMsP50, skippedFrames, profile }` | `width`, `height`, `fps`, `targetBitrateBps` — `parseStats` returns `null` without all four | `client.ts:358-370` |
   | `desktop-cursor` | `shape: string` | `shape: DesktopShape` = `{ png, hotspotX, hotspotY, serial }`; `seq` required; `lastInputSeq?` (landed this commit on the sender side, 2d) | `desktop.ts:95-115` |
   | `desktop-sources` | `{ monitors, windows }` | `{ sources: DesktopSourceInfo[], inputEnabled, peerVerified, cursorInFrame }` | `desktop.ts:11-28`, `:123-139` |

   `DesktopSourceInfo` carries `kind`, `name`, `width`, `height`, **`x`**, **`y`**, `scaleFactor`, `rotation`, `isPrimary`, `default` (`desktop.ts:11-28`). Those `x`/`y` are the source geometry Task 15's `applyInput` needs (2b), so `desktop-sources` is also where the real wiring gets `InputSource` — the argument is not invented at the decode task.
3. **Nothing calls `deps.send` for these frames.** *(STILL OPEN — unaffected by Task 25.)* Task 19's desktop session loop has **zero** real `deps.send` call sites for `desktop-stats` / `desktop-cursor` / `desktop-sources` (measured: 0 in the session body), so whoever ends up producing them must be named when the re-port lands. Task 25 fixed the builders, not the wiring: `buildStatsFrame` / `buildCursorFrame` / `buildSourcesFrame` still have **no production caller** anywhere in `apps/agent/src` (grep: only `data-channels.ts:287`'s docblock mentions one). The `deps.send` seam exists, the router serves `control`, and the frames are now wire-correct — the producer is what is missing.
4. **Desktop-input E2EE decrypt-before-decode has no owner (2c).** When the session is armed, `desktop-input`'s payload is `{ data: <base64> }` (`client.ts:484-494`) and the plaintext inside is the same kind-tagged event. The Rust decrypts **before** the gate and before decode, fail-closed, and rebuilds the envelope (`lib.rs:2413-2427`; the control path at `:2669-2690`). Nothing in the plan owns this: Task 7's `E2eeSession` (`acceptHello` / `encrypt` / `decrypt`) is a WS1 answerer and has no desktop path at all — the old `AgentE2ee`, with its `beginTerminalE2ee`/`isArmed` shape, named a class this plan no longer has — and the `desktop-e2ee-ack` outbound type is named with nothing that builds it: no Produces entry, no builder, no producer. Grep the plan for `desktop-e2ee-ack`. Until it lands, a crypted frame is dropped by `decodeInput` **deterministically** — it returns `null` for a payload with no `kind` tag, which this repair pins with a test — rather than half-parsing; with E2EE active, **every** input frame drops silently, and the re-port must wire the decrypt in front of `admit` to close it.
5. **`verifyOfferIdentity` and `advertisesE2ee` have no production caller in Plan 2.** The Rust admission gate (`lib.rs:1162` in `run_one_session`) is not fenced; Task 19 runtime does not wire `onOffer`. Handed off to Plan 3 alongside the other unfenced session-loop wirings.
6. **The one-session-at-a-time invariant is now a *caller* obligation, and nothing owns it.** The Rust refuses a second hello while a session is live, and it does so at the two dispatch sites rather than in `accept_hello`: the terminal path reads `let already_active = e2ee_guard.is_some();` and negotiates only `if !already_active` (`lib.rs:1313-1316`), the desktop path gates on `if negotiated && e2ee_session.is_none()` (`lib.rs:2364`). **Task 7's `E2eeSession.acceptHello` is a pure static constructor** — it takes no registry, sees no existing session, and cannot refuse anything; a second call simply derives a second key from the same `sessionId` and returns a second ack. So the invariant lives entirely with whoever calls it, and this plan currently has **no such caller at all**: Task 18's router drops an unknown `control` type and Task 19 wires no E2EE dispatch, both recorded above. Whoever lands the wiring must hold the session and check it before calling, or a peer's second hello silently re-keys a live terminal. **The Rust does not test this either**, stated plainly so the gap is not mistaken for a ported guarantee: `already_active` occurs only at those two production lines, `e2ee_session` occurs at seven production sites (`lib.rs:1267,1286,1630,2351,2364,2394,2416`) and **zero** times inside `#[cfg(test)]` (the test module starts at `lib.rs:3045`), and the two tests that drive `accept_hello` (`lib.rs:3548`, `:3691`) call it directly and bypass the gate entirely. This is therefore **not a regression against the authority** — it is an unfenced obligation the port inherits, and the first caller is where it must be pinned.
7. **Task 10's unreadable-root probe is implemented but unfenced.** Rust's `root_resolution_fails_when_missing_not_a_dir_or_unreadable` (`files.rs:3258`) has three arms, asserting `NotFound`, `NotADirectory`, and `PermissionDenied` on a mode-000 directory. Task 10's production code implements the probe via `readdirSync` (`sandbox.ts:83`), but its fence omits that third arm, keeping only missing and not-a-directory. Reverting `readdirSync` to `statSync` leaves the fence 18/18 green because `stat` succeeds on a mode-000 directory owned by the test runner. The test cannot be added without changing the locked count (18 `it()` / 19 `expect()`), so pinning the unreadable-root probe is handed off as an open obligation for Plan 3 / integration tests.

8. **The peer-shell allowlist fails OPEN in the production wiring — `shellPolicy` is optional and nothing supplies it.** *(OPEN — introduced by B41's wiring at `3eac965`; owner: **the transport-wiring task, Plan 3's first**.)* Task 27 taught the runtime to carry a peer-requested shell from the wire to `PtyManager.create`, and taught `PtyManager` to consult `options.policy` before any process exists (`pty.ts:139-141`). Both are correct. What is missing is the policy itself: `RuntimeDeps.shellPolicy` is declared optional (`runtime.ts:190`) and the adapter forwards it only when it is present —

   ```ts
   ...(options.shell === undefined
     ? { shell: this.config.shell }
     : { shell: options.shell, ...(this.deps.shellPolicy ? { policy: this.deps.shellPolicy } : {}) })
   ```

   — so with no policy, `pty.ts:139`'s ternary takes its false arm and the peer's string reaches `host.spawn` **unresolved**. Measured on the blob: `grep shellPolicy` in `apps/agent` returns **five** lines — `runtime.ts:190` (the declaration), `runtime.ts:302-303` (this ternary), and `runtime.test.ts:535`, `:563` (the two cells that pass one). **No production call site supplies it.** Both public entry points are silent on it: `AgentRuntime.start(config, deps = { send: … })` (`runtime.ts:320-327`) and `createAgentRuntime(config)` (`:370-374`), which forwards its argument by name and passes no `deps` at all. So a deployed agent today accepts whatever shell a peer names. The Rust does not: `Some(requested) => shell_policy_for_dispatch.resolve_client_shell(&requested)` runs before the spawn (`lib.rs:1378-1405`), and Task 9's `ShellPolicy` implements exactly that refusal (`shell-policy.ts`).

   **Precisely what is new here, since it is easy to overstate:** `RuntimeDeps` itself pre-dates this commit (`runtime.ts:161` at BASE `4339c0a`, carrying `send`, `now?`, `filesSession?`), and BASE `pty.ts:59` already declared `policy?: ShellPolicy` with the ternary at `:134-136`. New in `3eac965` is only the **wire-facing** half: `RuntimeDeps.pty`, `RuntimeDeps.shellPolicy`, the `runtime.terminal` adapter, and this conditional forward. That is what makes the fail-open reachable from a peer for the first time — before it, no wire path could ask for a shell at all, because there was no `terminal-create` arm. The fix is one line at each entry point (`shellPolicy: new ShellPolicy(…resolved from config…)`), which is why it belongs to whoever wires transport into `createAgentRuntime`, not to a redesign.

9. **Inbound `terminal-data` base64 is not validated, and the `catch` that claims to handle it cannot fire.** *(OPEN, **PRE-EXISTING at BASE** — not introduced by Task 27; owner: **the transport-wiring task, Plan 3's first**, decode-boundary half.)* The arm body is **byte-identical** at BASE `:388-402` and HEAD `:465-479` (`diff` of the two extracted ranges: empty — only its `case` label changed, from an `if (message.type !== …) return;` guard at BASE `:387` to a `case 'terminal-data':` arm at HEAD `:464`): it gates on `typeof data === 'string'`, decodes with `Buffer.from(data, 'base64')`, and wraps the write in `try { … } catch { /* Non-standard base64 (`Buffer` is lenient where Rust's STANDARD is strict) … */ }`. The comment states the divergence accurately and then relies on a guard that does not exist. Measured, not assumed: `Buffer.from('!!!!', 'base64')` → **0 bytes, no throw**; `Buffer.from('@@@A', 'base64')` → 0 bytes, no throw; `Buffer.from('QQ', 'base64')` → `0x41`, i.e. an unpadded string is accepted. Node's decoder discards invalid characters instead of raising, so the `catch` only ever sees an error from `write` itself, and the documented "malformed ⇒ drop" behaviour is in fact **malformed ⇒ write zero or mangled bytes**. The Rust's live path gates the channel and then STANDARD-decodes, which is strict: `if envelope.channel != "terminal" { continue; }` before the type match (`lib.rs:1302-1304`), then `STANDARD_ENGINE.decode(...)` with `Err` → `continue`, so no write (`lib.rs:1474-1480`; `STANDARD_ENGINE` is `STANDARD` aliased at `lib.rs:212`). **Not** `pty.rs:181-198` — that function (`decode_pty_input_with_id`) carries `#[allow(dead_code)]` and has **one** occurrence in the whole crate, its own `pub fn` line; it is the unused mirror of the shipped path, and citing it would send a reader to code that proves nothing about what runs. Carried here rather than repaired because Task 27's dispatch is explicitly the wire-set task and this arm was outside it; recorded because a later reader who trusts the comment will conclude the case is handled.

10. **`terminal-e2ee-hello` and `terminal-e2ee-ack` are unimplemented on the agent side; every peer that offers a terminal key is silently ignored.** *(OPEN — owner: **the transport-wiring task, Plan 3's first**, the same one as items 8 and 9 — named explicitly rather than left unassigned.)* `dispatchTerminal` has exactly **four** arms — `terminal-data` (`:464`), `terminal-create` (`:481`), `terminal-resize` (`:501`), `terminal-close` (`:522`) — and its `default:` returns without answering, mirroring the Rust's `_ => {}`. The browser, however, drives negotiation itself inside `createSession`: it sends `terminal-create` plaintext and then, when an E2EE driver exists, enqueues `terminal-e2ee-hello` on the same ordered send chain (`packages/terminal-core/src/client.ts:113-115`, `:150-154`) and installs its key only from a `terminal-e2ee-ack` (`:343-352`). The Rust answers both — `"terminal-e2ee-hello" =>` at `lib.rs:1307`, emitting `"type": "terminal-e2ee-ack"` at `:1341` — and the port has **no TS production code that names either frame**: `grep -n 'terminal-e2ee'` across `apps/agent/src` and `packages/*/src` returns the Rust sources plus the shared/terminal-core types and the `e2ee/manager.ts` docblock at `:28` that *describes* the hello, and nothing that handles it. `E2eeSession.acceptHello` has **zero production callers** — the only occurrence under `apps/agent/src` is its own declaration (`e2ee/manager.ts:58`); its eight other occurrences are call sites in its own fence, `apps/agent/test/e2ee/manager.test.ts`. The observable consequence is not a crash: the hello is dropped by the `default:` arm, no ack arrives, the browser's `isActive()` stays `false`, and every `terminal-data` frame the peer sends stays **plaintext** by the browser's own contract (`client.ts:173`). So the port silently declines to encrypt a channel the Rust encrypts, and the user is told nothing. That is why this entry names an owner instead of inheriting the "unassigned" phrasing elsewhere in this register: it is the terminal channel's answer to item 4's desktop-side gap, and the same wiring task closes both.

Start the re-port from the reader, not the builder: every field above was already being sent by the Rust before the plan existed, and the browser's parse is the acceptance test.

The `accepts an inbound frame exactly at the cap` case is not padding: the drop test alone passes against a cap of `0`, so without the boundary case the cap test measures only that *something* was dropped.

**R4's cap scope declared (MINOR 8):** the cap check runs for **every** channel, not only files — an SCTP message cap is per-channel by construction, and B-12g §1.5 scoped it to files because that was the path that asked; gating it on `label === 'files'` would re-arm the same unenforced-cap hole on `terminal` and `control`. The two cap tests use a `files` channel because that is the path with an observable consumer; the cap itself is before any label-specific dispatch.

**And none of this file is gated**, which the declaration must say because it is a gap rather than a covered behaviour. `apps/agent/**` is absent from `ci-node.yml`'s `paths:` and the gating test run excludes `@ponter/agent-node` (`:105-111`), so every test above is green locally and invisible in CI. The Plan-3 handoff is the same as Task 19's: the path plus dropping the `!@ponter/agent-node` filter from `:83`, `:86` and `:108`.

The count reconciles as **4 + 5 + 14 = 23**: the four label-gate cases above the table, the five B-12g cases in the table, and fourteen dispatcher/lifecycle cases that are neither. What those fourteen cover, stated as new work: terminal-data routed to the pty by id and as bytes; the no-terminalId drop; files binary `0x02` routed to the files session; files JSON routed to the files session unwrapped; the files session's output sent back wrapped, through the channel; desktop-select and desktop-bitrate on `control`; the `'desktop'` label closed; input running admit → decode → apply on `control`; a refused frame never reaching the decoder; corrupt JSON logged and ignored rather than thrown; `detach` removing the handlers; `send()` writing through to the attached channel and warning when it is absent; `send()` handing a binary frame through untouched; `send()` not double-encoding an already-serialised frame.

**MAJOR-4 declared (typecheck):** the landed Task 18 fences did **not** compile — 4 errors, all in this task's two fences: `this.dispatchDesktop(message, bytes)` against a one-argument declaration (2 errors at the `RouterChannel.send` sites were the same class one level down, `Property 'send' does not exist on type 'RouterChannel'`), and the always-throwing `get label()` fixture inferring `void`. Fixed by declaring the real adapter contract on `RouterChannel` (`send(data: string | ArrayBuffer | Uint8Array): void` — `webrtc-core/src/adapters/werift.ts:42` and `browser.ts:21` both have exactly this), dropping the dead second argument, and annotating the getter `get label(): string`. Measured 4 → 0; the fork is `.superpowers/probes/b12g-fence-typecheck-fix/`.

**MAJOR-5 declared (order):** `deps.input` is `{ admit, decode, apply }` and the arm runs them in that order. The landed version ran `decode → accept → inject` and its comment claimed that was "the order the Rust established"; the Rust runs **gate → limiter → decode → apply** (`lib.rs:2413-2469`), with its own comment reading *"cap AFTER decrypt and the Gate-A check, BEFORE decode/inject"* (`:2428-2430`). The security property is the point: the 120 Hz cap exists to bound the JSON parser, so it must sit in front of it. `admit(now)` takes a **timestamp**, not an event — the landed `accept(_event: InputEvent)` signature could not express the order at all, which is why reordering alone would not have fixed it.

The Rust's gate is the specification for the first four — `rtc.rs:663-689` accepts one label, refuses an unexpected one by closing it, drops an unlabelled channel, and closes a second `terminal` channel. That is parity of *behaviour* being ported without parity of *test* being ported, and the declaration now says so instead of implying the second.

---

### Task 19: Runtime lifecycle and the desktop session loop

**Files:**
- Create: `apps/agent/src/desktop/session.ts`
- Create: `apps/agent/src/runtime.ts`
- Create: `apps/agent/src/index.ts`
- Test: `apps/agent/test/runtime.test.ts`, `apps/agent/test/desktop/session.test.ts`

**Interfaces:**
- Consumes: every prior task, and — load-bearing — **`packetizeAnnexB`** (Plan 1 Task 3) and the **`RTCRtpSenderLike`** seam (Plan 1 Task 2). For MAJOR-1 the runtime consumes `FilesSession` (Task 11), `FilesRoot` (Task 10), `FilesTicker`, `IDLE_TICK_MS`, `ACK_TICK_MS` (its own file), and `FILES_IDLE_TIMEOUT_MS` (Task 11) in the wiring test.
- Produces:
  - `class DesktopSession { constructor(deps); start(source, profile, bitrate): Promise<void>; control(control: StreamControl): void; select(source: DesktopSource): Promise<void>; stop(): Promise<void> }`
  - `function resolveDefaultSource(config, sources): DesktopSource`
  - `class AgentRuntime { constructor(config, deps); static async start(config, deps?): Promise<AgentRuntime>; status(): RuntimeStatus; async stop(): Promise<void> }` — `deps` is the named `RuntimeDeps`, shared verbatim by the constructor and `static start` so the two cannot drift (MAJOR-6). It carries `send(label, frame)` (the seam Task 18's router exposes — the runtime→router binding is `send: router.send`), an optional `now`, and an optional `filesSession` factory (MAJOR-1's test seam; the default constructs the real `FilesRoot.open` + `FilesSession` and owns the two tick intervals)
  - `function createAgentRuntime(config): Promise<AgentRuntime>`

**⚠️ The video path, stated once because an earlier draft of this task got it
wrong.** Desktop frames do **not** travel over a data channel. They leave the
agent as **RTP**, through `sender.writeRtp(packet)` on the werift adapter's
sender (Plan 1 Task 2), after `packetizeAnnexB` (Plan 1 Task 3) turns the
encoder's Annex-B access unit into RFC 6184 mode-1 packets. That is what the
Rust did — `apps/agent/src/desktop.rs:1767-1776` hands the buffer to
`TrackLocalStaticSample.sample_writer(ssrc, payload_type).write_sample(&sample)`
and the `rtc-rtp` crate packetizes it. `deps.send('control', …)` in this task
is **not** the video path: it is for the JSON control/status frames
(`desktop-stats`, `desktop-cursor`, `desktop-sources` — B56/B58/B61) which do
travel on the **`control`** data channel — the label the browser opens
(`desktop-core/src/client.ts:503`) and the Rust selects for `SessionMode::Desktop`
(`rtc.rs:73` at `lib.rs:1124`), not `'desktop'`, which is the capability string
and the RTP media label only (Task 18's BLOCKING-2). An earlier draft routed
`encoded.data` straight to `deps.send('control', …)`, which would have put raw
Annex-B bytes
on a data channel and produced a black video with no error anywhere.

- [ ] **Step 1: Write the failing default-source test**

```ts
// apps/agent/test/runtime.test.ts
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, FilesTicker, IDLE_TICK_MS, resolveDefaultSource } from '../src/runtime.js';
import { FILES_IDLE_TIMEOUT_MS } from '../src/files/protocol.js';
import type { AgentConfig } from '../src/config.js';

const sources = {
  monitors: [
    { id: '1', primary: false },
    { id: '2', primary: true },
  ],
};

describe('resolveDefaultSource', () => {
  it('prefers the primary monitor by default', () => {
    expect(resolveDefaultSource('primary', sources)).toEqual({ kind: 'monitor', id: '2' });
  });

  it('honours an explicit monitor id', () => {
    expect(resolveDefaultSource('monitor:1', sources)).toEqual({ kind: 'monitor', id: '1' });
  });

  it('falls back to the first monitor when none is flagged primary', () => {
    const flat = { monitors: [{ id: '7', primary: false }] };
    expect(resolveDefaultSource('primary', flat)).toEqual({ kind: 'monitor', id: '7' });
  });

  it('resolves the test source', () => {
    expect(resolveDefaultSource('test', sources)).toEqual({ kind: 'test' });
  });

  it('throws a named error when there are no sources at all', () => {
    expect(() => resolveDefaultSource('primary', { monitors: [] })).toThrow(/no monitors/);
  });

  it('throws for an unknown selector rather than silently picking one', () => {
    // A typo in AGENT_DESKTOP_DEFAULT_SOURCE must fail at startup. Defaulting
    // would stream the wrong monitor and look like a capture bug.
    expect(() => resolveDefaultSource('moniter:1', sources)).toThrow(/unknown desktop source/);
  });
});

describe('FilesTicker', () => {
  /**
   * **R3: the production tick owner.** `checkIdle()` and `flushAcks()` were
   * defined and never called outside the fences — measured at B-12g's commit:
   * `setInterval` appeared **0** times in the whole document, and `checkIdle`'s
   * only callers were two assertions inside Task 11's session fence. A state
   * machine with an idle deadline and a 20 ms ack flush, driven by nobody,
   * never fires either one: a stalled transfer is never reaped and a low-rate
   * upload never acknowledges. This follow-up wires the driver (MAJOR-1) — the
   * `AgentRuntime` wiring tests at the end of this file own the intervals; the
   * class here keeps the injected clock so no test sleeps.
   *
   * The Rust drove both from `lib.rs:1852-1858`, ticked at `:1890` and
   * `:1898-1899` — 1 s for idle, 20 ms for acks. The port keeps the injected
   * clock: `now` is a parameter here exactly as it is in `FilesSession`, so
   * the tick is testable by advancing a number rather than by sleeping.
   */
  function ticker() {
    const calls: string[] = [];
    const session = {
      // `(): unknown[] => …`, not a bare `() => []`: the bare arrow infers
      // `never[]`, so `mockReturnValue([idleFrame])` in the emit test is
      // unassignable and the mock can only ever return `[]` — a type-level
      // vacuity (MAJOR-6 item 3: the annotation is the fix; the type was
      // hiding it).
      checkIdle: vi.fn((): unknown[] => {
        calls.push('idle');
        return [];
      }),
      flushAcks: vi.fn((): unknown[] => {
        calls.push('acks');
        return [];
      }),
    };
    const emit = vi.fn();
    let now = 0;
    const t = new FilesTicker(session, {
      now: () => now,
      emit,
    });
    return {
      session,
      emit,
      calls,
      t,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('calls checkIdle once per 1000 ms of elapsed time', () => {
    const { t, session, advance } = ticker();
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled(); // no time has passed
    advance(999);
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled();
    advance(1);
    t.tick();
    expect(session.checkIdle).toHaveBeenCalledTimes(1);
  });

  it('calls flushAcks once per 20 ms of elapsed time', () => {
    const { t, session, advance } = ticker();
    advance(19);
    t.tick();
    expect(session.flushAcks).not.toHaveBeenCalled();
    advance(1);
    t.tick();
    expect(session.flushAcks).toHaveBeenCalledTimes(1);
  });

  it('catches up on idle ticks it slept through, rather than dropping them', () => {
    // A tick interval that overshoots must not lose a reap: the idle deadline
    // is wall-clock, so skipping a `checkIdle` because the timer was 3 s late
    // leaves a timed-out transfer alive for another full period.
    const { t, session, advance } = ticker();
    advance(3_500);
    t.tick();
    expect(session.checkIdle).toHaveBeenCalledTimes(3);
  });

  it('emits whatever either tick returns', () => {
    const { t, session, emit, advance } = ticker();
    const idleFrame = { type: 'files-error', code: 'TRANSFER_TIMEOUT' };
    const ackFrame = { type: 'files-upload-ack', nextChunkIndex: 16 };
    session.checkIdle.mockReturnValue([idleFrame]);
    session.flushAcks.mockReturnValue([ackFrame]);
    advance(1_000);
    t.tick();
    expect(emit).toHaveBeenCalledWith(idleFrame);
    expect(emit).toHaveBeenCalledWith(ackFrame);
  });

  it('stops ticking after stop()', () => {
    const { t, session, advance } = ticker();
    t.stop();
    advance(5_000);
    t.tick();
    expect(session.checkIdle).not.toHaveBeenCalled();
    expect(session.flushAcks).not.toHaveBeenCalled();
  });
});

describe('AgentRuntime — the production tick wiring (MAJOR-1)', () => {
  /**
   * **MAJOR-1: the driver must be wired, not merely defined.** The ticker tests
   * above prove the state machine; these prove the runtime actually constructs
   * it and clears its intervals on `stop()`. They use the real
   * `setInterval`/`clearInterval` under `vi.useFakeTimers()`, so the handles
   * are the production ones — a wiring test that mocked the timer would prove
   * nothing about `setInterval` ownership. The session is injected through the
   * `filesSession` seam so the emitted frame is observable without a real
   * `FilesSession` root; the production values of that seam are themselves
   * covered by Task 11's `FilesSession` fence.
   */
  function wiring(overrides: Partial<AgentConfig> = {}) {
    const config = {
      filesRoot: '/data',
      desktopProfile: { id: '720p30' },
      ...overrides,
    } as unknown as AgentConfig;
    const sent: { label: string; frame: unknown }[] = [];
    const session = {
      // One frame, not an empty list: test 3 asserts the guard by absence, and
      // a session whose `checkIdle` never emits makes the empty-array assertion
      // pass even with the guard deleted (the fixture-vacuity class). The
      // shape is test 1's frame so the assertion has a real violation to
      // forbid.
      checkIdle: vi.fn(() => [{ type: 'files-error', code: 'TRANSFER_TIMEOUT' }] as unknown[]),
      flushAcks: vi.fn(() => [] as unknown[]),
    };
    const deps = {
      send: (label: string, frame: unknown) => sent.push({ label, frame }),
      // Real clock, not a constant: `FilesTicker.tick()` computes
      // `now - lastIdleAt`, so a constant closure freezes that at 0 forever
      // and no tick ever runs (the frozen-clock defect this fence shipped
      // with). `vi.useFakeTimers()` mocks `Date.now`, so the closure must
      // actually call it for `advanceTimersByTimeAsync` to move it.
      now: () => Date.now(),
      filesSession: () => session,
    };
    return { config, deps, sent, session };
  }

  it('drives the files session from real intervals and emits idle frames through send', async () => {
    vi.useFakeTimers();
    try {
      const { config, deps, sent, session } = wiring();
      session.checkIdle = vi.fn(() => [{ type: 'files-error', code: 'TRANSFER_TIMEOUT' }]);
      const runtime = await AgentRuntime.start(config, deps);
      expect(sent).toEqual([]);
      // One idle period: `checkIdle` runs once and its frame goes out on the
      // `files` channel — the label Task 18's router serves.
      await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
      expect(session.checkIdle).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([{ label: 'files', frame: { type: 'files-error', code: 'TRANSFER_TIMEOUT' } }]);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears the tick intervals so no late tick fires', async () => {
    vi.useFakeTimers();
    try {
      const { config, deps, sent, session } = wiring();
      session.checkIdle = vi.fn(() => [{ type: 'files-error', code: 'TRANSFER_TIMEOUT' }]);
      const runtime = await AgentRuntime.start(config, deps);
      await runtime.stop();
      // Well past several idle periods: nothing fires, because the handles are
      // cleared. Without the clearing this emits one frame per elapsed period.
      await vi.advanceTimersByTimeAsync(FILES_IDLE_TIMEOUT_MS * 3);
      expect(session.checkIdle).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the ticker entirely when the config has no files root', async () => {
    // The Rust's files manager is `Option<FilesManager>`; a config without a
    // root must not open one, and must not tick a session that does not exist.
    // The fixture emits (checkIdle returns a frame, exactly like test 1's) so
    // the `[]` assertion has something to be violated by: a session whose
    // checkIdle never emits would pass with the guard deleted, the same
    // vacuous-fixture class as the detach case (PM probe forkE — 59 leaked
    // frames when the guard is gone). `Date.now()` in `wiring()` is
    // load-bearing too: a constant closure (`now: () => 1_000_000`) freezes
    // the ticker's catch-up arithmetic at `now - lastIdleAt = 0` forever —
    // fake timers mock `Date.now` and cannot move a closure that never calls
    // it.
    vi.useFakeTimers();
    try {
      const { config, deps, sent } = wiring({ filesRoot: null });
      const runtime = await AgentRuntime.start(config, deps);
      await vi.advanceTimersByTimeAsync(FILES_IDLE_TIMEOUT_MS * 2);
      expect(sent).toEqual([]);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('status() reports the config it was started with', async () => {
    // MAJOR-6 item 4: `status()` is the only runtime member with no caller
    // anywhere in the fence — its five config fields are exactly what the
    // constructor wiring exists to produce, and the landed class (no
    // constructor) could not have compiled this call. `start` with no
    // `filesSession` and no `filesRoot` keeps the interval wiring out of the
    // assertion; the assertion reads what the wiring produced, not the
    // process.
    const config = {
      agentId: 'agent-1',
      server: 'wss://host/x',
      filesRoot: null,
      allowInput: true,
      desktopProfile: { id: '720p30' },
    } as unknown as AgentConfig;
    const runtime = await AgentRuntime.start(config);
    try {
      expect(runtime.status()).toEqual({
        agentId: 'agent-1',
        connected: false,
        server: 'wss://host/x',
        filesRoot: null,
        allowInput: true,
        desktopProfile: '720p30',
      });
    } finally {
      await runtime.stop();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement `runtime.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/runtime.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/runtime.ts
import type { ProfileId } from '@ponter/shared';
import type { AgentConfig } from './config.js';
import { FilesRoot } from './files/sandbox.js';
import { FilesSession } from './files/session.js';
import type { DesktopSource } from './desktop/control.js';

export interface DesktopSourceList {
  monitors: { id: string; primary: boolean }[];
}

/**
 * The two Rust tick periods (`lib.rs:1852-1858`). Named rather than inlined so
 * the intervals are greppable from the tests that assert them — the Rust's
 * were magic numbers at the call sites, which is part of why the port lost them.
 */
export const IDLE_TICK_MS = 1_000;
export const ACK_TICK_MS = 20;

/**
 * Resolves `AGENT_DESKTOP_DEFAULT_SOURCE` (B59).
 *
 * `primary` means "the monitor flagged primary, else the first one" — a headless
 * or virtual host commonly reports no primary at all, and failing there would
 * make the zero-click onboarding path dead on exactly the machines that need it.
 *
 * An unrecognised selector **throws**. Silently falling back to `primary` would
 * turn a typo in the operator's env into a stream of the wrong monitor, which
 * reads as a capture bug and is diagnosed hours later.
 */
export function resolveDefaultSource(selector: string, sources: DesktopSourceList): DesktopSource {
  if (selector === 'test') return { kind: 'test' };
  if (selector === 'primary') {
    if (sources.monitors.length === 0) throw new Error('no monitors are available to capture');
    const primary = sources.monitors.find((m) => m.primary) ?? sources.monitors[0];
    return { kind: 'monitor', id: primary.id };
  }
  const monitor = /^monitor:(.+)$/.exec(selector);
  if (monitor) {
    if (!sources.monitors.some((m) => m.id === monitor[1])) {
      throw new Error(`unknown desktop source ${selector}`);
    }
    // Present in `sources` but possibly captured by another process; the capture
    // layer reports that, not this resolver.
    return { kind: 'monitor', id: monitor[1] };
  }
  throw new Error(`unknown desktop source ${selector}`);
}

/**
 * The tick owner (R3) — the production caller `checkIdle()` and `flushAcks()`
 * did not have.
 *
 * The Rust drove two ticks: `idle_tick` at 1 s and `ack_tick` at 20 ms
 * (`apps/agent/src/lib.rs:1852-1858`, driven at `:1890` and `:1898-1899`). In
 * this plan the two functions existed and were called **only from test
 * assertions** — so a stalled transfer was never reaped and a slow upload was
 * never acknowledged, with no error anywhere.
 *
 * **Two intervals, one entry point, and the driver outside.** `tick()` is
 * called from a `setInterval` the runtime owns (not from here), which keeps
 * this class free of a real timer and therefore testable by advancing a number.
 * The clock is injected for the same reason `FilesSession`'s is: the deadline
 * arithmetic is what the tests need to control.
 *
 * **Catch up, do not drop.** If the timer fires late — a busy event loop, a GC
 * pause, a suspended laptop — the elapsed time may span several idle periods.
 * Calling `checkIdle()` once for 3.5 s of elapsed time leaves a timed-out
 * transfer alive for another full period; the idle deadline is wall-clock, so
 * the reap owed is proportional to the time that passed. Measured as a
 * count, not a boolean.
 *
 * **`flushAcks()` is called once per tick, not once per 20 ms elapsed.** Its
 * contract (§R7) is "take whatever is pending, with no gate" — calling it more
 * than once within a period cannot produce a second ack because `pendingAck`
 * is cleared on the first, so a catch-up loop there would be dead code that
 * reads as work.
 */
export class FilesTicker {
  private readonly now: () => number;
  private readonly emit: (frame: unknown) => void;
  private lastIdleAt: number;
  private lastAckAt: number;
  private stopped = false;

  constructor(
    private readonly session: {
      checkIdle(): unknown[];
      flushAcks(): unknown[];
    },
    deps: { now: () => number; emit: (frame: unknown) => void },
  ) {
    this.now = deps.now;
    this.emit = deps.emit;
    this.lastIdleAt = deps.now();
    this.lastAckAt = deps.now();
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();

    // Catch up: one `checkIdle()` per whole idle period that has elapsed.
    while (now - this.lastIdleAt >= IDLE_TICK_MS) {
      this.lastIdleAt += IDLE_TICK_MS;
      for (const frame of this.session.checkIdle()) this.emit(frame);
    }

    // One flush per tick. `flushAcks()` clears `pendingAck`, so a second call
    // in the same period is a no-op — see the class note.
    if (now - this.lastAckAt >= ACK_TICK_MS) {
      this.lastAckAt = now;
      for (const frame of this.session.flushAcks()) this.emit(frame);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

export interface RuntimeStatus {
  agentId: string;
  connected: boolean;
  server: string;
  filesRoot: string | null;
  allowInput: boolean;
  /** The profile **id** the config resolved to, not the whole record. */
  desktopProfile: ProfileId;
}

/**
 * The lifecycle owner (B14/B53).
 *
 * It exists as a class rather than a bag of closures for one reason: `stop()`
 * must be idempotent and must tear down in a fixed order — desktop session,
 * files session, pty sessions, then the socket — because a pty that outlives the
 * socket leaves an orphan shell on the host. The order is `stop()`'s
 * implementation, not a caller's responsibility.
 *
 * `createAgentRuntime` is the only public entry point; `AgentRuntime.start` is
 * exported for tests that want a handle without the process-level wiring.
 *
 * **MAJOR-1: the tick driver lives here.** `FilesSession` carries the idle
 * deadline and the 20 ms ack flush, but it is a state machine — something must
 * call `checkIdle()`/`flushAcks()` or neither ever fires. The Rust drove both
 * from one `tokio::select!` loop (`lib.rs:1845-1910`: `idle_tick` at 1 s,
 * `ack_tick` at 20 ms). The port's equivalent is two `setInterval` handles the
 * runtime owns: `IDLE_TICK_MS` and `ACK_TICK_MS`, both firing `ticker.tick()`,
 * whose catch-up arithmetic turns elapsed wall time into the right number of
 * calls. A config with no `filesRoot` has no `FilesSession` and no ticker,
 * matching the Rust's `Option<FilesManager>` handling, and `stop()` clears both
 * handles before anything else so a late tick cannot fire against a torn-down
 * session.
 */
export interface RuntimeDeps {
  send: (label: string, frame: unknown) => void;
  now?: () => number;
  filesSession?: (root: string, now: () => number) => { checkIdle(): unknown[]; flushAcks(): unknown[] };
}

export class AgentRuntime {
  private stopped = false;
  private readonly tickers: NodeJS.Timeout[] = [];

  /**
   * MAJOR-6: the class declared **no constructor** while `static start` called
   * `new AgentRuntime(deps)` and `status()` read five `this.config.*` fields —
   * so the class could not implement its own `RuntimeStatus` interface and the
   * fence did not typecheck (8 errors, 6 of them here). `config` and `deps` are
   * parameter properties: the class holds exactly what `status()` and `stop()`
   * read, and `RuntimeDeps` is the **one** declaration both this constructor
   * and `static start` use, so the two cannot drift.
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly deps: RuntimeDeps,
  ) {}

  /**
   * **MAJOR-1's test seam, and the honest shape of Plan 2's wiring.** The
   * production values construct the real session (`FilesRoot.open` +
   * `FilesSession`) and emit through `send`; a test overrides `filesSession`
   * with a fake state machine and observes the tick through its emit. The
   * `send` seam is the one Task 18's router exposes (`router.send`), so the
   * runtime→router binding is `send: router.send` once Task 18 lands in the
   * same binary.
   */
  static async start(
    config: AgentConfig,
    deps: RuntimeDeps = {
      send: () => {
        throw new Error('no transport is wired yet');
      },
    },
  ): Promise<AgentRuntime> {
    const runtime = new AgentRuntime(config, deps);
    if (config.filesRoot) {
      const now = deps.now ?? Date.now;
      const session = deps.filesSession
        ? deps.filesSession(config.filesRoot, now)
        : new FilesSession(FilesRoot.open(config.filesRoot), now);
      const ticker = new FilesTicker(session, {
        now,
        emit: (frame) => deps.send('files', frame),
      });
      runtime.tickers.push(
        setInterval(() => ticker.tick(), IDLE_TICK_MS),
        setInterval(() => ticker.tick(), ACK_TICK_MS),
      );
    }
    return runtime;
  }

  status(): RuntimeStatus {
    return {
      agentId: this.config.agentId,
      connected: false,
      server: this.config.server,
      filesRoot: this.config.filesRoot,
      allowInput: this.config.allowInput,
      desktopProfile: this.config.desktopProfile.id,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.tickers.splice(0)) clearInterval(handle);
  }
}

export async function createAgentRuntime(config: AgentConfig): Promise<AgentRuntime> {
  return AgentRuntime.start(config);
}
```

- [ ] **Step 3: Write the failing desktop-session test**

```ts
// apps/agent/test/desktop/session.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DesktopSession } from '../../src/desktop/session.js';

function deps() {
  return {
    capture: {
      sources: vi.fn(async () => ({ monitors: [{ id: '1', primary: true }], windows: [] })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      nextFrame: vi.fn(async () => ({ width: 4, height: 4, rgba: new Uint8Array(64).fill(7), seq: 1 })),
    },
    encode: {
      configure: vi.fn(),
      encode: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), keyframe: true })),
      close: vi.fn(),
    },
    /**
     * The RTP sink. Left as a null sender by default so the existing
     * encode/skip/ladder tests are unaffected; the RTP path has its own tests
     * below, which install a real fake sender.
     */
    rtp: {
      sender: vi.fn(() => null as { writeRtp(packet: Uint8Array): void } | null),
      payloadType: vi.fn(() => null as number | null),
    },
    send: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    now: () => 0,
    rtpClock: () => 0,
  };
}

describe('DesktopSession', () => {
  it('configures the encoder with the profile gop before the first frame', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(d.encode.configure).toHaveBeenCalledWith(expect.objectContaining({ gop: 60 }));
    expect(d.capture.start).toHaveBeenCalled();
  });

  it('clamps the initial bitrate through the same decode path', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1);
    expect(d.encode.configure).toHaveBeenCalledWith(expect.objectContaining({ bitrate: 250_000 }));
  });

  it('stops capture before closing the encoder', async () => {
    const order: string[] = [];
    const d = deps();
    d.capture.stop = vi.fn(async () => {
      order.push('capture');
    });
    d.encode.close = vi.fn(() => {
      order.push('encoder');
    });
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    await session.stop();
    expect(order).toEqual(['capture', 'encoder']);
  });

  it('re-configures the encoder on a quality change', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '1080p60', 4_000_000);
    d.encode.configure.mockClear();
    session.control({ kind: 'quality', profile: '720p30' });
    expect(d.encode.configure).toHaveBeenCalledWith(expect.objectContaining({ gop: 60 }));
  });

  it('resets the static-skip on a bitrate change', async () => {
    // One of the three reset sites: a bitrate change invalidates nothing about
    // the pixels, but the encoder's quantiser just moved, so the next identical
    // frame must still be sent or the browser keeps the pre-retarget picture.
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    const before = session.stats().skippedFrames;
    session.control({ kind: 'bitrate', bitrate: 2_000_000 });
    expect(session.stats().skippedFrames).toBe(before);
    expect(session.skipIsReset()).toBe(true);
  });

  it('applies a bitrate received before the first encode', async () => {
    // P5 contradiction #15: the Rust's apply_bitrate returned cmInitExpected
    // before the first frame and the production arm only warned, so the setting
    // was silently lost with no retry. The TS stores the value and applies it
    // when the encoder is configured, because losing it is a defect, not a
    // behaviour worth reproducing.
    const d = deps();
    const session = new DesktopSession(d as never);
    session.control({ kind: 'bitrate', bitrate: 3_000_000 });
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(d.encode.configure).toHaveBeenCalledWith(expect.objectContaining({ bitrate: 3_000_000 }));
  });

  it('reports a stats frame with the sustained profile', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '1080p60', 4_000_000);
    expect(session.stats().profile).toBe('1080p60');
  });

  it('encodes a changed frame on pump and writes it to RTP, not to a data channel', async () => {
    // The bug this pins: an earlier draft of this task sent the encoder's
    // The bug this pins: an earlier draft of this task sent the encoder's
    // Annex-B buffer to `deps.send('control', …)`, i.e. down a data channel.
    // That produces no error and a black video, because a data channel does not
    // carry RTP. The assertion that matters is therefore NOT "a frame was
    // delivered somewhere" — it is that the bytes reached `writeRtp` after
    // being packetized, and that `deps.send` was NOT used for them.
    const d = deps();
    // A real Annex-B access unit: 4-byte start code + one NAL (type 5, IDR).
    // The default mock returns `[1,2,3]`, which has no start code at all and
    // would make `packetizeAnnexB` throw — so this test installs its own.
    d.encode.encode = vi.fn(async () => ({
      data: new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]),
      keyframe: true,
    }));
    const written: Buffer[] = [];
    d.rtp.sender = vi.fn(() => ({ writeRtp: (p: Uint8Array) => written.push(Buffer.from(p)) }));
    d.rtp.payloadType = vi.fn(() => 102);
    const session = new DesktopSession(d as never);
    session.setRtpIdentity(0x1234);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);

    expect(await session.pump()).toBe(true);
    expect(d.encode.encode).toHaveBeenCalledTimes(1);

    // One NAL unit in one packet: a single type-5 slice under 1188 bytes
    // becomes one single-NAL-unit packet.
    expect(written).toHaveLength(1);
    const packet = written[0]!;
    // 12-byte RTP header + the 4 NAL bytes (start code stripped).
    expect(packet.length).toBe(12 + 4);
    expect(packet[0]! >> 6).toBe(2); // RTP version 2
    expect(packet[1]! & 0x7f).toBe(102); // the negotiated payload type
    expect(packet.readUInt32BE(8)).toBe(0x1234); // SSRC from setRtpIdentity
    // Annex-B framing is gone: the start code must not survive into the payload.
    expect([...packet.subarray(12, 16)]).not.toEqual([0, 0, 0, 1]);
    expect(packet[12]).toBe(0x65); // the NAL header byte

    // And the video did NOT go down a data channel.
    expect(d.send).not.toHaveBeenCalled();
  });

  it('drops a frame instead of throwing when no sender exists yet', async () => {
    // The zero-click path starts capture before the browser offers, so the
    // first frames have nowhere to go. Dropping is correct; buffering would
    // replay a stale picture the moment a peer connected.
    const d = deps();
    d.rtp.sender = vi.fn(() => null);
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    await expect(session.pump()).resolves.toBe(true);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('skips a repeated frame but keeps the keepalive', async () => {
    const d = deps();
    let n = 0;
    d.capture.nextFrame = vi.fn(async () => {
      n += 1;
      return { width: 4, height: 4, rgba: new Uint8Array(64).fill(7), seq: n };
    });
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(await session.pump()).toBe(true); // baseline
    expect(await session.pump()).toBe(false); // skipped
    expect(session.stats().skippedFrames).toBe(1);
  });

  it('downgrades on pump after 30 over-budget frames and resets the skip', async () => {
    const d = deps();
    let clock = 0;
    d.now = () => (clock += 40);
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '1080p60', 4_000_000);
    for (let i = 0; i < 30; i += 1) await session.pump();
    expect(session.stats().profile).toBe('720p60');
    expect(session.skipIsReset()).toBe(true);
    expect(d.encode.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: '720p60', gop: 120 }),
    );
  });
});
```

- [ ] **Step 4: Run it and watch it fail, then implement `desktop/session.ts`**

Run: `./apps/agent/node_modules/.bin/vitest run test/desktop/session.test.ts`
Expected: FAIL — module unresolved.

```ts
// apps/agent/src/desktop/session.ts
import type { ProfileId } from '@ponter/shared';
import { packetizeAnnexB } from '../session/packetizer.js';
import { clampBitrate, gopForFps, type DesktopSource, type StreamControl } from './control.js';
import { StaticFrameSkip, type RawFrame } from './static-skip.js';
import { SustainLadder } from './sustain.js';
import { FrameTimingRing } from './timing-ring.js';

/**
 * The slice of `RTCRtpSenderLike` (Plan 1 Task 2) this module needs.
 *
 * `writeRtp` takes the **complete** RTP packet — the packetizer builds the
 * 12-byte header, the adapter only adds SSRC/PT/seq/timestamp bookkeeping. This
 * is the RTP path, not a data channel; see the task preamble.
 */
export interface RtpSenderSink {
  writeRtp(packet: Uint8Array): void;
}

const PROFILES: Record<ProfileId, { fps: number; width: number; height: number }> = {
  '1080p60': { fps: 60, width: 1920, height: 1080 },
  '1080p30': { fps: 30, width: 1920, height: 1080 },
  '720p60': { fps: 60, width: 1280, height: 720 },
  '720p30': { fps: 30, width: 1280, height: 720 },
};

export interface DesktopSessionDeps {
  capture: {
    sources(): Promise<{ monitors: { id: string; primary: boolean }[]; windows: unknown[] }>;
    start(source: DesktopSource): Promise<void>;
    stop(): Promise<void>;
    nextFrame(): Promise<RawFrame>;
  };
  encode: {
    configure(options: { profile: ProfileId; bitrate: number; gop: number }): void;
    encode(frame: RawFrame): Promise<{ data: Uint8Array; keyframe: boolean }>;
    close(): void;
  };
  /**
   * The RTP sink for video. **Not** a data channel — see the task preamble.
   *
   * The adapter's sender stamps SSRC, payload type, sequence number and
   * timestamp; this dep supplies only the header fields the packetizer needs
   * to build the packet, and the packet bytes back. Injectable so the loop can
   * be tested with no encoder, no display and no peer.
   */
  rtp: {
    /** The sender for the negotiated video track, or `null` before one exists. */
    sender(): RtpSenderSink | null;
    /** The negotiated payload type, read from the sender after the answer. */
    payloadType(): number | null;
  };
  /**
   * JSON control/status frames on the `control` **data channel** — B56/B58/B61.
   * Never the video. Confusing this with the RTP sink above is the bug an
   * earlier draft of this task contained. The label is `control`, not
   * `desktop`: the browser opens `channelLabels: ['control']`
   * (`apps/web/src/stores/terminal.ts:937`) and the Rust's `frame_desktop_sources`
   * stamps `channel: "control"` (`desktop.rs:2062-2085`); `'desktop'` is the
   * capability string and the RTP media label (Task 18's BLOCKING-2).
   */
  send(label: 'control', frame: unknown): void;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
  now?: () => number;
  /** Injectable clock for the 90 kHz RTP timestamp. Defaults to `Date.now`. */
  rtpClock?: () => number;
}

/**
 * The capture → downscale → encode → packetize → send loop (B14/B59).
 *
 * Three states that must survive a change and do not in the obvious
 * implementation:
 *
 * - **A bitrate received before the first encode.** `control({kind:'bitrate'})`
 *   stores it and `start` applies it. Reproducing the Rust's "warn and drop"
 *   would lose the client's setting with no retry and no signal — the browser
 *   shows the new value in its UI and the stream keeps the old one. This is the
 *   one P5 contradiction where the code is a **defect**, so the TS asserts the
 *   correct behaviour and the divergence is stated here rather than hidden.
 * - **The static-skip has exactly three reset sites** — bitrate change, source
 *   swap, downgrade — and nowhere else. A reset on every control message would
 *   make the skip useless; a missing reset after a retarget would keep sending
 *   the pre-retarget picture.
 * - **`stop()` tears down capture before the encoder.** The other order leaves
 *   the encoder closing while a capture callback is mid-flight.
 */
export class DesktopSession {
  private profile: ProfileId = '720p30';
  private bitrate = 0;
  private ladder: SustainLadder | null = null;
  private skip: StaticFrameSkip | null = null;
  private timing: FrameTimingRing | null = null;
  private pendingBitrate: number | null = null;
  private skipWasReset = false;
  private seq = 0;
  private skippedFrames = 0;
  /** The RTP sequencer. Wraps at 2^16 inside the packetizer, per RFC 3550. */
  private rtpSequence = 0;
  /**
   * The SSRC stamped into each packet header.
   *
   * Zero is a legal SSRC, and werift overwrites `header.ssrc` with the sender's
   * own on the way out (`rtpSender.js:544`), so this value never reaches the
   * wire when the real adapter is used. It is set from the sender when one
   * exists so the packetizer's own conformance tests can assert a non-zero
   * header; see `setRtpIdentity`.
   */
  private rtpSsrc = 0;
  private started = false;

  constructor(private readonly deps: DesktopSessionDeps) {}

  /**
   * Record the SSRC the packets should carry.
   *
   * Called by the runtime once the peer's answer exists. Kept separate from
   * `start()` because the zero-click path starts capture **before** the browser
   * has offered, so the identity is not known at start time and may arrive
   * later. Not knowing it is not fatal: `sendRtp` drops frames until a sender
   * exists anyway, and the real werift sender overrides `header.ssrc` with its
   * own on the way out (`rtpSender.js:544`).
   */
  setRtpIdentity(ssrc: number): void {
    this.rtpSsrc = ssrc;
  }

  async start(source: DesktopSource, profile: ProfileId, bitrate: number): Promise<void> {
    this.profile = profile;
    const effective = clampBitrate(this.pendingBitrate ?? bitrate);
    this.pendingBitrate = null;
    this.bitrate = effective;
    const geometry = PROFILES[profile];
    this.skip = new StaticFrameSkip(geometry.fps);
    this.timing = new FrameTimingRing(32);
    this.ladder = new SustainLadder(profile, 1000 / geometry.fps);
    this.deps.encode.configure({ profile, bitrate: effective, gop: gopForFps(geometry.fps) });
    await this.deps.capture.start(source);
    this.started = true;
  }

  control(control: StreamControl): void {
    switch (control.kind) {
      case 'bitrate':
        this.bitrate = control.bitrate;
        this.skip?.reset();
        this.skipWasReset = true;
        this.ladder?.noteBitrateChange(control.bitrate);
        if (!this.started) {
          this.pendingBitrate = control.bitrate;
          return;
        }
        this.deps.encode.configure({
          profile: this.profile,
          bitrate: control.bitrate,
          gop: gopForFps(PROFILES[this.profile].fps),
        });
        return;
      case 'quality': {
        this.profile = control.profile;
        const geometry = PROFILES[control.profile];
        this.skip = new StaticFrameSkip(geometry.fps);
        this.ladder = new SustainLadder(control.profile, 1000 / geometry.fps);
        this.deps.encode.configure({
          profile: control.profile,
          bitrate: this.bitrate,
          gop: gopForFps(geometry.fps),
        });
        return;
      }
      case 'pause':
        return;
      case 'resume':
        this.skip?.reset();
        return;
      case 'stop':
        return;
    }
  }

  async select(source: DesktopSource): Promise<void> {
    await this.deps.capture.stop();
    await this.deps.capture.start(source);
    // Source-swap reset: the new source is a new screen, so the previous
    // signature is meaningless and must not suppress the first frame.
    this.skip?.reset();
    this.skipWasReset = true;
  }

  /**
   * One iteration of the loop: capture → skip → encode → send.
   *
   * The caller drives this at the profile's frame interval (Task 19's runtime
   * ticker does). Splitting the single iteration out rather than owning a timer
   * here is what makes the loop testable without a capture device and what lets
   * the runtime rebuild the interval when the profile changes — the Rust built
   * its sustain ticker **once** and never rebuilt it, so samples kept arriving on
   * the old cadence after a downgrade. The Rust creates its sustain interval once
   * from `profile.frame_budget()` (`desktop.rs:1528`) and never rebuilds it, while a
   * downgrade replaces the profile and the encoder (`desktop.rs:1731-1733`) and then
   * stamps `duration: profile.frame_budget()` on each sample (`desktop.rs:1769`). After
   * `720p60 → 720p30` the loop still ticks at 16.67 ms while samples are stamped
   * 33.3 ms: the encoder is fed at double its configured `max_frame_rate` and the RTP
   * sample durations disagree with the actual emission cadence. (`1080p60 → 720p60` is
   * unaffected — same fps.) The ladder is rebuilt in
   * `control()` and the interval is the caller's, so there is nothing left to go
   * stale.
   *
   * Returns whether a frame was sent, so the runtime can count encoded frames
   * without duplicating the skip decision.
   */
  async pump(): Promise<boolean> {
    if (!this.started || !this.skip || !this.ladder) return false;
    const frame = await this.deps.capture.nextFrame();
    this.seq += 1;
    this.skipWasReset = false;
    if (this.skip.shouldSkip(frame)) {
      this.skippedFrames += 1;
      return false;
    }
    const encodeMs = await this.encodeAndSend(frame);
    const downgrade = this.ladder.noteFrame(encodeMs);
    if (downgrade) {
      // A downgrade is the third and last reset site: the profile's geometry
      // changed, so the next identical frame must be sent to establish the new
      // reference at the new size.
      this.skip.reset();
      this.skipWasReset = true;
      this.applyProfile(downgrade);
    }
    return true;
  }

  /**
   * Times the encode only — the capture already happened when `pump` received
   * the frame. That single number is both what the ladder reads (B23: the frame,
   * not the p50) and what the timing ring records; the two consumers share one
   * measurement so they cannot disagree about what "slow" means.
   */
  private async encodeAndSend(frame: RawFrame): Promise<number> {
    const now = this.deps.now ?? Date.now;
    const started = now();
    const encoded = await this.deps.encode.encode(frame);
    const encodeMs = now() - started;
    this.timing?.record(this.seq, started, encodeMs, started);
    this.sendRtp(encoded.data);
    return encodeMs;
  }

  /**
   * Annex-B → RFC 6184 packets → `sender.writeRtp`, once per packet.
   *
   * This is the whole video path and it is deliberately not `deps.send`. The
   * encoder emits one Annex-B access unit per frame; `packetizeAnnexB` splits
   * it into single-NAL / STAP-A / FU-A packets at the negotiated payload type;
   * the werift sender stamps SSRC, sequence and timestamp onto each and pushes
   * it out. Skipping the packetizer — or handing the buffer to a data channel —
   * produces no error anywhere and a black video, which is why the test below
   * asserts `writeRtp` was called with a packet whose `payloadType` is the
   * negotiated one.
   *
   * The sequencer lives here, not in the packetizer: `packetizeAnnexB` returns
   * `nextSequenceNumber` and the caller owns the counter, exactly as the Rust
   * agent's `SampleWriter` did.
   *
   * A missing sender is not an error at frame time. `start()` can run before
   * the browser's offer arrives (the zero-click path does exactly that), and a
   * frame captured then has no one to send to yet. Dropping it and letting the
   * next tick pick up is correct — the alternative, buffering, would replay a
   * stale picture the moment the peer connected.
   */
  private sendRtp(annexB: Uint8Array): void {
    const sender = this.deps.rtp.sender();
    if (!sender) return;
    const payloadType = this.deps.rtp.payloadType();
    if (payloadType === null) return;

    const clock = this.deps.rtpClock ?? Date.now;
    // 90 kHz RTP clock. Milliseconds × 90 overflows 2^32 after ~13 hours, so
    // the multiplication is done modulo 2^32 rather than on the raw product.
    const rtpTimestamp = Math.floor((clock() * 90) % 2 ** 32);

    const { packets, nextSequenceNumber } = packetizeAnnexB(Buffer.from(annexB), {
      payloadType,
      sequenceNumber: this.rtpSequence,
      timestamp: rtpTimestamp,
      ssrc: this.rtpSsrc,
    });
    for (const packet of packets) sender.writeRtp(packet.bytes);
    this.rtpSequence = nextSequenceNumber;
  }

  private applyProfile(profile: ProfileId): void {
    this.profile = profile;
    const geometry = PROFILES[profile];
    this.deps.encode.configure({
      profile,
      bitrate: this.bitrate,
      gop: gopForFps(geometry.fps),
    });
  }

  stats(): { seq: number; skippedFrames: number; profile: ProfileId; bitrate: number } {
    return {
      seq: this.seq,
      skippedFrames: this.skippedFrames,
      profile: this.ladder?.current() ?? this.profile,
      bitrate: this.bitrate,
    };
  }

  /** Test affordance: true immediately after one of the three reset sites. */
  skipIsReset(): boolean {
    return this.skipWasReset;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.skip = null;
    this.ladder = null;
    await this.deps.capture.stop();
    this.deps.encode.close();
  }
}
```

- [ ] **Step 5: Write `index.ts` and run everything**

```ts
// apps/agent/src/index.ts
export { loadConfig } from './config.js';
export type { AgentConfig } from './config.js';
export { createAgentRuntime, AgentRuntime, resolveDefaultSource } from './runtime.js';
export type { RuntimeStatus } from './runtime.js';
```

```bash
./apps/agent/node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit -p apps/agent/tsconfig.json
./node_modules/.bin/prettier --write apps/agent/src apps/agent/test
git add apps/agent
git commit -m "feat(agent): wire the runtime lifecycle and the desktop session"
```

**TEST-INTEGRITY declaration:** two new files, **26 new `it()` / 50 new `expect()`**
(was **17 / 33** before the B-12g repair, **22 / 43** as that repair landed,
**25 / 49** after the R1–R12 follow-up; per file below). `reporting_estimator_publishes_its_initial_target` (`rtc.rs:1179`) is the **only** port here — it re-homes from Task 8. Everything else is **new**, and an earlier draft named eight Rust tests that do not exist anywhere in `apps/agent/src`: `resolve_default_source_prefers_primary` / `…honours_an_explicit_id` / `…resolves_test` / `…throws_without_monitors`, `runtime_stops_idempotently`, `desktop_session_configures_before_capture` / `…stops_capture_before_the_encoder` / `…reconfigures_on_a_quality_change`. The functions they name do exist — `default_source_id` (`desktop.rs:1004`) and `run_desktop_session` (`lib.rs:2002`/`2698`) — and neither has a test. The only in-tree use of `default_source_id` is the `#[ignore]`d live-display smoke (`desktop.rs:2707`), which asserts a frame, not a resolution rule.

Per file, on the same fence axis: `runtime.test.ts` **15 `it()` / 23 `expect()`**,
`desktop/session.test.ts` **11 / 27**. 15 + 11 = 26; 23 + 27 = 50.

**The B-12g repair added five `it()` and ten `expect()` to `runtime.test.ts`** —
`runtime.test.ts` was **6 / 6** and is now **11 / 16**. All five are R3's
(`FilesTicker`): one `checkIdle` per second; one `flushAcks` per 20 ms; the
catch-up count when a tick arrives late; that both ticks' frames are emitted;
and that `stop()` ends ticking. `desktop/session.test.ts` is **unchanged at
11 / 27** — R3 owns a tick over `FilesSession`, not over the desktop loop.

**This R1–R12 follow-up adds three `it()` and six `expect()` to
`runtime.test.ts`, all under MAJOR-1** — the production tick wiring the
landed repair's `FilesTicker` never had: a runtime-constructed ticker driven by
**real** `setInterval` handles under `vi.useFakeTimers()` (a mocked timer would
prove nothing about `setInterval` ownership), emitting through the `send` seam;
`stop()` clearing those handles so no late tick fires; and the no-files-root
config skipping the ticker entirely (the Rust's `Option<FilesManager>`). The
session is injected through a `filesSession` seam so the emitted frame is
observable without a real root; the production construction
(`FilesRoot.open` + `FilesSession`) is that seam's default.

**MAJOR-1's post-QA repair changed those three tests' fixtures without changing
either count: `runtime.test.ts` stays 14 / 22 on that pass (it is 15 / 23
only because MAJOR-6 adds `status()` below).** Two defects, both in the fence,
neither in the production source:

1. **The frozen clock.** `wiring()` set `now: () => 1_000_000` — a constant
   closure. `FilesTicker.tick()` computes `now − lastIdleAt`, so the closure
   froze that at `0` forever and **no tick ever ran**: the fence read
   `1 failed | 13 passed (14)` at `adc162a5`, failing on `checkIdle` called 0
   times after `advanceTimersByTimeAsync(IDLE_TICK_MS)`. `vi.useFakeTimers()`
   mocks `Date.now` but cannot move a closure that never calls it, so the fix
   is `now: () => Date.now()` and `Date.now()` is **load-bearing** here — a
   reader who "simplifies" it back to a constant re-breaks the fence with no
   change to the code under test. The runtime wiring itself was correct and is
   untouched.
2. **Test 3's vacuous fixture.** `skips the ticker entirely when the config has
   no files root` passed **with the `filesRoot` guard deleted** (measured:
   `14 passed (14)`), because the injected fake session's `checkIdle` returned
   `[]` and `expect(sent).toEqual([])` then held for the wrong reason. The
   fixture now returns one `files-error` frame — the same shape test 1 asserts
   — while the `[]` assertion stays: with the guard gone the leak is 59 frames,
   so the test discriminates. This is the same fixture-vacuity class as the
   `detach` case above, and it is the third instance in this task of an
   assertion encoding the defect rather than the behaviour.

**MAJOR-6 declared (typecheck + a missing caller).** The landed `AgentRuntime`
declared **no constructor** while `static start` called `new AgentRuntime(deps)`
and `status()` read five `this.config.*` fields — 8 typecheck errors, **6 of
them in the production class** (`Property 'config' does not exist`,
`Expected 0 arguments, but got 1`). `status()` was never called by any test, so
the class could not implement its own declared `RuntimeStatus` interface and
nothing noticed: `new AgentRuntime(deps)` is legal JavaScript, and vitest does
not typecheck. Fixed by a real constructor taking `(config, deps)` — with the
deps type hoisted to a named `RuntimeDeps` used by **both** the constructor and
`static start`, so they cannot drift — and by `ticker()`'s mocks gaining
`(): unknown[]`, which the bare arrow had inferred as `never[]` (a type-level
vacuity: a `never[]` mock can only ever return `[]`, so
`mockReturnValue([idleFrame])` was unassignable and the emit test was pinned to
the empty case). The new `status()` test is the +1 `it()` / +1 `expect()`
above; it is the only member with no caller anywhere in the fence.

`FilesTicker` is the production owner R3 requires, and the declaration says so
as a **capability**, not a test name. The pre-repair count was: `setInterval`
appeared **0** times in this document and `checkIdle()`'s only callers were two
assertions inside Task 11's fence, so the idle deadline and the 20 ms ack flush
had no driver. **The post-repair count is: `setInterval` appears twice as real
code in this document** — the two handles `AgentRuntime.start` owns
(`IDLE_TICK_MS` and `ACK_TICK_MS`, both firing `ticker.tick()`) — and the
wiring has its own three tests above. The ticker itself keeps the injected
clock so no test sleeps.

So this task is the largest single block of **new** coverage in Plan 2, and the declaration now says that rather than dressing it as an eight-test port. What the twenty-six cover: five `resolveDefaultSource` cases (primary by default; an explicit monitor id; the first monitor when none is flagged primary; the test source; a named throw when there are no sources; the unknown-selector throw), five `FilesTicker` cases (the 1 s idle period; the 20 ms ack period; the catch-up count when a tick arrives late; that both ticks' frames are emitted; `stop()` ending ticking), four `AgentRuntime` cases (real intervals driving the session and emitting on `files`; `stop()` clearing the handles; a no-files-root config skipping the ticker; `status()` reporting the config it was started with), and twelve `DesktopSession` cases (gop configured before the first frame; the initial bitrate through the same decode path; capture stopped before the encoder closes; re-configure on a quality change; the static-skip reset on a bitrate change; a bitrate applied before the first encode; the stats frame carrying the sustained profile; the pump writing RTP and not a data channel; the no-sender drop; the repeat-skip keeping the keepalive; the pump's downgrade after thirty over-budget frames). **New (declared divergences):** the pre-first-encode bitrate is **applied, not dropped** — the Rust's production arm only `tracing::warn!`s on `cmInitExpected` (rc = 4) from `SetOption` before the encoder's lazy init (`desktop.rs:1601-1603`, per the test comment at `:3093-3096`) and does not update `profile.bitrate_bps`, so a `desktop-bitrate` arriving before the first frame is lost with no retry and the echoed `targetBitrateBps` never reflects it; the unknown-selector throw; the static-skip reset on a bitrate change; and the three `pump()` tests, which exercise the loop the Rust's tests never ran as a loop — including the downgrade-then-reset path that the stale-interval defect above makes unobservable in Rust.

**And one R3 consequence the declaration must state, because it is a gap rather than a covered behaviour:** `runtime.test.ts` — ticker and wiring alike — is **not** gated. `apps/agent/**` is absent from `ci-node.yml`'s `paths:` and the gating test run excludes `@ponter/agent-node` (`:105-111`), so its tests are green locally and invisible in CI — the same status Task 11's crossing test carries. The Plan-3 handoff is the path plus dropping the `!@ponter/agent-node` filter from `:83`, `:86` and `:108`.

The `expect()` count is larger than the `it()` count by more than usual because the RTP test is one `it()` with ten assertions: it is checking a serialized packet byte by byte, and a packet is not one property.

**New, and the most important two in this task:** the RTP-path test and the no-sender drop. An earlier draft of this task wired the encoder's Annex-B output to `deps.send('control', …)` — a data channel — which would have shipped a black video with no error anywhere. Both are **new**, not ports: the Rust never tested the write path in isolation because `write_sample` did the packetizing for it. The RTP test asserts the header's payload type, SSRC, RTP version, that the Annex-B start code is **absent** from the payload, and that `deps.send` was **not** called.

---

### Task 20: Defect repairs from the binding audits

**Landed at:** `0a3f900db07238d3b6f92f7d57510ca23cae5d77`
**Files:**
- Modify: `apps/agent/src/files/session.ts` (defects 1, 2, 3, 4)
- Modify: `apps/agent/src/terminal/pty.ts` (defects 5, 6, 7)
- Modify: `apps/agent/src/files/sandbox.ts` (defect 8)
- Test: `apps/agent/test/files/session.test.ts`, `apps/agent/test/terminal/pty.test.ts`, `apps/agent/test/files/sandbox.test.ts`

**Origin and rationale:**
Independent QA binding audits found eight concrete contract defects, all repaired in one commit:
- **three** in the files transfer state machine, from QA's NOT-BOUND verdict on Task 11 (`52af996`): `remove()` ignored `recursive`, `beginUpload()` never sent the initial ack, the upload idle-timeout frame dropped `transferId` — plus a fourth, the wire-relative path check, which the same state machine owns;
- **two** lifecycle leaks in the terminal PTY manager, from QA's NOT-BOUND verdict on Task 12 (`50dcc9e`): a phantom slot leak when a subscription throws, and a stale exit evicting a live session that reused the id;
- **one** un-wired security allowlist (Task 12's `ShellPolicy` accepted but never read);
- **one** containment case missing under a root of `/` (Task 10's `ensureContained`).

That is four + two + one + one = eight. All were validated against an independent 45-cell QA probe matrix (`.superpowers/probes/t20-landing-qa/`) and verified clean across 14 mutants with zero gaps (QA BOUND PASS, `qa-verdict-task-20.md`).

**The eight repairs, each against the Rust it cites:**

1. **`remove()` honours `recursive` (CRITICAL)** — Rust `files.rs:911-951`: the root refusal is checked first, then `if recursive { remove_dir_all }` else the directory must be empty (`DirNotEmpty`). The port had omitted the recursive arm, refusing every non-empty folder delete. Landed: `Boolean(message.recursive)` selects `rmSync(target, { recursive: true })`; the non-recursive arm keeps `rmdirSync` + `ENOTEMPTY → DIR_NOT_EMPTY`; the root refusal sits above both. **This repair made `recursive` work; it did not make a non-boolean `recursive` safe — Task 22 did that**, by refusing the frame at the decode boundary before `remove()` is reached (see Task 22 below).
2. **`beginUpload()` sends the initial cumulative ack (CRITICAL)** — Rust `files.rs:1623-1627` returns `vec![UploadAck { next_chunk_index: 0 }]` ("the begin is answered with the first cumulative ack, spec §6.1"). The port had returned `[]`. In `packages/file-core/src/client.ts:328-336`, `upload()` only arms the idle timer before sending `files-upload-begin`; the chunk pump is driven entirely from `onAck` (`:610`). Without the initial ack, no chunk is ever sent and uploads stall until the 30 s idle timeout. Landed: `return [{ type: 'files-upload-ack', transferId, nextChunkIndex: 0 }]`.
3. **Upload idle-timeout frame carries `transferId`** — Rust `timeout_frame(direction, transfer_id)` (`files.rs:1259-1270`) sets the id on timeout frames in both directions. The download arm already did; the upload arm dropped it. **Measured consequence, not the obvious one:** the client does *not* hang — its own 30 s timer (`client.ts:328`) rejects the handle with a locally minted `TRANSFER_TIMEOUT`. What actually breaks is that the `files-error` arm only routes an error to a transfer when the frame carries its id (`client.ts:637-641`), so `client.transfers` never drops the entry: one dead entry per timed-out upload, for the life of the connection. The caller also gets the client's own message instead of the agent's frame, and the id-less error falls through to `onError` as an unsolicited error belonging to no request. Landed: `const { transferId } = this.upload;` read before `discardUpload`, emitted on `files-error`.
4. **`files-upload-complete.path` is wire-relative** — Rust `files.rs:2281` emits `state.dest_rel`, constructed via `join_rel` (`:2069-2075`): `''` + name for root, `dir/name` otherwise. The port put `destPath` (the host absolute path) on the wire, leaking the sandbox root location. Landed: `UploadState` stores `destRel`; both `name` and `path` derive from it.
5. **PTY registers slot after subscribing (phantom slot leak)** — The port called `sessions.set()` before subscribing `onData`/`onExit`. If subscription threw (e.g. invalid stream), the slot was registered but dead, leaking one of the 10 slots forever. Landed: subscribe first, register second. On throw, the child process is killed and `PtyError('pty-spawn-failed', ...)` is thrown.
6. **Stale `onExit` cannot evict a live session** — In Node PTY, `close()` deletes the map entry but cannot unsubscribe native handlers. If a terminal ID was reused, an old process's exit handler would evict the new, live session. Landed: `emitExit` guards with `if (this.sessions.get(terminalId)?.process === process_) this.sessions.delete(terminalId)`. The exit event itself is still reported either way, matching Rust.
7. **`ShellPolicy` consulted before process spawn** — Rust `lib.rs:1372-1400` resolves client-supplied shells against the allowlist in the dispatcher *before* `spawn_session`, answering refusals with the pinned spawn-failure frame. The port accepted `policy?: ShellPolicy` in `PtyCreateOptions` but never read it. Landed: `options.policy ? this.resolveShell(options.policy, options.shell) : options.shell`; a `ShellRefusedError` maps to `PtyError('pty-spawn-failed', 'shell refused: ...')`.
8. **Containment check under a root of `/`** — Rust `ensure_contained` uses `Path::starts_with` (component-wise). In TS, `this.root + sep` when `root === '/'` produced `//`, which no normal path starts with, rejecting all valid files under root `/` with `PATH_OUTSIDE_ROOT`. Landed: `const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;`.

**TEST-INTEGRITY declaration:**

Counts on committed blobs across `apps/agent/test/` at commit `0a3f900`:
- **Before (at `d640a9d`):** 33 test files, **376 `it()` / 618 `expect()`**
- **After (at `0a3f900`):** 33 test files, **388 `it()` / 643 `expect()`**
- **Net change:** **+12 `it()` / +25 `expect()`**

The suite run reports **34 files**, not 33, because `apps/agent/spike/spike.test.ts`
sits outside `test/`; it holds 9 `it()` at both revisions and is not counted above,
which is why the file count in this declaration (33) and in the suite result (34)
differ by exactly that file.

File-by-file breakdown:
| Test File | Before `it()` | After `it()` | Before `expect()` | After `expect()` | Net Δ |
|---|---|---|---|---|---|
| `test/files/session.test.ts` | 30 | **37** | 62 | **76** | +7 / +14 |
| `test/terminal/pty.test.ts` | 11 | **15** | 15 | **24** | +4 / +9 |
| `test/files/sandbox.test.ts` | 18 | **19** | 19 | **21** | +1 / +2 |
| **Total, the three touched files** | **59** | **71** | **96** | **121** | **+12 / +25** |

The other 30 test files are untouched, which is why the three-file total above
(59 → 71) differs from the suite total (376 → 388): every added `it()` is in one
of the three files this task repaired.

The 12 new test cases, quoted verbatim from the landed blobs, with the defect each fences:

| # | `it()` title (verbatim) | File |
|---|---|---|
| 1 | `removes a non-empty directory when recursive is set` | `files/session.test.ts` |
| 2 | `removes an empty directory without recursive (the non-recursive arm still works)` | `files/session.test.ts` |
| 3 | `refuses a non-empty directory when recursive is absent or false` | `files/session.test.ts` |
| 4 | `refuses the sandbox root even with recursive set` | `files/session.test.ts` |
| 5 | `answers the begin with the initial cumulative ack (defect 2)` | `files/session.test.ts` |
| 6 | `carries the transferId on an upload timeout frame (defect 3)` | `files/session.test.ts` |
| 7 | `carries the wire-relative destination on files-upload-complete (defect 4)` | `files/session.test.ts` |
| 8 | `does not leak a slot when a subscription throws (defect 5)` | `terminal/pty.test.ts` |
| 9 | `does not let a closed process evict the live session reusing its id (defect 6)` | `terminal/pty.test.ts` |
| 10 | `refuses a shell the policy disallows, before any spawn (defect 7)` | `terminal/pty.test.ts` |
| 11 | `spawns the canonical path the policy resolved (defect 7)` | `terminal/pty.test.ts` |
| 12 | `accepts a path under a root of "/" (defect 8)` | `files/sandbox.test.ts` |

Defect 1 carries four cells (positive, negative, the empty-directory control that
proves `recursive` is not mandatory, and the root refusal that precedes both arms).
The two shell cells are a pair: one shows the refusal happens **before** any spawn,
the other that the resolved canonical path is what actually executes.

Zero assertions removed or weakened. Zero `.skip`, `.only`, or `.todo` introduced. Removed lines in `apps/agent/test/`: exactly **1** — the `node:fs` import line in `sandbox.test.ts`, rewritten to a multi-line form that **adds `realpathSync`** (`git diff d640a9d 0a3f900 -- apps/agent/test` → `31/1`, `172/0`, `149/0`). Suite passed: **34 files / 422 passed**.

---

### Task 21: Re-point `agent-api-access-gate.test.ts` at the TypeScript agent tree

**Landed at:** `0b471e0c173305a47eca7b0c7ef659220b5e806d`
**Files:**
- Modify: `packages/api-client/test/agent-api-access-gate.test.ts`

**Origin and Problem:**
`plan-2-core.md:94` assigned `agent-api-access-gate.test.ts` to Plan 2 ("**Modify.** Re-point at the TS agent tree | R3, R6"), but no commit on this branch executed it while Tasks 1–20 landed. At `0a3f900` the file is **2 failed | 2 passed (4)**, reddening the gating CI job `@ponter/api-client#test`. Both failures are false positives on correct TypeScript, produced by rules translated from a Rust scan whose spelling conventions differ:
1. `DEFAULT_SERVER = 'ws://localhost:8787/api/ws/agent'` in `apps/agent/src/config.ts:42` is the port of `main.rs:29`'s clap default — a sanctioned-set question, not a stray URL. Measured: it is the only file in the 32-file tree a `wss?://` literal appears in.
2. `/\{\s*(error|code|message)\s*:/` fires on **3** files — `logging/index.ts` (the level table `{ error: 0, … }` and the method map `error: (f, m) => …`), `signalling/client.ts:110,118,137,165`, `signalling/inbound.ts:47` (all `logger.warn({ error: … })` / `{ code: … }` log fields) — while staying **silent** on a real `details` envelope. The Rust's own discriminator is `details` (`build-agent.yml:95-98`).

**The landed change:**

1. **The sanctioned set is per rule, not one shared directory.** One shared `api/` cannot express the Rust's `main.rs` + `api.rs` split: too narrow for the URL rule, too wide for the HTTP rule.
   | rule | set | measured effect on the 32-file tree |
   |---|---|---|
   | `SANCTIONED_URL` | `['api/', 'config.ts']` | excludes exactly **1 of 32** |
   | `SANCTIONED_ENVELOPE` | `['api/']` | excludes **0 of 32** — `apps/agent/src/api/` does not exist yet |
   | `SANCTIONED_HTTP` | `[]` | excludes **0 of 32**; sanctioning `api/` here would sanction an absence |
   `isSanctioned()` matches a directory prefix (`api/`) or an exact file (`config.ts`); `startsWith` alone would treat `config.ts.bak` as sanctioned. `governed(keys)` takes the rule's set as an argument.

2. **The three patterns name the class, not one spelling** (a rule written against one spelling reports zero offenders on a tree that spells the class another way, which reads as a green gate):
   ```ts
   const HTTP_CLIENT =
     /(?:from|require\(|import\()\s*['"]node:(?:http|https)['"]|from\s*['"]undici['"]|require\(\s*['"]undici['"]\s*\)|import\(\s*['"]undici['"]\s*\)/;
   const LITERAL_URL = /['"`](?:https?|wss?):\/\//;
   const ERROR_ENVELOPE =
     /\bdetails\s*\??\s*:|\{[^{}]*\berror\s*:[^{}]*\bstatus\s*:|\{[^{}]*\bstatus\s*:[^{}]*\berror\s*:/;
   ```
   **Deliberately excluded from `ERROR_ENVELOPE`: `error` + `code` together.** The agent uses that pair for its own wire frames (`{ type: 'files-error', code: 'TRANSFER_TIMEOUT', … }`) and for logging, so including it would fire on the agent rather than on a hand-rolled envelope. The cost is a **documented gap** — an envelope carrying `error` + `code` and neither `details` nor `status` is not seen — pinned by a control so it stays a decision rather than an oversight.

3. **The vacuity guard is the one that can fail.** `files.every(f => f.endsWith('.ts'))` is deleted: `walk()` pushes only paths already ending in `.ts`, so the assertion restated its own filter. Replaced 1 for 1 by the property that actually distinguishes the right root from the wrong one:
   ```ts
   expect(files.some((f) => relPath(f).includes('node_modules/'))).toBe(false);
   ```
   Measured both polarities through the file's own `walk()`: `apps/agent/src` → **32 walked, 0 under `node_modules/`** (passes); `apps/agent` one level up → **5907 walked, 5837 under `node_modules/`** (fails). `expect(files.length).toBeGreaterThan(0)` is kept — it is the live guard, since `walk()` has no `try` and a missing directory throws. A **sanctioned-set liveness** cell is added for the URL rule (`expect(governed(SANCTIONED_URL).length).toBeLessThan(walk(AGENT_SRC).length)`, measured `31 < 32`): a set that names nothing real makes its rule unconditionally strict, and no fixture can show that. No file count is pinned, so a legitimate source addition keeps it green.

4. **Positive controls, driving the same `RegExp` objects.** A `describe` block of **3 cells / 20 assertions**: 4 HTTP import spellings, 2 URL quote styles, 5 envelope forms that must fire (including the type-annotation form `as { error?: string; details?: unknown }`), and 6 logging / prose / wire-frame forms that must stay silent — **plus the accepted gap**, pinned. Measured before writing: **20 fixtures, 0 mismatches**. Without these, the "no offenders" scans would be unfalsifiable: a pattern matching nothing at all passes every one of them.

5. **Cross-host paths.** `relPath(f) = relative(AGENT_SRC, f).split(sep).join('/')` is used by both `isSanctioned()` and the `node_modules` control, so `api/` and the control agree on a Windows runner where `relative()` returns backslashes.

**Deliberately not written:** the `api/`-boundary half ("the envelope filter removes at least one file"). It is false today — `apps/agent/src/api/` does not exist, so `governed(SANCTIONED_ENVELOPE).length === 32`. Writing it now forces `it.skip`, which the Global Constraints forbid; the omission is stated in the `SANCTIONED_ENVELOPE` docblock so it is a ruling rather than a hole. It belongs to the commit that adds `apps/agent/src/api/`.

**TEST-INTEGRITY declaration:**

Counts on committed blobs (`git show 0a3f900:…` vs `git show 0b471e0:…`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` / `grep -oP '\bexpect\s*\('`:
- **Before:** **4 `it()` / 6 `expect()`**
- **After:** **8 `it()` / 26 `expect()`**
- **Net:** **+4 / +20**; `.skip` / `.only` / `.todo` **0 → 0**

Package total `packages/api-client`: **2 failed | 39 passed (41) → 45 passed (45)** — +4, exactly the added cells. `apps/agent` unchanged at **422 passed / 34 files**, as required. Every removed line has a declared replacement: the dead `every('.ts')` assertion, the single-spelling `HTTP_CLIENT`, the `{error|code|message :` envelope rule, `SANCTIONED = 'api/'`, `governed()` without an argument, the `node:path` import (adds `sep`), and docblock lines stating the old rationale.

**Gating requirement, measured:** the turbo job
`pnpm exec turbo run test --filter='!@ponter/agent-node' --filter='!@ponter/web' --filter='!@ponter/shared' --continue=always` → **9/9**. `tsc --noEmit` and `prettier --check` (on the committed blob, with `--ignore-path /dev/null --config`) clean. Both polarities measured: three offenders planted in a scratch tree under `/tmp` (none in the repo) → **3 failed | 5 passed**, 8/8 after removal; and 6 in-file mutants **6 killed, 0 survivors** — including one that weakens the liveness cell to `toBeLessThanOrEqual` and shows the strict comparison is what gives that cell teeth. Report: `task-21-report.md`.

---

### Task 22: Validate the inbound files frame at the decode boundary

**Landed at:** `2e3f7636ee75fbc0d059b600e7de57add488baab`
**Files:**
- Modify: `apps/agent/src/files/session.ts` (**+169 / −0**, two hunks, zero deletions)
- Test: `apps/agent/test/files/session.test.ts` (**+359 / −0**, zero deletions)

**Origin: the class, not one spelling.**
QA's Task 20 verdict found **one** member — `remove()` selects the destructive arm with `Boolean(message.recursive)`, so a peer sending the **string** `"false"` deletes the tree. PM then measured the whole class: every field of every one of the twelve inbound types against a Rust oracle, in one run. The defect is not twelve bugs; it is **the absence of a validator**. The Rust decodes each payload with `serde_json::from_value` into typed fields (`files.rs:582-600`), so a wrong JSON kind or a missing required field fails the whole frame, which `lib.rs:1969-1975` answers as `BAD_FRAME`. The port's `decodeFilesFrame` checked only that `type` was one of twelve names, and each handler then coerced. Measured consequences, each a payload the Rust refuses and the port accepted:

| payload | port's action before the repair | disk |
|---|---|---|
| `files-delete`, `recursive: "false"` / `"0"` / `"true"` / `1` / `[]` / `{}` | **deleted the tree** | tree gone |
| `files-upload-begin`, `size: "abc"` / `{}` (NaN) | created `.part` | **past the size cap** |
| `files-upload-begin`, `size: null` / `-1` / `1.5` | created `.part` | wrong size recorded |
| `files-upload-begin`, `name` **missing** | created `undefined.ponter-part` | a file named `undefined` |
| `files-list`, `path: 12` / `requestId: 5` | accepted | — |
| `files-pause`, `direction: "sideways"` | refused downstream as `TRANSFER_UNKNOWN` | — |

The size-cap row is the one to read twice. `beginUpload` guards with `if (size > FILE_MAX_BYTES)` — a **comparison**, and `NaN` is false against every comparison, so `Number()` yielding `NaN` walks straight past the only limit on upload size. The Rust has no equivalent because `u64` cannot hold `NaN`.

Severity, honestly: the shipped browser client types every field correctly (`packages/file-core/src/client.ts` — `delete(path, recursive: boolean = false)`), so none of this is reachable from the product today. It is reachable from a hand-written peer, it is **fail-open on a destructive operation and on a size limit**, and it diverges from the Rust's contract — which is why it was fixed before merge rather than carried.

**The landed shape**, all in `apps/agent/src/files/session.ts` beside `FILES_INBOUND_TYPES`:

- `type FieldKind = 'string' | 'u64' | 'bool' | 'direction'` and `interface InboundShape { required; optional }`.
- `INBOUND_FIELDS: Record<FilesInboundType, InboundShape>` — **12 types / 32 fields** (29 required, 3 optional). The `Record` keyed by `FilesInboundType` is load-bearing: a thirteenth type added to the enumeration is a `tsc` error (TS2741) until it has a shape, so the contract cannot be skipped by a new arm.
- `matchesKind(value, kind)`. The `u64` arm is `typeof v === 'number' && Number.isInteger(v) && Number.isSafeInteger(v) && v >= 0` — rejecting a string, a non-integral number, a negative number, `NaN`, `Infinity`, `null`, an array and an object. `Number.isSafeInteger` is the honest bound: `serde_json`'s `u64` is 64-bit and `MAX_SAFE_INTEGER` is the closest a double gets, while the browser never declares a size above `FILE_MAX_BYTES`.
- `inboundShapeValid(message)` — required fields present and of kind; optional fields absent, `null`, or of kind; extra keys ignored.
- **Wiring:** `handle()` already owned a `try/catch` at BASE (`session.ts:199`), so the guard was inserted **into** it, not wrapped around `dispatch`:

  ```ts
  const decoded = decodeFilesFrame(message);
  if (decoded === null) return [];
  try {
    if (!inboundShapeValid(decoded)) {
      throw new SandboxError('BAD_FRAME', 'the frame could not be decoded');
    }
    return this.dispatch(decoded);
  } catch (error) { /* unchanged: ACTION_TYPES → files-action-result, else files-error */ }
  ```

  Throwing **inside** that `try` is what keeps the failure routing intact: the three action types answer on `files-action-result` with `success: false, error: 'BAD_FRAME'`, everything else on `files-error` with `code: 'BAD_FRAME'`, and `requestId` / `transferId` extraction is the same code path a bad *path* already took. The message string is the Rust's own — `"the frame could not be decoded"` (`lib.rs:1972`) — so the two ports answer identically. The check is **above** the `try` in zero implementations: placing it there would require re-implementing the action/transfer routing, and the three action frames are exactly the ones a bad payload is most likely to name.

**Two oracle properties the check must respect**, both measured against Rust rather than assumed:

1. **`serde` does not deny unknown fields.** `deny_unknown_fields` occurs **0** times in `files.rs`. An extra key is ignored, so the validator checks the named fields and ignores everything else. A stricter "no key outside the table" rule would refuse frames the Rust accepts — a new divergence introduced by a fix for divergence.
2. **`Option<T>` accepts an explicit `null`.** The oracle measures `recursive = null` as **ACCEPTED** (then `unwrap_or(false)` takes the non-recursive arm). So absent and `null` are both fine for an optional field, and a present non-null value must still be of the right kind. `recursive: "false"` is `BAD_FRAME`; `recursive: null` is not. Only `files-delete` (`recursive: bool`) and `files-cancel` (`requestId`, `transferId`: both strings) declare optional fields.

**What the boundary does *not* cover, stated so the claim is not over-read.**
`acceptBinaryChunk` is a second public entry into the same state machine and never passes through `handle()`: `session/data-channels.ts:263` routes a `0x02`-prefixed binary frame straight to it. Its boundary is `decodeUploadChunk` (`files/protocol.ts:86`), which has its own `BAD_FRAME` throws for a truncated header and an over-cap payload — a separate instrument for a separate encoding. "The decode boundary is validated" is a claim about the **JSON** path. Also unchanged by design: `String(message.type).replace('files-', '')` in `actionFailure` / `actionResult` stays correct — `type` is the discriminant the decode already validated.

**Why the coercions stay.** `String(...)`, `Number(...)` and `Boolean(...)` are all still in the handlers after this commit, and the plan's own fences still show them. That is correct, and the class comment above `dispatch` says why: every value reaching an arm has passed the boundary, so the coercion is the *narrowing* from `unknown` to the handler's parameter type — not a validation. `Boolean(message.recursive)` sees only `true`, `false`, `null` or absent, and maps all four correctly. Rewriting it to `message.recursive === true` would restore fail-open behaviour for the case the boundary now refuses; leaving the boundary out would make every one of those lines a bug again at once.

**TEST-INTEGRITY declaration:**

Blob counts on the committed blobs (`git show e171f88:…` vs `git show 2e3f763:…`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` / `grep -oP '\bexpect\s*\('`:

| scope | before (BASE `e171f88`) | after (`2e3f763`) | net |
|---|---|---|---|
| `test/files/session.test.ts` | **37 `it()` / 76 `expect()`** | **45 / 110** | **+8 / +34** |
| `apps/agent/test/` (33 files) | **388 / 643** | **396 / 677** | **+8 / +34** |

`.skip` / `.only` / `.todo`: **0 → 0**. Removed lines in both files: **0** — the commit is 528 insertions and **zero deletions** (`git diff --numstat e171f88 2e3f763` → `169 0` and `359 0`; `git show --stat 2e3f763` → `2 files changed, 528 insertions(+)`). The plan states blob counts and not a runner total on purpose: the runner reports 56 cells for this file at HEAD against 45 `it()` because `it.each` expands, so a runner count is task-local and cannot be compared across revisions.

The `apps/agent` suite total (excluding `apps/agent/spike/spike.test.ts`, which sits outside `test/` and is unchanged at 9 `it()`): **430 passed / 34 files**, up from 422.

The 8 new cells, quoted verbatim, with the brief cell each fences and what it proves:

| # | `it()` title (verbatim) | fences |
|---|---|---|
| 1 | `files-delete rejects non-boolean recursive with BAD_FRAME and preserves tree` | brief cell 1 — **S-1 itself**: six non-boolean values each answer `BAD_FRAME` *and* the tree survives (a fix that deleted first and refused after would pass a frame-shape assertion); controls: `true` deletes, `false` and omitted answer `DIR_NOT_EMPTY` |
| 2 | `files-upload-begin rejects non-u64 size with BAD_FRAME without creating .part file` | cell 2 — seven invalid sizes, each with **no `.part` on disk**; control `size: 10` acks, `MAX + 1` answers `FILE_TOO_LARGE` |
| 3 | `rejects missing required field with BAD_FRAME and does not coerce to undefined string` | cell 3 — missing `name` refused and no `undefined.ponter-part`; control `name: "undefined"` (a legal string) **is** accepted, so the cell cannot pass by banning the word |
| 4 | `files-list rejects non-string path and requestId with BAD_FRAME` | cell 4 — plus a string control that still lists |
| 5 | `files-pause rejects invalid direction with BAD_FRAME before transfer lookup (code assertion)` | cell 5 — a **code** assertion by design: `BAD_FRAME`, not the downstream `TRANSFER_UNKNOWN`; control `"upload"` reaches the lookup and answers `TRANSFER_UNKNOWN` |
| 6 | `INBOUND_FIELDS schema table has an entry for every declared inbound type` | cell 6 — and it is not a key-existence check: each entry's **own** declared kinds synthesise a frame that must pass, then one required field is broken and must fail. Anti-vacuity: the table must declare exactly **32** fields, so emptying an entry reds it instead of quietly shrinking what is validated |
| 7 | `tolerates extra unknown keys without rejecting the frame (serde parity)` | cell 8 — junk keys on a legal `files-list` still list |
| 8 | `optional field accepts explicit null while rejecting non-boolean string` | cell 9 — **same fixture, two outcomes**: `recursive: null` → `DIR_NOT_EMPTY`, `recursive: "false"` → `BAD_FRAME`. This pair is the proof the check is per-kind, not "reject anything that is not `true`" |

Brief cell 7 (the unknown-`type` arm still drops) required no new cell: the pre-existing `drops a type outside the twelve instead of reaching an arm` (asserting `files-explode` → `[]`) is its positive control, and it keeps passing — the boundary did not swallow warn-and-ignore.

**Both polarities, measured independently by BA and by QA.** BA's reachability probe (3 cells, written against the landed source) is **2 failed at BASE `e171f88`, 3 passed at HEAD**, with the accept-control green at both — so the probe can see the defect it claims is fixed. QA's matrix (`.superpowers/probes/t22-landing-qa/`) runs 56 cells in one pass: at BASE exactly the **7** demonstrator cells red, all 56 green at HEAD; and **9/9 mutants killed** (M1 `u64` → cell 2; M2 `bool` → cells 1, 9; M3 required-fields → cells 2–6; M4b table entry removed → cell 6 + `tsc` TS2741; M5 `direction` → cell 5; M6 `string` → cells 3, 4, 6; M7 unknown-keys-rejected → cell 7; M8 `null`-rejected → cell 8; M9 boundary bypassed → cells 1–5, 8). M4 (making the table `Partial`) survives vitest because it is a type-only change and is killed by `tsc --noEmit` (TS18048) — which is the fourth axis doing the work vitest cannot.

**A correction to the audit artifacts, recorded because the plan must not inherit it.** `qa-verdict-task-22.md` states the `session.ts` diff three ways and two of them are wrong: its §1 scope row says `+72 / −1` and its §7 block says `431 insertions(+), 1 deletion(-)`, with a §2 narrative that names a "removed line 1". The commit has **zero deletions** on both files, as measured above three ways (`--numstat`, `show --stat`, and `diff -u` between the two blobs). The verdict's counts are stale; this section carries the measured ones. QA has been given the measurement to correct its own artifact.

Two non-blocking observations from QA's audit, carried rather than closed: **O-1** `this.actionFailure` does not string-coerce `message.requestId`, so a non-string id on an action frame is echoed as-is — pre-existing at BASE and now **unreachable through `handle()`** for the same reason the coercions are (the boundary refuses a non-string `requestId` on every action type); **O-2** the Rust drops a malformed frame that carries no extractable string id (`lib.rs:1966` → `Vec::new()`), while the port answers `files-error` without an id. O-2 is a real behavioural difference with no protocol impact (the browser has nothing to match it to) and is recorded as a divergence, not repaired.

---

### Task 23: Temp-dir teardown in the five test files

**Landed at:** `35e8a32ba7a862c72542f52a8fb55bdb6c45369d`
**Files (tests only, 0 source files modified):**
- `apps/agent/test/files/sandbox.test.ts` (+25 / −3)
- `apps/agent/test/files/session.test.ts` (+30 / −13)
- `apps/agent/test/identity/store.test.ts` (+23 / −3)
- `apps/agent/test/terminal/pty.test.ts` (+17 / −3)
- `apps/agent/test/terminal/shell-policy.test.ts` (+17 / −2)
- Total: **5 files changed, 112 insertions(+), 24 deletions(-)** (`git diff --shortstat 6b47ede 35e8a32`); `git diff --name-only 6b47ede 35e8a32 | grep -c '^apps/agent/src/'` → **0**.

**Origin & Purpose:**
At BASE, `apps/agent/test/` had 22 `mkdtempSync` occurrences across five files (17 call sites + 5 import lines) and zero teardown hooks. Every test execution left its fixtures in `/tmp`, leaking +106 temporary directories per full suite run (`+106` measured at BASE across three independent runs). Task 23 installs a clean, self-contained teardown mechanism across all five files without introducing shared global state or altering test semantics.

**The Landed Pattern:**
Each file maintains an isolated module-scope registry, a registering helper, and a single top-level `afterAll` hook:

```ts
/** Every temp dir this file creates, removed once the file finishes. */
const TMP_DIRS: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
```

- **Call sites converted:** All 17 `mkdtempSync(join(tmpdir(), ...))` call sites across the five files were replaced with `tmpDir(...)` (sandbox: 2, session: 12, store: 1, pty: 1, shell-policy: 1). Outside the helper bodies, zero `mkdtempSync` calls remain.
- **Teardown flags:** `recursive: true` is strictly mandatory because fixtures nest subdirectories; omitting it (`recursive: false`) fails all five files with `EISDIR`. `force: true` ensures teardown is idempotent and cannot throw if an assertion cell already deleted its target directory (e.g., destructive delete tests).
- **Per-file isolation:** No global registries are used (`git grep 'globalThis.*TMP_DIRS'` is empty). Each test file's teardown runs independently under vitest's process isolation, verified by disabling `afterAll` in `session.test.ts` alone: only session's 68 directories leak, not a union of files.

**The Sibling Cell: Variant C vs. Variant B (Why Variant B was rejected):**
In `apps/agent/test/files/sandbox.test.ts:126-142`, the component-wise containment cell creates a second directory that is not produced by `mkdtempSync`:

```ts
const sibling = `${dir}2`;
mkdirSync(sibling);
TMP_DIRS.push(sibling); // added
```

Routing this creation through `tmpDir('ponter-sibling-')` (Variant B) was initially considered and rejected after measurement. The cell exists specifically to verify that `Sandbox` checks path component boundaries rather than a naive string `startsWith` prefix:
- `${dir}2` shares a string prefix with `dir` (`/tmp/.../ponter-files-XYZ` vs. `/tmp/.../ponter-files-XYZ2`) without being path-contained by it.
- Under the mutant `const prefix = this.root` at `apps/agent/src/files/sandbox.ts:159` (naive string prefix without trailing separator), Variant B generates random prefixes that share only `/tmp/ponter-`, causing the mutant to **SURVIVE** (19 passed — assertion satisfied by absence of signal).
- Under Variant C (`${dir}2` kept + `TMP_DIRS.push(sibling)`), the common string prefix is retained, and the mutant is **KILLED** (`1 failed | 18 passed`). Restoring the code passes all 19 tests, ensuring both polarities hold.

**TEST-INTEGRITY Declaration:**
Counted on committed blobs (`git show 6b47ede:<path>` vs. `git show 35e8a32:<path>`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` and `grep -oP '\bexpect\s*\('`:

| File | `it()` BASE → HEAD | `expect()` BASE → HEAD | `.skip / .only / .todo` |
|---|---|---|---|
| `apps/agent/test/files/sandbox.test.ts` | 19 → **19** | 21 → **21** | 0 → 0 |
| `apps/agent/test/files/session.test.ts` | 45 → **45** | 110 → **110** | 0 → 0 |
| `apps/agent/test/identity/store.test.ts` | 5 → **5** | 6 → **6** | 0 → 0 |
| `apps/agent/test/terminal/pty.test.ts` | 15 → **15** | 24 → **24** | 0 → 0 |
| `apps/agent/test/terminal/shell-policy.test.ts` | 12 → **12** | 13 → **13** | 0 → 0 |
| **Total** | **96 → 96** | **174 → 174** | **0 → 0** |

All five rows are **identical**. Test title sets are also identical (105 titles, `diff` empty). Zero test-side assertions were added, weakened, or removed:
- Audit of the **24 deleted lines**: exactly 7 import lines that expanded to include `afterAll`/`rmSync`, and 17 `mkdtempSync` call sites converted to `tmpDir`. Zero deleted lines contain `expect(`.
- Text vs. runner reconciliation: The text recipe reports 96 `it()` across the five files while the runner reports 107 passed because `session.test.ts:617` contains `it.each(FILES_INBOUND_TYPES)` with 12 cases (45 text → 56 runtime; 19 + 56 + 5 + 15 + 12 = 107).

**The Seven Measured Axes (All verified in one run):**
1. **Run:** `cd apps/agent && ./node_modules/.bin/vitest run`: **34 files / 430 passed (430)**, exit 0. The 5 touched files alone: **5 files / 107 passed**.
2. **Text:** 96 → 96 `it()`, 174 → 174 `expect()`, 0 `.skip/.only/.todo`.
3. **Typecheck:** `cd apps/agent && ./node_modules/.bin/tsc --noEmit`: **exit 0**. Must-error control (appending bad type to `sandbox.test.ts`) exits **2** (TS2322), proving `test/` is in `tsconfig.json`'s include scope.
4. **Format:** Prettier check on all 5 committed blobs exits 0; positive control exits 1; repo `pnpm format:check` exits 0.
5. **The Leak:** Full `/tmp` superset detector across three consecutive full suite runs: **0, 0, 0** new entries (`233 → 233` entries, delta 0). BASE was **+106**.
6. **Must-Error Controls:**
   - **C1** (disable `afterAll` in all 5 files): **+106** entries.
   - **C2** (disable `afterAll` in `sandbox.test.ts` only): **+20** entries (18 `root()` factory calls + 1 sibling + 1 outside = 20), matching the file's runtime creation count.
   - **C3** (disable `afterAll` in all 5 files across full suite): **+106** entries (`C1 == R0 == C3 == 106`).
   - **C4** (drop only `TMP_DIRS.push(sibling)` in `sandbox.test.ts`): **+1** entry (`ponter-files-XYZ2`).
   - **Failure path:** Injected test failure in `sandbox.test.ts` still runs `afterAll` (exit 1, leak delta 0).
7. **Workspace Gating Job:** `pnpm exec turbo run test --filter='!@ponter/agent-node' --filter='!@ponter/web' --filter='!@ponter/shared' --continue=always --force`: **9 successful, 9 total** (`@ponter/mobile` has no test script, dropping from 10 to 9). As `@ponter/agent-node` is excluded from CI gating, manual verification of axes 1–6 is load-bearing.

---

### Task 24: Literal pin of the PTY session cap

**Landed at:** `783dda143809e5d330b529663faf8e8dafdeaeac`
**Files (tests only, 0 source files modified):**
- Modify: `apps/agent/test/terminal/pty.test.ts` (+10 / −0)
- Total: **1 file changed, 10 insertions(+)** (`git diff --numstat 35e8a32 783dda1` → `10 0`); `git diff --name-only 35e8a32 783dda1 | grep -c '^apps/agent/src/'` → **0**.

**Origin & Purpose: The circular assertion defect.**
Register Item 5 / Brief §1 identified a circular assertion hole in `apps/agent/test/terminal/pty.test.ts`. Existing tests asserted `expect(accepted).toBe(MAX_SESSIONS)` where `accepted` counted iterations in a loop explicitly bounded by `for (let i = 0; i < MAX_SESSIONS; i += 1)`. In TypeScript, both sides of the assertion read the identical imported module-level constant symbol. Consequently, the test asserted `constant === constant`, never verifying what the constant actually was. At BASE (`35e8a32`), mutating `MAX_SESSIONS` from 10 to 1, 2, 3, 5, 9, 11, 16, or 100 left the test suite 100% blind and green.

The Rust codebase did not have this blind spot because its PTY cap was an explicit constructor parameter (`PtyManager::new(max_sessions)`, `lib.rs:2871-2879`), so Rust unit tests passed literal values (such as `PtyManager::new(1)`) and asserted observable overflow behaviour (`lib.rs:3132-3156`). When the TypeScript port converted the cap into a module-level constant (`apps/agent/src/terminal/pty.ts:5`), it lost the literal parameter that made the Rust assertions non-circular.

**The Landed Cell:**
A dedicated test cell was added to `apps/agent/test/terminal/pty.test.ts:96-104` inside the `describe('PtyManager.create', ...)` block, mirroring the precedent in `apps/agent/test/files/session.test.ts:400` (`FILES_IDLE_TIMEOUT_MS`):

```ts
  // Only the literal `10` is asserted. "The prod cap equals the constant"
  // is NOT asserted, because in TS both sides are the same symbol — asserting
  // that `MAX_SESSIONS` equals itself cannot fail. Rust could assert the
  // equivalent by passing a literal to its constructor (`PtyManager::new(1)`);
  // TS made the cap a module constant, so only asserting against the literal
  // wire value `10` makes the assertion non-circular.
  it('pins the session cap to the wire value', () => {
    expect(MAX_SESSIONS).toBe(10);
  });
```

The comment preceding the cell was carefully drafted in prose to avoid writing `expect(` syntax inside comments (unlike a prior comment in `session.test.ts:396`), ensuring naive text-search recipes `\bexpect\s*\(` accurately match only executable assertions.

**TEST-INTEGRITY Declaration:**
Recounted on committed blobs (`git show 35e8a32:apps/agent/test/terminal/pty.test.ts` vs. `git show 783dda1:apps/agent/test/terminal/pty.test.ts`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` and `grep -oP '\bexpect\s*\('`:

| Scope | Before (BASE `35e8a32`) | After (`783dda1`) | Net |
|---|---|---|---|
| `apps/agent/test/terminal/pty.test.ts` | **15 `it()` / 24 `expect()`** | **16 / 25** | **+1 / +1** |
| `apps/agent/test/` (33 files) | **396 / 677** | **397 / 678** | **+1 / +1** |

`.skip` / `.only` / `.todo`: **0 → 0**. Deleted lines: **0** (`git diff --numstat` → `10 0`). Title-set diff: exactly `+ "pins the session cap to the wire value"`, with zero existing cells modified, renamed, or deleted.

**Seven Measured Axes (All verified independently):**
1. **Single-file run:** `cd apps/agent && ./node_modules/.bin/vitest run test/terminal/pty.test.ts`: **16 passed (16)**, exit 0.
1b. **Full suite run:** `cd apps/agent && ./node_modules/.bin/vitest run`: **34 files / 431 passed (431)** (430 at BASE + 1), exit 0.
2. **Text recount on committed blob:** 15/24 → 16/25 (+1 it / +1 expect), 0 skips.
3. **Typecheck:** `cd apps/agent && ./node_modules/.bin/tsc --noEmit`: **exit 0**, 0 diagnostics. Must-error control with string cap `MAX_SESSIONS = "10"`: **exit 2, 4 diagnostics** (`error TS2365: Operator '>=' cannot be applied to types 'number' and 'string'`).
4. **Format:** Prettier check on committed blob exits 0; positive control exits 1; repo-wide `pnpm format:check` exits 0.
5. **Both polarities:** Unmutated control `MAX_SESSIONS = 10` is green (16/16). Mutant `MAX_SESSIONS = 3` is **RED (1 failed | 15 passed)** on `pins the session cap to the wire value` with `AssertionError: expected 3 to be 10` (mutant killed).
6. **No other cell moved:** Under mutant `MAX_SESSIONS = 3`, exactly the single pin cell fails while all other 15 existing test cells remain green. Specificity controls U1 (`MAX_PTY_CHUNK` mutated to 32 KiB) and U2 (enforcement `>=` mutated to `>`) fail their own respective cells while the pin cell remains green.
7. **Workspace gating job:** `pnpm exec turbo run test --filter='!@ponter/agent-node' --filter='!@ponter/web' --filter='!@ponter/shared' --continue=always --force`: **9 successful, 9 total**, exit 0.

**QA Scope Finding (§6): Unpinned Constants in the Workspace:**
QA's independent mechanical census and multi-point band mutation of all 24 numeric exported constants in `apps/agent/src/**` revealed that the brief's claim ("`MAX_SESSIONS` is the only member") was incomplete. Three other constants admit material value mutations while leaving the entire 431-test suite green:
1. `FILE_MAX_BYTES` (1 GiB, `apps/agent/src/files/protocol.ts:10`): The only test exercising it (`session.test.ts:780`) tests `size: FILE_MAX_BYTES + 1` (circular rejection above constant), leaving values such as 512 MiB or 2 GiB completely unpinned. A literal pin `expect(FILE_MAX_BYTES).toBe(1073741824)` is proven by QA's `gap-cure.mjs` to catch this gap.
2. `ACK_FLUSH_INTERVAL_MS` (20 ms, `apps/agent/src/files/protocol.ts:9`): Zero tests import or verify this constant; any value ≤ 20 ms passes because the test harness advances mock time in 20 ms ticks.
3. `MAX_FRAME_BYTES` (64 KiB, `apps/agent/src/terminal/pty.ts:11`): A dead port artifact with **zero production callers** in the TypeScript codebase (as recorded in `data-channels.ts:236`), allowing any value from 1 KiB to 1 MiB to ship green. Scheduled for removal in Task 27.

---

### Task 25: Put the three desktop control frames on the wire the browser reads

**Landed at:** `95fd96c035830b0a9c0f0d0a52ebbeb53297722a` (landing) + `833e6c1d4237cf4abd3900df06fddafff6db69da` (test-only fix round)
**Files modified:**
- Landing commit (`95fd96c`, +429 / −147, 3 files):
  - `apps/agent/src/desktop/frames.ts` (+92 / −78, 1 product file)
  - `apps/agent/test/desktop/frames.test.ts` (+185 / −69)
  - `packages/desktop-core/test/frames-composition.test.ts` (+152 / −0, new composition test file)
- Fix commit (`833e6c1`, +69 / −4, 2 files, 0 in `src/`):
  - `apps/agent/test/desktop/frames.test.ts` (+66 / −0)
  - `packages/desktop-core/test/frames-composition.test.ts` (+3 / −4)

**Origin & Purpose: The Three Composition Defects (D-1, D-2, D-3):**
Driving the agent's desktop control frames through `webrtc-core`'s typed listener and `packages/desktop-core`'s browser client parsers at BASE revealed three independent defects that silently broke control frame delivery despite green unit tests:
1. **D-1 (No envelope):** All three builders emitted `{ type, data }`. The browser and WebRTC wire format requires `DataChannelMessage { type, channel: 'control', payload, timestamp }` (`packages/shared/src/types/webrtc.ts:9-14`). The browser reads `msg.payload`, so `data` was ignored: stats and cursor frames were dropped silently, and sources frames arrived with `payload === undefined`.
2. **D-2 (Sources payload shape mismatch):** Agent emitted `{ monitors, windows }` with non-wire shapes. The browser parser (`client.ts:270-291`) reads `DesktopSourcesPayload` (`sources`, `inputEnabled`, `peerVerified`, `cursorInFrame`), where each source in `sources` requires 11 camelCase fields (`id, kind, name, width, height, x, y, scaleFactor, rotation, isPrimary, default`). At BASE, the browser normalized this to `{ sources: [], inputEnabled: false, peerVerified: false, cursorInFrame: false }` — an empty display picker and an input gate that read closed even when open.
3. **D-3 (Stats and cursor validation failure):** `parseStats` (`client.ts:358-370`) requires finite numbers for `width`, `height`, `fps`, and `targetBitrateBps`. The agent emitted `{ seq, fps, bitrate, encodeMsP50, captureMsP50, skippedFrames, profile }` without `width`, `height`, or `targetBitrateBps`. The stats line could never render. For cursor, `seq` was missing, causing `watch(() => desktopCursor?.seq)` to never trigger latency/extrapolation resets. In addition, `shape: null` was emitted instead of omitting the field when unset (violating Rust's `skip_serializing_if = "Option::is_none"`).

**Implementation & Parity with Rust:**
- **Wire envelope:** All three builders return serialized JSON matching `DataChannelMessage<T> satisfies`: `{ type, channel: 'control', payload, timestamp }`.
- **Shared Types:** Uses canonical types from `@ponter/shared` (`DesktopStats`, `DesktopSourcesPayload`, `DesktopSourceInfo`, `DesktopCursorPayload`, `DataChannelMessage`). Local non-wire interfaces (`StatsInput`, `CursorInput`, `SourcesInput`) are eliminated.
- **Optional field omission:** Rust serde uses `skip_serializing_if = "Option::is_none"`. In TypeScript, conditional spreads (`...(field !== undefined ? { field } : {})`) are used for `status`, `frameSeq`, `captureMsP50`, `encodeMsP50`, `frameSamples`, `shape`, and `lastInputSeq`, ensuring unset keys are completely absent from serialized JSON.
- **`buildSourcesFrame` parameterization:** Takes `(sources, inputEnabled, peerVerified, cursorInFrame, timestamp)` and passes all flags directly, enabling two-direction verification mirroring Rust `desktop.rs:3036-3088`.
- **`round1` divergence:** Retained and declared in docblock. Rust serializes `f32` unrounded (`7.25`), whereas TS emits `7.3`. P50 values are unread by client UI/stores (which read `width`, `height`, `fps`, `targetBitrateBps`, `status.kind`, `status.detail`).

**The Test-Only Fix Round (Commit `833e6c1` closing F-1..F-4):**
QA audit on landing commit `95fd96c` reported four fence gaps (F-1..F-4) with zero product defects:
- **F-1 (Optional stats set-direction):** Added test cell `carries the optional stats fields when they are set, and omits only the unset one` (+4 `expect()`), killing mutants dropping `status`, `frameSeq`, and `frameSamples`.
- **F-2 (Sources envelope timestamp):** Cell 10 added `expect(frame.timestamp).toBe(7)` (+1 `expect()`), killing mutant timestamp omission.
- **F-3 (Masked cross-tree type gate & false comment):** Deleted all three `as never` casts and stale comment in `packages/desktop-core/test/frames-composition.test.ts`. Unmasked call-site type checking verified live (drifting parameter types causes `tsc` TS2345 in `desktop-core`).
- **F-4 (Multi-entry sources & windows):** Added test cell `carries multi-entry sources including windows and monitors` (+3 `expect()`), asserting full preservation of multi-entry sources with both `monitor` and `window` kinds.

**Cross-Tree Composition Gate:**
`packages/desktop-core/test/frames-composition.test.ts` imports the agent's builders directly (`import ... from '../../../apps/agent/src/desktop/frames'`). Because `@ponter/desktop-core#typecheck` and `#test` are gated in `ci-node.yml`, `apps/agent/src/desktop/frames.ts` is now covered by a CI-gated compiler check. The cross-package gate is active, unmasked, and verified.

**TEST-INTEGRITY Declaration & Accounting:**
Recounted on committed blobs (`git show 69ffc18:<path>` vs. `git show 833e6c1:<path>`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` and `grep -oP '\bexpect\s*\('`:

| File | Before (`69ffc18`) | Landing (`95fd96c`) | Fix (`833e6c1`) | Net Delta |
|---|---|---|---|---|
| `apps/agent/test/desktop/frames.test.ts` | 7 `it()` / 10 `expect()` | 12 / 23 | **14 / 31** | **+7 / +21** |
| `packages/desktop-core/test/frames-composition.test.ts` | 0 / 0 (absent) | 3 / 7 | **3 / 7** | **+3 / +7** |

`.skip` / `.only` / `.todo`: **0 → 0**. Zero tests weakened. All 4 old cells were replaced with justification (plan fields replaced with wire schema, shape record decoupled, null shape replaced with key omission, sources decoupled into wire payload + multi-entry cells).

**Final Suite & Package Test Counts** (measured on commit `833e6c1`, not on a shared working tree — later untracked work in the tree changes both figures):
- `apps/agent`: 34 files / **438 passed (438)** (+7 net tests vs BASE 431; 436 at landing `95fd96c`, +2 in the fix round).
- `packages/desktop-core`: 2 files / **54 passed (54)** (+3 tests in `frames-composition.test.ts` vs BASE 51).

**QA Binding Verdicts:**
- Landing commit `95fd96c`: **BOUND PASS** (QA verdict `qa-verdict-task-25.md`).
- Fix commit `833e6c1`: **BOUND PASS** (QA verdict `qa-verdict-task-25-re-review.md`).

---

### Task 26: Decode the desktop control types the browser actually sends

**Landed at:** `8fd1098425a97edba422eb21e75e54cf8d202037` — 6 files, **+516 / −247**.
**Files modified:**
- `apps/agent/src/desktop/control.ts` (+80 / −66, decoders repointed to real wire format, dead vocabulary removed)
- `apps/agent/src/desktop/session.ts` (+26 / −37, `control(control: BitrateControl)` restricted to bitrate)
- `apps/agent/src/session/data-channels.ts` (+38 / −49, `dispatchDesktop` wired through `decodeStreamControl`, duplicate arms removed)
- `apps/agent/test/desktop/control.test.ts` (+121 / −85, unit fence repointed at real wire fixtures)
- `apps/agent/test/desktop/session.test.ts` (+30 / −10, dead quality cell removed, live bitrate retarget cell added)
- `packages/desktop-core/test/control-composition.test.ts` (+221 / −0, **new** cross-tree composition fence)

**Origin & Purpose: The Dead Desktop Control Vocabulary (QA Task 17 F-1):**
At BASE, `apps/agent/src/desktop/control.ts` exported two decoders that decoded a vocabulary no producer on this wire ever sends:
1. **`decodeStreamControl`** parsed `type: 'stream-control'` with `action: 'pause' | 'resume' | 'stop' | 'set-bitrate' | 'set-quality'` into a 5-member `StreamControl` union. Neither the browser nor Rust ever produces or consumes this vocabulary.
2. **`decodeDesktopSelect`** parsed `type: 'desktop-select'` with `source: { kind, id }`, splitting the source into `{ kind: 'monitor' | 'window', id } | { kind: 'test' }`.

What the browser actually sends (`packages/desktop-core/src/client.ts:424`, `:429`):
- `selectSource(sourceId: string)`: `sendControl('desktop-select', { sourceId })`
- `setBitrate(bitrateBps: number)`: `sendControl('desktop-bitrate', { bitrateBps })`

What Rust implements (`apps/agent/src/desktop.rs:1998-2023`):
- `desktop-select`: extracts `source_id: String` verbatim as `StreamControl::SourceSwap(source_id)` without splitting.
- `desktop-bitrate`: deserializes `bitrate_bps: u32` and clamps it via `clamp_bitrate` to `[250_000, 20_000_000]`.
- Unknown control types return `Ok(None)`: dropped silently, never answered.

**Why every fence was green at BASE (The Duplicate Implementation Defect):**
`apps/agent/test/desktop/control.test.ts` fed the decoders the dead plan-invented vocabulary, certifying an implementation against a contract no one else used. Meanwhile, `apps/agent/src/session/data-channels.ts:dispatchDesktop` had implemented a second, hand-rolled decoder for the real types, consuming only `clampBitrate` from `control.ts`. Thus, both unit fences passed green while certifying drifted, duplicated contracts.

**The Deliverable (Shape A: Repoint & Wire):**
- **Decoder Signature Takes Merged Body:** In Rust, `decode_control` takes raw `&str` and performs envelope parsing, channel gating (`channel == "control"`), and deserialization. In TypeScript, `DataChannelRouter.handleFrame` already parsed the envelope, gated `channel !== label`, and built `{ type, ...payload }` before `dispatchDesktop` is called. Therefore, `decodeStreamControl` and `decodeDesktopSelect` take `Record<string, unknown>` (the merged body), avoiding duplicate parsing and channel checks.
- **`StreamControl` Union Reduced to 2 Members:** `{ kind: 'select'; sourceId: string } | BitrateControl`, matching Rust's `SourceSwap` and `SetBitrate` (`desktop.rs:1938-1947`). Dead variants (`pause`, `resume`, `stop`, `quality`) are removed.
- **`BitrateControl`:** `{ kind: 'bitrate'; bitrate: number }`.
- **`DesktopSource` Retained for Capture Layer:** Kept in `control.ts` but re-documented as the capture layer's input specification, explicitly *not* a wire decode output.
- **`DesktopSession.control()` Takes `BitrateControl`:** Accepts only `{ kind: 'bitrate', bitrate }`. Stream profile reconfiguration is triggered strictly from the sustain ladder in `pump()` (`applyProfile`), never from inbound control messages.
- **Deduplication in `data-channels.ts`:** Hand-rolled decoding in `dispatchDesktop` is replaced by `decodeStreamControl`. Unknown control types drop silently (matching Rust `_ => Ok(None)`); known types with invalid payloads log a warning.
- **Strict `u32` Boundary Validation (`isU32`):** Rust deserializes `bitrate_bps: u32` (`desktop.rs:1970`). A negative, fractional, or oversized number fails deserialization before reaching `clamp_bitrate`. At BASE, the TS hand-rolled arm accepted non-integers (e.g., `3_000_000.5` clamped to `3_000_001`). The port introduces `isU32`, rejecting invalid values as `null` at the decode boundary to match Rust serde strictness.

**Cross-Tree Composition Fence:**
`packages/desktop-core/test/control-composition.test.ts` connects the real browser client (`DesktopClient.selectSource` / `setBitrate`) through `webrtc-core`'s `DataChannelManager` into the agent's `DataChannelRouter`.
- 6 real test cells:
  1. `selectSource reaches onSelect as the scheme string it sent`
  2. `setBitrate reaches onControl clamped at the wire boundary` (99 Mbps → 20 Mbps)
  3. `a bitrate inside the range passes through unchanged` (positive control)
  4. `drops the dead stream-control vocabulary the old fence certified`
  5. `refuses a fractional bitrate instead of rounding it onto the wire` (RED at BASE)
  6. `warns on a malformed known type instead of dropping it silently` (RED at BASE)
- Two of six cells are RED at BASE, catching the fractional bitrate leak and malformed warning defects. The remaining four cells act as regression pins verifying that the working duplicate in `data-channels.ts` was preserved during the rewrite.

**TEST-INTEGRITY Declaration:**
Measured on committed blobs (`git show {3eac965,8fd1098}:<path>`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` / `grep -oP '\bexpect\s*\('`:

| File | BASE `3eac965` | HEAD `8fd1098` | Delta |
|---|---|---|---|
| `apps/agent/test/desktop/control.test.ts` | 10 `it()` / 21 `expect()` | 12 / 27 | **+2 / +6** |
| `apps/agent/test/desktop/session.test.ts` | 11 / 27 | 11 / 28 | **+0 / +1** |
| `packages/desktop-core/test/control-composition.test.ts` (new) | — | 8 / 16 (recipe) / 6 / 14 (real cells) | **+8 / +16 (recipe)** |

`.skip` / `.only` / `.todo`: **0 → 0** across all touched files.

**Accounting for Cell Removals & Replacements:**
- `control.test.ts`:
  - `decodes the four control kinds` (3 `expect`): Removed. Pinned `pause`/`resume`/`stop`, which have no variants in Rust `StreamControl`. Replaced by cell asserting dead vocabulary decodes to `null`.
  - `decodes a quality change` (1 `expect`): Removed. `set-quality` is not an inbound wire command. Replaced by `refuses a bitrate that is not a u32 instead of clamping it`.
  - `rejects an unknown profile instead of defaulting` (1 `expect`): Folded into the above.
  - `rejects an unknown action and malformed JSON` (2 `expect`): Replaced by `drops a control type the Rust has no arm for` and `does not accept the dead stream-control vocabulary`.
  - `decodes monitor, window and test sources` (3 `expect`): Replaced by `returns the scheme string rather than a parsed {kind, id} pair`.
  - `rejects a monitor with no id or an empty one` (3 `expect`): Replaced by `refuses a missing, non-string or empty sourceId`.
- `session.test.ts`:
  - `re-configures the encoder on a quality change` (1 `expect`): Removed. Profile changes are internal to the sustain ladder in `pump()`. Replaced by `retargets the encoder on a bitrate received while streaming` (+2 `expect`), which killed surviving mutant M-j.
- `control-composition.test.ts` recipe anomaly:
  - The recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` matches lines 135 (`must clamp it (`) and 166 (`arm for it (`), yielding 8 matches for 6 real test cells. Vitest runner executes exactly **6** tests.

**Suite Counts (clean checkouts):**
- `apps/agent`: BASE **35 files / 466 tests** → HEAD **35 files / 468 tests**, exit 0 (+2 tests net).
- `packages/desktop-core`: BASE **2 files / 54 tests** → HEAD **3 files / 60 tests**, exit 0 (+6 tests).

---

### Task 27: Own the terminal message set on the wire (B41)

**Landed at:** `3eac9653e301eae0b0dd3f4006c151271cbb4c49` — 9 files, **+1475 / −27**.
**Files modified:**
- `apps/agent/src/terminal/frames.ts` (+117 / −0, **new** — the three builders)
- `apps/agent/src/session/data-channels.ts` (+191 / −19, the four inbound arms)
- `apps/agent/src/runtime.ts` (+130 / −1, the `pty`/`shellPolicy` deps, the subscriptions, `runtime.terminal`)
- `apps/agent/src/terminal/pty.ts` (+39 / −7, chunk emit + the policy option)
- `apps/agent/test/session/data-channels.test.ts` (+297 / −0)
- `apps/agent/test/runtime.test.ts` (+324 / −0)
- `apps/agent/test/terminal/pty.test.ts` (+69 / −0)
- `apps/agent/test/terminal/frames.test.ts` (+122 / −0, **new**)
- `packages/terminal-core/test/frames-composition.test.ts` (+186 / −0, **new**)

**Zero deletions in every pre-existing test file.** The only deletions in the commit are 19 lines in `data-channels.ts` and 7 in `pty.ts`, all replaced by the arms and comments below.

**Origin & Purpose: the terminal wire had no owner.**
At BASE the router could write bytes into a pty and held a `resize` member nothing called, and that was the whole terminal surface. Measured on the blob, not read off the task story:

1. **No outbound terminal frame existed at all.** `terminal-data`, `terminal-exit` and `terminal-error` were types with no builder anywhere in `apps/agent/src`. The Rust builds all three — `build_terminal_data_frame` (`pty.rs:123-134`), `frame_pty_exit` (`:295-306`), `frame_pty_error` (`:80-97`) — from the same envelope struct it shares with every other frame (`pty.rs:38-45`). The consequence is Task 25's D-1 on a different channel, and the mechanism is worth stating exactly because it is the opposite of a validation: `webrtc-core`'s typed listener parses the frame and fires on **one** condition only, `typeof parsed.type === 'string'` (`data-channel.ts:37`) — it never looks at `channel`. Every consumer then reads `msg.payload` (`terminal-core/src/client.ts:271-274`); with no envelope `payload` is `undefined`, the consumer throws on `payload.terminalId` **inside the listener's `try`**, and the bare `catch` at `:42-44` swallows it. So a flat frame is not rejected — it is dispatched to a handler that explodes invisibly, and the `terminal` channel's own fence could not see it.
2. **Three of the four inbound types had no arm.** The browser sends `terminal-create`, `terminal-resize`, `terminal-close` and `terminal-data` on the `terminal` channel (`terminal-core/src/client.ts:106`, `:220`, `:248`, `:179`), and the Rust dispatches all four (`lib.rs:1366`, `:1436`, `:1452`, `:1463`). BASE had `terminal-data` plus a `resize` member on `RouterDeps` (`data-channels.ts:101`) **with no caller at all** — the port's only `resize` implementation is `pty.ts:223-225` (whose body calls `process.resize` at `:224`), and nothing in `apps/agent/src` or its tests calls it — so a peer that resized or closed a terminal was silently ignored, and one that tried to create a terminal got nothing, because there was no create path to refuse.
3. **A refused spawn was invisible.** `PtyManager.create` rejects with a `PtyError` carrying one of two pinned kebab-case codes (`pty.ts:65-75`, `:124-131`); with no create arm, that rejection had no wire representation. The Rust answers exactly this case through `spawn_failure_frame` at the **dispatch site** (`lib.rs:1431-1434`, defined `:2833-2849`) and its own comment says why: a refused shell with no frame is a blank terminal the user cannot distinguish from a slow one.

**The deliverable, against the Rust it cites:**

- **Three builders, each taking its `timestamp` as a parameter** (`frames.ts:62-117`), mirroring the Rust's signature (`pty.rs:123`, `:295`, `:80`). A builder that read `Date.now()` could not be pinned and two identical calls would disagree — which is exactly why the Rust passes the clock in. `type` is a **sibling** of `payload`, `channel: 'terminal'`.
- **`exitCode: null` is written, not omitted.** `@ponter/shared` declares `exitCode?: number`, which cannot express the Rust's `None`; Rust's field is `Option<u32>` with **no** `skip_serializing_if` (`pty.rs:271-275`), so serde writes `"exitCode": null`. The builder widens locally as `TerminalExitPayload` rather than editing the shared type — the browser reads `payload.exitCode` and `markExited(exitCode?: number)` treats `null` as `undefined` (`terminal-core/src/session.ts:49-55`), so nothing downstream changes. This is deliberately **not** Task 25's rule: `DesktopStats` omits its five optional fields because they carry the attribute (`desktop.rs:2111-2119`).
- **`data` is already base64 and is passed through untouched.** The encode lives in `PtyManager.emitChunks` (`pty.ts:275-280`), which base64s each 16 KiB slice (`MAX_PTY_CHUNK`, `pty.ts:4`). Encoding again at the builder would send the base64 of the base64 text.
- **Four inbound arms** in `dispatchTerminal` (`data-channels.ts:462-542`). `cols`/`rows` are validated as a strict `u16` — `Number.isInteger && > 0 && <= 0xffff` — and **dropped, never clamped**, mirroring Rust's serde rejection plus the dispatch site's log-and-drop (`lib.rs:1440-1443`). Clamping would resize a live terminal to a geometry the peer never asked for, and the peer has no way to learn its request was altered.
- **One `terminal-error` framer, at the dispatch site only.** The Rust frames a refused create in the dispatcher (`lib.rs:1431-1434`, via `spawn_failure_frame` `:2833-2849`), not inside `pty.rs`; framing in both places would send two frames for one refusal and the browser would show the message twice, with the duplicate arriving second. The port keeps the rejection in `PtyManager` and turns it into the frame in `DataChannelRouter.createTerminal` (`data-channels.ts:554-587`). **Pinned on three sides:** `pty.test.ts`'s three `rejects.toMatchObject` cells (`:124`, `:379`, `:456` on the HEAD blob) keep `create` a rejection, `runtime.ts:273-281`'s comment records why the runtime does not frame, and the runtime cell `reports a refused shell to the browser on the terminal channel` (`runtime.test.ts:552`) asserts **`channel.send` called exactly once** (`:625` in the cell) — because reading only the last frame cannot see a second one.
- **The error's `code` is read off the thrown object, not parsed from the message.** The Rust matches the string `"maximum concurrent PTY sessions"` (`lib.rs:2835-2842`) only because `anyhow::Error` erases the type. TS keeps the class, so the discriminator is `code`; an unrecognised code falls back to `pty-spawn-failed`, the Rust's own fallback arm (`lib.rs:2841-2842`).
- **`AgentRuntime` owns the framing subscription.** `RuntimeDeps` grows `pty?: PtyHost` (`runtime.ts:183`) — the same injection shape `filesSession` already uses, with the lazy real `node-pty` adapter as the production default (`:247`) — and `shellPolicy?: ShellPolicy` (`:190`); the constructor subscribes `PtyManager.onData`/`onExit` and builds the frames there, where the channel that carries them is known (`runtime.ts:253-272`), and exposes `runtime.terminal` as the `RouterDeps['terminal']` adapter (`:282-308`). `PtyManager` itself still never serialises — so no `pty.test.ts` cell asserts an envelope its subject does not own.
- **New cross-tree fence** `packages/terminal-core/test/frames-composition.test.ts`: the real agent builders driven through the real `TerminalClient` (`terminal-core/src/client.ts`) and `webrtc-core`'s real `DataChannelManager` — no hand-built envelopes. This is the **composition axis**: two green fences in isolation did not prove the seam, and Task 25's D-1 is precisely a seam defect that both sides' own tests certified as correct.

**TEST-INTEGRITY declaration** — measured on committed blobs (`git show {4339c0a,3eac965}:<path>`), recipe `grep -oP '(?<![.\w])it(?:\.each)?\s*\('` / `grep -oP '\bexpect\s*\('`:

| file | BASE `4339c0a` | HEAD `3eac965` | delta |
|---|---|---|---|
| `apps/agent/test/session/data-channels.test.ts` | 23 / 40 | 34 / 61 | **+11 / +21** |
| `apps/agent/test/runtime.test.ts` | 15 / 23 | 21 / 42 | **+6 / +19** |
| `apps/agent/test/terminal/pty.test.ts` | 16 / 25 | 19 / 33 | **+3 / +8** |
| `apps/agent/test/terminal/pty-real.test.ts` | 1 / 2 | 1 / 2 | 0 / 0 |
| `apps/agent/test/terminal/frames.test.ts` (new) | — | 9 / 21 | **+9 / +21** |
| `packages/terminal-core/test/frames-composition.test.ts` (new) | — | 6 / 12 | **+6 / +12** |

`.skip` / `.only` / `.todo`: **0 → 0** in all five touched `apps/agent` files and in the new package file.

**Two figures that look like errors and are not — stated so a later reader does not "fix" a correct number.**

- **`frames.test.ts` declares 9 `it()` and holds 8 cells.** The recipe's lookbehind `(?<![.\w])` excludes a preceding `.` or word character, but not a space: line 16 is a **comment** reading `a frame without it (or filed under another label)`, and `it (` matches. Counted at line start, the file has exactly **8** real cells, all named below. The declaration carries the recipe's 9 because the recipe is the instrument; the suite below carries 8 because the runner counts cells. Verified both ways: `grep -cP '^\s*it\('` → 8, full recipe → 9.
- **The per-file deltas sum to 35 `it()` while the suite delta is 28.** Both are right, for two independent reasons. (a) The suite figure counts `apps/agent` only, and `frames-composition.test.ts` lives in `packages/terminal-core`. (b) The suite anchor uses `frames.test.ts`'s **8** real cells, not the recipe's 9. So 35 − 6 (package) − 1 (over-count) = 28.

**Suite, measured in a clean worktree at each commit** (not in the shared tree, which Task 26 was writing to during this documentation):
- `apps/agent`: BASE **34 files / 438 tests** → HEAD **35 / 466**, both exit 0.
- `packages/terminal-core`: BASE **5 files / 40 tests** → HEAD **6 / 46**, both exit 0.

**The eight real cells in `frames.test.ts`**: `emits the DataChannelMessage envelope on the terminal channel`; `carries the base64 it was handed, without encoding it again`; `takes its timestamp from the caller, never from the clock`; `types its payload as the shared TerminalDataMessage`; `emits the envelope with the reaped exit code`; `keeps the exitCode key with a null value when no code was reaped`; `names the failure with the pinned kebab-case code`; `carries session-limit-reached unchanged`.

**What is bound:** the three outbound frames' envelope and payloads, including both polarities of `exitCode`; the four inbound arms including the create→error path; the `u16` bound in both directions (non-integer and out-of-range both dropped); the runtime subscription building frames rather than the manager; and the seam from the builders through the real browser client.

**Not touched, and deliberately:** Task 17's `decodeStreamControl` / `decodeDesktopSelect` vocabulary (owned by Task 18's Ruling 2/3 entry), and `apps/agent/**`'s CI gating — still absent from `ci-node.yml`'s `paths:` with `@ponter/agent-node` filtered out, so every cell above is green locally and invisible in CI. Same Plan-3 handoff as Tasks 19 and 25.

---

## Closing sections

### The retirement note (R5) — the ten noise rules, and what becomes of each

`apps/agent/src/logging.rs:26-101` carries **ten** `(target, message)` rules, not
six, and `logging.rs` has **eight** `#[test]`s. The table below accounts for every
one of the ten. An earlier draft of this note invented four rules that do not
exist ("ICE failed", "Ping timeout", an `rtc_sctp` rule, and a `libwayshot` /
"error" pair whose real message reads differently), asserted both "none port" in
Task 1 and "six retire" here, and reversed the DTLS decision the Rust source
documents at length. The reconciliation is: **Task 1's `NOISE` table ships empty,
and that is correct** — every rule names a Rust crate target, and the TypeScript
stack is werift, whose logging is a different mechanism. What follows is not a
port list; it is the rationale each rule encodes, so the knowledge survives even
though the rules do not.

| # | The real rule | What it suppressed, and where the concern lives now |
|---|---|---|
| 1 | `libwayshot_xcap` / "Ignoring a wl_output with version < 4." | Fires once per unrelated Wayland global, so a wall of identical lines each capture start. **Plan 3** — the portal/capture path is ADR-90's and its logging is Plan 3's. |
| 2 | `rtc_ice` / "remote mDNS candidate added, but mDNS is disabled" | Expected, because the agent disables mDNS on purpose. Under werift the equivalent is a candidate that never gathers a pair — visible through the connection state, which the session must react to rather than hide (`classifyClose`, Task 3). |
| 3 | `rtc_ice` / "no such remote" | A STUN success arriving after its pair is gone; rtc-ice discards it. No werift counterpart: werift's ICE agent does not log the discard. Nothing to retire and nothing to port. |
| 4 | `rtc_ice` / "ErrMismatchUsername" | A peer sending with the `ufrag:ufrag` order swapped. Same as #3 — discarded silently by both stacks. |
| 5 | `rtc::peer_connection::handler` / "unhandled STUN packet" | The layer above re-logging the two discards in #3/#4. If werift ever grows such a line, the rule shape here is what Task 1's empty table is for. |
| 6 | `rtc::peer_connection::handler` / "ErrMismatchUsername" | The same re-log, same resolution as #5. |
| 7 | `rtc_dtls` / "Unsupported Extension Type" | Chrome offers DTLS extensions this stack does not implement; ignoring them is correct per RFC 5246 §7.4.1.4 and the handshake completes. **Retires with no replacement** — werift implements a different extension set and logs no equivalent. |
| 8 | `webrtc::peer_connection::driver` / "from 127.0.0.1:" | The loopback socket's STUN writes fail with EINVAL because gathering iterates every socket including loopback; only loopback writes are dropped, so a real-interface failure still shows. **Live concern, re-express here if werift logs it** — this is the one the port is most likely to need, because the Node agent keeps the loopback candidate for same-host peers. |
| 9 | `webrtc::peer_connection::transport::turn_relayer` / "CreatePermission error response (error 403" | coturn's SSRF guard rejects loopback/ULA peers. Verified against deploy coturn 4.18.0; a 403 is always this guard (bad credentials surface as 401), so suppressing it cannot hide an auth fault. **Live concern for Plan 3's TURN work**, where the equivalent diagnostic is werift's relay-permission error. The permission and transaction *timeouts* it triggers are deliberately NOT suppressed — those are also what an unreachable TURN server emits. |
| 10 | `quinn_udp` / "halting segmentation offload" | quinn-udp reports UDP segmentation offload being unavailable at INFO and falls back to `sendmsg`. **Retires with no replacement** — there is no QUIC transport in the Node agent. |

**The DTLS alert line is NOT among these ten, and the Rust deliberately keeps it.**
`logging.rs:56-63` documents the decision and `logging.rs:259` pins it with
`the_dtls_alert_line_is_kept_even_though_it_usually_means_a_clean_close`: rtc
renders `Error::ErrAlertFatalOrClose`, whose text is shared by a benign
`close_notify` and a genuine fatal alert (handshake failure, fingerprint
mismatch), so no string rule can tell them apart, and rtc logs no DTLS transport
state — nothing else would surface the fatal case. One extra line per session is
the price of never hiding a real DTLS failure. Any earlier note claiming this was
retired had it backwards. Task 3's `classifyClose` covers *close codes on the
signalling socket*; it does not and cannot cover a DTLS alert, so it is not a
replacement for the Rust rule — there is no rule to replace.

The mechanism ports intact — target-plus-substring matching, an unknown line is
kept, a known phrase from an unknown target is kept, and `RUST_LOG` composes with
the filter. Task 1's fence writes **three** tests for that mechanism
(`matches on target AND message`, `keeps an unknown line from a known-noisy
target`, `keeps every line when the table is empty`). The Rust has **eight**
logging tests (`logging.rs:193-350`): six `is_noise` cases plus two end-to-end
composed/bridged cases. Five of the six `is_noise` cases are per-rule assertions
against rules that do not port, so they have nothing to assert against an empty
table — that is a consequence of the retirement, not a coverage decision. The two
end-to-end cases are a real loss and are recorded as such: the composed-filter
and `log`-crate-bridge tests have no Node equivalent, because there is no `log`
crate to bridge. Task 1's third test ("keeps every line when the table is empty")
pins the property those per-rule cases collectively guaranteed. The **coturn 403**
rationale (#9) does not retire: it is a signalling-server behaviour, not a log
filter, and it lives in the desktop `agent-supervisor` tree as well.

### Coverage-matrix update (the §9.4 gate)

Before this plan's work can be called done, the coverage matrix must record:

- **49 B-rows closed** across Tasks 1–19, with the owning task's test file named.
- **R3 recorded as a three-way split: 13 re-homed / 2 ported-then-retired / 5
  retired.** The earlier "12 re-homed / 8 retired" in this plan was arithmetically
  impossible (`to_ws_url` alone carries 11, `with_bearer` 2). The enumeration is
  in this plan's corrections block; the matrix's §6.2 carries the same derivation.
- **B19 has no home here** — `applyBitrate` lives in Plan 1 Task 4's addon. If it
  did not land there, it is a Plan 3 gap.
- **New R-entry: ten noise rules recorded, none ported** (above). Not "six
  retired": the retirement note accounts for all ten of `logging.rs:26-101` and
  concludes Task 1's `NOISE` table **ships empty**, because every rule names a
  Rust crate target and the TypeScript stack is werift. What the R-entry records
  is the *rationale* each rule encodes, and the two live concerns it keeps
  findable (the loopback STUN write, #8, and coturn's 403 SSRF guard, #9).
- **New R-entry: `files-download-chunk` as a JSON outbound type** — dropped, never
  emitted by the Rust and therefore unobservable to any browser.
- **Plan-quality declarations corrected:** `desktop-profile-parity.test.ts` is
  **2→2 `it()`, 4→2 `expect()`**, not the "1→2" Plan 1 wrote.

### Self-review

**Spec coverage.** Every §ref named in the header has an owning task: §3.3
(config, Task 1), §3.4 (reuse map — `rewriteWsScheme` sibling, Task 2), §3.5
(backoff/close, Task 3), §4.1–4.7 (files, Tasks 10–11), §6.1 (terminal, Tasks 12,
18), §8 (desktop, Tasks 13, 16–17, 19), §8.1 (static skip, Task 13), §9.1
(input, Task 15), §9.4 (coverage gate, above), §11.1 (identity proof, Task 14).

**A gap this self-review found, and it was the worst one.** The first draft of
this plan had **no consumer at all** for `packetizeAnnexB` (Plan 1 Task 3) and
**no reference at all** to `RTCRtpSenderLike` (Plan 1 Task 2) — two artifacts
Plan 1's own Interfaces block says "Task 3 and Plan 2 consume". Task 19's
`encodeAndSend` sent the encoder's Annex-B buffer to `deps.send('control', …)`,
i.e. down a **data channel**, where it would have produced no error and a black
video. The Rust never did that: `apps/agent/src/desktop.rs:1767-1776` hands the
buffer to `sample_writer(ssrc, payload_type).write_sample(&sample)` and the
`rtc-rtp` crate packetizes it.

This is exactly the failure class a self-review exists to catch — not a typo in
one line, but two halves of a plan each internally consistent and jointly
broken, joined by an interface nobody checked was consumed. Fixed by: naming
both dependencies in Task 19's Interfaces, adding the `rtp` dep and
`sendRtp()` to `DesktopSession`, splitting `deps.send` (JSON control frames on
the `control` data channel) from `deps.rtp` (video over RTP) by comment and by type, and
adding the two tests that fail if the wire path regresses to a data channel.
The general lesson, written down so the next planner applies it: **for every
artifact a plan declares it "produces for a later plan", grep the later plan for
that name.** An unconsumed producer is either dead code or a missing call site,
and nothing else in the document distinguishes the two.

**Placeholder scan.** No task says "similar to Task N"; every code block is
complete; no step says "add error handling" without showing it. Three steps
reference another task's *evidence* (Task 8's `rtc.rs` port split) but repeat the
code they need.

**Type consistency.** `FilesFrame`, `InputEvent`, `StreamControl`, `DesktopSource`
and `ProfileId` are declared once and consumed by name in every later task.
`clampBitrate` is exported from `control.ts` and imported by `session.ts` — not
re-declared. `nextBackoff` is pure and takes milliseconds in every caller.
`RuntimeDeps` is declared once in `runtime.ts` and used by both
`AgentRuntime`'s constructor and `static start`.

**One shadowing hazard, because it cost this repair a round (MAJOR-4).**
`InputEvent` is also a **DOM global** (`lib` includes `DOM`), so any module that
names the type without importing it silently declares the browser's event
instead of the agent's — and only a consumer that imported the real one
disagrees, which is how Task 18's source fence was caught. Import it
type-only (`import type { InputEvent } from '../input/decode.js'`); never rely
on it being "obviously" in scope.

**Review Focus coverage.** Each of the five named lines has its test:
reconnect-reset → Task 5's `run()` test; unclassifiable-frame cascade → Task 4's
zero-warnings test; empty-plaintext E2EE frame → Task 7; symlink escape → Task
10's `rejects a symlink that resolves outside the root` and `uses component-wise
containment, not string prefix`; forever-identical desktop frame → Task 13's
keepalive-count test plus Task 19's bitrate reset.

**Two P5 contradictions ruled here, both stated at their task:**
**#11** (the never-rebuilt sustain ticker): the TS rebuilds the ladder in
`control()` on a quality change because the ladder's `budgetMs` is derived from
the profile's fps — a stale ladder would compare 33 ms frames against a 16.7 ms
budget and downgrade to the floor immediately. The Rust's single-construction
ticker is a **defect**, recorded as such in Task 19's review note.
**#15** (the pre-first-encode `apply_bitrate` no-op): **fixed, not reproduced** —
Task 19's `applies a bitrate received before the first encode` asserts the
setting survives, with the divergence declared in the class comment.
