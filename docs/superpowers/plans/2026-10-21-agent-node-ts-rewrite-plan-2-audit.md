# Plan 2 compliance audit — agent Node/TS rewrite

**Audited revision:** `8a92601` (plan file `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md`, 7614 lines, 19 tasks).
**Read against:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md`, the Rust source it ports (`apps/agent/src/**`), and the plan's own coverage matrix (`…-plan-1-coverage-matrix.md`).
**Auditor:** BA role session. **Classification:** BLOCKING / non-blocking / refuted.

Every line number below is into the plan **as committed at `8a92601`**. The plan was amended twice during this audit (`406f968` → `8411480` → `5ff4182` → `44d5099` → `0030391` → `a6d86e5` → `8a92601`); where an amendment changed a finding, the finding states which revision it applies to. Findings are pinned to `8a92601` except where a heading says otherwise.

Reproduce any row with the recipe in §10.

---

## 1. Summary

| Class | Count |
|---|---|
| BLOCKING | 9 (B-1…B-9), plus **B-10** raised 2026-10-21 and still open |
| Non-blocking | 6 (one corrected after the fact — see N-6) |
| Refuted (plan is right, or the concern does not hold) | 4 |

The headline: **every one of the 19 tasks' TEST-INTEGRITY declarations is wrong**, and **21 Rust test names cited as porting sources do not exist anywhere in `apps/agent/src`**. Both are the same class of defect — a number or a name written into a declaration that does not describe the tree — and both are BLOCKING because the declaration is the gate the plan itself defines (Plan 2 line 29: an undeclared change is BLOCKING; a declared change that is false is worse, because it passes the gate while misdescribing it).

**Status: B-1…B-9 are closed** by PM's amendment `cebe659` (2026-10-21), verified independently — see §9.1. One non-blocking finding (N-6) was **partly mine and wrong**; it is corrected in place.

**B-10 is open and is the largest item in the rewrite:** the **auto-ABR loop** — the 500 ms ticker that reads a congestion estimator and retargets the encoder, latched off by a manual `desktop-bitrate` frame — has **no B-row, no R-entry, no task, and no plan**. The manual bitrate path is covered (B19 + B62 + B20); the automatic one is outside the §9.4 gate's vocabulary entirely, so a "62 of 62" pass cannot fail on it. It needs an owner ruling, not a porter's guess. See §3's B-10 for the evidence, the four questions, and the landing-spot recommendation.

---

## 2. BLOCKING findings

### B-1. All 19 TEST-INTEGRITY declarations mismatch the code fences in the same task

Declared counts (the plan's own numbers) against fence-actual counts at `8a92601`. `it()` / `expect()`:

| Task | Declared | Fence actual | Δ |
|---|---|---|---|
| T1 | 9 / 17 | **10 / 18** | +1 / +1 |
| T2 | 7→19 `it()`, `expect()` "grows by 15" | 12 / 16 new (url.test.ts); 4 / 5 (upgrade.test.ts) | see B-2 |
| T3 | 15 / 26 | **14 / 20** | −1 / −6 |
| T4 | 18 / 34 | **19 / 28** | +1 / −6 |
| T5 | 21 / 30 | **19 / 29** | −2 / −1 |
| T6 | 9 / 15 | **9 / 11** | 0 / −4 |
| T7 | 7 / 13 | **7 / 11** | 0 / −2 |
| T8 | 36 / 48 | **36 / 48** | 0 / 0 ✔ |
| T9 | 12 / 12 | **12 / 13** | 0 / +1 |
| T10 | 20 / 26 | **18 / 19** | −2 / −7 |
| T11 | 22 / 30 | **25 / 42** | +3 / +12 |
| T12 | 13 / 19 | **11 / 15** | −2 / −4 |
| T13 | 18 / 22 | **16 / 22** | −2 / 0 |
| T14 | 12 / 13 | **11 / 11** | −1 / −2 |
| T15 | 15 / 20 | **16 / 25** | +1 / +5 |
| T16 | 10 / 13 | **9 / 16** | −1 / +3 |
| T17 | 14 / 21 | **15 / 27** | +1 / +6 |
| T18 | 13 / 17 | **12 / 17** | −1 / 0 |
| T19 | 17 / 30 | **17 / 33** | 0 / +3 |

**18 of 19 are wrong in at least one field; exactly one (T8) is right.** T8 is right because it was re-derived in `5ff4182` — which is evidence the method works when applied, and evidence that it was not applied elsewhere.

The errors are not one-directional, so this is not a rounding convention: `it()` is overstated for 6 tasks and understated for 7; `expect()` is overstated for 10 and understated for 5. The largest single miss is **T11 at +12 `expect()`** (declared 30, fences contain 42).

**Why this is BLOCKING, not cosmetic:** the plan defines the declaration as the TEST-INTEGRITY gate (line 29). A plan whose every declaration is false trains its executors to tick a gate that measures nothing, and an executor who *does* land the fence verbatim then owes a count the declaration already claimed. The gate must be true before execution, not after.

### B-2. Task 2's declaration is not in the same shape as the rest, and its one number is off by one

T2 (line 659) declares `url.test.ts`: **`7 it() → 19 it()`**, "`expect()` grows by 15", plus a new file of 4/5.

Measured: the file has **7 `it()` / 18 `expect()`** today; the fence appends **12 `it()` / 16 `expect()`**. So the after-state is **19 `it()` (7 + 12) and 34 `expect()` (18 + 16)** — the `it()` figure is right *by addition*, and the `expect()` growth is **16, not 15**.

This is the only task whose declaration is expressed as a delta rather than a standalone count, which is why it reads as consistent while being wrong: `7 + 12 = 19` validates the `it()` number against the existing file and hides that nobody checked the fence.

### B-3. Twenty-one Rust test names cited as porting sources do not exist

Each was cited as the Rust counterpart of a TS test. Verified against all 318 anchored test names in `apps/agent/src`:

| Cited name | Real counterpart |
|---|---|
| `sustain_ladder_downgrades_after_thirty_frames` | `sustain_monitor_downgrades_once_and_never_oscillates` (desktop.rs:3363) |
| `sustain_ladder_resets_on_an_on_budget_frame` | `sustain_monitor_resets_the_streak_on_an_on_budget_frame` (3385) |
| `sustain_ladder_stops_at_the_floor` | `sustain_monitor_never_downgrades_from_the_floor` (3404) |
| `bitrate_change_reopens_the_latch` | `sustain_monitor_reopens_only_above_the_floor` (3413) |
| `clamps_bitrate_to_the_supported_range` | `decode_control_reads_and_clamps_a_desktop_bitrate` (2966) |
| `decodes_stream_control_variants` | the four `decode_control_*` tests: `…reads_a_desktop_select` (2951), `…reads_and_clamps_a_desktop_bitrate` (2966), `…ignores_another_channel_and_an_unknown_type` (2991), `…rejects_a_malformed_select_payload` (3012) |
| `decodes_desktop_select_variants` | `decode_control_reads_a_desktop_select` (2951) — one of the four above |
| `rejects_an_unknown_profile` | `stream_profile_rejects_an_unknown_name` (lib.rs:3354) |
| `gop_is_two_seconds_of_frames` | `gop_frames_are_two_seconds_of_the_profile_fps` (desktop.rs:2479) |
| `stats_frame_field_names` | `frame_desktop_stats_uses_the_camel_case_wire_shape` (3146) |
| `cursor_frame_includes_shape_when_hidden` | `frame_desktop_cursor_includes_shape_when_some_and_omits_when_none` (3789) |
| `rejects_an_unknown_channel_label` | **none** — no test of the label gate exists |
| `rejects_a_second_channel_with_the_same_label` | **none** — same |
| `drops_a_channel_whose_label_errors` | **none** — same |
| `dispatches_terminal_input` | **none** — no dispatcher test exists |
| `dispatches_files_frames` | **none** — same |
| `dispatches_desktop_control` | **none** — same |
| `resolve_default_source_prefers_primary` | **none** — `default_source_id` (desktop.rs:1004) has no test |
| `runtime_stops_idempotently` | **none** — `run_desktop_session` (lib.rs:2002/2698) has no test |
| `desktop_session_configures_before_capture` | **none** — same |
| `…stops_capture_before_the_encoder`, `…reconfigures_on_a_quality_change` | **none** — same |

Three more names are **functions mistaken for tests**: `run_with_reconnect` (lib.rs:341, a function), `verify_offer_identity` (lib.rs:989, a function; its real tests are `verify_offer_identity_accepts_…` / `…_rejects_…`, five of them), `to_absolute` (input.rs, a function).

**The Task 18 cluster is the serious one.** The declaration (line 6803) claims to port six tests that exercise the data-channel label gate and the dispatcher. The gate exists — `on_data_channel` in `rtc.rs:663-689` accepts one label, closes a second, closes an unexpected one, drops an unlabelled frame — and it has **no test at all**. The plan's Task 18 says the Rust "had this but did not test it" for exactly one case (the second right-label channel, line 2979), which is honest; but the declaration then lists three label tests and three dispatch tests among the *ports*, when there is nothing to port. An executor following the declaration would write new tests and believe they were reproductions, and the R-entry that records "T18 ports 6, adds 3 new" would be false in the direction that matters (it would under-report new coverage and over-report parity).

### B-4. Task 3's backoff-parity test fails as written — and the plan's own arithmetic explanation is wrong twice

The fence (lines 725-738) asserts `Math.abs(d - expected) <= 1` over `rust = [200, 300, 450, 675, 1013, 1519, 2000]`, advancing `d = nextBackoff(d)` each round.

TS `nextBackoff` is `Math.round(Math.min(current * 1.5, 2000))`. Emulating both ladders from a clean start:

```
rung 0: rust-exp 200  ts 200  diff 0
rung 1: rust-exp 300  ts 300  diff 0
rung 2: rust-exp 450  ts 450  diff 0
rung 3: rust-exp 675  ts 675  diff 0
rung 4: rust-exp 1013 ts 1013 diff 0
rung 5: rust-exp 1519 ts 1520 diff 1   <- passes, but for the wrong reason
rung 6: rust-exp 2000 ts 2000 diff 0   <- TS hit the cap one rung earlier
```

**The test passes**, but not as the plan describes: at rung 6 the TS value is 2000 only because the cap clamped `1520 * 1.5 = 2280`, while the Rust array's 2000 came from `1519 → 2278.5 → clamped`. The two ladders reach the cap by different routes and the assertion cannot see it. That is a weak test, not a failing one — and I record it because my first pass reported it as failing, which was wrong. See §4 (D-1) for the correction.

**The plan's explanation of *why* there is a 1 ms divergence (line 34) is wrong twice over:**

1. It says `675 * 1.5` "rounds to 1012". `Math.round(1012.5) = 1013`. The line-34 text asserts the opposite of what `Math.round` does.
2. It attributes the divergence to "the 675 round-trip". The actual divergence is at the **1013 → 1519/1520** step: `(1.013 * 1.5) * 1000 = 1519.4999999999998` → Round → **1519**, while `1013 * 1.5 = 1519.5` → `Math.round` → **1520**. The tie that behaves differently is `1519.5`, not `1012.5`; and at `(0.675 * 1.5) * 1000 = 1012.5000000000002` both sides round to **1013**, i.e. the step the plan blames is precisely the step where they *agree*.

The rule the plan states ("assert `[200,300,450,675]` and the cap; assert the 5th rung within ±1 ms") is the right rule. The mechanism behind it is stated backwards, and an executor who reads the mechanism rather than the rule will write a test that pins the wrong rung.

The same mistake is inherited from `signal.rs:112-116`, which says the sequence is "`200, 300, 450, 675, 1012.5, …`" — the real Rust value at that rung is 1013 after `.round()`. The plan should cite the code, not the comment.

### B-5. The logging retirement note names six rules that do not exist, and contradicts Task 1's "none port"

`logging.rs` carries **exactly 10** `NOISE` entries:

1. `libwayshot_xcap` / "Ignoring a wl_output with version < 4."
2. `rtc_ice` / "remote mDNS candidate added, but mDNS is disabled"
3. `rtc_ice` / "no such remote"
4. `rtc_ice` / "ErrMismatchUsername"
5. `rtc::peer_connection::handler` / "unhandled STUN packet"
6. `rtc::peer_connection::handler` / "ErrMismatchUsername"
7. `rtc_dtls` / "Unsupported Extension Type"
8. `webrtc::peer_connection::driver` / "from 127.0.0.1:"
9. `webrtc::peer_connection::transport::turn_relayer` / "CreatePermission error response (error 403"
10. `quinn_udp` / "halting segmentation offload"

The plan is internally inconsistent about them:

- **Task 1, line 378:** "The Rust filter carried ten rules. **None of them port**."
- **Closing retirement note, line 7522:** "**six** noise rules with no Node successor".
- **Final checklist, line 7553:** "New R-entry: six retired noise rules".

And the six the retirement note names (`rtc::peer_connection`/"ICE failed", `rtc_ice::agent`/"Ping timeout", `rtc_dtls`/"Alert", `rtc_sctp`/"SCTP", `libwayshot`/"error", `quinn_udp`/"blocked") **are not six of the ten**. No rule says "ICE failed"; none says "Ping timeout"; there is no `rtc_sctp` rule; the real `libwayshot` message is "Ignoring a wl_output with version < 4."; the real `quinn_udp` message is "halting segmentation offload". The `rtc_dtls` rule that exists is "Unsupported Extension Type" — and the note's "dtls alert" entry collides with a rule the Rust **deliberately does not suppress**, documented at length in the source (the `ErrAlertFatalOrClose` comment): a fatal alert and a clean close share one message, so suppressing it would hide real failures. The plan retires a rule on the grounds that "the decision survives as `classifyClose`" — but the Rust's decision was explicitly the opposite (keep it).

So the count is wrong (6 vs 10 vs "none"), the identities are wrong (4 of 6 do not exist), and one retirement reverses a documented safety decision. The R-entry this feeds into would record a fabrication.

Also unaccounted: `logging.rs` has **8** `#[test]`s (6 `is_noise` cases + `composed_filter_drops_noise_and_keeps_everything_else` + `the_log_crate_bridge_is_filtered_too`). Plan Task 1 declares **3** TS tests for the logger (line 461 folds them into a 9/17 total). The twin end-to-end tests — the composed filter and the `log`-crate bridge — have no declared successor and no declared retirement.

### B-6. `decisions.md` is git-ignored but is cited as load-bearing authority

Plan 2 cites `.superpowers/plan2/decisions.md` (`D1` at line 32, `D8 #5` at 4619, `D8 #7` at 4955, `P5 #11` and `P5 #15` at 7512), and line 154 states plainly that the `to_ws_url` ruling lives there.

Verified: `.gitignore:45` is `.superpowers/`, and `git ls-files .superpowers | wc -l` → **0**. None of it is in the repository.

Plan 2 is executed by **fresh subagents per task** (its own recommended execution method). A subagent in a fresh clone cannot open the document its requirements cite as the reason for a load-bearing decision. Either the rulings move into the plan text or the citations are marked as unavailable-to-executors.

### B-7. B38 has no plan that will land it

The coverage matrix (line 170) assigns **B38 — Windows shell detection `pwsh` → `powershell` → `cmd.exe` — to Plan 2**, with status "Not yet written". Plan 2's Task 9 explicitly defers it (line 3241): "(`pwsh` → `powershell` → `cmd.exe`) is **Plan 3's**, because it needs the …". **Plan 3 does not exist.**

The six real `main.rs` tests covering shell resolution — `an_explicit_shell_always_wins_over_detection`, `unix_falls_back_to_shell_env_then_bin_sh`, `shell_preference_is_ordered_and_stops_at_the_first_hit`, `first_available_can_resolve_to_a_path_not_just_the_bare_name`, `windows_prefers_powershell_7_over_legacy_powershell`, `allow_input_cli_and_env_parsing` — appear **nowhere** in Plan 2 (0 hits each). Task 9 declares "all 10 `shell_policy.rs` tests" and nothing from `main.rs`, so the shell-resolution surface leaves the Rust tree in Plan 2 with no declared successor and no declared retirement.

### B-8. Two env vars the Rust CLI reads are absent from Plan 2's config, and two are invented

Rust CLI env surface (extracted from `apps/agent/src/**`): `AGENT_ALLOW_INPUT`, `AGENT_CREDENTIAL`, `AGENT_DESKTOP_DEFAULT_SOURCE`, `AGENT_DESKTOP_POLL_INTERVAL_MS`, `AGENT_DESKTOP_PROFILE`, `AGENT_DESKTOP_SELECT_TIMEOUT_MS`, `AGENT_DESKTOP_SOURCE`, `AGENT_FILES_ROOT`, `AGENT_ID`, `AGENT_IDENTITY_PATH`, `AGENT_SERVER`, `AGENT_SHELL`, `RUST_LOG`, `STUN_SERVER` (plus `DISPLAY`, `HOME`, `SHELL`, `WAYLAND_DISPLAY`, `XDG_CONFIG_HOME` from the environment).

Plan 2's `loadConfig` (lines 318-336) reads: `AGENT_ID`, `AGENT_SERVER`, `AGENT_CREDENTIAL`, `AGENT_SHELL`, `SHELL`, `AGENT_IDENTITY_PATH`, `XDG_CONFIG_HOME`, `HOME`, `STUN_SERVER`, **`AGENT_COLS`**, **`AGENT_ROWS`**, `AGENT_ALLOW_INPUT`, `AGENT_FILES_ROOT`, `AGENT_DESKTOP_PROFILE`, `AGENT_DESKTOP_DEFAULT_SOURCE`, `RUST_LOG`.

- **Missing:** `AGENT_DESKTOP_SOURCE` (main.rs:64, default `screen`) and `AGENT_DESKTOP_SELECT_TIMEOUT_MS` (main.rs:80, default 5000, ADR-22) — **0 hits each in the plan**. Also `AGENT_DESKTOP_POLL_INTERVAL_MS` (desktop.rs:582, with six dedicated tests at 3870-3910) — **0 hits**.
- **Invented:** `AGENT_COLS` / `AGENT_ROWS` (line 328-329). The Rust binds **neither**: `--cols 80` / `--rows 24` are clap flags with no `env =` attribute (main.rs:58-60, 292-293). Plan 2 turns two CLI flags into env vars, which is a silent change to the desktop↔agent contract that the plan's own Global Constraints (line 26) declares frozen.

### B-9. The "38 B-rows" figure is wrong — the enumeration is 49

Line 15: "Plan 2 owns **38 B-rows**: B1–B14, B18, B20, B22–B24, B27–B30, B34, B36–B56, B58, B59, B61, B62."

The enumerated list sums to **49**, and the coverage matrix's own Plan-2 rows are **exactly those 49** (no set difference in either direction). Line 7546 repeats the figure in the closing checklist ("38 B-rows closed").

This is the same shape as the R3 defect the plan already corrected (§"12 re-homed / 8 retired" → 13/2/5): **the list is right and the number is wrong**. It matters because the §9.4 gate is a count — an executor closing 49 rows against a checklist that says 38 will either stop early or report a contradiction.

---

## 3. Non-blocking findings

### N-1. `api.rs:20-48` is a wrong citation for `to_ws_url`

Line 476: "`function rewriteWsScheme(url: string): string` — 1:1 port of `api.rs:20-48`."
The function body is **23-42**; the doc comment starts at **16**; `NETWORK_ERROR`'s doc begins at 47. Correct citation: **`api.rs:16-42`**. As written the range includes two lines of the next item's doc comment.

### N-2. `signal.rs`'s comment into `transport.ts` has stale line numbers, and the plan inherits the confusion

`signal.rs:100-103` says the constants are "mirrored from `packages/webrtc-core/src/transport.ts:45-46` … and the `* 1.5` / `Math.min(.., maxIntervalMs)` at `:140-143`, `:165-168`, `:171-174`". Real locations: `initialIntervalMs`/`maxIntervalMs` declarations at **50-51** (defaults at 79-80); the three `Math.min(this.currentIntervalMs * 1.5, …)` sites at **209-210, 234-235, 240-241**.

Not a Plan 2 defect — but Plan 2 cites `signal.rs` as the parity authority (line 904), so the plan inherits stale line numbers into its own provenance. Worth a one-line correction in Task 3's preamble.

### N-3. Task 11's "24 of `files.rs`'s 65 tests" partition is unverifiable as stated

Line 4619 states a 24/41 split. The **65** is right (`grep -c '#\[(tokio::)?test\]' apps/agent/src/files.rs` → 65). The split's *named* examples are right too (`rfc3339_formats_epoch_seconds_utc`, `decode_guard_*`, `test_transfer_id_codec_*` all exist and are Rust-internal). But the partition is not auditable: the declaration names **one** of the 24 ported tests (`path_policy_rejects_dotdot_escape` appears; the other 23 are described, not named), while Task 10 separately claims seven `path_policy_*`/`upload_create_path_*` tests — several of which are among Task 11's 24. Two tasks claiming overlapping members of one 65-test file without a per-test list is how a retirement silently drops a test.

The declaration's retirements are separately checkable and mostly hold: `files-download-chunk` is **not** emitted by the pump (files.rs:1449 emits `DownloadChunkBinary`; `Outbound::DownloadChunk` survives only for the ADR-34 frame-cap test at 2345 and the test-side `chunk_bytes` helper at 2681, so "dead in Rust, never emitted" is correct for production paths); `QUEUE_FULL` is constructed nowhere (only `as_str()` and its spelling test at 3508), so "never produced" is correct; the four `decode_*` guard tests are real (`decode_guard_never_errors_on_foreign_frames` 2388, `decode_guard_extracts_ids_for_attribution` 2415, `decode_round_trips_every_browser_to_agent_type` 2433, plus `error_code_spellings_are_pinned` 2357 as the fourth).

### N-4. Task 12's "`chunk_boundaries` is replaced, not ported" rationale is sound, but the replacement does not exist in Rust

`chunk_boundaries` (pty.rs:508) does exactly what its name says at the boundary values — it frames 0, `MAX_PTY_CHUNK`, and `MAX_PTY_CHUNK + 1` bytes and asserts the round-trip length — but it does **not** exercise a splitter, because `frame_pty_output` (pty.rs:141) does not split: it delegates straight to `build_terminal_data_frame`. `MAX_PTY_CHUNK` is used in production only as the **read buffer size** (pty.rs:392), never as a frame boundary.

So Plan 2's claim that "the Rust test's name promised chunking it never exercised" is **correct**, and the TS replacement (`emitChunks`, plan line 4911, splitting at `MAX_PTY_CHUNK`) adds behaviour the Rust does not have. **That is a behaviour change, not a port** — possibly a wanted one, but it belongs in the declaration as a new behaviour with a migration note, not as a test replacement.

### N-5. Task 19's "`reporting_estimator_publishes_its_initial_target` re-homes here" has no home

Task 8 (line 2979) moves it to "Task 19's runtime". Task 19's declaration (line 7512) says it re-homes there. Neither fence contains it: the T19 `runtime.test.ts` fence has six tests, all source resolution; the `session.test.ts` fence has eleven, none about an estimator. The Rust test exists (rtc.rs:1179). So the test leaves `rtc.rs` in a declaration and arrives nowhere.

> **N-5 is the small end of a larger hole.** The estimator test is one symptom; the behaviour it belongs to — the auto-ABR loop — has no row, no task, and no plan. That is **B-10** below, and it is a different class: N-5 is a dropped *test*, B-10 is a dropped *behaviour*.

### B-10. The auto-ABR loop has no coverage row in any plan, and no owner in any plan

> **Raised by PM 2026-10-21; independently verified by BA.** Severity: **above N-5**, and below B-1..B-9 only because B-1..B-9 are defects *inside* Plan 2's declared scope, whereas B-10 is a scope hole that predates Plan 2 and reaches all three plans plus the spec. It is the largest open item in the rewrite.

**The distinction that makes it a different class.** B-1..B-9 are all *declarations that do not describe the tree* — a wrong number, a phantom name, a missing citation. Every one of them is repairable by editing a sentence. B-10 is not: **no sentence anywhere claims the auto-ABR behaviour exists in the TypeScript agent.** The §9.4 gate says *"Every row of §4 — all 62 of them, B1 through B62 — plus the six retirements of §4.7 … must be covered by at least one test."* The gate is exact, and the auto-ABR loop is not one of the 62 rows and not one of the 6 retirements. **It is outside the gate's vocabulary.** A gate that is complete over a list that omits a behaviour cannot fail on that behaviour, and a §9.4 "all clear" would be a false negative — exactly the failure mode Plan 3's T6 warns about (*"A deletion that outruns the ledger is a silent coverage loss, and the plan cannot detect it afterwards — the evidence is what gets deleted."*).

**What the Rust does.** Three pieces, all live code on the desktop path:

| Piece | Location | Behaviour |
|---|---|---|
| The estimator wrapper | `rtc.rs:97-172` (module `abr`), `rtc.rs:152-158` (`abr::estimator()`) | Wraps `rtc`'s GCC so its target is **observable**: `configure_congestion_control` boxes the estimator inside the interceptor chain, so the wrapper is the only application-supplied object that can carry the number back out, via an `Arc<AtomicU64>` (`rtc.rs:111`, `:121-124`). |
| The decision function | `desktop.rs:1958-1974` (`abr_next_target`) | Rejects non-finite/≤0; ignores an estimate within 5% of the seed (`ABR_INITIAL_BPS`); clamps to `[250 kbps, 20 Mbps]`; retargets only on a ≥15% move; `None` means "leave the encoder alone". |
| The loop | `lib.rs:2235-2268` | A 500 ms ticker reads the atomic, calls `abr_next_target`, and sends `StreamControl::SetBitrate` down the **same** path manual control uses. A manual `desktop-bitrate` frame latches an `AtomicBool` (`manual`) and **stops auto for the rest of the session**, so the two never fight. |

It is installed only when `has_control` is true (`rtc.rs:422-434`) — i.e. desktop sessions — and the loop is spawned unconditionally within that arm (`lib.rs:2238`).

**Three Rust tests, none of which can be ported as-is:**

- `desktop.rs:3649` `abr_next_target_ignores_the_unmoved_seed`
- `desktop.rs:3659` `abr_next_target_applies_a_dead_band`
- `desktop.rs:3667` `abr_next_target_clamps_and_rejects_garbage`

**The search for a home, and its result.** PM grepped four rewrite documents and the matrix; I grepped the same set plus Plan 3 and the Rust source. Across the **spec** (`…rewrite-design.md`), **Plan 1** (`…plan-1-spike-foundation-addon.md`), **the coverage matrix** (`…plan-1-coverage-matrix.md`), **Plan 2** (`…plan-2-core.md`) and **Plan 3** (`…plan-3-desktop-retirement.md`):

| Term | spec | Plan 1 | matrix | Plan 2 | Plan 3 |
|---|---|---|---|---|---|
| `abr_next_target` | 0 | 0 | 0 | 0 | 0 |
| `auto-ABR` / `dead-band` / `ADR-23` / `GCC` / `congestion` / `autoTarget` / `SenderBandwidthEstimator` / `ReportingEstimator` | 0 | 0 | 0 | 0 | 0 |
| `abr` (case-insensitive) | 3 | 0 | 0 | 1 | 0 |
| `ABR_MIN_BPS` / `ABR_MAX_BPS` | 1 | 0 | 0 | 0 | 0 |

The only `abr` in the spec is **B20** (spec:574), the clamp row, whose port target is *"The core's clamp"*. The only `abr` in Plan 2 is inside Task 8's declaration (plan:3243) — the sentence about the estimator test that N-5 covers. **B20 is the boundary of this feature, not the feature**: `clampBitrate` is what a bitrate is bounded *to*, and the auto-ABR loop is what *chooses* the bitrate. Nothing in the ledger spans the second.

**Two adjacent rows that do not close the gap either:**

- **B19** (spec:573) — the encoder-side retarget (`applyBitrate`, Plan 1 Task 4's addon). That is *what happens when* a target is chosen. It does not choose.
- **B62** (spec:641) — *"the desktop control state machine — `DesktopSelectMessage`, the `StreamControl` enum with its `SetBitrate` and `SourceSwap` variants, and `StatsStatusKind::QualityDowngraded`"*. B62 covers the **enum and the decode**, i.e. the manual path. The auto path is a *producer* of `SetBitrate` that B62 does not mention, and the `manual` latch that stops it is not in B62's description.

**So: the manual bitrate path is covered (B19 + B62 + B20); the automatic one has nothing.**

**The architectural wrinkle that makes this a decision, not a backlog item.** werift **does** expose the needed surface — verified in the installed `werift@0.24.4`:

```
lib/webrtc/src/media/sender/senderBWE.d.ts
  export declare class SenderBandwidthEstimator {
      readonly onAvailableBitrate: Event<[number]>;
      readonly onCongestion: Event<[boolean]>;
      receiveTWCC(feedback: TransportWideCC): void;
      rtpPacketSent(sentInfo: SentInfo): void;
  }
```

and `rtpSender.js:619`/`:657` wire it (`this.senderBWE.rtpPacketSent(sentInfo)` on send, `this.senderBWE.receiveTWCC(feedback)` on `RtcpTransportLayerFeedback` of type `TransportWideCC`). **werift's estimator is TWCC-based, and the Rust's was `rtc`'s GCC.** So a port is a re-implementation against a different estimator: the Rust's three tests cannot be ported, the numbers will differ, and the dead-band thresholds carry over as *policy* but not as *measured behaviour*.

**There is a second, sharper dependency the ledger does not record either.** The Rust's GCC is installed via `configure_congestion_control(…, CongestionFeedback::Twcc, …)` (`rtc.rs:424-430`), which **changes the SDP** — it registers `transport-cc` feedback and a header extension on the media engine. The Rust comment at `rtc.rs:417-420` says so and gates it on `has_control` so the terminal path stays byte-identical. **That SDP delta is itself a wire-visible behaviour with no B-row.** `grep -n 'transport-cc\|twcc\|transportCC'` over the spec and both plans returns **0** — the rewrite documents never mention TWCC at all, while the Rust agent's desktop offer carries it. If the Node agent negotiates without it, the browser's SDP answer differs from today's; if it negotiates with it, the terminal path may acquire a header extension it does not have today. Both branches are unowned. (werift's own `transport-cc` support is confined to `media/extension/rtcpFeedback.js` — the *parser*; the negotiation side is not obviously there, which is a further reason this needs an owner's ruling rather than a porter's guess.)

**Severity and disposition.** This is a **spec-level decision**, and the questions are:

1. **Does auto-ABR ship in the Node agent at all?** The Week 8 spec (`…2026-10-03-phase3-week8-stream-quality-design.md:26,562`) says auto-ABR "ships" but is *"a **goal**, not an acceptance criterion (ADR-23, §10.2)"*, and `ARCHITECTURE.md:970` records it as *"GCC auto-ABR — target, verified via spike §3.7 (not an acceptance criterion)"*. **The rewrite spec never mentions it.** So the rewrite is not silently dropping a shipped feature; it is **silently inheriting a feature the governing spec never claimed**. That distinction matters: it makes "do not port it" a *legitimate* answer that still needs writing down, and it makes "port it" a *scope addition* that needs the spec amended.
2. **Against which estimator?** werift's TWCC `SenderBandwidthEstimator` is the only surface available, and it is not GCC.
3. **What is the declared divergence?** The Rust's dead-band and 15%-move policy are portable as policy; the measured values are not.
4. **What happens to the `transport-cc` SDP delta?**

**Why this is not Plan 2's to absorb silently, and not Plan 3's to absorb at all.** Plan 2 is the TS core; the auto-ABR loop is a *session-loop* behaviour, so if it ships it belongs in **Plan 2's Task 19** (`runtime.ts` + `desktop/session.ts`) — the task that owns the desktop session loop and already owns `resolveDefaultSource` and the `DesktopSession` class, and whose declaration (plan:7794) already claims `reporting_estimator_publishes_its_initial_target` as its one port from Task 8. That is the natural home, and it is the only place in any plan where a periodic task that retargets the encoder during a session can exist. **But it cannot be landed there by an implementer**, because the estimator choice, the divergence, and the SDP question are all owner calls, and a plan cannot invent them.

**Recommendation to PM (the landing spot is PM's to rule; this is the evidence, not the decision):**

- **Record B-10 in the audit as an open spec-level item** — done, this section.
- **Do not let it be absorbed by B20, B19 or B62.** Each of those is a manual-path row; the auto path is a different producer with its own lifecycle (a ticker, a latch, a shared target).
- **Add it to Plan 3's T6 retirement ledger** as an *unresolved* item, so Plan 3's "close the retirement ledger before deleting the Rust tree" step cannot pass while this is open. Plan 3's T8 is the right list for carried-forward Plan 2 items; B-10 belongs there with the same standing as N-4 (which T8 already carries).
- **Escalate to the owner with the four questions above**, alongside N-4, which is already on the same list for the same reason: both are *behaviour decisions*, not *docs decisions*.
- **If the answer is "auto-ABR does not ship in the Node agent"**, then the rewrite spec needs an **R7** retirement row with the reason, and `ARCHITECTURE.md`'s Week 8 line needs amending — otherwise the docs will describe a feature the agent no longer has, and this repo has already paid that price once (the `desktop/devices.rs` drift Plan 3's T9 names).
- **If the answer is "auto-ABR ships"**, it needs a new B-row (B63) in the spec, a Task 19 fence, a declared divergence against the werift TWCC estimator, and a stated answer on the `transport-cc` SDP delta. The Rust's three `abr_next_target` tests are the *policy* to port; the estimator's own behaviour is new.

**What I could not verify, and am not claiming:** whether the werift TWCC estimator can be made to produce a *usable* number for a 500 ms-tick encoder retarget in this stack, and whether werift's `transport-cc` negotiation is reachable from the adapter's `PeerConnection`. Those are P0-spike questions (spec §9.3 is the werift-as-sender gate) and belong to the spike, not to this audit.

### N-6. The `desktop-profile-parity` baseline was wrong; Plan 2's correction of it is right

> **Corrected 2026-10-21, after PM's correction.** The original version of this finding said Plan 2's "4→2" was wrong. **That half was wrong** — see the retraction below. The other half stands.

Plan 1 declared "1 `it()` → 2 `it()`". Plan 2 corrects it (lines 98-108) to "at `453a779` already 2 `it()` and 4 `expect()`; after the rewrite 2 `it()` and 2 `expect()`", and repeats the "4→2" in the closing checklist (line 7557).

**What I got wrong.** Plan 2's "4→2" is a *prediction of the after-state*, not a claim about the tree as it stands — and the prediction is correct. The rewrite is Plan 1 Task 5, and it landed in `7d723e6`:

```
git show 7d723e6:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts | grep -cE '(^|[^.[:alnum:]_$])it\('   # 2
git show 7d723e6:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts | grep -c 'expect('                       # 2
```

The rewritten file imports `STREAM_PROFILES` from `@ponter/shared` and `DESKTOP_PROFILES` from the desktop's `ipc-types`, compares the two sets as values, and the two `expect()`s that guarded the old regex helper (`start > -1`, `end > start` — `453a779` lines 34 and 36) are gone with the helper. So **4 → 2 `expect()` is exactly what happened**, and Plan 2's declaration describes the tree correctly. My original finding measured `git diff 453a779 HEAD` — empty at the time — and mistook "the file has not changed *yet*" for "the file will not change".

**What still stands — the first half, which is the load-bearing half.** The Rust parity guarantee was implemented by **reading `apps/agent/src/lib.rs` as text** and regex-extracting the `StreamProfile` literals out of `impl std::str::FromStr for StreamProfile`. That mechanism cannot survive the Rust's deletion (Plan 3), so the guarantee had to be re-implemented as a **same-language import** of `@ponter/shared`'s table. Plan 1 Task 5's rewrite does exactly that, and the file's own doc comment now says so: *"They now live in one table, so both sides are imported as values — the same guarantee, with nothing left to parse."* The rewrite must land; Plan 2 must not carry the old regex-based file forward.

**Retraction of the path.** An earlier draft of this section (and the message accompanying it) gave the path as `apps/web/…`. That was wrong: the file is `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts`. The audit file never carried the `apps/web` path.

---

## 4. Refuted

### D-1. "Task 3's backoff parity test fails" — REFUTED (my own earlier claim)

I first reported this as a failing assertion (`|2000 − 1519| = 481` at rung 5), on an emulation that applied TS's cap but not Rust's. **Rust caps too** (`signal.rs:119`, `scaled.min(BACKOFF_MAX.as_millis())`). Re-derived with both caps: the test **passes**, every rung within ±1 ms. What survives is the weaker finding **B-4** — the pass is accidental at rung 6 and the explanation at line 34 is wrong.

### D-2. Ruling #1 (`rewriteWsScheme` as a sibling of `toWsUrl`) — the plan is RIGHT

`toWsUrl` (url.ts:20-32) trims the **whole** string at line 21, then rewrites the scheme. `to_ws_url` (api.rs:23-42) splits at the first `?`/`#` (28-31), trims only the head (32), then rewrites. They disagree on `http://h/a/?next=/`:

- `toWsUrl` → `ws://h/a/?next=` (the trailing slash inside the query is eaten)
- `rewriteWsScheme` → `ws://h/a/?next=/` (preserved)

The Rust test `preserves_a_ws_query_value_ending_in_slash` (api.rs:182) pins exactly this, and re-homing it onto `toWsUrl` would fail. The three `toWsUrl` composers (`ws-ticket.ts:4`, `agent-supervisor.ts:131`, `fleet.ts:103`) pass base URLs, not complete WS URLs, so the whole-string trim is correct for them. Sibling function is the right call. **The plan's own disagreement test (line 484 fence, "differs from `toWsUrl` exactly where a query or fragment is present") is the correct pin.**

### D-3. Ruling #2 (the agent's own ladder vs `ReconnectBackoff`) — the plan is RIGHT

`ReconnectBackoff.next()` (backoff.ts) is `min(initialMs * 2 ** retries, maxMs) + Math.round(random() * 2 * jitterMs - jitterMs)` — factor **2**, ±50 ms jitter, defaults 200/2000. The agent ladder is factor **1.5**, no jitter, integer ms. `signal.rs`'s comment does describe `RESTPollingTransport`'s inline `* 1.5` logic (transport.ts:209-210, 234-235, 240-241), not `backoff.ts`. Renting `ReconnectBackoff` and reconfiguring it would give one class two meanings. The plan's separate module with its own constants is right, and the "does not add jitter" test (line 741) is the assertion that keeps them from being merged later.

### D-4. Ruling #4 (E2EE empty-plaintext divergence) — the plan is RIGHT

`packages/crypto/src/encrypt.ts:114-121` rejects only `framed.length <= IV_BYTES` (12), so a 28-byte frame (12 IV + 16 tag) is **accepted** and decrypts to empty plaintext. `apps/agent/src/e2ee.rs:161-163` rejects `framed.len() <= IV_BYTES + TAG_BYTES` (28), so the same frame is `MalformedFrame`. The plan's Task 7 declares an "empty-plaintext round trip" as a **new** test and a declared divergence (line 2278). That is exactly right: the divergence is real, it is in a security-adjacent path, and the plan declares rather than hides it.

---

## 5. Rulings answered explicitly

| # | Ruling | Verdict |
|---|---|---|
| 1 | `rewriteWsScheme` as a new sibling | **Plan right** — D-2 |
| 2 | Agent's own backoff ladder vs `ReconnectBackoff` | **Plan right** — D-3 |
| 3 | R3 arithmetic | **Plan right** (as amended at `406f968`: 13 re-homed / 2 ported-then-retired / 5 retired, `to_ws_url` 11 + `with_bearer` 2 + `ApiError` 7 = 20). Independent re-derivation stands. |
| 4 | E2EE empty-plaintext divergence | **Plan right** — D-4 |
| 5 | Logging "6 of 10 rules retire" | **Refuted as stated** — the direction is right (most rules retire) but the count is wrong (10 rules, stated as both "none" and "six"), 4 of the 6 named rules do not exist, and one retirement reverses a documented safety decision. → **B-5** |
| 6 | Every citation | **21 non-existent test names (B-3), 1 wrong line range (N-1), 1 stale line range (N-2), 1 fabricated retirement table (B-5), 1 unciteable source (B-6).** |

> **N-6 amended.** N-6 was originally listed among the non-blocking findings as "both corrections are wrong in both directions". PM's re-measurement showed the "4→2" half was a **prediction of the after-state** that the implementation matched exactly, not a claim about the tree as it stood; my finding measured the tree before the rewrite landed and mistook "not changed yet" for "will not change". N-6 is corrected in place; its surviving half — the regex-over-`lib.rs` mechanism cannot outlive the Rust — is unaffected.

---

## 6. What the audit did not cover

- **Spec-side claims.** I read the spec for §3.3/§3.4/§3.5/§4.x/§9.x context but did not audit Plan 2's §refs against the spec section by section.
- **`apps/agent/test/session/packetizer.test.ts`.** Plan 1 Task 3 creates it; it is **not in the tree** (`apps/agent/src/session/` does not exist). Task 19 imports `packetizeAnnexB` from it. That is a Plan 1 execution gap, not a Plan 2 defect — but **Task 19 cannot run until Plan 1 Task 3 lands**, and the plan says so at line 69 ("Already written in Plan 1 Task 3. Do not recreate"), which is currently false. Flagging for PM as a Plan-1 status item.
- **Whether the fences would actually compile.** I counted and read; I did not typecheck a single fence.
- **Task 12's `emitChunks` behaviour change** is recorded (N-4) but not adjudicated — whether an agent-side 16 KiB splitter is wanted is an owner/spec question, not a docs question.
- **Whether the werift TWCC estimator is usable for a 500 ms-tick encoder retarget**, and whether werift's `transport-cc` negotiation is reachable from the adapter's `PeerConnection`. Both are P0-spike questions (spec §9.3 is the werift-as-sender gate); I verified the *surface exists* and the *ledger is silent*, not that the feature is implementable as the Rust had it.

---

## 7. One structural observation

The failure is not scattered. Three of the nine BLOCKING findings (B-1, B-2, B-9) are **counts that do not describe the tree**; two more (B-3, B-5) are **names that do not exist**; one (B-4) is **arithmetic stated backwards**; one (B-7, B-8) is **a surface enumerated incompletely on both sides**.

The common cause is visible in the plan's own history: T8's declaration is the one that is right, and it is right because `5ff4182` **re-derived** it after the RTP rewrite changed its fences. Every other task's number was written once and never re-derived against the fence it describes. The plan already knows the remedy — §"Corrections" is where R3 was derived three ways — it just has not been applied to the declarations.

A cheap, mechanical fix exists: for each task, count `it(` and `expect(` **inside the fences only** (not prose), write that number into the declaration, and re-run it whenever a fence moves. The counter I used for §2 is 40 lines of Python; it reproduces B-1 exactly.

---

## 8. Recommended disposition

**Do not execute Plan 2 as it stands.** B-1/B-2 mean no task's gate is trustworthy; B-3/B-5 mean two R-entries would record fabricated parity; B-7/B-8 mean two surfaces leave the Rust tree with no owner.

> **Applied.** PM closed all of these in `cebe659`; §9.1 records the independent re-verification. The one residual found during that verification (the "six retired noise rules" R-entry line) was closed in `72e8594`. N-4 remains open for the owner by design: whether the Node agent should split terminal output at 16 KiB is a protocol question, not a docs one.
>
> **Still open, and larger than any of the above: B-10, the auto-ABR loop** (§3). It is not a plan defect but a **ledger hole** — a live behaviour of the Rust agent with no B-row, no R-entry, no task, and no owner. It needs an owner ruling on four questions (does auto-ABR ship; against which estimator; what divergence is declared; what happens to the `transport-cc` SDP delta) and it needs to be carried in Plan 3's T8 alongside N-4, so that Plan 3's T6 "close the retirement ledger" step cannot pass while it is unresolved.

Suggested order for the amendments (all of them plan-side; per PM's ruling, I do not edit Plan 2):

1. Re-derive all 19 declarations from their fences (B-1, B-2). Mechanical, one pass.
2. Delete or re-name the 21 phantom test names against the real list in `apps/agent/src` (B-3). Task 18's six need the most attention: they are new tests, not ports.
3. Rewrite the retirement note from the real 10-rule table, and reconcile "none port" vs "six retire" (B-5).
4. Fix the `[200,300,450,675]` explanation to name the `1519.5` tie, not `1012.5` (B-4).
5. Decide B38's owner and move the six `main.rs` shell tests into a task, or write an explicit retirement (B-7).
6. Add `AGENT_DESKTOP_SOURCE`, `AGENT_DESKTOP_SELECT_TIMEOUT_MS`, `AGENT_DESKTOP_POLL_INTERVAL_MS`; remove `AGENT_COLS`/`AGENT_ROWS` or declare them a deliberate addition to the contract (B-8).
7. Correct 38 → 49 (B-9).
8. Move the `decisions.md` rulings into the plan text (B-6).

---

## 9. Amendment log observed during this audit

The plan moved six times while I was reading it. Recording so PM can confirm ownership:

| Revision | Change |
|---|---|
| `406f968` | R3 derived three ways; the file's own arithmetic corrected |
| `8411480` | webrtc-core: the R-S3 coverage test made discriminating on the answer m-line order |
| `5ff4182` | **Task 19's video path connected to RTP** — `this.deps.send('desktop', …)` → `this.sendRtp(encoded.data)` via `packetizeAnnexB` + `RtpSenderSink`; T8's counts re-derived (and as a result T8 is the one correct declaration) |
| `44d5099` | CI filter breakage recorded; two Task 3 rulings |
| `0030391` | CI exclusion pointed at the renamed package |
| `a6d86e5`, `8a92601` | Step 0b rationale; `CONTRIBUTING.md` |

Findings B-3's Task 19 rows and the T19 count were **re-checked against `8a92601`** after `5ff4182` landed. Everything else was stable from `406f968` onward.

### 9.1 Post-audit verification — `cebe659` (PM's closing amendment)

PM applied the eight recommended amendments in `cebe659` ("apply Plan 2's remaining audit amendments (B-3, B-6, B-7, B-8)"), on top of the earlier mechanical pass. I re-verified the result against `cebe659` rather than taking the report for it.

**All 19 declarations re-measured with an independent fence-walker** (toggle on ``` lines; count `it(`/`expect(` with a negative lookbehind for `.`/`$`; restrict to fences whose first line is a `// …test…` banner — the same rule that produced B-1):

| Task | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fence `it()` | 21 | 16 | 14 | 19 | 19 | 9 | 7 | 36 | 12 | 18 | 25 | 11 | 16 | 11 | 16 | 9 | 15 | 12 | 17 |
| fence `expect()` | 40 | 21 | 20 | 28 | 29 | 11 | 11 | 48 | 13 | 19 | 42 | 15 | 22 | 11 | 25 | 16 | 27 | 17 | 33 |

**0 mismatches against the declarations as written in `cebe659`.** Task 2's declaration was rewritten from a delta to a count (7 → 19 `it()`, 18 → 34 `expect()`) and records why. Every one of the other 18 states its after-state directly.

Spot-checks of the non-count amendments, all confirmed in `cebe659`:

- **B-3** — the phantom names are gone. Task 18's six are now declared **new** (the label gate at `rtc.rs:663-689` and the inbound router at `lib.rs:2739` have no Rust test); Task 19's eight likewise, and its declaration names the real untested functions (`default_source_id` at `desktop.rs:1004`, `run_desktop_session` at `lib.rs:2002`/`2698`). The `sustain_ladder_*` names were replaced with the real `sustain_monitor_*` (`desktop.rs:3363-3420`). I confirmed every function these declarations name exists in the tree.
- **B-6** — `grep -c decisions.md` → **0** in the amended plan; the rulings travel inline.
- **B-7** — B38 landed in **Task 1** (`resolveShell`, `firstAvailable`, `windowsShellRoots`, `main.rs:169-182`/`186-218`), with the reason recorded: it resolves the *operator's* shell at config time, while Task 9's `ShellPolicy` governs which shells a *peer* may request.
- **B-8** — the three env vars are now in `loadConfig` and its tests (7 / 6 / 8 hits); `AGENT_COLS`/`AGENT_ROWS` appear exactly once each, in the line that explains they **must not** exist (the Rust binds them as bare clap flags with no `env =`).
- **B-9** — 38 → 49 in both places, with the rationale recorded.

**One residual inconsistency found in `cebe659`** (it is not one of the nine findings — it is the same *class* as B-5, and it sat three lines below the table that contradicts it):

> Line 7872: `- **New R-entry: six retired noise rules** (above).`

The retirement note it points at (`cebe659` lines 7806-7859) accounts for **all ten** rules and concludes that Task 1's `NOISE` table **ships empty** — *"every one names a Rust crate's target … and the TypeScript stack is werift"*. Under that reckoning no rule "retires" in the port sense; the ten rationales are recorded so the knowledge survives. **Closed by PM in `72e8594`**, which rewrites the line to *"ten noise rules recorded, none ported"* and adds the why, plus the two live concerns the R-entry keeps findable (the loopback STUN write, #8; coturn's 403 SSRF guard, #9). `grep -n 'six retired\|retired noise'` over the plan now returns nothing.

---

## 10. Reproduction recipes

```bash
# Pin the audited plan revision
git show 8a92601:docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md > /tmp/plan2.md

# B-1 / B-2: fence-only it()/expect() counts per task
#   walk "### Task N:" headings, toggle on lines starting with ```,
#   count /\b(it|expect)\s*\(/ with a negative lookbehind for `.`/`$`,
#   restrict to fences whose first line is a `// …test…` banner.
#   Script used: /tmp/p2audit/fences_head.py (40 lines).

# B-3: real Rust test names
grep -rnE '^\s+(async )?fn [a-z0-9_]+\(\)' -B6 apps/agent/src/*.rs | grep -B6 '#\[test\]'
#   318 anchored names across 14 files; the file-level split (desktop 85,
#   files 65, lib 28, …) sums to the 318 used for the name check.

# B-5: the real noise table
sed -n '/const NOISE/,/^\];/p' apps/agent/src/logging.rs | grep -cE '^\s*\('     # 10

# B-6
git check-ignore -v .superpowers/plan2/decisions.md                            # .gitignore:45
git ls-files .superpowers | wc -l                                              # 0

# B-8
grep -rhoE 'env = "[A-Z0-9_]+"' apps/agent/src/ | sort -u                      # 14 names
grep -c 'AGENT_DESKTOP_SOURCE\|AGENT_DESKTOP_SELECT_TIMEOUT_MS' /tmp/plan2.md  # 0

# B-9
grep -c '^| B[0-9]' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md  # 62
# enumerate B1-14,B18,B20,B22-24,B27-30,B34,B36-56,B58,B59,B61,B62 → 49
# matrix rows naming Plan 2                                                   → 49 (same set)

# N-6 (corrected): the rewrite is Plan 1 Task 5, landed in 7d723e6
git show 453a779:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts | grep -c 'expect('                        # 4  (before)
git show 7d723e6:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts | grep -cE '(^|[^.[:alnum:]_$])it\('    # 2  (after)
git show 7d723e6:apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts | grep -c 'expect('                        # 2  (after)
git branch -a --contains 7d723e6                                                                    # worktree-feat-agent-node-ts-fe

# 9.1: re-verify every declaration after PM's amendment
git show cebe659:docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md > /tmp/p2audit/plan2_cebe659.md
python3 -I /tmp/p2audit/verify_amend.py     # 0 mismatches across all 19 tasks
grep -c decisions.md /tmp/p2audit/plan2_cebe659.md                                                 # 0

# B-10: the auto-ABR loop has no row anywhere
#   the Rust, all three pieces
grep -n "abr_next_target\|mod abr\|fn estimator()" apps/agent/src/{rtc,desktop}.rs
grep -n "abr_task\|abr_target" apps/agent/src/lib.rs
#   the search across every rewrite document
for f in docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md \
         docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-spike-foundation-addon.md \
         docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md \
         docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md \
         docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-3-desktop-retirement.md; do
  printf '%-70s %s\n' "$f" "$(grep -ci 'abr\|estimator\|congestion' "$f")"
done
#   the spec's only abr is B20, the clamp — the boundary, not the feature
grep -n "ABR_MIN_BPS\|ABR_MAX_BPS" docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md
#   the werift surface (installed copy)
grep -n "SenderBandwidthEstimator\|receiveTWCC\|onAvailableBitrate" \
  .claude/worktrees/feat-agent-node-ts-fe/node_modules/.pnpm/werift@0.24.4_supports-color@10.2.2/node_modules/werift/lib/webrtc/src/media/sender/senderBWE.d.ts
#   the SDP delta nobody records
grep -rn "transport-cc\|twcc\|transportCC" \
  docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md \
  docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-*.md            # 0 hits
```
