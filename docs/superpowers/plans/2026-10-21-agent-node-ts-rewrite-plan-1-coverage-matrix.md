# Agent Node/TypeScript Rewrite — Behavioural-Parity Coverage Matrix

**Plan:** Plan 1 — spike, foundations, and the native addon
(`docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-spike-foundation-addon.md`, Task 6)
**Spec:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md` §4 (B1–B62), §4.7 (R1–R6), §9.4 (the gate)
**Branch:** `feat/agent-node-ts-rewrite`
**Status of this file:** Plan 1's snapshot. Plan 2 and Plan 3 extend it; each plan flips the rows it lands from `Not yet written` to `Covered` and names the test.

## What this matrix is for

Spec §9.4 states the gate:

> Every row of §4 — **all 62 of them, B1 through B62** — plus the **six**
> retirements of §4.7 (R1 through R6) — must be covered by at
> least one test in the ported suite.

This file is where that accounting becomes visible. It has two jobs.

**Job 1 — ownership.** Most rows are knowingly not Plan 1's. Plan 1 owns the spike,
the sender seam, the packetizer, the native addon, and the shared profile table. The
signalling core, the terminal, the files service, E2EE, and the desktop session
orchestration belong to Plan 2; the native-only behaviours and the Rust retirement
belong to Plan 3. Naming a row `Plan 2` is a correct assignment, not a gap. A gap is
a row for which no plan is identified at all — those are called out in §4 below.

**Job 2 — TEST-INTEGRITY accounting.** Spec §8.1 fixes the baseline:

> The Rust agent carries **362 anchored `#[test]`/`#[tokio::test]` attributes**
> across 19 files. The port must carry an equivalent suite, not a smaller one.
> Each Rust test that is retired must be accounted for by a TS test or by an
> explicit R-entry (§4.7) — **never by deletion or skip**.

**This table's counts were re-derived from the tree, and they correct an earlier
draft of this file.** That draft totalled 359. 359 was a grep artifact: an
un-anchored `#\[(tokio::)?test\]` pattern counted one prose line as a test
(`apps/agent/src/pty.rs:578`, `// … and a #[tokio::test] body is one.`) and
missed all four `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`
(`apps/agent/src/desktop.rs:3253,3278,3303,3332`). 358 + 4 = **362**. The table
below uses the anchored pattern
`^\s*#\[(test|tokio::test)(\([^)]*\))?\]\s*$`, and the two per-file counts that
move are `desktop.rs` (81 → **85**) and `pty.rs` (12 → **11**).

The baseline has three numbers (§8.1): **362** anchored attributes — the
accounting baseline — **361** compilable on Linux (355 lib + 6 bin), **357**
runnable on Linux (351 lib after 4 `#[ignore]` + 6 bin). Deltas are measured
against **362**.

| Rust file | `#[test]`/`#[tokio::test]` | Owning plan |
|---|---|---|
| `apps/agent/src/desktop.rs` | 85 | Plan 1 (encode/addon half) + Plan 2 (core half) |
| `apps/agent/src/files.rs` | 65 | Plan 2 |
| `apps/agent/src/lib.rs` | 28 | Plan 1 (profile table, `:445-507`) + Plan 2 |
| `apps/agent/src/cursor.rs` | 22 | Plan 2 (change detection, wire frame) + Plan 3 (X11 sampling) |
| `apps/agent/src/api.rs` | 20 | Plan 2 — **but only 7 retire with R3**; see §2's R3 note |

> **Correction to a number I first wrote here.** `api.rs` carries 20 tests, and it is
> tempting to let R3 retire all 20. Seven of them exercise `ApiError`
> (`from_response` ×11 call sites, `network` ×3, `is_auth_fatal` ×8), which has no
> caller outside `api.rs` — that is the dead code R3 names. The other **13 test live
> code**: eleven cover `to_ws_url` (called from `lib.rs:730`) and two cover
> `with_bearer` (called from `signal.rs:353`). Those 13 must be re-homed to a TS test,
> not retirable. R3's row in §2 says 7 for this reason.

| `apps/agent/src/input.rs` | 19 | Plan 1 (`map_code`, addon) + Plan 2 (decoder, rate limiter) |
| `apps/agent/src/desktop/warm_capture.rs` | 18 | Plan 2 |
| `apps/agent/src/rtc.rs` | 16 | Plan 2 |
| `apps/agent/src/signal.rs` | 15 | Plan 2 |
| `apps/agent/src/pty.rs` | 11 | Plan 2 |
| `apps/agent/src/shell_policy.rs` | 10 | Plan 2 |
| `apps/agent/src/portal/evdev_map.rs` | 10 | Plan 1 (addon, Linux key map) |
| `apps/agent/src/logging.rs` | 8 | Plan 2 |
| `apps/agent/src/portal/remote_desktop.rs` | 7 | Plan 1 (addon, Linux input) + Plan 3 (portal session) |
| `apps/agent/src/main.rs` | 7 | Plan 2 |
| `apps/agent/src/e2ee.rs` | 7 | Plan 2 |
| `apps/agent/src/portal/injector.rs` | 5 | Plan 1 (addon, Linux input) |
| `apps/agent/src/identity.rs` | 5 | Plan 2 |
| `apps/agent/src/portal/token_store.rs` | 4 | Plan 2 |
| **Total** | **362** | |

**A per-file count can still vary by target**, because many tests are
`cfg`-gated: `#[cfg(unix)]` ×4 in `shell_policy.rs`,
`#[cfg(not(target_env = "musl"))]` ×5 across `rtc.rs` (4) and `lib.rs` (1), and
`#[cfg(all(target_os = "linux", not(target_env = "musl")))]` ×2 in
`portal/remote_desktop.rs`. The table above is the attribute count, which is
target-independent; do not substitute a runnable count for it.

The per-plan retirement target this implies: **Plan 1 must land a TS suite covering
the rows it owns before Plan 3 deletes anything.** No Rust test may be deleted while
its behaviour is still `Not yet written` in this matrix.

## The three side channels

Spec §4.6 and §9.4 single out three rows that a partial port drops **silently**,
because they travel beside the video rather than inside it — a port that wires up
only the video path loses them without a single failing test. Each is called out
here in prose, and each must have a named consumer before the gate can close.

- **B56 — the cursor frame.** The Rust agent samples the pointer position and shape
  and emits a `desktop-cursor` control frame only when either changed
  (`cursor.rs:1-735`; `desktop.rs:2093-2104`). A port that sends video and input but
  never polls the cursor ships a remote desktop with an invisible pointer and **no
  error anywhere** — the browser simply draws no cursor. **Test: not yet written —
  Plan 2 owns the change-detection and the wire frame (`apps/agent/src/desktop/`
  suite); Plan 3 owns the X11 XFixes sampling half.** The gate must assert the frame
  appears on the wire when and only when the pointer moves.
- **B61 — the `desktop-stats` telemetry.** Periodic control frames carrying the
  encoded-frame count, the dimensions, the current profile, and the quality-downgraded
  status (`desktop.rs:1700-1720`, `:1535-1537`, `:1738-1746`; `DesktopStats` at
  `:2106`, `frame_desktop_stats` at `:2147`). Losing it breaks nothing visible and
  breaks everything operational: the web dashboard's fidelity readout and the
  sustain ladder's own feedback both go dark. **Test: not yet written — Plan 2.**
- **B62 — the desktop control state machine.** `DesktopSelectMessage`
  (`desktop.rs:1986`), the `StreamControl` enum with its `SetBitrate` and `SourceSwap`
  variants (`:1938-1944`), and `StatsStatusKind::QualityDowngraded` (`:2136`). A port
  that carries the video but drops the control frames cannot change source, cannot
  retarget bitrate, and cannot report a downgrade — the stream works and the controls
  are dead. **Test: not yet written — Plan 2.**

## 1. Behaviour rows (B1–B62)

`Owning task` names the plan and task that lands the behaviour. `Test file` names the
suite that asserts it; `Not yet written — Plan N` means the owning plan has not landed
yet, which is the expected state for every row that is not Plan 1's.

| B# | Behaviour (one line) | Owning task (Plan 1 / Plan 2 / Plan 3) | Test file | Status |
|---|---|---|---|---|
| B1 | Two-level message envelope (outer transport `type` + inner tagged signal) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B2 | Bearer auth in the WS upgrade header, never in the query string | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B3 | Reconnect ladder 200 ms × 1.5 → 2000 ms cap | Plan 2 | Existing: `packages/webrtc-core` `ReconnectBackoff` suite, re-pointed at the agent | Not yet written (Plan 2 re-points it) |
| B4 | Terminal close codes 4401 (credential) / 4409 (replaced) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B5 | Ping every 30 s, idle timeout 90 s | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B6 | Inbound frame cap 256 KiB (signalling), 64 KiB (data channel) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B7 | Server pushes `ice-servers` then `identity-challenge`, in that order | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B8 | Answer proof over role/sessionId/sdpSha256/fingerprint | Plan 2 | Existing: `packages/shared/test/identity-proof.test.ts` (the canonical string), plus a Plan 2 call-site test | Partially covered (shared half only) |
| B9 | DTLS fingerprint normalised to uppercase colon-hex, fail-closed on malformed | Plan 2 | Existing: `packages/shared` fingerprint suite, re-pointed at the agent | Not yet written (Plan 2 re-points it) |
| B10 | ICE: mDNS disabled, bind `0.0.0.0:0`/`127.0.0.1:0`, TURN/TCP filtered, server ICE wins over `--stun` | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B11 | Short ICE timeouts when media-only (3 s disconnected / 5 s failed / 1 s check) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B12 | The desktop track is attached **before** `setRemoteDescription` | Plan 1 (the seam) + Plan 2 (the handler) | `packages/webrtc-core/test/adapters/werift-sender.test.ts` asserts the seam holds the order; the agent-side handler assertion is Plan 2 | Partially covered (Plan 1 Task 2 seam only) |
| B13 | Only the expected data-channel label is accepted; others closed immediately | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B14 | Capture → downscale → encode → RTP pipeline | Plan 2 (orchestration); Plan 1 lands the capture and encode halves | Not yet written — Plan 2 | Not yet written (halves covered) |
| B15 | Even-dimension crop before encode | Plan 1, Task 4 | `apps/agent/test/native/fault-containment.test.ts` — the odd-source crop case | Covered |
| B16 | SIMD box-filter downscale | Plan 1, Task 4 | `apps/agent/test/native/fault-containment.test.ts` — the downscale case reads the SPS frame size back | Covered |
| B17 | H.264 encoder config (`ScreenContentRealTime`, `Bitrate` RC, `Complexity::Low`, AQ off, background detection off, bt709) | Plan 1, Task 4 | `apps/agent/test/native/smoke.test.ts` pins the profile, constraint byte and level the config resolves to | Partially covered (the SPS-visible half) |
| B18 | Dynamic GOP = `(fps × 2).round().max(1)` frames | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B19 | Bitrate retarget: raise sets `MAX_BITRATE` on `SPATIAL_LAYER_0` then `BITRATE` on `SPATIAL_LAYER_ALL`; lower needs only the latter | **None in Plan 1** — see §4 | None | **Gap — see §4.1** |
| B20 | Bitrate clamp `[250 kbps, 20 Mbps]` | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B21 | Stream profiles 1080p30 / 720p30 / 1080p60 / 720p60 | Plan 1, Task 5 | `packages/shared/test/stream-profile.test.ts`; pinned from a gating package by `packages/api-client/test/agent-api-access-gate.test.ts`'s suite run | Covered (non-gating package — see §5) |
| B22 | Static-frame skip: 4-lane FNV-1a hash, 1 s keepalive cap, reset on bitrate/source/profile change | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B23 | Sustain ladder: monotonic degradation by pixels/sec, `QualityDowngraded` status | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B24 | Frame timing ring: median capture latency + median encode ms | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B25 | Annex-B output with SPS/PPS/IDR first | Plan 1, Task 4 | `apps/agent/test/native/smoke.test.ts` asserts the Annex-B start code and the reported SPS fields | Covered |
| B26 | RFC 6184 packetization (single-NAL / STAP-A / FU-A) | Plan 1, Task 3 | `apps/agent/test/session/packetizer.test.ts` plus the literal conformance fixtures from the vendored crate | Covered |
| B27 | The negotiated H.264 payload type, never `codecs.first()` | Plan 2 (core PT selection); Plan 1 Task 2 lands the R-S3 mechanism | `packages/webrtc-core/test/adapters/werift-sender.test.ts` covers the mechanism; the agent's selection function is Plan 2 | Partially covered (Plan 1 Task 2 mechanism only) |
| B28 | Input JSON on the `control` DC, `kind` ∈ {pointer-move, pointer-button, wheel, key, text} | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B29 | Coordinates normalised 0..1, NaN → 0.0, clamped | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B30 | Rate cap 120 Hz over a fixed 1 s window, over-limit frames dropped | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B31 | Linux: `org.freedesktop.portal.RemoteDesktop` D-Bus calls | Plan 1, Task 4 (the backend) + Plan 3 (the portal session) | Not yet written — Plan 1 Task 4 Step 12 covers the pure helpers only; the D-Bus call needs a live session | Partially covered |
| B32 | `KeyboardEvent.code` → evdev keycode map | Plan 1, Task 4 | `apps/agent/native/test/` — the key-map table is a pure function and is unit-testable without a session | Covered |
| B33 | Windows: pointer absolute, key map, text | Plan 1, Task 4 | Not yet written — needs a Windows runner; Plan 1 Task 4 Step 12 covers the key map only | Partially covered |
| B34 | `AGENT_ALLOW_INPUT` is agent-local; a peer cannot turn it on | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B35 | Coordinate → absolute-pixel mapping clamped to the display bounds | Plan 1, Task 4 | `apps/agent/native/test/` — the mapping is a pure function once the display bounds are supplied | Covered |
| B36 | Shell allowlist: `/bin/sh` floor ∪ `/etc/shells`; absolute; canonicalize; executable bit | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B37 | `--shell`/`AGENT_SHELL` is always allowed (operator-trusted) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B38 | Windows shell detection: `pwsh` → `powershell` → `cmd.exe` | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B39 | PTY env: `TERM=xterm-256color`, `LANG=C.UTF-8` | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B40 | PTY output: standard base64, 16 KiB chunks, slave end held for correct EOF | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B41 | Terminal message set: create / resize / close / exit / error | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B42 | Files binary frame layout `[1B type][16B id][8B BE index][payload]`, 32 KiB | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B43 | Files JSON message set (12 inbound, 11 outbound) | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B44 | Path sandbox: reject absolute, NUL, backslash, empty/`.` components; containment via canonicalize + prefix | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B45 | Single in-flight transfer per direction; 64-chunk window; 30 s idle; ack every 16 chunks / 20 ms | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B46 | Upload temp suffix `.ponter-part`; resume requires exact `.part` length | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B47 | Ed25519 PKCS#8 identity file, mode 0600, base64 public key | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B48 | Canonical proof bytes ≡ `canonicalProofMessage` | Plan 2 | Existing: `packages/shared/test/identity-proof.test.ts` covers the canonical string; the agent call site is Plan 2 | Partially covered (shared half only) |
| B49 | E2EE: ECDH P-256 → HKDF-SHA256 → AES-256-GCM; `info="ponter-ws1-terminal-v1"`, `salt=session_id`, empty AAD | Plan 2 | Existing: `packages/crypto` `EncryptionManager` suite, re-pointed at the agent | Not yet written (Plan 2 re-points it) |
| B50 | E2EE frame `[12B IV][ct ‖ 16B tag]` | Plan 2 | Existing: `packages/crypto` frame suite, re-pointed at the agent | Not yet written (Plan 2 re-points it) |
| B51 | E2EE test vectors shared with the browser | Plan 2 | Existing: `packages/crypto/test/vectors/e2ee-vectors.json` is consumed by the crypto suite today | Not yet written (Plan 2 re-points it) |
| B52 | E2EE hello/ack handshake, each side signs its key binding | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B53 | API error envelope `{status?, code, message, details?}`; auth-fatal iff 401 or `UNAUTHORIZED` | Plan 2 | Existing: `packages/api-client` error suite; the agent-side classification test is Plan 2 | Partially covered |
| B54 | `RUST_LOG` env var, default `info`, noise filters for known-benign subsystems | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B55 | The `e2ee` capability is advertised iff the offer proposed it | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B56 | **Side channel** — cursor polling; emit a `desktop-cursor` control frame only on a position or shape change | Plan 2 (change detection + wire frame) + Plan 3 (X11 XFixes sampling) | Not yet written — Plan 2 | Not yet written |
| B57 | DPI awareness (Windows) — `SetProcessDpiAwarenessContext(-4)` → `SetProcessDpiAwareness(2)` → `SetProcessDPIAware()` | Plan 3 | Not yet written — Plan 3 | Not yet written |
| B58 | **Side channel half** — desktop source enumeration (`SourceKind`, `DesktopSourceInfo`, the `desktop-sources` frame) | Plan 3 (native enumeration) + Plan 2 (the frame) | Not yet written — Plan 3 | Not yet written |
| B59 | Source selection — `AGENT_DESKTOP_DEFAULT_SOURCE` default, `source_for` resolves a requested id | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B60 | `capture_image` polling fallback, `AGENT_DESKTOP_POLL_INTERVAL_MS` defaulting to the profile's frame budget | Plan 3 | Not yet written — Plan 3 | Not yet written |
| B61 | **Side channel** — `desktop-stats` telemetry: encoded-frame count, dimensions, profile, quality-downgraded status | Plan 2 | Not yet written — Plan 2 | Not yet written |
| B62 | **Side channel** — desktop control state machine: `DesktopSelectMessage`, `StreamControl{SetBitrate,SourceSwap}`, `StatsStatusKind::QualityDowngraded` | Plan 2 | Not yet written — Plan 2 | Not yet written |

## 2. Retirement rows (R1–R6)

Each retirement is a row in its own right because spec §8.1 requires every retired
Rust test to be accounted for by a TS test **or by an explicit R-entry**. An R-row is
the accounting: it says the behaviour is gone on purpose, and why. All six land in
Plan 3, together with the deletion itself.

| R# | Retired (rationale from spec §4.7) | Owning task (Plan 1 / Plan 2 / Plan 3) | Test file | Status |
|---|---|---|---|---|
| R1 | The standalone CLI binary and its `clap` parser — desktop-only; the `AgentSupervisor` already passes configuration via environment variables | Plan 3 | The absence is asserted by the retirement sweep, not by a unit test | Not yet written — Plan 3 |
| R2 | The musl / terminal-only build variant — no cross-compilation | Plan 3 | Asserted by the absence of the target in the build matrix | Not yet written — Plan 3 |
| R3 | `apps/agent/src/api.rs`'s `ApiError` type — `from_response`, `network`, `is_auth_fatal` have **no caller outside `api.rs`**, and `packages/api-client` owns error classification in TS. **Retires 7 Rust tests, not 20** — the other 13 in that file cover `to_ws_url` and `with_bearer`, which are live | Plan 2 (the `ApiError` replacement at its call sites if one appears, and the re-homing of the 13 live tests) + Plan 3 (the deletion) | `packages/api-client/test/agent-api-access-gate.test.ts` asserts no hand-rolled envelope or HTTP client exists in the agent tree; the 13 live tests re-home to a Plan 2 `to_ws_url`/`with_bearer` suite | Partially covered (gate written in Plan 1 Task 5, exercised in Plan 2) |
| R4 | `apps/agent/vendor/xcap` — superseded by the addon's capture; the `PATCH.md` rationale is carried into the addon's capture code as a comment | Plan 3 | The rationale comment is reviewed, not tested | Not yet written — Plan 3 |
| R5 | The `QuietNoise` filter's Rust-crate-specific target names — replaced by equivalent TS filter names | Plan 2 (the TS filter) + Plan 3 (the retirement) | Not yet written — Plan 2 | Not yet written |
| R6 | `build-agent.yml` and the agent GitHub Release — desktop-only | Plan 3 | The TypeScript equivalent of the workflow's boundary gate is `packages/api-client/test/agent-api-access-gate.test.ts` | Partially covered (the gate half, Plan 1 Task 5) |

## 3. Plan 1's rows, counted

Plan 1 lands tests for **seven** B-rows outright and the mechanism for **four** more:

| Row | Plan 1 task | Test |
|---|---|---|
| `B15` | Task 4 | `fault-containment.test.ts` — odd-source crop |
| `B16` | Task 4 | `fault-containment.test.ts` — downscale, SPS frame size read back |
| `B21` | Task 5 | `stream-profile.test.ts` |
| `B25` | Task 4 | `smoke.test.ts` — Annex-B start code + SPS fields |
| `B26` | Task 3 | `packetizer.test.ts` + literal conformance fixtures |
| `B32` | Task 4 | `apps/agent/native/test/` — the evdev key map |
| `B35` | Task 4 | `apps/agent/native/test/` — the coordinate mapping |

Partial (mechanism only, whole behaviour is Plan 2's):

| Row | Plan 1 delivers | Plan 2 completes |
|---|---|---|
| `B12` | The `addTrack` seam that holds the pre-`setRemoteDescription` order | The agent's offer handler |
| `B17` | The encoder config's SPS-visible half (profile, constraint, level) | The rate-control and complexity constants' behaviour under load |
| `B27` | The R-S3 re-pointing mechanism | The agent's PT-selection function |
| `B31` | The Linux input backend | The portal session lifetime |

Plus three gate rows with no B-number: the spike's A1–A4 assertions (spec §9.3), the
addon fault-containment gate (spec §9.2), and the two API-access gates (spec D13).

## 4. Rows with no owning task — the honest gaps

These are the rows where the assignment is not clean. They are listed here rather
than buried in the table because a matrix that looks complete is worth less than one
that names what it could not place.

### 4.1 B19 — the bitrate-retarget path has no home anywhere

This is the one **real gap** in the whole matrix, and it is a Plan 1 defect rather
than a Plan 2/Plan 3 boundary question.

Spec §4.2 B19 says the behaviour's port target is *"the native addon's
`applyBitrate`"*. But Task 4's interface block — the addon's **entire** public
surface, stated as such at the plan's line 1270 — is:

```
platform, listSources, createEncoder, encode, destroyEncoder, injectInput, errorCodes
```

There is **no `applyBitrate`**. So:

- Plan 1 does not land it, because Task 4 never declares it;
- Plan 2 cannot land it, because B19's two-step option order
  (`ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` **first**, then
  `ENCODER_OPTION_BITRATE` on `SPATIAL_LAYER_ALL`; lower needs only the latter) lives
  inside the openh264 encoder handle, which is the addon's;
- Plan 3 does not land it, because Plan 3 is native-only behaviours and retirement.

**Consequence if unfixed:** the port ships without dynamic bitrate retargeting. That
is B62's `StreamControl::SetBitrate` arriving with nowhere to go — the control frame
is parsed and discarded. It is exactly the silent-drop class this matrix exists to
catch, and no test anywhere in the three plans would fail.

**Proposed fix, before Plan 1's Task 4 is dispatched:** add
`setBitrate(handle: number, bps: number): Promise<void>` to the addon's
`index.d.ts` and to `NativeAddon`, add the corresponding entry point in `encoder.cc`
implementing the two-step option order, and add a test to
`apps/agent/native/test/` that asserts the option order against a fake encoder
handle. The behaviour is `desktop.rs:1893-1922` and is a pure sequence of two API
calls, so it is unit-testable without a live encoder.

### 4.2 B17 — the config is only half visible from outside

B17 lists seven configuration constants. Task 4's smoke test can only observe the
three that reach the SPS (`profile_idc`, the constraint byte, `level_idc`); the other
four (`ScreenContentRealTime` usage type, `Bitrate` rate control, `Complexity::Low`,
adaptive quantization off, background detection off, bt709 VUI) are internal
openh264 state with no getter — the same wall Task 4 hits for profile and level
(plan line 1826: `GetBaseParams` returns no profile, no level; `GetOption` has no
`ENCODER_OPTION_PROFILE`). The matrix marks B17 **partially covered** rather than
covered for this reason. It is not a gap in ownership — it is a gap in observability,
and the honest fix is a C++-level test in `apps/agent/native/test/` that reads the
configured `SEncParamExt` back before `Initialize`, not a black-box assertion.

### 4.3 B31 and B33 — native backends tested only at the pure-function layer

Both rows are Plan 1's, both are in the addon, and neither can be fully asserted
without a live desktop session (a Wayland portal session, a Windows input desktop).
Plan 1 Task 4 Step 12 covers the pure helpers (key map, coordinate mapping) and
leaves the OS calls unasserted. The matrix records them as **partially covered**.
This is an environment limit, not an ownership gap, and Plan 3's desktop integration
work is where the end-to-end assertion can live.

### 4.4 B12 and B27 — the seam is Plan 1's, the behaviour is Plan 2's

Both are marked **partially covered**, and the split is deliberate: Plan 1 Task 2
lands and tests the werift mechanism (`addTrack` before `setRemoteDescription`;
`selectNegotiatedCodec` re-pointing), and Plan 2 owns the agent code that *uses* it.
Recording the partial state is the point — a reader who saw "Covered" here would
assume the agent's own handler is tested, and it is not.

## 5. A caveat about how rows are counted as covered

**B21 has a gating problem worth stating explicitly**, because the plan already
knows about it (Global Constraints, line 31):

`ci-node.yml` runs `@ponter/shared`'s suite under `continue-on-error: true`. A green
assertion in `packages/shared/test/stream-profile.test.ts` therefore **cannot fail
the build**. B21's row is marked covered because the test exists and is correct, but
the *pin* is Task 5 Step 5's rewrite of
`apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` — that suite is in a
gating package and reads the same table. Any future row that lands only in
`@ponter/shared` carries the same caveat and must be pinned from a gating package
before it counts.

The same caveat applies to `packages/crypto`'s suites (B49–B51) if `ci-node.yml`'s
`continue-on-error` set covers them; Plan 2 must check before marking those rows
covered.

## 6. Two defects in the spec that this matrix cannot fix

Both were flagged in the earlier BA audit and are still open on the spec. They are
recorded here so they are not lost when Plan 2 is written.

### 6.1 R3's rationale cites a document that does not exist

Spec `:655` reads:

> | R3 | `apps/agent/src/api.rs`'s HTTP error-mapping layer | Dead code — the agent
> has no HTTP client (wire report §5.4). `packages/api-client` owns this concern in TS. |

Spec `:313` carries the same parenthetical. **There is no wire report in this
repository.** `git log --all` finds no file matching `*wire*` that was ever committed,
and the only file by that description is `/tmp/agent-wire-contract-brief.md` — a
session scratch file from 2026-10-21 10:14 that was never added to the tree. A reader
following the citation finds nothing, and a citation that resolves to nothing is
indistinguishable from a claim with no support.

The claim itself is **true**, and can be cited to source instead:

- No caller outside `api.rs` references `ApiError`, `from_response`, `network` or
  `is_auth_fatal` (verified by `grep -rn` across `apps/agent/src`).
- The agent's only outbound HTTP-ish paths are the WS upgrade
  (`signal.rs:353`, via `with_bearer`) and the signalling URL rewrite
  (`lib.rs:730`, via `to_ws_url`) — both live, neither an HTTP API client.
- So `ApiError` is dead code and `packages/api-client` is the right home.

Proposed replacement for both sites: *"Dead code — `ApiError` has no caller outside
`api.rs`; the agent's only outbound paths are the WS upgrade (`signal.rs:353`) and the
signalling URL rewrite (`lib.rs:730`). `packages/api-client` owns this concern in TS."*

This is a spec edit, not a matrix edit. It is listed here because the matrix is what
sent a reader to that row.

### 6.2 R3's retry count was wrong, and my own first draft repeated it

The spec does not state a test count for R3; the matrix's first draft claimed 20,
which is `api.rs`'s total test count. It is 7. §2's R3 row now carries the correct
number and the reason. The accounting consequence matters more than the number: **13
tests in `api.rs` cover live code and must be re-homed, not retired** — they are not
part of R3's budget, and Plan 3 must not delete them along with the file.

## 7. How to extend this matrix

1. When a plan lands a row, change its `Status` to `Covered` and its `Test file` to
   the real path. Never change a `Status` without a test to point at.
2. When a plan lands rows whose Rust tests are being retired, add the before→after
   `it()`/`expect()` counts to that plan's report, per spec §8.1. The 362
   anchored-attribute baseline in this file's preamble is the number that
   accounting is measured against.
3. When a row moves between plans, say why in the row. A plan boundary that shifts
   silently is how a behaviour ends up in nobody's plan — which is exactly how B19
   got here.
4. Re-run the two verification commands after every edit:

```bash
grep -c '^| B[0-9]' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md
grep -c '^| R[0-9]' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md
```

Expected: `62` and `6`.
