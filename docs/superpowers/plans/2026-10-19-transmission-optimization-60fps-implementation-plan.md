# Desktop Transmission Optimization & 60 FPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the desktop stream from 30 FPS to 60 FPS on the existing SIMD CPU pipeline, skip re-encoding of unchanged frames, scale the fallback ladder to the selected profile, and lower the web playout delay to match the new cadence.

**Execution Order:** Phase 15 (9-digit device code) lands **first**; Phase 16 (this plan) lands **second**. Task 4 builds on top of Phase 15 Task 6: it edits `apps/desktop/src/shared/ipc-types.ts`, `apps/desktop/src/renderer/types.ts`, and `apps/desktop/src/main/config.ts` where `deviceCode` already exists, and must preserve the `deviceCode` fields.

**Architecture:** The agent already drives its loop from `StreamProfile::frame_budget()` (`tokio::time::interval` at line 1416 of `apps/agent/src/desktop.rs`), so a 60 FPS profile changes the ticker with no separate constant. Two new profiles (`1080p60`, `720p60`) join `StreamProfile`; the encoder's GOP becomes a pure function of the profile (`fps * 2` seconds, preserving the existing 60-frame GOP at 30 FPS); the Windows `capture_image` fallback poll interval follows the profile's budget instead of a fixed 33 ms; the sustain monitor gains an explicit per-profile next rung instead of a single hard-coded floor; and a content-hash gate in the tick loop skips identical consecutive frames while a keepalive cap guarantees the encoder still emits. No new dependency is added, and no hardware encoder is introduced — that remains ADR-92's out-of-scope Level 4 roadmap, tracked separately.

**Tech Stack:** Rust, OpenH264 (`openh264 0.9.8`), `fast_image_resize` (already wired), Tokio, `tracing`; TypeScript/Vue for the web playout change.

**Spec:** `docs/superpowers/specs/2026-10-19-device-code-and-transmission-optimization-design.md` (Part B)

## Global Constraints

- **Language & Comments:** 100% English for code, identifiers, tests, docs, commit messages, and PR bodies. Zero Vietnamese characters.
- **Commit Attribution:** Exactly one author line, `Ngo Tuan Anh <ngotuananh2101@gmail.com>`. Absolutely no `Co-authored-by` trailers (human or AI).
- **TEST-INTEGRITY:** Never delete, skip, or weaken an existing test. Every touched test file carries a declared before→after `it()` / `expect()` (or `#[test]`) pair with a reason. An undeclared test change is BLOCKING.
- **Crate name for `cargo test -p`:** `ponter-agent` (hyphen), from `apps/agent/Cargo.toml`. The lib target's underscore spelling is not a package name and does not resolve.
- **Floor profile:** `SAFE_720P30` stays the guaranteed floor and keeps its name. `DEFAULT_1080P30` stays the CLI default.
- **Phase ordering & single ownership:** Phase 15 (device code) lands before Phase 16 (60 FPS); Phase 16 Task 4 edits files Phase 15 Task 6 already changed (`ipc-types.ts`, `renderer/types.ts`, `config.ts`), and must preserve the `deviceCode` field. Phase 16 Task 4 is the **single owner** of all desktop-profile plumbing: `desktopProfile`, `AGENT_DESKTOP_PROFILE`, and the profile tests in `config.test.ts` and `agent-supervisor.test.ts`.
- **No WebCodecs, no hardware encoder, no new crate.** ADR-48 is descoped and ADR-92 keeps the GPU path as roadmap only.

## Review Focus

1. **`cargo test -p ponter-agent` actually runs the suite.** The package name has a hyphen; the wrong name silently matches nothing and a green run proves nothing.
2. **30 FPS behaviour is byte-identical.** A host on `1080p30` must produce the same GOP (60), the same ticker (33.3 ms), and the same fallback target (`720p30`) as before. Any drift here is a regression on the default deployment.
3. **Frame skip cannot starve the stream.** Identical frames must still be encoded at least once per second, or a late-joining or packet-loss-recovering viewer freezes on a stale reference frame.
4. **The skip hash covers pixels, not metadata.** Hashing `seq` (which increments on every capture) would never report two frames as equal; the gate would be dead code that passes review.
5. **The GDI fallback at 60 FPS.** On Windows without a video recorder, a fixed 33 ms poll caps the stream at 30 FPS regardless of the profile, so the fallback interval must derive from `profile.frame_budget()`.
6. **Playout delay vs. jitter.** Dropping 100 ms to 40 ms at 60 FPS leaves ~2.4 frames of buffer; the change must not be made configurable in the same commit (a knob here hides a regression).

---

### Task 1: Add the 60 FPS profiles

**Files:**
- Modify: `apps/agent/src/lib.rs` (`StreamProfile`, `FromStr`, profile tests)
- Modify: `apps/agent/src/main.rs` (doc comment on `--desktop-profile`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StreamProfile::DEFAULT_1080P60` — 1920×1080, 60.0 fps, 8_000_000 bps
  - `StreamProfile::SAFE_720P60` — 1280×720, 60.0 fps, 5_000_000 bps
  - `FromStr` accepts `1080p60`, `720p60`, `1080p30`, `720p30`.


- [ ] **Step 1: Update the failing tests**

In `apps/agent/src/lib.rs`, replace `stream_profile_parses_the_two_named_profiles`:

```rust
    #[test]
    fn stream_profile_parses_the_four_named_profiles() {
        assert_eq!(
            "1080p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::DEFAULT_1080P30
        );
        assert_eq!(
            "720p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::SAFE_720P30
        );
        assert_eq!(
            "1080p60".parse::<StreamProfile>().unwrap(),
            StreamProfile::DEFAULT_1080P60
        );
        assert_eq!(
            "720p60".parse::<StreamProfile>().unwrap(),
            StreamProfile::SAFE_720P60
        );
    }
```

Replace the body of `stream_profile_rejects_an_unknown_name`. It currently uses `"1080p60"` as the unknown value, which becomes a valid profile after this task:

```rust
    #[test]
    fn stream_profile_rejects_an_unknown_name() {
        let err = "1440p60".parse::<StreamProfile>().unwrap_err();
        assert!(format!("{err:#}").contains("expected 1080p60, 720p60, 1080p30 or 720p30"));
    }
```

Extend `stream_profile_frame_budget_matches_fps`:

```rust
    #[test]
    fn stream_profile_frame_budget_matches_fps() {
        let budget = StreamProfile::DEFAULT_1080P30.frame_budget();
        assert!((budget.as_secs_f32() - 1.0 / 30.0).abs() < 1e-6);

        let fast = StreamProfile::DEFAULT_1080P60.frame_budget();
        assert!((fast.as_secs_f32() - 1.0 / 60.0).abs() < 1e-6);
        // 1.0f32 / 60.0f32 rounds up to 0.016666668 s = 16_666_668 ns.
        assert_eq!(fast.as_millis(), 16);
        assert_eq!(fast.as_nanos(), 16_666_668);

        let fast720 = StreamProfile::SAFE_720P60.frame_budget();
        assert_eq!(fast720, fast, "the ticker depends on fps, not resolution");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ponter-agent stream_profile`
Expected: FAIL to compile — `no associated item named DEFAULT_1080P60 found for struct StreamProfile`.

- [ ] **Step 3: Add the constants and the parsing arms**

In `impl StreamProfile` in `apps/agent/src/lib.rs`, after `SAFE_720P30`:

```rust
    /// 1080p at 60 FPS, 8 Mbps. The 60 FPS ticker budget is 16.67 ms, so the
    /// SIMD downscale plus a software H.264 encode must fit in one tick.
    pub const DEFAULT_1080P60: Self = Self {
        max_width: 1920,
        max_height: 1080,
        fps: 60.0,
        bitrate_bps: 8_000_000,
    };
    /// 720p at 60 FPS, 5 Mbps. The preferred 60 FPS rung on a host that cannot
    /// sustain 1080p60: same cadence, 55% of the pixels per frame.
    pub const SAFE_720P60: Self = Self {
        max_width: 1280,
        max_height: 720,
        fps: 60.0,
        bitrate_bps: 5_000_000,
    };
```

In the `FromStr` match:

```rust
        match value {
            "1080p60" => Ok(Self::DEFAULT_1080P60),
            "720p60" => Ok(Self::SAFE_720P60),
            "1080p30" => Ok(Self::DEFAULT_1080P30),
            "720p30" => Ok(Self::SAFE_720P30),
            other => {
                bail!("unknown desktop profile {other:?}; expected 1080p60, 720p60, 1080p30 or 720p30")
            }
        }
```

Update the doc comment above the `FromStr` impl: "Only the four named profiles exist; anything else is an error rather than a silent default, so a typo in a deployment fails loudly at startup."

In `apps/agent/src/main.rs`, replace the `--desktop-profile` doc comment:

```rust
    /// Desktop quality profile: `1080p30` (default), `720p30` (safe floor),
    /// `1080p60`, or `720p60`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p ponter-agent stream_profile`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/lib.rs apps/agent/src/main.rs
git commit -m "feat(agent): add 1080p60 and 720p60 stream profiles"
```

**TEST-INTEGRITY** (`apps/agent/src/lib.rs` — baseline 20 `#[test]` + 8 `#[tokio::test]`, measured on the base commit):

| Test | Before | After | Reason |
|---|---|---|---|
| `stream_profile_parses_the_two_named_profiles` | 2 assertions | renamed to `..._the_four_named_profiles`, 4 assertions | covers the two new profiles; nothing removed |
| `stream_profile_rejects_an_unknown_name` | input `"1080p60"`, message `expected 1080p30 or 720p30` | input `"1440p60"`, message `expected 1080p60, 720p60, 1080p30 or 720p30` | the old input is now valid; the assertion's intent (a typo fails loudly) is unchanged |
| `stream_profile_frame_budget_matches_fps` | 1 assertion | 3 assertions | pins the 16.67 ms budget the 60 FPS ticker depends on |

Declaration count is unchanged (20 + 8); no test is deleted or skipped.

---

### Task 2: Scale the encoder GOP with the profile

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`gop_frames_for`, `DesktopEncoder::new`, tests)

**Interfaces:**
- Consumes: `StreamProfile` (Task 1).
- Produces: `pub(crate) fn gop_frames_for(profile: StreamProfile) -> u32` — `fps * 2`, rounded, minimum 1.

- [ ] **Step 1: Write the failing test**

Add beside the existing encoder tests in `apps/agent/src/desktop.rs`:

```rust
    #[test]
    fn gop_frames_are_two_seconds_of_the_profile_fps() {
        // 30 FPS keeps the historical 60-frame GOP byte-for-byte.
        assert_eq!(gop_frames_for(StreamProfile::DEFAULT_1080P30), 60);
        assert_eq!(gop_frames_for(StreamProfile::SAFE_720P30), 60);
        // 60 FPS doubles it, so the keyframe interval stays two seconds.
        assert_eq!(gop_frames_for(StreamProfile::DEFAULT_1080P60), 120);
        assert_eq!(gop_frames_for(StreamProfile::SAFE_720P60), 120);
    }

    #[test]
    fn gop_frames_never_collapse_to_zero() {
        let degenerate = StreamProfile {
            max_width: 640,
            max_height: 360,
            fps: 0.2,
            bitrate_bps: 1_000_000,
        };
        assert_eq!(gop_frames_for(degenerate), 1);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p ponter-agent gop_frames`
Expected: FAIL to compile — `cannot find function gop_frames_for`.

- [ ] **Step 3: Implement the helper and wire it in**

Add `gop_frames_for` at module scope in `apps/agent/src/desktop.rs`, immediately above `DesktopEncoder::new`. It is a plain, unconditional free function with **no `#[cfg]` attribute of any kind** — not `#[cfg(windows)]`, not `#[cfg(test)]` — so it is compiled on every platform. This is required, not stylistic: `mod desktop;` at `apps/agent/src/lib.rs:16` is unconditional, the lib target builds on Linux, and `DesktopEncoder::new` is its single caller. A Windows-only cfg would leave the call site unresolved on Linux and hide the helper from the tests below.

```rust
/// The keyframe interval in frames: two seconds of the profile's cadence.
///
/// Derived from the profile rather than fixed at 60 so a 60 FPS stream keeps a
/// two-second GOP (120 frames) instead of an IDR every second, and a 30 FPS
/// stream keeps the historical 60. A pure function so the mapping is testable
/// without constructing an encoder.
pub(crate) fn gop_frames_for(profile: StreamProfile) -> u32 {
    (profile.fps * 2.0).round().max(1.0) as u32
}
```

Replace the hard-coded line in `DesktopEncoder::new`:

```rust
            .intra_frame_period(IntraFramePeriod::from_num_frames(gop_frames_for(profile)))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p ponter-agent gop_frames`
Expected: PASS — 2 tests.

Run the lib target from this non-Windows host: `cargo test -p ponter-agent --lib`
Expected: PASS. This is the placement proof: on Linux the lib target compiles only because `gop_frames_for` carries no `#[cfg]`, and the `gop_frames_*` tests in the same module call it directly.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/desktop.rs
git commit -m "feat(agent): derive the encoder gop from the stream profile"
```

**TEST-INTEGRITY** (`apps/agent/src/desktop.rs` — baseline 57 `#[test]` + 9 `#[tokio::test]`, measured on the base commit): +2 `#[test]`, 6 assertions. No existing test touched. Running total after this task: 59 `#[test]` + 9 `#[tokio::test]`.

---

### Task 3: Poll interval follows the profile on the Windows fallback

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`parse_poll_interval`, `gdi_poll_interval`, `ScreenSource::for_monitor`, `source_for`, the six `parse_poll_interval_*` tests)

**Interfaces:**
- Consumes: `StreamProfile` (Task 1).
- Produces:
  - `fn parse_poll_interval(raw: Option<String>, fallback: Duration) -> Duration`
  - `#[cfg(windows)] fn gdi_poll_interval(profile: StreamProfile) -> Duration`
  - `pub async fn ScreenSource::for_monitor(monitor_id: u32, profile: StreamProfile) -> Result<Self>`
  - `pub async fn source_for(id: &str, profile: StreamProfile) -> Result<Box<dyn FrameSource>>` — the parameter loses its `_` prefix.

**Why:** `run_capture_image_poll` drains the newest frame at the poll interval. At a fixed 33 ms it can never deliver more than ~30 frames per second, so a `1080p60` session on a host whose video recorder is unavailable streams at half the requested rate with no error anywhere.

- [ ] **Step 1: Update the failing tests**

In `apps/agent/src/desktop.rs`, change all six `parse_poll_interval_*` tests to pass the fallback explicitly. Their assertions are unchanged:

```rust
    #[test]
    fn parse_poll_interval_returns_the_default_for_none() {
        assert_eq!(
            parse_poll_interval(None, GDI_DEFAULT_POLL_INTERVAL),
            GDI_DEFAULT_POLL_INTERVAL
        );
    }

    #[test]
    fn parse_poll_interval_returns_the_default_for_empty() {
        assert_eq!(
            parse_poll_interval(Some("".to_string()), GDI_DEFAULT_POLL_INTERVAL),
            GDI_DEFAULT_POLL_INTERVAL
        );
    }

    #[test]
    fn parse_poll_interval_returns_the_default_for_zero() {
        assert_eq!(
            parse_poll_interval(Some("0".to_string()), GDI_DEFAULT_POLL_INTERVAL),
            GDI_DEFAULT_POLL_INTERVAL
        );
    }

    #[test]
    fn parse_poll_interval_returns_the_default_for_garbage() {
        assert_eq!(
            parse_poll_interval(Some("not-a-number".to_string()), GDI_DEFAULT_POLL_INTERVAL),
            GDI_DEFAULT_POLL_INTERVAL
        );
    }

    #[test]
    fn parse_poll_interval_uses_an_explicit_millisecond_value() {
        assert_eq!(
            parse_poll_interval(Some("50".to_string()), GDI_DEFAULT_POLL_INTERVAL),
            Duration::from_millis(50)
        );
    }

    #[test]
    fn parse_poll_interval_uses_a_large_millisecond_value() {
        assert_eq!(
            parse_poll_interval(Some("16".to_string()), GDI_DEFAULT_POLL_INTERVAL),
            Duration::from_millis(16)
        );
    }
```

Add the two new tests:

```rust
    #[test]
    fn parse_poll_interval_uses_the_profile_budget_as_its_fallback() {
        let budget = StreamProfile::DEFAULT_1080P60.frame_budget();
        assert_eq!(parse_poll_interval(None, budget), budget);
        assert_eq!(
            parse_poll_interval(Some("0".to_string()), budget),
            budget,
            "an explicit 0 is still the fallback, not a 0 ms poll"
        );
    }

    #[test]
    fn parse_poll_interval_prefers_an_explicit_value_over_the_budget() {
        assert_eq!(
            parse_poll_interval(
                Some("20".to_string()),
                StreamProfile::DEFAULT_1080P60.frame_budget()
            ),
            Duration::from_millis(20)
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ponter-agent parse_poll_interval`
Expected: FAIL to compile — `this function takes 1 argument but 2 arguments were supplied`.

- [ ] **Step 3: Thread the profile through**

Replace `parse_poll_interval` and `gdi_poll_interval`:

```rust
/// Parse `AGENT_DESKTOP_POLL_INTERVAL_MS` into a `Duration`; returns `fallback`
/// on an absent, empty, zero, or unparseable value.
///
/// The fallback is the profile's frame budget, so the `capture_image` path
/// polls at the stream's cadence: a fixed 33 ms would cap a 60 FPS session at
/// 30 FPS. Split from `gdi_poll_interval` so the parsing logic is unit-testable
/// on every platform without touching the process environment.
#[allow(dead_code)]
fn parse_poll_interval(raw: Option<String>, fallback: Duration) -> Duration {
    raw.and_then(|s| s.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(fallback)
}

/// The poll interval for the `capture_image` fallback path (Task 3).
///
/// Reads `AGENT_DESKTOP_POLL_INTERVAL_MS`; defaults to the profile's frame
/// budget (16.7 ms at 60 FPS, 33.3 ms at 30 FPS). A value of 0 or an
/// unparseable string is treated as the default.
#[cfg(windows)]
fn gdi_poll_interval(profile: StreamProfile) -> Duration {
    parse_poll_interval(
        std::env::var("AGENT_DESKTOP_POLL_INTERVAL_MS").ok(),
        profile.frame_budget(),
    )
}
```

Change `ScreenSource::for_monitor`'s signature and the one call inside the capture thread:

```rust
    pub async fn for_monitor(monitor_id: u32, profile: StreamProfile) -> Result<Self> {
```

```rust
                            run_capture_image_poll(
                                monitor,
                                ready_tx,
                                frame_tx,
                                stop_rx,
                                gdi_poll_interval(profile),
                                FIRST_FRAME_TIMEOUT,
                            );
```

`StreamProfile` is `Copy + Send`, so the `move` closure captures it without disturbing the `Send`-safety comment above the thread: only the `u32` id and a copy of the profile cross into the thread, never an `xcap` handle.

Change `source_for`'s signature and its call:

```rust
pub async fn source_for(id: &str, profile: StreamProfile) -> Result<Box<dyn FrameSource>> {
```

```rust
            Ok(Box::new(ScreenSource::for_monitor(wanted, profile).await?))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p ponter-agent`
Expected: PASS. The three `source_for` test call sites (`desktop.rs:2528`, `:2636`, `:2648`) and the two `lib.rs` call sites already pass a profile and need no edit; only the parameter name changed.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/desktop.rs
git commit -m "feat(agent): derive the capture poll interval from the stream profile"
```

**TEST-INTEGRITY** (`apps/agent/src/desktop.rs` — baseline 57 `#[test]` + 9 `#[tokio::test]`; after Task 2: 59 + 9): the six `parse_poll_interval_*` tests gain a second argument (`GDI_DEFAULT_POLL_INTERVAL`); every assertion is unchanged, so their counts and meaning are preserved. +2 `#[test]`, 5 assertions. No test removed or skipped. Running total after this task: 61 `#[test]` + 9 `#[tokio::test]`.

---

### Task 4: Forward the desktop profile from the desktop app

**Files:**
- Modify: `apps/desktop/src/shared/ipc-types.ts`
- Modify: `apps/desktop/src/renderer/types.ts`
- Modify: `apps/desktop/src/main/config.ts`
- Modify: `apps/desktop/src/main/agent-supervisor.ts`
- Modify: `apps/desktop/src/main/agent-control.ts`
- Test: `apps/desktop/src/main/__tests__/config.test.ts`
- Test: `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`

**Interfaces:**
- Consumes: the agent's four profile names (Task 1).
- Produces:
  - `DESKTOP_PROFILES`, `DesktopProfileName`, `DEFAULT_DESKTOP_PROFILE`, `normalizeDesktopProfile(raw: unknown)` in `shared/ipc-types.ts`
  - `AppConfig.desktopProfile` / `SaveConfigPayload.desktopProfile`
  - `SupervisorConfig.desktopProfile?: DesktopProfileName`
  - `AGENT_DESKTOP_PROFILE` in the sidecar environment

**Dependency on Phase 15:** this task assumes Phase 15 Task 6 has already landed. `AppConfig.deviceCode`, `DesktopDevice.deviceCode`, and `SaveConfigPayload.deviceCode` will already exist in `apps/desktop/src/shared/ipc-types.ts` and `apps/desktop/src/renderer/types.ts`. Add the profile fields beside them; do not remove or overwrite `deviceCode`.

**Why the desktop side needs this at all:** the sidecar reads `AGENT_DESKTOP_PROFILE` (`apps/agent/src/main.rs:69`), but nothing in `apps/desktop/src/` sets it today. A 60 FPS profile is therefore unreachable from the shipped app — only from a hand-written environment.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/main/__tests__/config.test.ts`, append:

```ts
  it('defaults desktopProfile to 1080p30 and persists a valid value', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockClear();

    expect(manager.load().desktopProfile).toBe('1080p30');

    manager.save({ desktopProfile: '1080p60' });
    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.desktopProfile).toBe('1080p60');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(written));
    expect(manager.load().desktopProfile).toBe('1080p60');
  });

  it('normalises an unknown persisted desktopProfile to 1080p30', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ desktopProfile: '1080p' }),
    );
    expect(manager.load().desktopProfile).toBe('1080p30');
  });
```

This file mocks the whole `fs` module, so these tests follow the same `vi.mocked(fs.readFileSync).mockReturnValue(...)` and `mock.calls[0]![1]` shapes the existing cases use rather than writing real temp files.

The file also contains one exact-object assertion, `expect(written).toEqual({ ... })` in `does not persist the localhost fallback when no URL was ever set`. `save()` now writes one more key, so add `desktopProfile: '1080p30',` to that literal. `deviceCode: null` is already there from Phase 15 Task 6 — leave it.

In `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`, append:

```ts
  it('emits AGENT_DESKTOP_PROFILE with the configured value', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
      desktopProfile: '1080p60',
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p60');
  });

  it('emits the safe default when no profile is configured', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p30');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/desktop test -- config.test agent-supervisor.test`
Expected: FAIL — `desktopProfile` is `undefined`, and `env.AGENT_DESKTOP_PROFILE` is `undefined`.

- [ ] **Step 3: Add the profile guard to the IPC contract**

In `apps/desktop/src/shared/ipc-types.ts`, above `interface AppConfig`:

```ts
export const DESKTOP_PROFILES = [
  '1080p30',
  '720p30',
  '1080p60',
  '720p60',
] as const;
export type DesktopProfileName = (typeof DESKTOP_PROFILES)[number];
export const DEFAULT_DESKTOP_PROFILE: DesktopProfileName = '1080p30';

/** Any absent, unknown, or non-string value resolves to the safe default. */
export function normalizeDesktopProfile(raw: unknown): DesktopProfileName {
  return typeof raw === 'string' &&
    (DESKTOP_PROFILES as readonly string[]).includes(raw)
    ? (raw as DesktopProfileName)
    : DEFAULT_DESKTOP_PROFILE;
}
```

Add to `AppConfig`:

```ts
  /** Desktop stream profile forwarded to the sidecar as AGENT_DESKTOP_PROFILE. */
  desktopProfile: DesktopProfileName;
```

Add to `SaveConfigPayload`:

```ts
  /** `undefined` = unchanged. An invalid value is normalised to 1080p30. */
  desktopProfile?: DesktopProfileName;
```

Add the same `desktopProfile` field to `AppConfig` in `apps/desktop/src/renderer/types.ts` (line ~63). The renderer keeps its own copy of this contract.

- [ ] **Step 4: Persist it and forward it**

In `apps/desktop/src/main/config.ts`, import `normalizeDesktopProfile` from `../shared/ipc-types`; add to the `load()` return:

```ts
      desktopProfile: normalizeDesktopProfile(persisted.desktopProfile),
```

and to `save()`'s `updated` object:

```ts
      desktopProfile:
        payload.desktopProfile !== undefined
          ? normalizeDesktopProfile(payload.desktopProfile)
          : normalizeDesktopProfile(persisted.desktopProfile),
```

In `apps/desktop/src/main/agent-supervisor.ts`, add to `SupervisorConfig`:

```ts
  desktopProfile?: DesktopProfileName;
```

import `DesktopProfileName` and `DEFAULT_DESKTOP_PROFILE` from `../shared/ipc-types`, and add to the `env` literal in `buildEnvironment()`:

```ts
      AGENT_DESKTOP_PROFILE: config.desktopProfile ?? DEFAULT_DESKTOP_PROFILE,
```

In `apps/desktop/src/main/agent-control.ts`, forward it in `startNow()`:

```ts
      this.deps.supervisor.start({
        agentId,
        serverUrl: cfg.serverUrl ?? '',
        allowInput: cfg.allowInput,
        identityPath: this.deps.identityPath,
        desktopProfile: cfg.desktopProfile,
      });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop typecheck && pnpm --filter @ponter/desktop test`
Expected: PASS. Any fixture that builds a complete `AppConfig` literal needs the new required field; give it `desktopProfile: '1080p30'` rather than relaxing the type.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/ipc-types.ts apps/desktop/src/renderer/types.ts apps/desktop/src/main/config.ts apps/desktop/src/main/agent-supervisor.ts apps/desktop/src/main/agent-control.ts apps/desktop/src/main/__tests__/config.test.ts apps/desktop/src/main/__tests__/agent-supervisor.test.ts
git commit -m "feat(desktop): forward the desktop stream profile to the sidecar"
```

**TEST-INTEGRITY** (re-measured at execution; baselines from `main`):

| File | Before | After (expected) | Reason |
|---|---|---|---|
| `main/__tests__/config.test.ts` | 12 `it()` / 27 `expect()` | 14 `it()` / 31 `expect()` (+2 `it()`, +4 `expect()`) | pins the profile default, round-trip, and invalid-value fallback |
| `main/__tests__/agent-supervisor.test.ts` | 11 `it()` / 27 `expect()` | 13 `it()` / 29 `expect()` (+2 `it()`, +2 `expect()`) | pins `AGENT_DESKTOP_PROFILE` and its default; `AgentSupervisor` is instantiated with `keychainMock as any` |

`keychainMock` and `AgentSupervisor` patterns match the existing tests in `agent-supervisor.test.ts` verbatim: the mock is created once per file and `getSecret.mockReturnValue(...)` is set before each construction, and `AgentSupervisor` takes a single argument.

---

### Task 5: A per-profile sustain ladder

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`SustainAction`, `SustainMonitor`, `downgrade_for`, the tick body, sustain tests)

**Interfaces:**
- Consumes: `StreamProfile` (Task 1).
- Produces:
  - `pub enum SustainAction { Continue, DowngradeTo(StreamProfile) }` (drops the `Eq` derive — `StreamProfile` holds an `f32`, and its own derive list at `apps/agent/src/lib.rs:444` is `Clone, Copy, Debug, PartialEq` with no `Eq`)
  - `pub(crate) fn downgrade_for(profile: StreamProfile) -> Option<StreamProfile>`

**The ladder** (ordered by pixels per second, so every rung is strictly cheaper to encode):

| From | To | Pixels/s |
|---|---|---|
| `DEFAULT_1080P60` | `SAFE_720P60` | 124.4 M → 55.3 M |
| `SAFE_720P60` | `SAFE_720P30` | 55.3 M → 27.6 M |
| `DEFAULT_1080P30` | `SAFE_720P30` | 62.2 M → 27.6 M |
| `SAFE_720P30` | none (floor) | — |

`1080p30` is not a rung below `720p60`: it costs *more* pixels per second, so demoting to it would make the stall worse.

- [ ] **Step 1: Update the failing tests**

Three of the four `sustain_monitor_*` tests currently compare against the unit variant `SustainAction::Downgrade`; the fourth (`sustain_monitor_never_downgrades_from_the_floor`) only asserts `Continue` and compiles unchanged. Update the three expected values; the loop counts and messages stay as they are.

`sustain_monitor_downgrades_once_and_never_oscillates`:

```rust
        assert_eq!(
            monitor.observe(slow),
            SustainAction::DowngradeTo(StreamProfile::SAFE_720P30),
            "the 30th consecutive slow frame trips the fallback"
        );
```

`sustain_monitor_resets_the_streak_on_an_on_budget_frame`:

```rust
        assert_eq!(
            monitor.observe(slow),
            SustainAction::DowngradeTo(StreamProfile::SAFE_720P30)
        );
```

`sustain_monitor_reopens_only_above_the_floor`, second trip:

```rust
        assert_eq!(
            monitor.observe(slow),
            SustainAction::DowngradeTo(StreamProfile::SAFE_720P30)
        );
```

Add three new tests:

```rust
    #[test]
    fn downgrade_ladder_is_monotonic_in_pixels_per_second() {
        let pixel_rate = |p: StreamProfile| {
            f64::from(p.max_width) * f64::from(p.max_height) * f64::from(p.fps)
        };
        for from in [
            StreamProfile::DEFAULT_1080P60,
            StreamProfile::SAFE_720P60,
            StreamProfile::DEFAULT_1080P30,
        ] {
            let to = downgrade_for(from).expect("a non-floor profile has a next rung");
            assert!(
                pixel_rate(to) < pixel_rate(from),
                "{:?} -> {:?} must reduce the encode load",
                (from.max_width, from.max_height, from.fps),
                (to.max_width, to.max_height, to.fps)
            );
        }
        assert_eq!(downgrade_for(StreamProfile::SAFE_720P30), None);
    }

    #[test]
    fn a_1080p60_monitor_demotes_to_720p60_first() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P60);
        let slow = Duration::from_millis(20); // > the 16.67 ms 60 FPS budget
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(
            monitor.observe(slow),
            SustainAction::DowngradeTo(StreamProfile::SAFE_720P60),
            "the first rung below 1080p60 keeps the 60 FPS cadence"
        );
    }

    #[test]
    fn a_720p60_monitor_demotes_to_the_floor() {
        let mut monitor = SustainMonitor::new(StreamProfile::SAFE_720P60);
        let slow = Duration::from_millis(20);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            monitor.observe(slow);
        }
        assert_eq!(
            monitor.observe(slow),
            SustainAction::DowngradeTo(StreamProfile::SAFE_720P30)
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ponter-agent sustain`
Expected: FAIL to compile — `no variant named Downgrade found for enum SustainAction`.

- [ ] **Step 3: Implement the ladder**

Replace `SustainAction`:

```rust
/// What the sustain check wants to do next.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SustainAction {
    /// Stay on the current profile.
    Continue,
    /// Rebuild at the named profile — a resolution and/or cadence change, so
    /// an encoder rebuild.
    DowngradeTo(StreamProfile),
}

/// The next rung below `profile`, or `None` at the floor.
///
/// Every rung is strictly cheaper in pixels per second, so a demotion always
/// reduces the encode load. `1080p30` is deliberately not a rung below
/// `720p60`: it is the more expensive of the two.
pub(crate) fn downgrade_for(profile: StreamProfile) -> Option<StreamProfile> {
    if profile == StreamProfile::DEFAULT_1080P60 {
        Some(StreamProfile::SAFE_720P60)
    } else if profile == StreamProfile::SAFE_720P60
        || profile == StreamProfile::DEFAULT_1080P30
    {
        Some(StreamProfile::SAFE_720P30)
    } else {
        None
    }
}
```

Replace the `SustainMonitor` struct and its three methods:

```rust
pub struct SustainMonitor {
    /// The per-frame budget of the profile currently being encoded.
    budget: Duration,
    /// Consecutive over-budget frames seen so far.
    consecutive_over: u32,
    /// Set once a downgrade is requested (or when there is no rung below) so
    /// the monitor can never ask twice — ADR-24's anti-oscillation hysteresis.
    latched: bool,
    /// The rung to request when the streak trips; `None` at the floor.
    next: Option<StreamProfile>,
}

impl SustainMonitor {
    pub fn new(profile: StreamProfile) -> Self {
        let next = downgrade_for(profile);
        Self {
            budget: profile.frame_budget(),
            consecutive_over: 0,
            // At the floor there is nowhere to fall back to, so the latch
            // starts closed and `observe` can never ask for a downgrade.
            latched: next.is_none(),
            next,
        }
    }

    pub fn observe(&mut self, encode_time: Duration) -> SustainAction {
        if self.latched {
            return SustainAction::Continue;
        }
        if encode_time > self.budget {
            self.consecutive_over += 1;
        } else {
            // A single on-budget frame proves the stall was transient; the
            // streak resets so a jittery-but-sustainable host is never demoted.
            self.consecutive_over = 0;
        }
        if self.consecutive_over >= SUSTAIN_FRAMES_BEFORE_FALLBACK {
            self.latched = true;
            if let Some(next) = self.next {
                return SustainAction::DowngradeTo(next);
            }
        }
        SustainAction::Continue
    }

    /// A bitrate change — manual (the browser) or automatic (the auto-ABR task,
    /// which sends on the same control channel) — is a fresh evaluation request,
    /// so the latch re-opens — but only while there is a lower rung to fall to.
    pub fn note_bitrate_change(&mut self, current: StreamProfile) {
        if downgrade_for(current).is_some() {
            self.latched = false;
            self.consecutive_over = 0;
        }
    }
}
```

Update the doc comment above `SUSTAIN_FRAMES_BEFORE_FALLBACK` to say "before the agent falls back one rung (ADR-24)".

In the tick body, replace the downgrade arm:

```rust
                if let SustainAction::DowngradeTo(next) = sustain.observe(encode_time) {
                    // ADR-24: the host cannot sustain the current profile's
                    // budget, so drop one rung. One rebuild, one IDR blip, and
                    // the monitor for the new profile starts with its own
                    // `next` (closed by construction at the floor).
                    tracing::warn!(
                        from = ?(profile.max_width, profile.max_height, profile.fps),
                        to = ?(next.max_width, next.max_height, next.fps),
                        encode_ms = encode_time.as_secs_f64() * 1000.0,
                        "desktop: cannot sustain the profile; falling back one rung"
                    );
                    profile = next;
                    encoder = DesktopEncoder::new(profile)?;
                    sustain = SustainMonitor::new(profile);
                    // The stats frame carries the *real* next-frame size, so it
                    // is deferred one tick (§6.4) rather than reporting the box.
                    pending_stats = Some(Some(StatsStatus {
                        kind: StatsStatusKind::QualityDowngraded,
                        detail: format!(
                            "{}x{} @ {} fps (quality downgraded)",
                            next.max_width, next.max_height, next.fps as u32
                        ),
                    }));
                }
```

The `detail` string changes from the hard-coded `"720p30 (quality downgraded)"` to a description of the rung actually selected. It stays a human-readable status, and `StatsStatusKind::QualityDowngraded` — the machine-readable field the UI keys on — is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p ponter-agent sustain`
Expected: PASS — 7 tests run by this filter: the four existing `sustain_monitor_*` tests, adapted in place, plus the three new tests. (`abr_next_target_ignores_the_unmoved_seed` is not selected by the `sustain` filter and is not touched by this task.)

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/desktop.rs
git commit -m "feat(agent): fall back one rung at a time with a per-profile sustain ladder"
```

**TEST-INTEGRITY** (`apps/agent/src/desktop.rs` — baseline 57 `#[test]` + 9 `#[tokio::test]`; after Task 3: 61 + 9):

| Test | Before | After | Reason |
|---|---|---|---|
| `sustain_monitor_downgrades_once_and_never_oscillates` | expects `SustainAction::Downgrade` | expects `DowngradeTo(SAFE_720P30)` | the variant now names its target; the profile is the same one the old code hard-coded |
| `sustain_monitor_resets_the_streak_on_an_on_budget_frame` | `Downgrade` | `DowngradeTo(SAFE_720P30)` | same |
| `sustain_monitor_reopens_only_above_the_floor` | `Downgrade` | `DowngradeTo(SAFE_720P30)` | same |
| `sustain_monitor_never_downgrades_from_the_floor` | `Continue` only | unchanged verbatim | still true: `downgrade_for(SAFE_720P30)` is `None` |

Only these four `sustain_monitor_*` tests exist in the file (`apps/agent/src/desktop.rs:3183`, `:3205`, `:3221`, `:3230`). Three of them change an expectation (`Downgrade` → `DowngradeTo(SAFE_720P30)`); the fourth, `sustain_monitor_never_downgrades_from_the_floor`, only asserts `Continue` and is untouched. `abr_next_target_ignores_the_unmoved_seed` (`:3254`) calls the unrelated `abr_next_target()` helper, never mentions `SustainAction`, and is **not** touched by this task.

+3 `#[test]` (all new behaviour: the monotonic ladder, the 1080p60 first rung, and the 720p60 floor rung), 12 assertions, plus four existing tests mechanically adapted. Assertion counts in the adapted tests are unchanged. Running total after this task: 64 `#[test]` + 9 `#[tokio::test]`.

---

### Task 6: Skip re-encoding unchanged frames

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`StaticFrameSkip`, `frame_signature`, `run_stream`, tests)

**Interfaces:**
- Consumes: `RawFrame` (existing).
- Produces:
  - `pub(crate) struct StaticFrameSkip` with `new(fps: f32)`, `should_skip(&mut self, frame: &RawFrame) -> bool`, `reset(&mut self)`
  - `pub(crate) fn frame_signature(frame: &RawFrame) -> u64`

**Design:** the gate hashes pixel content (not `seq`, which increments on every capture and would make every frame look new). Identical frames are skipped before the downscale and the encode, so the saving covers both the ~7 ms resize and the ~4 ms encode. A keepalive cap of `fps` frames (one second) forces an encode even on a perfectly static screen, so a late joiner and a loss-recovering viewer always get fresh data; the counter resets on every encode, so the cap is a bound on *consecutive* skips, not a total. A source swap, a bitrate retarget, and a profile downgrade all reset the gate, because the reference frame the encoder holds no longer describes the new input (spec §4.2.4 item 4). Skipped ticks are not encoded ticks, so they do not advance `encoded`; the periodic `desktop-stats` emission would therefore freeze on a static screen, so the skip branch emits its own stats frame at most once per second (spec §4.2.4 item 5).

**Open question — signature cost vs spec §4.2.4 item 1.** The spec sketches a two-stage signature: a sparse probe over the buffer, with a full-buffer FNV-1a pass only when the probe matches. This plan implements a single-stage full-buffer FNV-1a over 64-bit words on every frame, because the sparse probe as written is unsound for this pipeline: a solid-colour surface makes every sampled pixel identical regardless of what changed between samples, so a probe that samples only every 64th pixel would report "unchanged" for a frame whose entire content moved inside a sampled gap — the very case `static_frame_skip_detects_a_single_pixel_change` pins. Making the probe sound needs a tile-grid maximum-difference pass, which costs a second full read of the buffer and buys nothing over the single pass. **Recommended default:** keep the single-pass FNV-1a and treat the spec's item 1 wording as illustrative, as its own "(for example, …)" clause signals. **If wrong:** a static 1080p screen pays one extra full-buffer read per frame (~8.3 MB) that the two-stage design would avoid only on frames where the probe already matched — and those are exactly the frames where the full pass runs anyway. Recorded here rather than resolved silently; PM and the owner should confirm at review.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent/src/desktop.rs`:

```rust
    fn solid_frame(width: u32, height: u32, value: u8, seq: u64) -> RawFrame {
        RawFrame {
            width,
            height,
            rgba: vec![value; (width * height * 4) as usize],
            seq,
        }
    }

    #[test]
    fn static_frame_skip_detects_identical_pixels() {
        let mut gate = StaticFrameSkip::new(60.0);
        assert!(!gate.should_skip(&solid_frame(8, 8, 0x40, 0)));
        assert!(
            gate.should_skip(&solid_frame(8, 8, 0x40, 1)),
            "identical pixels with a new seq must still be skipped"
        );
    }

    #[test]
    fn static_frame_skip_lets_a_changed_frame_through() {
        let mut gate = StaticFrameSkip::new(60.0);
        gate.should_skip(&solid_frame(8, 8, 0x40, 0));
        assert!(!gate.should_skip(&solid_frame(8, 8, 0x41, 1)));
        assert!(
            gate.should_skip(&solid_frame(8, 8, 0x41, 2)),
            "the new content becomes the reference"
        );
    }

    #[test]
    fn static_frame_skip_detects_a_single_pixel_change() {
        let mut gate = StaticFrameSkip::new(60.0);
        let mut frame = solid_frame(8, 8, 0x40, 0);
        gate.should_skip(&frame);
        frame.rgba[(4 * 8 + 4) * 4] = 0x41;
        frame.seq = 1;
        assert!(
            !gate.should_skip(&frame),
            "a one-byte change must not be reported as static"
        );
    }

    #[test]
    fn static_frame_skip_respects_the_one_second_keepalive() {
        let mut gate = StaticFrameSkip::new(60.0);
        // Reference frame: encoded, because the gate has nothing to compare to.
        gate.should_skip(&solid_frame(4, 4, 0x10, 0));
        let mut skipped = 0;
        // The cap is `fps` *consecutive* skips, so the loop bound and the
        // expected count are both 60: seq 1..=60 all skip, and the 61st frame
        // is the one the cap forces through.
        for seq in 1..=60 {
            if gate.should_skip(&solid_frame(4, 4, 0x10, seq)) {
                skipped += 1;
            }
        }
        assert_eq!(skipped, 60, "the cap allows `fps` skips, then one encode");
        assert!(
            !gate.should_skip(&solid_frame(4, 4, 0x10, 61)),
            "the frame after the cap is encoded and becomes the new reference"
        );
        assert!(
            gate.should_skip(&solid_frame(4, 4, 0x10, 62)),
            "the counter restarts after the forced encode"
        );
    }

    #[test]
    fn static_frame_skip_reset_forces_the_next_frame_through() {
        let mut gate = StaticFrameSkip::new(60.0);
        gate.should_skip(&solid_frame(4, 4, 0x10, 0));
        assert!(gate.should_skip(&solid_frame(4, 4, 0x10, 1)));
        gate.reset();
        assert!(
            !gate.should_skip(&solid_frame(4, 4, 0x10, 2)),
            "after a reset the next frame is the new reference"
        );
    }

    #[test]
    fn frame_signature_distinguishes_dimensions() {
        let wide = RawFrame {
            width: 4,
            height: 2,
            rgba: vec![0; 4 * 2 * 4],
            seq: 0,
        };
        let tall = RawFrame {
            width: 2,
            height: 4,
            rgba: vec![0; 2 * 4 * 4],
            seq: 0,
        };
        assert_ne!(frame_signature(&wide), frame_signature(&tall));
    }

    #[test]
    fn stats_due_while_skipping_fires_once_per_second() {
        let start = Instant::now();
        assert!(!stats_due_while_skipping(start, start));
        assert!(
            !stats_due_while_skipping(start, start + Duration::from_millis(999)),
            "just under a second is not due"
        );
        assert!(stats_due_while_skipping(start, start + Duration::from_secs(1)));
    }

    /// Spec §4.2.4 item 5: a static screen must still report stats. This drives
    /// the real `StaticFrameSkip` and the real throttle predicate across one
    /// second of identical frames and asserts both invariants the spec names:
    /// `encoded` does not advance, and a stats frame is still produced.
    #[test]
    fn a_static_screen_emits_stats_without_encoding() {
        let mut gate = StaticFrameSkip::new(60.0);
        let mut encoded = 0u64;
        let mut stats_emitted = 0u64;
        let mut last_stats_at = Instant::now();
        let mut now = last_stats_at;

        // Tick 0: the gate has no reference, so this frame is encoded and the
        // stream emits its first stats frame.
        assert!(!gate.should_skip(&solid_frame(4, 4, 0x10, 0)));
        encoded += 1;
        stats_emitted += 1;

        // 60 ticks at ~16.667 ms each = 1.00002 s, so the throttle fires exactly
        // once across the loop. Integer microseconds keep that arithmetic exact.
        for seq in 1..=60u64 {
            now += Duration::from_micros(16_667);
            if gate.should_skip(&solid_frame(4, 4, 0x10, seq)) {
                if stats_due_while_skipping(last_stats_at, now) {
                    last_stats_at = now;
                    stats_emitted += 1;
                }
                continue;
            }
            encoded += 1;
            stats_emitted += 1;
        }

        assert_eq!(encoded, 1, "every frame in the window was skipped");
        assert_eq!(
            stats_emitted, 2,
            "one stats frame at stream start, one from the skip throttle"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p ponter-agent static_frame_skip`
Expected: FAIL to compile — `cannot find type StaticFrameSkip in this scope`.

- [ ] **Step 3: Implement the gate**

Add above `SustainAction` in `apps/agent/src/desktop.rs`:

```rust
/// A 64-bit FNV-1a hash over the frame's pixel buffer and geometry.
///
/// Deliberately not `DefaultHasher`: SipHash runs at roughly 1 GB/s, which is
/// ~8 ms on a 1080p RGBA frame — most of a 60 FPS budget spent proving the
/// frame is unchanged. FNV-1a over 64-bit words runs an order of magnitude
/// faster and is only used to decide "identical", never for integrity.
pub(crate) fn frame_signature(frame: &RawFrame) -> u64 {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut chunks = frame.rgba.chunks_exact(8);
    for word in &mut chunks {
        let value = u64::from_ne_bytes(word.try_into().expect("chunks_exact(8)"));
        hash ^= value;
        hash = hash.wrapping_mul(PRIME);
    }
    for byte in chunks.remainder() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash ^= (u64::from(frame.width) << 32) | u64::from(frame.height);
    hash
}

/// Suppresses re-encoding when consecutive captured frames are pixel-identical.
///
/// The cap is one second of frames: a static screen still produces an encoded
/// frame every `fps` ticks, so a viewer that joins late or loses packets never
/// waits on a stale reference. `reset` is called after a source swap or a
/// profile change, where the encoder's reference no longer matches the input.
pub(crate) struct StaticFrameSkip {
    last: Option<u64>,
    consecutive_skips: u32,
    max_consecutive_skips: u32,
}

impl StaticFrameSkip {
    pub fn new(fps: f32) -> Self {
        Self {
            last: None,
            consecutive_skips: 0,
            max_consecutive_skips: (fps.round() as u32).max(1),
        }
    }

    /// True when this frame duplicates the previous one and the keepalive cap
    /// has not been reached. The frame still becomes the new reference.
    pub fn should_skip(&mut self, frame: &RawFrame) -> bool {
        let signature = frame_signature(frame);
        let identical = self.last == Some(signature);
        self.last = Some(signature);
        if !identical {
            self.consecutive_skips = 0;
            return false;
        }
        if self.consecutive_skips >= self.max_consecutive_skips {
            self.consecutive_skips = 0;
            return false;
        }
        self.consecutive_skips += 1;
        true
    }

    pub fn reset(&mut self) {
        self.last = None;
        self.consecutive_skips = 0;
    }
}

/// Spec §4.2.4 item 5: while frames are being skipped, `encoded` does not
/// advance, so the periodic `desktop-stats` emission (`encoded % fps_period`)
/// would stop on a static screen. The skip branch emits at most one stats frame
/// per second instead. This predicate is that whole rule, extracted as a free
/// function so it is testable without a live stream.
fn stats_due_while_skipping(last_stats_at: Instant, now: Instant) -> bool {
    now.duration_since(last_stats_at) >= Duration::from_secs(1)
}
```

- [ ] **Step 4: Wire the gate into the tick body**

In `run_stream`, beside `let mut sustain = SustainMonitor::new(profile);`:

```rust
    let mut static_skip = StaticFrameSkip::new(profile.fps);
    let mut static_skipped: u64 = 0;
    // Spec §4.2.4 item 5: skipped ticks do not advance `encoded`, so the
    // periodic stats emission cannot be the only source of `desktop-stats`
    // frames on a static screen. The skip branch emits its own, throttled here.
    let mut last_stats_at = Instant::now();
```

`Instant` is already imported at the top of the file (`use std::time::{Duration, Instant};`, line 7), so no new import is needed.

In the tick arm, after `next_frame` succeeds and before `downscale`:

```rust
                // Static-frame gate: identical pixels cost nothing to capture
                // but everything to encode. The keepalive cap inside
                // `should_skip` bounds how long a viewer can be starved.
                if static_skip.should_skip(&frame) {
                    static_skipped += 1;
                    // Spec §4.2.4 item 5: `encoded` must NOT advance here, so
                    // the periodic emission below never runs on a static screen.
                    // Report the last known size and the current timings at most
                    // once per second instead. `send_stats` is already an
                    // in-scope closure, so this is a call, not a refactor.
                    let now = Instant::now();
                    if stats_due_while_skipping(last_stats_at, now) {
                        last_stats_at = now;
                        let (fs_seq, cap_p50, enc_p50, enc_samples) =
                            timing_snapshot(&timing_ring, &last_frame_seq);
                        send_stats(
                            &events, encoded_size, profile, None, fs_seq, cap_p50, enc_p50,
                            enc_samples,
                        );
                    }
                    continue;
                }
```

`send_stats` is defined earlier in `run_stream` as a closure capturing `events`, so it is callable here without threading anything through. The call passes `encoded_size` — the last *encoded* frame's dimensions, which is what the spec means by "last known `encoded_size`" — and `None` for the status, because a skip is not a state transition.

The gate must be invalidated on every control event the spec names (spec §4.2.4 item 4). Add `static_skip.reset();` in all three places:

1. **Bitrate retarget** — in the `StreamControl::SetBitrate(bps)` success arm, beside `sustain.note_bitrate_change(profile);`. The encoder is reconfigured for a new target, so the signature the gate holds no longer describes what will be encoded next.
2. **Source swap** — in the `Ok(new_encoder)` arm, next to `encoder = new_encoder;`.
3. **Profile downgrade** — in the downgrade arm (Task 5), beside `sustain = SustainMonitor::new(profile);`.

In the debug diagnostic line, include the skip count so the behaviour is observable:

```rust
                    tracing::debug!(
                        encoded,
                        static_skipped,
                        width = frame.width,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p ponter-agent`
Expected: PASS. The existing `TestPatternSource`-based tests are unaffected: its bar moves on every frame, so `should_skip` returns `false` throughout and those tests keep observing one encoded frame per tick.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/desktop.rs
git commit -m "feat(agent): skip re-encoding pixel-identical frames with a keepalive cap"
```

**TEST-INTEGRITY** (`apps/agent/src/desktop.rs` — baseline 57 `#[test]` + 9 `#[tokio::test]`; after Task 5: 64 + 9): **+8 `#[test]`**, 16 assertions, plus one local helper `solid_frame`. The eight are `static_frame_skip_detects_identical_pixels`, `static_frame_skip_lets_a_changed_frame_through`, `static_frame_skip_detects_a_single_pixel_change`, `static_frame_skip_respects_the_one_second_keepalive`, `static_frame_skip_reset_forces_the_next_frame_through`, `frame_signature_distinguishes_dimensions`, `stats_due_while_skipping_fires_once_per_second`, and `a_static_screen_emits_stats_without_encoding`. No existing test is touched; `TestPatternSource` is untouched, so no test that depends on its output changes.

The last two are the spec §4.2.4 item 5 pins: the first asserts the throttle predicate itself, the second drives the real `StaticFrameSkip` and the real predicate across one second of identical frames and asserts both invariants — `encoded` stays at 1 and a second stats frame is still produced. The keepalive test's `skipped == 60` count is checkable from its own loop bound: `for seq in 1..=60` with `max_consecutive_skips = fps.round() as u32 = 60`, and the counter is incremented *after* the cap check, so all sixty iterations skip and the 61st frame is the one the cap forces through.

Running total after this task: 72 `#[test]` + 9 `#[tokio::test]` (+15 `#[test]`, +0 tokio across Tasks 2, 3, 5, 6).

---

### Task 7: Lower the web playout delay for the 60 FPS cadence

**Files:**
- Modify: `apps/web/src/stores/terminal.ts:956`
- Test: `apps/web/src/__tests__/terminal-store.test.ts:712-722`

**Interfaces:**
- Consumes: nothing.
- Produces: `new DesktopClient(agentId, peer, { playoutDelayMs: 40 }, ...)`.

**Why 40 ms:** at 60 FPS a frame is 16.7 ms, so 40 ms is a 2.4-frame buffer — enough to absorb normal jitter, and 60 ms less standing latency than the 30 FPS-era 100 ms. The value stays a literal at the call site: a user-facing knob would let a regression hide behind a setting.

- [ ] **Step 1: Update the failing test**

In `apps/web/src/__tests__/terminal-store.test.ts`, change the title and the expectation:

```ts
  it('DesktopClient constructor receives { playoutDelayMs: 40 }', async () => {
```

```ts
    expect(lastCall?.options).toEqual({ playoutDelayMs: 40 });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/web test -- terminal-store`
Expected: FAIL — received `{ playoutDelayMs: 100 }`.

- [ ] **Step 3: Change the call site**

In `apps/web/src/stores/terminal.ts`, replace the options object:

```ts
      // 40 ms is ~2.4 frames at 60 FPS: enough to absorb jitter, 60 ms less
      // standing latency than the 30 FPS-era 100 ms buffer.
      const client = new DesktopClient(
        agentId,
        peer,
        { playoutDelayMs: 40 },
        e2eeContext ? new TerminalE2ee(e2eeContext) : undefined,
      );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/terminal.ts apps/web/src/__tests__/terminal-store.test.ts
git commit -m "perf(web): lower desktop playout delay to 40 ms for the 60 fps cadence"
```

**TEST-INTEGRITY** (`apps/web/src/__tests__/terminal-store.test.ts`, baseline 33 `it()` / 61 `expect()`): one test's title and one expected value change from `100` to `40`. Declaration and assertion counts are unchanged; the test still asserts the constructor receives exactly one option, so its strength is preserved.

---

### Task 8: Full verification

- [ ] **Step 1: Run the Rust suite**

```bash
cargo test -p ponter-agent
```

Expected: PASS. The package name is `ponter-agent` with a hyphen (`apps/agent/Cargo.toml`); the underscore spelling is a lib-target name only and does not resolve as a package.

- [ ] **Step 2: Run the workspace suites**

```bash
pnpm typecheck
pnpm format:check
pnpm --filter @ponter/desktop test
pnpm --filter @ponter/web test
```

Expected: every command exits 0.

- [ ] **Step 3: Confirm the default deployment is untouched**

```bash
grep -n "IntraFramePeriod::from_num_frames" apps/agent/src/desktop.rs
grep -n "AGENT_DESKTOP_PROFILE" apps/agent/src/main.rs apps/desktop/src/main/agent-supervisor.ts
```

Expected: the encoder line reads `gop_frames_for(profile)` with no literal, and the environment variable appears in exactly the CLI definition and the supervisor. A literal `60` left in the encoder means a 60 FPS stream gets a one-second GOP.

- [ ] **Step 4: Confirm attribution and language**

```bash
git log --format='%an <%ae>%n%b' main..HEAD | grep -i "co-authored-by" || echo "no trailers"
git diff main..HEAD | grep -nP '[\x{1EA0}-\x{1EFF}]' || echo "no Vietnamese characters"
```

Expected: `no trailers` and `no Vietnamese characters`.

- [ ] **Step 5: Commit the plan's own trail note if the repo convention requires one**

If the repository's `docs/ARCHITECTURE.md` §8 trail is updated in a separate docs-only PR (the convention used for PRs #115/#116), do not touch it here. Otherwise append one entry naming ADR-92 and the squash SHA, using the literal `(squash SHA in next §8 update)` when the squash has not happened yet.
