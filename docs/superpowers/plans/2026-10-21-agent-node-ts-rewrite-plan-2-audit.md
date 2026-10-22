# Plan 2 compliance audit — agent Node/TS rewrite

**Audited revision:** `8a92601` (plan file `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md`, 7614 lines, 19 tasks).
**Read against:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md`, the Rust source it ports (`apps/agent/src/**`), and the plan's own coverage matrix (`…-plan-1-coverage-matrix.md`).
**Auditor:** BA role session. **Classification:** BLOCKING / non-blocking / refuted.

Every line number below is into the plan **as committed at `8a92601`** unless the finding says otherwise. The plan was amended fifteen times during and after this audit (§9 and §9.0); where an amendment changed a finding, the finding states which revision it applies to, and findings closed by an amendment carry a `CLOSED <revision>` marker in place rather than being deleted — a repair that silently erases its own evidence re-opens the hole on the next pass.

Reproduce any row with the recipe in §10.

---

## 1. Summary

| Class | Count |
|---|---|
| BLOCKING | 9 (B-1…B-9) closed; **B-10 RULED 2026-10-22 — it ships** (carrier landed `c81ae4b`, ruling recorded in Plan 3's T8 at `:231`); **B-11 closed 2026-10-21 by `d471109`**; **B-12 open** (raised by QA, measured 2026-10-22) — items 1/3/4 in §B-12b (buckets revised to **25/15/25**), the frame-to-wire + lifecycle boundary in §B-12c, the ack shape in §B-12d, the retire-clause re-derivation in §B-12e, the wire-spelling pin in §B-12f; item 2 **ruled 2026-10-22** to honour `recursive` |
| Non-blocking | 10 (N-6 partly mine and corrected; N-3a/N-3b closed by `d471109`; N-4 amended twice — the open part is PM-side and is recorded in §N-4/§N-4a) |
| Refuted (plan is right, or the concern does not hold) | 4 |

The headline: **every one of the 19 tasks' TEST-INTEGRITY declarations is wrong**, and **21 Rust test names cited as porting sources do not exist anywhere in `apps/agent/src`**. Both are the same class of defect — a number or a name written into a declaration that does not describe the tree — and both are BLOCKING because the declaration is the gate the plan itself defines (Plan 2 line 29: an undeclared change is BLOCKING; a declared change that is false is worse, because it passes the gate while misdescribing it).

**Status: B-1…B-9 are closed** by PM's amendment `cebe659` (2026-10-21), verified independently — see §9.1. One non-blocking finding (N-6) was **partly mine and wrong**; it is corrected in place.

**B-10 was the largest item in the rewrite and is now RULED (owner, 2026-10-22): the loop ships, as a full port.** The **auto-ABR loop** — the 500 ms ticker that reads a congestion estimator and retargets the encoder, latched off by a manual `desktop-bitrate` frame — had **no B-row, no R-entry, no task, and no plan**; the manual bitrate path is covered (B19 + B62 + B20) while the automatic one sat outside the §9.4 gate's vocabulary entirely, so a "62 of 62" pass could not fail on it. The ruling is recorded where the work lands, in Plan 3's T8 (`…plan-3-desktop-retirement.md:231`), which now reads *"RULED BY THE OWNER (2026-10-22): it ships … This is now a task, not a question."* **What survives from this section is the evidence, not a question** — and two of the three sub-questions below stay in it because the ruling assigns them to the *task*, not to the owner: Plan 3 says the task "must state which" divergence it takes on the estimator and "must say so in the B-row" if it skips the pacer. A task that answers those by silence has still shipped a different control loop. See §3's B-10 for the measurements.

**B-11 — raised 2026-10-21, CLOSED 2026-10-21 by `d471109`.** Plan 2's `FilesSession.list()` emitted a **different wire shape** from the Rust's `RemoteFile` — **seven divergences**: four field-shape (no `path`; `kind` where the Rust sends `isDirectory`; `size: null` where the Rust sends the directory's real `metadata.len()`; `modifiedEpochMs` where the wire type declares an RFC 3339 `Z` string) and three behavioural (dirs-first byte-wise sort replaced by `localeCompare`; a per-entry `statSync` failure silently substituted with `0` where the Rust fails the whole listing; `ENOTDIR` on `list()` of a file becoming `IO_ERROR` where the Rust sends `NOT_A_DIRECTORY`). Task 11 had **no test of `list()` at all**, and its declaration passed anyway because B43 is a **count** (12 inbound / 11 outbound) and a count cannot see a shape. **PM's repair `d471109` fixed all seven and added the three missing `list_*` tests**; I re-verified every one against the crate source and the fence now matches on all seven, with the declaration re-derived to **29 `it()` / 60 `expect()`** and both counts exact. See §3's B-11 for the evidence that stands as the record of what was wrong.

**B-12 — raised 2026-10-22 by QA, measured here, and the measured defect is not the one QA described.** Task 11's declaration says its partition is *derived* from the fences rather than estimated, but the criterion it gives for the non-ports — *Rust-internal helpers, Task 10's seven, pure arithmetic, or per-platform filesystem races* — covers only **15 of the 40**. **Twenty-five fall in none of those four categories**, and every one is a wire-surface or state-machine behaviour, several of them the *positive* half of a behaviour whose negative half the task does port. QA's quoted phrase — "named individually" — **does not appear anywhere in Task 11**; the plan describes the 26 by category, so QA's paraphrase overstates what the plan claims. But QA pointed at the right task and the right class, and the underlying defect is real: **seven guards the fence implements and no test ever trips** (`TRANSFER_UNKNOWN`, `BAD_FRAME` ×2, `FILE_TOO_LARGE`, `NOT_A_FILE`, `DIR_NOT_EMPTY`, `NOT_FOUND` — production-only tokens, zero assertions between them), and **the declaration's own totals are right for the wrong sets** — 26 is a count of `it()` titles reaching only **25** Rust tests, and two of its three declared "new" tests were already counted among *"the three `list_*` tests"* by its own ports sentence at `:5063-5065`. **B-12a is why it is BLOCKING:** of the three dispatch arms with **zero test sites** in the task (`files-mkdir`, `files-delete`, `files-rename`), `files-delete` **drops the `recursive` flag** that the Rust, `packages/shared` and the browser all carry — a fence deciding unilaterally that `rm -r` is not offered, recorded as a code comment rather than a declared divergence. Four artefacts agree and only the fence disagrees, which is B-11's disposition: a repair to an owned contract, not an owner question. **§B-12b is the finished repair for items 1, 3 and 4** — all 65 tests enumerated into three closing buckets (**25 ported / 15 correctly not ported / 25 gaps**), plus the 26-vs-25-vs-3 re-derivation. **§B-12c is the finding no bucket could hold:** `FilesSession` has no owner for the frame-to-wire boundary and no lifecycle owner — no envelope outbound, no envelope unwrap inbound, no timers, `deps.send` declared but never implemented (55 `as never` casts hide it), and no inbound frame cap — so the ported agent and the shipped browser cannot exchange a single files frame while every fence stays green. **§B-12d** is the ack shape (Rust separates the predicate from the take; the plan collapses both, making the 20 ms tick a no-op) and the `endUpload` frame the plan drops. **§B-12e** re-derives the retire clause name by name, including the two retirements that are *correct*. **§B-12f** is the wire-spelling pin: the Rust pins 14 of 16 codes non-vacuously across two tests, TypeScript spells 16 of 16 in two independent lists, and only one of them is enforced — the bare, untyped, untested `isFilesErrorCode` array is the one that decides wire behaviour, and it is exactly the one nothing relates to the union. **Item 2 (`recursive`) is settled: the owner ruled 2026-10-22 to honour it as the Rust does**, so the fence is the only artefact that moves — the retirement path was considered and rejected, and §B-12a records why.

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

### N-3. Task 11's "24 of `files.rs`'s 65 tests" partition is unverifiable as stated — and its own declaration sentence is wrong twice over

> **Extended 2026-10-21 with N-3a and N-3b below**, both raised by PM and both verified here. The partition problem is the original N-3; the two subsections are defects *in the same declaration sentence* that N-3's own text did not reach.

Line 4619 states a 24/41 split. The **65** is right (`grep -c '#\[(tokio::)?test\]' apps/agent/src/files.rs` → 65). The split's *named* examples are right too (`rfc3339_formats_epoch_seconds_utc`, `decode_guard_*`, `test_transfer_id_codec_*` all exist and are Rust-internal). But the partition is not auditable: the declaration names **one** of the 24 ported tests (`path_policy_rejects_dotdot_escape` appears; the other 23 are described, not named), while Task 10 separately claims seven `path_policy_*`/`upload_create_path_*` tests — several of which are among Task 11's 24. Two tasks claiming overlapping members of one 65-test file without a per-test list is how a retirement silently drops a test.

The declaration's retirements are separately checkable and mostly hold: `files-download-chunk` is **not** emitted by the pump (files.rs:1449 emits `DownloadChunkBinary`; `Outbound::DownloadChunk` survives only for the ADR-34 frame-cap test at 2345 and the test-side `chunk_bytes` helper at 2681, so "dead in Rust, never emitted" is correct for production paths); `QUEUE_FULL` is constructed nowhere (only `as_str()` and its spelling test at 3508), so "never produced" is correct; the four `decode_*` guard tests are real (`decode_guard_never_errors_on_foreign_frames` 2388, `decode_guard_extracts_ids_for_attribution` 2415, `decode_round_trips_every_browser_to_agent_type` 2433, plus `error_code_spellings_are_pinned` 2357 as the fourth).

#### N-3a. Task 11's declaration names a test that exists in no fence — and mislabels the other as new

> **CLOSED 2026-10-21 by `d471109`.** PM removed the phantom name, and the repair addressed the bucket problem I raised rather than relabelling: the declaration now says **"the counts are per-test-name, derived from the two fences, not from a split estimated by subtraction"** and explicitly records that the old 41's criterion did not cover `paused_state_survives_idle_timeout`. The text below stands as the record of the defect.

> **Raised by PM 2026-10-21; verified here, with one correction to PM's framing.**

`plan-2-core.md:4888` says *"Two are **new**: `paused transfers do not time out` and `drained .part before resume` as separate assertions."* Neither half survives.

- **`drained .part before resume` does not exist anywhere.** `grep -rn "drained"` over the whole 7,940-line plan returns exactly one line — `:4888`, the sentence making the claim. `grep -rn "drain"` likewise returns only that line. There is no `it()` by that name and no assertion matching the description. This is the same defect class as B-1…B-9: a declaration that does not describe the thing it points at.
- **`paused transfers do not time out` exists (`:4221`) but is not new — it is a port.** The Rust has `paused_state_survives_idle_timeout` (`files.rs:3834`): it downloads, pauses, forces `deadline` into the past, and asserts `check_idle()` returns **empty** with the slot still `Some`. The plan's `:4221` fence does the same thing through the injected clock (`now = 60_000`, `expect(...).not.toContain('TRANSFER_TIMEOUT')`). **PM verified presence; presence is not the claim.** The claim is *"new"*, and the Rust test it ports is real. (Whether it sits among the declaration's 24 ported or its 41 unported does not rescue the wording: if it is one of the 24, it is a port; if it is one of the 41, then the 41's stated criterion — *"Rust-internal helpers … or per-platform filesystem races"* — does not cover a wire-surface idle behaviour either.)

So the sentence is wrong **twice, in two different ways**: one phantom name, one real test misclassified as new. And the misclassification cannot be fixed by moving the name into the other bucket either, because the other bucket's own definition excludes it: the 41 are *"Rust-internal helpers … or per-platform filesystem races"*, and a wire-surface idle behaviour is neither. So the repair has to account for a test that belongs to **neither list as currently defined** — which is a partition repair, not a rename. The count around it is arithmetically fine — I re-walked the Task 11 range (`3888-4887`) and got **25 `it()` / 42 `expect()`**, exactly as declared. **The count is right and the prose is wrong**, which is precisely why re-deriving counts alone was never going to catch it, and why the fence-walker that closed B-1…B-9 is necessary but not sufficient.

#### N-3b. The `FILES_IDLE_TIMEOUT_MS` claim is half right, and its *reason* is inverted

> **CLOSED 2026-10-21 by `d471109`.** The repair added `it('pins the idle timeout to the wire value')` asserting only the literal `30_000`, and — better than what I proposed — carries a comment at `:4300-4305` explaining *why* the prod-equals-constant assertion is deliberately omitted, naming the `cfg(test)` divergence. The text below stands as the record.

> **Raised by PM 2026-10-21; PM's premise verified, PM's explanation corrected.**

`plan-2-core.md:4888` claims the TS test *"asserts the constant is `30_000` **and** that the prod timeout equals it."* Three checks:

1. **The Rust premise is right.** `files.rs:31` is `pub const FILES_IDLE_TIMEOUT_MS: u64 = 30_000;`; `:40-45` is the comment *"the wire value stays pinned by [`FILES_IDLE_TIMEOUT_MS`] and its own assertion"*, with `FILES_IDLE_TIMEOUT` shrinking to **50 ms** under `cfg(test)`. And **no Rust test pins it** — `awk 'NR>=2287' files.rs | grep FILES_IDLE_TIMEOUT` returns **nothing** (the test module starts at `:2287`). The gap the declaration claims to repair is real.
2. **The promised TS assertion is absent.** `grep -n "FILES_IDLE_TIMEOUT_MS"` over the whole plan gives nine hits, and **none is an assertion**: `:3964` the source definition, `:4286`/`:4295` the test-file import and re-export, and six production uses of `this.now() + FILES_IDLE_TIMEOUT_MS` (`:4495`, `:4515`, `:4531`, `:4572`, `:4609`, `:4772`). The only `30_000` inside the test fences is `now = 30_000` (`:4237`) — a fake-clock value in `kills a stalled transfer at the idle timeout`, not an assertion on the constant. There is no `expect(FILES_IDLE_TIMEOUT_MS).toBe(30_000)` and no prod-equals-constant check.
3. **The reason PM gives for why this matters is backwards.** PM writes that in Rust "the wire constant and the test constant were the same symbol; in TS they are not." **It is the reverse.** Rust has **two** symbols that diverge under `cfg(test)` (`30_000` vs `50`) — which is exactly why an equality assertion had something to compare and why its absence was a gap. TS has **one** constant, `FILES_IDLE_TIMEOUT_MS = 30_000`, used identically by production and by tests (the tests vary `now()`, not the constant). So *"the prod timeout equals it"* is not a missing assertion in TS — it is a **vacuous** one: both sides are the same symbol, and `expect(X).toBe(X)` cannot fail. The only non-vacuous pin available is on the **wire value** (`30_000`), which is what the Rust comment actually promised and never got.

**What this means for the repair.** The declaration must (a) drop `drained .part before resume` or add the assertion it describes, (b) stop calling `paused transfers do not time out` new, (c) either add `expect(FILES_IDLE_TIMEOUT_MS).toBe(30_000)` or drop the promise, and (d) **name the `cfg(test)` difference** rather than imply it. Item (d) is the part the current text never states: the Rust shrinks its timeout so tests do not sleep 30 s, and Plan 2 reaches the same end by injecting `now()` — a design difference, correctly chosen, that the declaration describes as if it were a repair of Rust's gap.

**Sequencing, agreed with PM.** Both go into the same single repair as B-11 and N-3: fence shape + the three `files.rs` list tests + this declaration rewrite, landing as one declared before→after. Neither blocks PR #174 (nothing in it executes Plan 2); both block **starting Task 11**. Neither is an owner question — they are declarations about a plan the owner never sees, which puts them in §3 and not §4.

### N-4. `chunk_boundaries` never exercised a splitter — but the Rust *did* honour the 16 KiB wire bound. Corrected 2026-10-22.

> **Amended 2026-10-22, after PM's resolution of N-4 in Plan 3 T8. Two of my original claims are retracted below; one stands.**

**What stands.** `chunk_boundaries` (`pty.rs:507-519`) does not exercise a splitter. Its body frames 0, `MAX_PTY_CHUNK`, and `MAX_PTY_CHUNK + 1` bytes through `frame_pty_output` and asserts the round-trip *length*; `frame_pty_output` (`:141-143`) delegates straight to `build_terminal_data_frame` (`:123-134`), which base64-encodes whatever slice it is handed and never splits. So Plan 2's claim — *"the Rust test's name promised chunking it never exercised"* — is **correct**, and the TS replacement asserts strictly more than the Rust test did. That part of my N-4 holds.

**Retracted, part 1: "the replacement adds behaviour the Rust does not have".** That conclusion was wrong, and PM is right to call it so. The Rust **does** bound its output at 16 KiB — but at the *read site*, not the framer: `start_reader` allocates `vec![0u8; MAX_PTY_CHUNK]` (`pty.rs:392`) and hands `buf[..n]` to the channel (`:397`), and `read()` **cannot return more bytes than the buffer holds**. I verified that rather than asserting it: a 16 KiB buffer reading a 500 KB file returns exactly `16384`, and a 64 KiB buffer on the same file returns `65536`. `pty.rs:392` is the **only** production read in the crate (`grep -n 'read(&mut' apps/agent/src/pty.rs` → one hit), and `lib.rs:1039` only frames what it is handed. So the Rust's chunks *are* ≤ 16 KiB by construction, and `emitChunks` does not add a behaviour — it **makes explicit, at the framer, a bound the Rust enforced one layer earlier**. B40 says 16 KiB; the Rust met it; the port meets it. The disposition is *"a stated contract made explicit in the layer that owns the wire shape"*, not *"a behaviour change needing a migration note"*.

**Retracted, part 2 — and this one is PM's error, not mine: "the Rust enforced nothing".** As of `844ba29` the claim appears in **two** plans and **three** places, and all three are **false as written**:

| where | wording |
|---|---|
| Plan 3 T8 `:228` | *"**The Rust never enforced it.**"* |
| Plan 3 T8 `:248` | *"'a behaviour the Rust only appeared to have, now made real'"* |
| Plan 2 Task 12 declaration `:5531` | *"but the Rust enforced nothing … `emitChunks` is what makes the port meet the contract the Rust merely appeared to meet"* |

The citation given for it is `MAX_PTY_CHUNK` at `:22` being "the read buffer" — but *being the read buffer* is precisely the mechanism by which the bound **is** enforced. A buffer-sized `read()` is a bound, not the absence of one. The only reading under which "enforced nothing" is true is "the framer does not enforce it", which is a different and much narrower statement than the one the plans make. The T8 preamble makes the same move one level higher — *"the contract is already written down, and only the Rust failed to meet it"* (`:222-223`) — so a repair has to catch the framing sentence as well as the three instances above, or the conclusion will be re-derived from the preamble on the next edit.

**The `node-pty` half, which is sound but supports a narrower conclusion than stated.** PM measured 1.2.0-beta.12 with a real `/bin/sh`: 8 MiB of output in 2 555 events, largest **18 433 bytes**. Against `DEFAULT_MAX_MESSAGE_SIZE = 65536` (`werift/lib/webrtc/src/transport/sctp.js:10`) the unsplit worst case is ~24 580 base64 characters, so this is contract drift, not a crash — I agree. But **node-pty's larger events do not imply the Rust had the same exposure**: the Rust's buffer caps its reads regardless of what a JS binding would have delivered. The correct statement is *"node-pty would deliver more than 16 KiB, so the port needs an explicit splitter where the Rust needed none — because the Rust's bound lived in its read buffer"*. That is a real porting hazard and it justifies `emitChunks` completely; it just is not evidence that the Rust was unbounded.

**Net disposition: PM's outcome is right, PM's mechanism is wrong, and the two plans should not ship "the Rust enforced nothing".** The citation in C12 and B40 needs the same treatment — see N-4a.

### N-4a. C12 and B40 are right about the contract and wrong about their evidence

> **Raised by PM 2026-10-22; verified here, and it is a docs defect in my lane.**

Both spec rows state the 16 KiB wire contract correctly and both cite `pty.rs:22,123-143` as the evidence that the Rust implements it. **Neither citation supports that claim:**

| cited | what it actually is | does it show 16 KiB chunks? |
|---|---|---|
| `pty.rs:22` | `pub const MAX_PTY_CHUNK: usize = 16 * 1024;` — the constant, with a doc comment about base64 expansion | The *value*, not its use. A constant nobody applies proves nothing. |
| `pty.rs:123-134` | `build_terminal_data_frame` — base64-encodes the slice it is handed | **No.** It frames `&[u8]` of any length; there is no split. |
| `pty.rs:141-143` | `frame_pty_output` — one-line delegation to the above, marked `#[allow(dead_code)]` | **No.** And it is dead code: no production path calls it. |

**The call that actually enforces the bound is `pty.rs:392`** — `read(&mut buf)` with `buf = vec![0u8; MAX_PTY_CHUNK]` — plus the `:397` hand-off of `buf[..n]`. That is what makes every emitted chunk ≤ 16 KiB, and it is the citation both rows need.

**The deeper problem with the rows isn't the line numbers — it's that the rows do not distinguish *intent* from *mechanism*.** C12 is a *constraint* ("the terminal output is … 16 KiB chunks"), so citing the read site is exactly right: it shows the property holds. B40 is a *behaviour to port*, and there the row should say what the Rust does rather than imply a framer it does not have. Concretely:

- **C12** should cite `pty.rs:22,392,397` — constant, read buffer, hand-off — and drop `:123-143`, which proves only that the framer is length-agnostic.
- **B40** should keep the contract wording and add the note that the bound is a **read-buffer** bound (`:392`), so a port whose input source is not buffer-bounded (node-pty, per N-4) must apply it at the framer instead. That phrasing keeps the row true *and* tells an executor what to do — which the current citation does not.

This is the same class as the `desktop/devices.rs` drift Plan 3 T9 already names, and it is why PM asked for it here: an executor reading B40 and following its citation would look at a framer that never splits and conclude the contract is unenforced — which is precisely the wrong conclusion, and the one both plans now draw in prose (`"the Rust enforced nothing"`). **Fixing the citation and fixing that sentence are the same fix.**

### N-5. Task 19's "`reporting_estimator_publishes_its_initial_target` re-homes here" has no home

Task 8 (line 2979) moves it to "Task 19's runtime". Task 19's declaration (line 7512) says it re-homes there. Neither fence contains it: the T19 `runtime.test.ts` fence has six tests, all source resolution; the `session.test.ts` fence has eleven, none about an estimator. The Rust test exists (rtc.rs:1179). So the test leaves `rtc.rs` in a declaration and arrives nowhere.

> **N-5 is the small end of a larger hole.** The estimator test is one symptom; the behaviour it belongs to — the auto-ABR loop — has no row, no task, and no plan. That is **B-10** below, and it is a different class: N-5 is a dropped *test*, B-10 is a dropped *behaviour*.

### B-10. The auto-ABR loop has no coverage row in any plan, and no owner in any plan

> **Status: RULED BY THE OWNER 2026-10-22 — it ships, as a full port.** Recorded in Plan 3's T8 (`…plan-3-desktop-retirement.md:231`): *"B-10 — the auto-ABR loop — RULED BY THE OWNER (2026-10-22): it ships … This is now a task, not a question."* **Read the rest of this section as the evidence the ruling was made on, and read the three questions below as assigned to the task rather than left to the owner** — Plan 3 hands two of them to the implementing task explicitly (*"The task must state which"* for the estimator divergence; *"must say so in the B-row"* for a skipped pacer). One half of one question was never answered by the ruling and is not answered here either: **the seed** (4 Mbps as the Rust, or 0 and let the first TWCC report set it). Plan 3's T8 does not name a seed, and `abr_next_target` rejecting `estimate <= 0.0` (`desktop.rs:1962`) means the choice is load-bearing — it decides whether the loop waits for feedback by design or by coincidence. That is a question for the task's author, and it is flagged here so it is answered in writing rather than arrived at.

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

**There is a second, sharper dependency the ledger does not record either.** The Rust's GCC is installed via `configure_congestion_control(…, CongestionFeedback::Twcc, …)` (`rtc.rs:424-430`), which **changes the SDP** — it registers `transport-cc` feedback and a header extension on the media engine. The Rust comment at `rtc.rs:417-420` says so and gates it on `has_control` so the terminal path stays byte-identical. **That SDP delta is itself a wire-visible behaviour with no B-row.** `grep -n 'transport-cc\|twcc\|transportCC'` over the spec and both plans returns **0** — the rewrite documents never mention TWCC at all, while the Rust agent's desktop offer carries it. If the Node agent negotiates without it, the browser's SDP answer differs from today's; if it negotiates with it, the terminal path may acquire a header extension it does not have today. Both branches are unowned.

> **Correction 2026-10-21 #1 (this paragraph originally claimed something false).** The first version ended with *"werift's own `transport-cc` support is confined to `media/extension/rtcpFeedback.js` — the parser; the negotiation side is not obviously there."* **That is wrong**, and I should have checked the installed package before writing it. werift ships a negotiation-side helper — `useTransportWideCC()` in `media/extension/rtpExtension.js:28-32`, returning `RTCRtpHeaderExtensionParameters{uri: RTP_EXTENSION_URI.transportWideCC}` — and `lib/rtp/src/rtp/headerExtension.js:21` carries the **byte-identical** URI string to `rtc`'s (`http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01`, `sdp-0.8.0/src/extmap/mod.rs:19-20`). The negotiation side is there; it is simply **never on by default**.
>
> **Correction 2026-10-21 #2 — the more important one, and it refutes the Rust comment's premise.** `register_default_interceptors` **already calls `configure_twcc_receiver_only`** (`interceptor_registry.rs:196-211`, at `:206`), and that function registers the `transport-cc` `rtcp-fb` **and** the `TRANSPORT_CC_URI` header extension for **both** Video **and** Audio (`:568-604`). And `rtc.rs:440-441` calls `register_default_interceptors` **unconditionally**, on the same `media` the gated call mutated. So:
>
> - **The video half of the "SDP delta gated on `has_control`" does not exist.** The terminal path already gets video `transport-cc` feedback and the TWCC extmap from the **default** interceptors, whether or not `has_control` is set. `rtc.rs:417-420`'s comment — *"it registers `transport-cc` feedback and a header extension on the media engine, which changes the SDP. The terminal path must stay byte-identical"* — is **wrong about its own mechanism**. The gating does not preserve byte-identity for the video m-line, because the default chain already changed it.
> - **The audio half is also not a delta.** `configure_twcc_receiver_only` registers Audio too, so `configure_congestion_control`'s audio registration is a **duplicate**, and `MediaEngine::register_feedback` de-duplicates on `(typ, parameter)` (media_engine.rs:719-725) while `register_header_extension` finds-and-mutates by URI (`:676-695`). Net SDP effect of the gated call on audio: **none**, beyond what the default already did.
> - **So the real, unrecorded SDP delta is smaller than I claimed and differently shaped.** What `configure_congestion_control` actually adds that the default does not is **`Slot::CongestionControl` and `Slot::Pacer`** — the *send-side* loop and the pacing. The *wire* delta is essentially nil. This **strengthens** the finding in one direction and **narrows** it in another, and both matter:
>   - Narrower: "the Node port must decide what to advertise in SDP" is **wrong** as a framing — the default werift/rtc behaviour on that point is what the Rust already has, and the browser echoes `rtcp-fb` regardless. Q4 as I first wrote it was answering a question that did not exist.
>   - Stronger: what the port loses is **pacing and the send-side estimator**, which is exactly the pacer bullet below. The behaviour with no werift analogue is the *only* real delta, not one of three.
>
> The rewrite documents' silence on `transport-cc` is still true and still worth a line, but it is **not** a wire-contract risk. Recording my own correction rather than quietly deleting it, because the wrong version is the one a reader would most likely re-derive.

**The two-m-line half, verified against the crate source.** `configure_congestion_control` registers the feedback *and* the header extension **per codec kind**, in a `for kind in [RtpCodecKind::Video, RtpCodecKind::Audio]` loop (`rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs:676-694`) — so the delta is not one m-line, it is **both**. Two things follow that the ledger does not record:

- The Rust agent registers audio codecs (`register_default_codecs` → Opus/G722/PCMU/PCMA, `rtc.rs:412-415`), so the Audio half of that loop has codecs to attach to. The browser, however, is **video-only** (`packages/webrtc-core/src/media-channel.ts:20-28` adds exactly one `video` transceiver and returns early when `media.video` is unset), so today the audio m-line never materialises in the answer — **and, per correction #2, the audio registration is a duplicate of the default's anyway.** It is latent in the weaker sense: nothing observable changes if it were removed.
- `configure_congestion_control` also builds **`Slot::Pacer`** (`registry.with(Slot::Pacer, PacerBuilder::new().build())`, `:713-717`). **This is the one behaviour that is genuinely new.** The Rust **paces its own departures** on the desktop path, and rtc's own docs say why this is not a default: *"Congestion control implies pacing, pacing implies queueing delay, and that is not something an application should acquire without asking. `register_default_interceptors` does not call this."* (`:641-642`; restated as decision **D6** at `:889-890`, asserted by a test at `:900-906` that `Slot::Pacer` is absent from the default chain). werift has **no send-side pacer to port to**: `grep -ri 'pacer\|pacing'` over `werift@0.24.4/lib` returns one hit, inside an SCTP retransmission comment. So the honest count of "what a port must replace" is **two**: the estimator (TWCC instead of GCC) and the pacer (absent entirely). The TWCC negotiation is **not** a third — correction #2 removes it.
>
> **Amended conclusion: "port auto-ABR" is two behaviours, not three** — the estimator and the pacer. The SDP question I raised under Q4 is **withdrawn**: the default interceptors already register what the Rust's gated call registers on the wire, so there is nothing for an owner to decide there.

**Severity and disposition.** This is a **spec-level decision**, and the questions are:

1. **Does auto-ABR ship in the Node agent at all?** The Week 8 spec (`…2026-10-03-phase3-week8-stream-quality-design.md:26,562`) says auto-ABR "ships" but is *"a **goal**, not an acceptance criterion (ADR-23, §10.2)"*, and `ARCHITECTURE.md:970` records it as *"GCC auto-ABR — target, verified via spike §3.7 (not an acceptance criterion)"*. **The rewrite spec never mentions it.** So the rewrite is not silently dropping a shipped feature; it is **silently inheriting a feature the governing spec never claimed**. That distinction matters: it makes "do not port it" a *legitimate* answer that still needs writing down, and it makes "port it" a *scope addition* that needs the spec amended.
2. **Against which estimator — and seeded how?** werift's TWCC `SenderBandwidthEstimator` is the only surface available, and it is not GCC. It also **seeds at `0`**, not 4 Mbps, so `abr_next_target`'s `estimate <= 0.0 → None` guard would swallow the initial value into "no change" — arguably right (wait for real feedback), but reached **by coincidence**. Owner sub-question: seed at 4 Mbps as the Rust did, or start at 0 and let the first real TWCC report set the target?
3. **What is the declared divergence?** The Rust's dead-band and 15%-move policy are portable as policy; the measured values are not. And the divergence is **two behaviours, not one** — the estimator *and* the absent pacer (correction #2). A divergence note that names only the estimator will read as parity and behave as a downgrade.
4. ~~What happens to the `transport-cc` SDP delta?~~ **WITHDRAWN 2026-10-21 — the premise was wrong.** `register_default_interceptors` already registers the TWCC `rtcp-fb` and extmap for both kinds (`interceptor_registry.rs:196-211`, `:568-604`), so the gated call's wire effect is nil and the terminal path was never byte-identical on that m-line anyway. The Rust comment at `rtc.rs:417-420` states its own mechanism incorrectly. **This is now a docs defect in the Rust, not an owner question** — worth a line in Plan 3's T9 alongside the `desktop/devices.rs` drift, because the comment is the thing a porter reads.

**Why this is not Plan 2's to absorb silently, and not Plan 3's to absorb at all.** Plan 2 is the TS core; the auto-ABR loop is a *session-loop* behaviour, so if it ships it belongs in **Plan 2's Task 19** (`runtime.ts` + `desktop/session.ts`) — the task that owns the desktop session loop and already owns `resolveDefaultSource` and the `DesktopSession` class, and whose declaration (plan:7794) already claims `reporting_estimator_publishes_its_initial_target` as its one port from Task 8. That is the natural home, and it is the only place in any plan where a periodic task that retargets the encoder during a session can exist. **But it cannot be landed there by an implementer**, because the estimator choice, the seeding, and the pacer are all owner calls, and a plan cannot invent them.

**Recommendation to PM (the landing spot is PM's to rule; this is the evidence, not the decision):**

> **Outcome, 2026-10-22: the fourth option was taken.** The owner ruled **it ships, as a full port**, and the ruling is recorded in Plan 3's T8 (`:231`) as a task rather than a question. The bullets below are the pre-ruling recommendation and are kept as the record of what was recommended against what was decided — the reader should compare the two, not read the bullets as live advice. Which of them were followed: the item is recorded here (first bullet); it was **not** absorbed by B20/B19/B62 (second); the T6/T8 carry landed as `c81ae4b` (third); the escalation happened and produced the ruling (fourth); and the last bullet is the one now in force, with the pacer named as **a thing to build**, not a divergence to declare.

- **Record B-10 in the audit as an open spec-level item** — done, this section.
- **Do not let it be absorbed by B20, B19 or B62.** Each of those is a manual-path row; the auto path is a different producer with its own lifecycle (a ticker, a latch, a shared target).
- **Add it to Plan 3's T6 retirement ledger** as an *unresolved* item, so Plan 3's "close the retirement ledger before deleting the Rust tree" step cannot pass while this is open. Plan 3's T8 is the right list for carried-forward Plan 2 items; B-10 belongs there with the same standing as N-4 (which T8 already carries).
- **Escalate to the owner with the three surviving questions above** — Q4 is withdrawn because its premise was false — alongside N-4, which is already on the same list for the same reason: both are *behaviour decisions*, not *docs decisions*. **One piece is *not* an owner question and can be filed straight away:** the Rust comment at `rtc.rs:417-420` is simply wrong about what `configure_congestion_control` changes, and the fix is a comment correction for Plan 3's T9 — the same class as the `desktop/devices.rs` drift T9 already names.
- **If the answer is "auto-ABR does not ship in the Node agent"** — *not the answer taken.* It would have needed an **R7** retirement row with the reason, and `ARCHITECTURE.md`'s Week 8 line amended — otherwise the docs describe a feature the agent no longer has, and this repo has already paid that price once (the `desktop/devices.rs` drift Plan 3's T9 names).
- **If the answer is "auto-ABR ships"** — **this is the answer taken (2026-10-22, full port).** It needs a new B-row (B63) in the spec, a Task 19 fence, a declared divergence against the werift TWCC estimator, and a stated answer on the `transport-cc` SDP delta. The Rust's three `abr_next_target` tests are the *policy* to port; the estimator's own behaviour is new. **Plan 3's ruling adds one thing this bullet understated:** "full port" also means **building the pacer**, because werift has none — a task that skips it has shipped a different control loop and must say so in the B-row.

**What I could not verify, and am not claiming:** whether the werift TWCC estimator can be made to produce a *usable* number for a 500 ms-tick encoder retarget in this stack, and whether werift's `transport-cc` negotiation is reachable from the adapter's `PeerConnection`. Those are P0-spike questions (spec §9.3 is the werift-as-sender gate) and belong to the spike, not to this audit.

> **Closed 2026-10-21 — both questions now have measured answers, and two of them change the ruling's shape.** BE measured these against the installed `werift@0.24.4`; I re-verified each in the package source and, where possible, against this repo's own captured SDP.
>
> | Claim | Verified how | Holds? |
> |---|---|---|
> | `SenderBandwidthEstimator` is not a root export; the deep specifier fails | `package.json` `exports` permits only `"."` and `"./nonstandard"`; neither `index.d.ts` mentions it | **Yes** |
> | Reachable as `pc.getSenders()[0].senderBWE` | `media/rtpSender.d.ts:41` — `readonly senderBWE: SenderBandwidthEstimator`, imported at `:27` | **Yes** — a port has a path and needs no vendoring |
> | The seed is **0**, not 4 Mbps | `media/sender/senderBWE.js:76-81` — `_availableBitrate` initialises to `0` | **Yes** |
> | werift **echoes** the offer's `rtcp-fb … transport-cc` even with local TWCC off | `peerConnection.js:1074-1076` — `findCodecByMimeType` returns **`target`** (the *remote* codec), not the local one, so the answer's `rtcp-fb` list is the browser's. **Independently confirmed by this repo's own spike capture**: `apps/agent/spike/report.json` run 0 answers a Chrome offer with `a=rtcp-fb:102 transport-cc` while the local config was `useH264()` (`spike.ts:176`), whose `rtcpFeedback` is only `nack`/`nack pli`/`goog-remb` (`media/codec.js:6-12`) | **Yes** — and the repo already had the evidence |
> | `extmap` appears only if local config names `useTransportWideCC()` | `transceiverManager.js:265-267` filters the offer's extensions through `config.headerExtensions[kind]`, which defaults to `[]` (`peerConnection.js:1084-1087`). Same capture: the offer carries `a=extmap:4 …transport-wide-cc…`, the answer carries **no extmap at all** | **Yes** |
> | `senderBWE` leaks unbounded on the exact path a port must take | `senderBWE.js:133-140`: `Object.keys(sentInfo)` reads the *one packet just sent* (`["wideSeq","size","sendingAtMs","sentAtMs"]`), so `Number()` yields four `NaN` and the `delete` loop never runs. Intended: `Object.keys(this.sentInfos)` | **Yes — an upstream werift defect.** BE measured 200 sends → 200 retained entries |
>
> **What this does to the questions.** Two of the four now sharpen rather than soften:
>
> - **Q2 ("against which estimator") gains a sub-question that is an owner call, not an implementer's pick: seed at 4 Mbps as the Rust did, or start at 0 and let the first real TWCC report set the target?** `abr_next_target` rejects `estimate <= 0.0` (`desktop.rs:1962`), so the port would swallow werift's initial `0` into "no change" — arguably the right behaviour (the loop waits for real feedback), but it arrives there **by coincidence**, not by design. The Rust's `reporting_estimator_publishes_its_initial_target` (`rtc.rs:1177-1187`) asserts `published == ABR_INITIAL_BPS`; the TS equivalent cannot assert the same number, so it is **not portable as written** — it either asserts `0` or does not exist.
> - **Q3/Q4 gain a third behaviour.** The pacer (above) has no werift counterpart, so "declare the divergence" is not one sentence about the estimator: it is the estimator, the un-persisted TWCC negotiation, and the absence of pacing. A port that names only the first will read as parity and behave as a downgrade.
>
> **One thing this does *not* change.** The leak is an upstream defect in the *only* estimator surface a port can reach, so it is material to the ruling — but it is not the rewrite's to fix, and it does not by itself decide ship/do-not-ship. Recording it here so the owner's decision is made with it in view, not discovering it after the port lands.

### B-11. `FilesSession.list()` emits a different wire shape from the Rust, and the gate cannot see it

> **Raised by PM 2026-10-21 from BE's reading; independently verified by BA and extended.** Severity: **BLOCKING**, same class as B-10.

**What the two shapes are.** Plan 2's `list()` (`…plan-2-core.md:4439-4454`, the fence itself at `4445-4451`) builds each entry as:

```ts
{ name: entry.name,
  kind: entry.isDirectory() ? 'directory' : 'file',
  size: entry.isDirectory() ? null : (stat?.size ?? 0),
  modifiedEpochMs: stat ? Math.floor(stat.mtimeMs) : 0 }
```

The Rust (`files.rs:286-292`, `RemoteFile`, `#[serde(rename_all = "camelCase")]`) builds:

```rust
pub struct RemoteFile { pub name: String, pub path: String, pub size: u64,
                        pub is_directory: bool, pub modified_at: String }
```

| field | Rust / `packages/shared` / browser | Plan 2's `list()` | Effect |
|---|---|---|---|
| `name` | `String` | `name` | same |
| `path` | `join_rel(rel, name)` — **full relative path** (`files.rs:1327`) | **absent** | navigation and `:key` both break |
| `size` | `u64`, `metadata.len()` — **a real number for directories too** (`:1329`) | `size \| null`, **`null` for a directory** | `formatSize(null)` on a row the UI did not expect to have one |
| `isDirectory` | `bool` | **`kind: 'directory' \| 'file'`** | every `v-if="entry.isDirectory"` is `undefined` |
| `modifiedAt` | RFC 3339 UTC **string**, always ending `Z` (`rfc3339_utc`, `files.rs:141`, `:1324`) | **`modifiedEpochMs`: a number** | `formatModified(undefined)` |

**Four of the five fields differ**, not three. Two consequences matter for the repair:

- **The directory `size` is not merely renamed, it changes type *and* meaning.** The Rust sends `metadata.len()` for a directory (`files.rs:1329` — a real number); Plan 2 sends `null`. A faithful port keeps the number.
- **`modifiedAt` loses three things at once**: the field name, the type, *and* the UTC-`Z` normalisation that `rfc3339_utc` performs (`files.rs:141-161`). `Math.floor(stat.mtimeMs)` is stringless, so a repair that only renames the key to `modifiedAt` still ships a `number` where `RemoteFile.modifiedAt: string` is declared.

**The full enumeration is seven divergences, not four** — the four field-shape changes above, plus three *behavioural* ones in the same fence that a shape fix alone would leave wrong. Kept separate on purpose: the first four are wire-shape, the last three are behaviour.

| # | Kind | Plan 2 (`:4440-4453`) | Rust (`files.rs`) | Consequence |
|---|---|---|---|---|
| 1 | shape | no `path` field | `path: join_rel(rel, &name)` (`:1327`) | navigation dies; `files-download` also takes a path |
| 2 | shape | `kind: 'directory' \| 'file'` | `is_directory: bool` (`:1330`) | every `entry.isDirectory` is `undefined` |
| 3 | shape | `size: null` for dirs | `metadata.len()` (`:1329`) | type break on a declared `size: number` |
| 4 | shape | `modifiedEpochMs: number` | `modified_at: String`, RFC 3339 UTC (`:1331`, `:141-161`) | type break; no `Z` normalisation |
| 5 | behaviour | sorts by `localeCompare` alone | dirs first, **then name byte-wise** (`:1336-1340`) | order diverges on case/accents/punctuation; `localeCompare` is ICU-dependent, so not even deterministic across hosts |
| 6 | behaviour | `statSync(…, {throwIfNoEntry:false})` then `?? 0` | a per-entry `metadata()` failure **fails the whole list** with `IO_ERROR` (`:1316-1319`, comment: *"a half-listed directory is worse"*) | silently substitutes `0`/`0` and lists anyway |
| 7 | behaviour | `handle()` maps only `SandboxError`, everything else → `IO_ERROR` (`:4362-4367`) | `read_dir` maps `ErrorKind::NotADirectory` → `NOT_A_DIRECTORY` (`:1303-1306`) | **wire-code change on an error path** |

**On #7, the mechanism, because it is subtler than "the plan forgot a mapping".** The plan *does* have an `errnoToCode` helper that maps `ENOTDIR → NOT_A_DIRECTORY` and `EISDIR → NOT_A_DIRECTORY` (`:3738-3746`), but it is only called inside `FilesRoot` (`:3798`, `:3774`). `list()` does not go through it — it calls `readdirSync(path, …)` **outside** any `try`, so Node's `ENOTDIR` propagates to `handle()`'s generic catch and becomes `IO_ERROR`. I confirmed Node raises `code='ENOTDIR', errno=-20` for `readdirSync` on a regular file. So the Rust's `list_on_a_file_is_not_a_directory` (`files.rs:2730`) ported against the plan's fence would assert the wrong code, and nothing in the plan would notice.

**Who consumes it.** `packages/shared/src/types/files.ts:6-13` declares the Rust shape (`RemoteFile { name; path; size: number; isDirectory: boolean; modifiedAt: string; mode? }`). `packages/file-core/src/client.ts:548-553` passes `files-list-result` through **untyped and unvalidated** — it destructures `requestId` and resolves the rest as `FilesListResult`, so no layer between the agent and the browser would catch a shape change. And `apps/web/src/components/files/FilesView.vue` reads four of the five fields:

| line | code | under Plan 2's shape |
|---|---|---|
| `:77` | `if (entry.isDirectory) navigate(entry.path)` | `undefined` → **falls to the download branch, on a directory** |
| `:304` | `:key="entry.path"` | `undefined` → duplicate keys for every row |
| `:314` | `v-if="entry.isDirectory"` (folder icon) | `undefined` → **every row renders the file icon** |
| `:325` | `entry.isDirectory ? '—' : formatSize(entry.size)` | `undefined` → `formatSize(size)` on directories, where `size` is `null` |
| `:328` | `formatModified(entry.modifiedAt)` | `undefined` → **empty cell on every row** |

**And an existing E2E goes red.** `packages/webrtc-core/test/e2e/files.e2e.test.ts:123,127` asserts `expect(notes?.isDirectory).toBe(false)` and `expect(docs?.isDirectory).toBe(true)`. Under Plan 2's shape both are `undefined`, so both fail — **the moment Task 11 lands**. `/mnt/Data/Ponta/remote-platform` has no other producer of `files-list-result` to update, which is what makes it a straight contradiction rather than a coordinated change.

**Why the gate cannot see it — the same structural reason as B-10.** **B43** ("Files JSON message set (12 inbound, 11 outbound)") has a row, Plan 2 owns it, and Task 11's declaration (**25 `it()` / 42 `expect()`**) passes. Both counts are satisfied. **What no row and no test states is the *shape* of the message inside the row.** A count-based gate is blind to a field-level change, exactly as it was blind to a behaviour that had no row at all. This is the same lesson as B-10 from the other direction: B-10 is a behaviour with no row; **B-11 is a row whose contents changed while the row still passes.**

The gap is visible in the tests, not just in the type. **Task 11 contains no test of `list()` at all.** Its 25 `it()`s are chunk arithmetic, the binary frame, `partName`, download, upload, resume, and cancel — `grep` for a `list`/`sort`/`truncat`/`director` test in the task's range returns only `rejects a truncated header` (a binary-frame test, unrelated). So the declaration's 25/42 is *true* and *silent* on the one function whose output crosses the wire unchanged. The Rust, by contrast, has three (`files.rs:2703` ordering + directory-`size` + `path` + `Z`-suffix, `:2730` not-a-directory, `:2740` cap), and **none of them are in Task 11's port list**.

**Deliberate, or a fence error? The evidence says fence error, and the three possibilities are distinguishable:**

1. **"The plan intends to change the browser too."** Refuted: `grep apps/web` over all of Plan 2 returns no web file, and Task 11's Files block lists no `packages/shared` or `apps/web` edit. A coordinated change would have to appear there.
2. **"The fence is wrong; the Rust shape is the contract."** **Supported.** The wire type already has an owner (`files.ts:6-13`, unchanged since Week 10, spec §2.3 `…week10-file-transfer-design.md:102` — *"`RemoteFile.path` is the entry's full relative path"*), the browser already consumes it, and the existing E2E already asserts it.
3. **"`kind`/`modifiedEpochMs` is internal and mapped to the wire elsewhere in the plan."** Refuted: `modifiedEpochMs` occurs **exactly once** in the plan (`:4451`) and nowhere else in the repo outside it (`grep -rn modifiedEpochMs` over `apps/`, `packages/` → nothing). There is no mapping site.

**Recommendation.** Treat it as **a plan repair, not an owner question** — the contract is already owned, and unlike B-10/N-4 there is no behaviour decision to make. Concretely, `list()` should build `{ name, path: joinRel(rel, entry.name), size: stat?.size ?? 0, isDirectory: entry.isDirectory(), modifiedAt: rfc3339Utc(...) }`, sort **dirs-first then byte-wise**, let a per-entry `stat` failure fail the list, and route `readdirSync` through `errnoToCode`. Task 11 should then gain the three `files.rs` list tests it currently omits (`list_returns_entries_sorted_dirs_first` `:2703`, `list_on_a_file_is_not_a_directory` `:2730`, `list_cap_truncates_at_4096_with_the_flag` `:2740`) — `grep` for each of those names in Plan 2 returns **0**, so the whole list surface is unported, which is *why* nothing caught divergences 1–7. **I have not edited Plan 2**; this is the evidence and the recommendation, and the landing edit is PM's.

**Why the repair is not free, and why PM is right to hold it.** Adding those three tests changes Task 11's declared `25 it() / 42 expect()`, and a count change is itself a TEST-INTEGRITY declaration — it must be declared, reviewed, and shown to match its own fence. So the fence correction and the declaration correction have to land together, and they cannot land before **N-3** (Task 11's unauditable "24 of 41" partition) is resolved, or the plan would be right about `list()` and still wrong about what it ports. PM's ruling — fence repair is theirs, held until N-3 is settled, both derived from this section — is the correct sequencing.

**The disposition distinction, stated once.** B-11 is **a docs defect, not an owner question**, and that is what puts it in §3 and not §4. The wire contract has four owners that already agree — the Rust, `packages/shared`, the browser, and the existing E2E — and only the plan disagrees. B-10 and N-4 are different: there, no artefact states the answer, so someone has to *decide*. A plan being wrong about an owned contract is repaired; a behaviour nobody has decided needs a ruling.

### B-12. Task 11's partition criterion is not exhaustive — 25 of the 40 "non-ports" fall in neither stated category, and one of them is a wire-contract divergence

> **Raised by QA 2026-10-21 ("its 26 ports are 'named individually', and 46 of 65 are not"), routed by PM. QA's count is in the right neighbourhood and its quoted claim is not in the plan. The measured defect is worse and sits one level down: the declaration's *criterion* for its non-ports — which it labels **39** in the current text and **41** in the partition it replaced, against a measured **40** — not its naming of the 26.** Severity: **BLOCKING** — the same class as B-1…B-9, and the same class as B-11.

**What QA got right, and what the plan actually says.** QA reports the declaration as claiming the 26 ports are "named individually". That phrase — and `by name`, `named one by one`, `each named` — **occurs nowhere in Task 11** (`grep` over the whole 3,865–5,125 range returns 0 for all four). The declaration describes the 26 by **category**: *"those covering the wire surface, the window, ack batching, resume alignment, cancel, idle, and the three `list_*` tests"*. So the paraphrase overstates what the plan says, and I decline QA's framing on that point.

But the declaration's surviving sentence — **"The counts are per-test-name, derived from the two fences, not from a split estimated by subtraction"** — is doing real work, and that work is where the defect is. It claims the partition is *derived*, not *estimated*. Derivation requires the criterion covering those non-ports to be exhaustive over its own members. It is not. (The declaration's residual is stated two ways across its own history: *"The remaining **39**"* at `:5065`, from `65 − 26` in titles, and the *"24 of 65 / 41 remaining"* partition at `:5074` it replaced. Measured against the fence, **40** Rust tests are not ported, and the criterion below covers 18 of them.)

**Measured, against `apps/agent/src/files.rs` (65 anchored test attrs, `grep -cE '^\s*#\[(tokio::)?test'`) — the complete partition is §B-12b:**

| | count |
|---|---|
| ported (25 Rust tests, 26 `it()` titles) | **25** |
| non-ports | **40** |
| → non-ports covered by one of the declaration's four stated reasons (arithmetic 1 + Task 10's seven + internal helpers 5 + retired `decode_*` 2 + filesystem races 3) | **15** |
| → non-ports in **none** of them | **25** |

The 25 in neither category — each one is a wire-surface or state-machine behaviour, not a helper and not a race:

```
decode_guard_never_errors_on_foreign_frames          frame_files_wraps_the_envelope
decode_round_trips_every_browser_to_agent_type       error_frames_carry_the_code_and_attribution
download_assembles_byte_equal_content                download_of_a_directory_is_not_a_file
oversize_size_is_rejected_by_the_pure_guard          empty_upload_finalizes_an_empty_file
upload_into_a_missing_directory_is_not_found         chunk_for_an_unknown_id_is_transfer_unknown
chunk_length_mismatch_is_bad_frame                   upload_totals_changed_mid_flight_is_bad_frame
busy_is_checked_after_the_path_checks                a_completed_download_frees_the_slot
cancel_stops_the_download_and_removes_the_state      idle_timeout_removes_a_stalled_uploads_part
stale_part_is_removed_and_retried_once               teardown_clears_both_directions
test_mkdir_delete_rename_sandbox                     test_rename_root_rejected
test_rename_destination_existing_rejected            resume_approved_after_upload_pause
download_pause_ack_reports_acked_chunk_index         download_resume_seeks_and_pumps_from_resume_point
paused_download_absorbs_acks_without_repumping
```

Two names that appear in an earlier draft of this list are **not** in it: `test_error_code_str_mapping` (`files.rs:3506`) and `test_pause_and_resume_alignment_check` (`files.rs:3518`, exercises `verify_resume_upload` arithmetic — ported by `requires the .part length to equal the resume offset exactly`). The second has a true stated reason. **The first does not** — an earlier version of this sentence called it "an internal helper", which was the same misreading as row 4's, in the same direction: it asserts `RESUME_INVALID` and `QUEUE_FULL` (`:3505-3509`), which are browser-visible wire spellings, and with `error_code_spellings_are_pinned`'s 12 it makes **14 of 16**. A test classified by what its function *is* rather than by what it *protects* is precisely the failure mode §B-12e exists to correct, and I made it twice. Its bucket stays **B**; its label is corrected here and in row 54. See §B-12f.

**Seven of the 25 are not merely unported — they are guards the fence implements and no test ever trips.** This is the sharpest form of the defect, because the code is *there* and looks covered:

| Rust test | guard in the fence | assertions |
|---|---|---|
| `chunk_for_an_unknown_id_is_transfer_unknown` | `TRANSFER_UNKNOWN` at `:4754`, `:4829`, `:4892`, `:4900`, `:4926` | **0** |
| `chunk_length_mismatch_is_bad_frame` | `BAD_FRAME` at `:4761` | **0** |
| `upload_totals_changed_mid_flight_is_bad_frame` | `BAD_FRAME` at `:4757` | **0** |
| `oversize_size_is_rejected_by_the_pure_guard` | `FILE_TOO_LARGE` at `:4632`, `:4705` | **0** |
| `download_of_a_directory_is_not_a_file` | `NOT_A_FILE` at `:4631` | **0** |
| `upload_into_a_missing_directory_is_not_found` | `resolveParentForCreate` at `:4707` | **0** |

Measured by counting each token in the fence's *test* bodies versus its *production* bodies: **seven** guards appear in production and in no test — the six above, plus the root-delete guard at `:4985` (`PERMISSION_DENIED`, *"the files root itself cannot be deleted"*), whose Rust counterpart is inside `test_mkdir_delete_rename_sandbox`. `NOT_A_FILE`, `FILE_TOO_LARGE` and `DIR_NOT_EMPTY` each occur **zero** times in either test fence.

Every one is a **wire-surface or state-machine behaviour**, not a helper and not a race. Several are the *positive* halves of behaviours whose negative halves Task 11 does port — `resume_rejected_on_part_size_mismatch` is ported, `resume_approved_after_upload_pause` is not; `upload_of_an_existing_name_is_already_exists` is ported, `upload_into_a_missing_directory_is_not_found` is not; `cancel_*` is ported, `teardown_clears_both_directions` is not. A criterion that classifies one half as "port" and drops its other half as "helper" is not a criterion; it is a label placed after the fact.

**The count is settled, and the 26 counts the wrong kind of thing.** An earlier draft of this section said I could not reproduce 26 and would not assert it wrong. Reading each title against its Rust body — not against its name — settles it (the full mapping is §B-12b, and the 26/25/3 arithmetic is at its end):

| | measured |
|---|---|
| `it()` titles in the two fences | 29 |
| titles that are ports of a Rust test | **26** |
| titles with no Rust antecedent | **3** |
| **distinct Rust tests ported** | **25** |

The declaration's sentence is *"Ports 26 of `files.rs`'s 65 tests"*. **Only 25 Rust tests are ported.** The 26 is the count of `it()` *titles*, and one Rust test (`download_acks_gate_the_window`) is ported by two of them — `emits begin, then exactly the 64-chunk window…` and `drops a download whose ack claims more chunks than were sent`. Both halves are in the same Rust test, so both are legitimate ports; the arithmetic is simply per-title, not per-Rust-test, and the sentence is written as if they were the same unit.

**And the split is composed wrongly, which is worse than a miscount.** The declaration names its three additions explicitly at `:5086-5111`. Measured, that set is wrong by two in each direction:

- It declares **`lists entries sorted directories-first, then name byte-wise`** and **`reports NOT_A_DIRECTORY when listing a file`** as *new*. Both are ports, and the **same declaration's ports sentence already counts them as ports**: `:5063-5065` reads *"Ports 26 of `files.rs`'s 65 tests — those covering the wire surface, the window, ack batching, resume alignment, cancel, idle, **and the three `list_*` tests**"*. The additions list — *"Three additions, each declared as new rather than counted as a port:"* at `:5086` — then names two of those three `list_*` titles (`:5100`, `:5104`) as additions rather than ports. So the task contradicts itself within one declaration — not at two "ports" call sites, but between its ports sentence and its additions list.
- The three titles that actually have no Rust antecedent are **`pins the idle timeout to the wire value`** (correctly declared new), **`appends the resume suffix as a sibling`** (`part_name` exists at `files.rs:68` but has no test of its own), and **`ignores a duplicate or regressive ack without erroring`** — and that last one inverts what the fence claims. The Rust states the rule in a **comment** at `files.rs:1502` (*"Duplicate/regressive acks are ignored, not errors (spec §2.4)"*) and **asserts it nowhere**: no Rust test sends a duplicate or regressive ack. `download_acks_gate_the_window` sends `ack("t-1", 21)`, which is *beyond*-sent, a different rule with a different outcome (`BAD_FRAME`, asserted at `files.rs:2776-2777`). So this title is a genuine **new assertion of a rule the Rust documented but never tested** — the strongest of the three, and the declaration does not mention it.

So the set of 3 must change by two in each direction, while 26 and 3 stay the right totals. **A count that is correct for the wrong partition cannot be repaired by adjusting the count**, which is why item 1 has to be the enumeration and not a re-arithmetic.

#### B-12a. Inside those 25: `files-delete` silently drops `recursive`, on a contract four artefacts already agree on

This is the reason B-12 is BLOCKING rather than a bookkeeping note. Task 11 implements twelve `dispatch` arms (`…plan-2-core.md:4527-4557`) and tests nine. **`files-mkdir`, `files-delete` and `files-rename` have zero test sites in the entire task** (`grep "type: 'files-mkdir'"` and its two siblings over 3,865–5,125 → 0), and `teardown()` — the documented "both slots cleared, any `.part` removed" entry point — is **never called by any test** either.

Under-tested is not by itself a divergence. One of the three is:

- **Rust** — `FilesDeleteRequest { request_id, path, recursive: Option<bool> }` (`files.rs:546-550`); `delete(path, recursive)` runs `remove_dir_all` when `recursive` is true, and returns `DIR_NOT_EMPTY` only when it is false (`files.rs:901-941`).
- **`packages/shared`** — `FilesDeleteRequest.recursive?: boolean` (`packages/shared/src/types/files.ts:160-164`).
- **Browser** — `delete(path, recursive = false)` puts `recursive` on the wire (`packages/file-core/src/client.ts:189-196`).
- **Plan 2's fence** — `remove()` never reads `message.recursive`; it always `rmdirSync` and maps `ENOTEMPTY` to `DIR_NOT_EMPTY` (`…plan-2-core.md:4979-5001`, with the deliberate-change comment at `:4973-4978`: *"`rm -r` is **not** offered"*).

So a browser that sends `{ type: 'files-delete', path: 'docs', recursive: true }` gets `DIR_NOT_EMPTY` from the port and a deleted tree from the Rust. **Four artefacts agree and only the fence disagrees**, which is exactly B-11's disposition: a repair to an owned contract, not an owner question.

**And the browser does not merely *carry* `recursive` — it is the only value it ever sends for a directory.** `DeleteConfirmDialog.vue` emits `props.isDirectory` as the `recursive` argument (`emit('confirm', props.isDirectory)`), `FilesView.vue:142-145` forwards it to `store.filesDelete`, and `stores/terminal.ts:1890` hands it to `client.delete(path, recursive)`. Its own copy says *"This is a directory. Deleting it removes its contents."* and the button reads **"Delete folder"**. `apps/web/src/__tests__/FilesView.test.ts:443` pins it: `expect(del).toHaveBeenCalledWith('tab-f1', 'docs', true)`.

So the divergence is not hypothetical for an unusual caller. **Clicking "Delete folder" in the shipped UI sends `recursive: true`, and the port would refuse it with `DIR_NOT_EMPTY` on a non-empty directory** — a user-visible regression in the single most common destructive action the file manager offers. That is what makes this a wire-contract repair rather than a preference, and it also constrains item 2 below: the flag cannot simply be dropped, because retiring it means changing what the browser's delete dialog promises.

The fence's comment reads as a considered security decision, and it is a *good* argument — a sandbox peer that can recursively delete a tree with one message is a real hazard. But it is an **undiscussed change to a wire contract**, presented as an implementation note, and it is invisible to the §9.4 gate for B-11's reason: **B43 is a count** (12 inbound / 11 outbound), and `recursive` is a field inside a message the count already counts.

**The owner ruled on 2026-10-22: honour `recursive` as the Rust does. The retirement path was considered and rejected.** This paragraph keeps that reasoning, because the option looked cheaper than it was and the reason it lost is the reason it will be proposed again.

The case for retiring was real. `rm -r` behind a one-message wire API is the most dangerous thing in the file-transfer surface: a peer holding a session id and a root-relative path can remove a whole tree in a single frame, and the plan's author reached for the restriction for exactly that reason. The case for honouring is what actually decided it:

- **The browser's button promises the deletion.** `DeleteConfirmDialog.vue` renders *"This is a directory. Deleting it removes its contents."* and a **"Delete folder"** label, and derives `recursive` from `props.isDirectory`. Retiring the flag in the agent does not make recursive deletion unavailable — it makes it *fail*, with `DIR_NOT_EMPTY`, after the dialog has already told the user the contents would go. The failure lands on the most common destructive action in the file manager, and it lands as a bug rather than as a restriction.
- **"Retire it" was never a one-file change.** It required an ADR, a `packages/shared` type change, a browser-side copy and behaviour change, and a `DeleteConfirmDialog.vue` edit — all in the same commit, because any subset leaves the artefacts disagreeing. The fence comment implied the restriction could be made unilaterally inside `remove()`. It could not.
- **The hazard is already bounded elsewhere.** `packages/shared` and the Rust both scope deletion to a configured sandbox root, and the root is refused at the offer. The recursive flag does not widen *what* can be reached; it only decides whether a non-empty directory can be removed within a tree the session may already delete. The security argument is real but it argues about the sandbox root, not about this field.

So the smaller-looking option cost more and broke a shipped UI promise, and the four-artefact agreement is the correct resolution. **This is why the repair is a fence repair and not a spec change**, and it is worth recording because a later reader who re-proposes the restriction will be re-proposing something that was argued and lost.

**What the repair has to do** (PM's lane, not mine):

1. Restate the 40's criterion so it is a real partition — or, better, **name all 65** in the declaration. §B-12b is that enumeration, ready to paste. At 65 rows it is one screen and it ends the class permanently.
2. **Implement `recursive` as the Rust does** (owner ruling, 2026-10-22 — no longer an open question). Task 11's `remove()` must read `message.recursive`, call `remove_dir_all` when it is true, and map `ENOTEMPTY` to `DIR_NOT_EMPTY` only when it is false; the deliberate-change comment at `…plan-2-core.md:4973-4978` must go, because it records a decision the owner did not take. `packages/shared` (`files.ts:160-164`), `packages/file-core/src/client.ts:189-196` and `DeleteConfirmDialog.vue` already carry the flag and need no change — the fence is the only artefact that has to move. **The implementation shape is settled, and it is a shape, not a one-liner — see §B-12d.** Because the flag now selects a destructive path, item 3's test sites for `files-delete` are the thing that makes this checkable rather than asserted: they must cover both polarities (`recursive: true` removing a non-empty directory, and `recursive: false` **or absent** returning `DIR_NOT_EMPTY`).
3. Add test sites for the three untested dispatch arms and for `teardown()`, and for the seven guards in the table above that the fence implements and no test trips. Item 3 is what makes items 1–2 checkable rather than asserted.
4. Re-derive the count. The 26 and the 3 are the right *totals* and the wrong *sets* (see above); §B-12b gives both.

#### B-12b. The enumeration the repair needs: all 65, each in exactly one bucket, plus the 26/3 re-derivation

Buckets: **A** ported · **B** not ported, stated reason true · **C** **gap** — no true reason. Totals: **A 25 · B 15 · C 25 · sum 65.**

> **Revised 2026-10-22** after PM re-derived the retire clause and I re-measured five rows against `files.rs`. Three rows moved **B → C** (6, 9, 29), one had its reason replaced while staying **B** (3), and one is confirmed **B** on a reason the declaration never gave (4). §B-12e records the retire-clause re-derivation name by name, including the two verdicts that are *correct* — an audit that reports five problems where two are not problems is uncalibrated, and the next reader discounts the other four.

| # | Rust test | `files.rs` | bucket | disposition |
|---|---|---|---|---|
| 1 | `total_chunks_matches_the_spec_arithmetic` | `:2322` | A | ported: counts the last partial chunk |
| 2 | `expected_chunk_len_is_full_except_the_last` | `:2331` | A | ported: returns a full chunk except the last |
| 3 | `chunk_base64_plus_envelope_stays_under_the_frame_cap` | `:2338` | B | not ported: **the artefact it frames is retired** — `Outbound::DownloadChunk`, the JSON base64 variant, is declared retired at `:5081`/`:8194` and the thin slice pumps `DownloadChunkBinary` (`files.rs:516`, ADR-36). The binary replacement's bound *is* asserted (`:3912-3924`, and the decode guard at `:4032-4035`). **The old reason — "pure arithmetic, no wire behaviour" — was false**: it asserts a frame length against `pty::MAX_FRAME_BYTES` (`:2353`), which is a wire cap. See §B-12c(e) for the inbound cap that genuinely is missing. |
| 4 | `error_code_spellings_are_pinned` | `:2357` | B | not ported, **on a reason the declaration does not give — and the reason I first gave was also wrong.** The verdict holds: the property is observable, and the browser enumerates the codes at runtime (`packages/file-core/src/client.ts:75-93`, a bare literal array in the `isFilesErrorCode` predicate; `:566-570` routes an unknown code to `BAD_FRAME`), and the two lists currently agree at **16**. But **not** because the `FilesErrorCode` union is a compile-time guard — it is not. A subset assignment to `FilesErrorCode[]` type-checks silently; only a **misspelling** is caught (`TS2820`), so the union proves spellings, never completeness. The shared "guard" tests overstate themselves (`packages/shared/test/file-types.test.ts:81-105` writes *"the union must accept exactly these twelve"* and then asserts `new Set(codes).size === 12` **on the array it just built**; `packages/shared/test/files-types.test.ts:40-48` asserts `toHaveLength(4)` **on the array it just built** — both vacuous at any union size), and `client.ts`'s array is untyped and untested, so a code added to the union **and** to `apps/web`'s `Record` but omitted from the array is invisible to `tsc` **and** to those tests. The true shape is a **14-of-16 Rust pin across two tests, neither ported**, against a TypeScript side that spells 16 of 16 — and is guarded, but by a *different* artefact one function away (`Record<FileClientErrorCode, string>` at `apps/web/src/lib/file-errors.ts:8`) than the one that decides wire behaviour (`isFilesErrorCode`) — see **§B-12f**. "Rust-internal helper / literal pin" is the wrong label, and so was my "the union makes a misspelling a `tsc` error": it catches misspellings, never omissions. |
| 5 | `rfc3339_formats_epoch_seconds_utc` | `:2380` | B | not ported: function is ported (`rfc3339Utc`, `:4060-4062`) and the wire **format** is guarded by a regex at `:4138`. **LOW, one line, not a row:** the four exact epoch→string pairs are not asserted, so the arithmetic is unguarded. |
| 6 | `decode_guard_never_errors_on_foreign_frames` | `:2388` | **C** | GAP: asserts a frame carrying `"channel": "terminal"` decodes to `Ok(None)` (`files.rs:590`). The plan has **no payload-level channel check** — `grep -cE "channel ===\|channel !==\|envelope"` over the whole plan → 15 hits, **none in the files path** (the 15 are Task 5's signal envelope, `:3227`'s pty slot, and two prose clauses). The plan's primary defence is the *transport* label (Task 18's `attach`, `:7284-7292`); the Rust's is the *payload* field. The two agree on a well-behaved peer and diverge on a hand-crafted frame. "Declared retired (`decode_*` guards)" is false: the behaviour is not implemented. **This is a hardening the port lost, not a defence** — see §B-12c(b). |
| 7 | `decode_guard_extracts_ids_for_attribution` | `:2415` | B | not ported: `decode_*` guard, declared retired |
| 8 | `decode_round_trips_every_browser_to_agent_type` | `:2433` | **C** | GAP: it is the **inbound field-name contract**, and it reaches only **7 of the plan's 12 shapes**. `FilesInbound` declares 12 (`files.rs:489-504`) and `decode_files_frame` has 12 arms (`:596-632`); this test omits `Mkdir`, `Delete`, `Rename`, `Pause`, `Resume`. The plan's own `mkdir`/`rename` read names the wire does not carry — `message.path`/`message.name` against `dir`/`name`, and `message.from`/`message.toPath`/`message.toName` against `oldPath`/`newPath`. See §B-12c(f), with the `message.<field>` counts and their positive controls. |
| 9 | `frame_files_wraps_the_envelope` | `:2484` | **C** | GAP, and it is the whole frame-to-wire boundary: asserts `value["channel"]=="files"`, `payload.requestId`, `truncated`, `timestamp` (`:2484-2501`). Measured over Task 11's span: `channel` → **0**, `timestamp` → **0** (positive control `requestId` → 8, `payload` → 21). `grep -cE "frame_files\|frameFiles"` over the whole plan → **1**, and that one hit is the retire clause's own prose. "Rust-internal helper / literal pin" is false — the browser is an observer. See §B-12c(a)/(b). |

| 10 | `error_frames_carry_the_code_and_attribution` | `:2503` | **C** | GAP: wire behaviour with no TS assertion |
| 11 | `path_policy_rejects_dotdot_escape` | `:2518` | B | not ported: Task 10 owns it |
| 12 | `path_policy_rejects_absolute` | `:2532` | B | not ported: Task 10 owns it |
| 13 | `path_policy_rejects_empty_components_and_dots` | `:2541` | B | not ported: Task 10 owns it |
| 14 | `path_policy_rejects_symlink_escape` | `:2553` | B | not ported: Task 10 owns it |
| 15 | `path_policy_rejects_prefix_confusion` | `:2572` | B | not ported: Task 10 owns it |
| 16 | `upload_create_path_validates_parent_and_name` | `:2593` | B | not ported: Task 10 owns it |
| 17 | `list_returns_entries_sorted_dirs_first` | `:2703` | A | ported: lists entries sorted directories-first, then name byte-wise |
| 18 | `list_on_a_file_is_not_a_directory` | `:2730` | A | ported: reports NOT_A_DIRECTORY when listing a file |
| 19 | `list_cap_truncates_at_4096_with_the_flag` | `:2740` | A | ported: truncates at the cap and sets the flag |
| 20 | `download_acks_gate_the_window` | `:2759` | A | ported: emits begin, then exactly the 64-chunk window, then waits for acks + drops a download whose ack claims more chunks than were sent |
| 21 | `download_assembles_byte_equal_content` | `:2789` | **C** | GAP: wire behaviour with no TS assertion |
| 22 | `empty_download_is_begin_then_end` | `:2814` | A | ported: completes an empty file with begin then end |
| 23 | `download_of_a_directory_is_not_a_file` | `:2832` | **C** | GAP: guard implemented, zero assertions (fence :4631) |
| 24 | `oversize_size_is_rejected_by_the_pure_guard` | `:2842` | **C** | GAP: guard implemented, zero assertions (fence :4632 / :4705) |
| 25 | `upload_happy_path_writes_the_file_and_cleans_the_part` | `:2861` | A | ported: writes the file and removes the .part on success |
| 26 | `empty_upload_finalizes_an_empty_file` | `:2895` | **C** | GAP: wire behaviour with no TS assertion |
| 27 | `upload_into_a_missing_directory_is_not_found` | `:2911` | **C** | GAP: guard implemented, zero assertions (fence :4707 + resolveParentForCreate) |
| 28 | `upload_of_an_existing_name_is_already_exists` | `:2926` | A | ported: refuses a name that already exists |
| 29 | `stale_part_is_removed_and_retried_once` | `:2939` | **C** | GAP: **the recovery is implemented and no test exercises it.** The plan's `beginUpload` opens the `.part` with `'wx'` and, on `EEXIST`, unlinks and retries once (`:4714-4720`) — that *is* the Rust's behaviour. What no test does is **begin over a stale `.part`**: measured, `stale` occurs **3** times in the production fence and **0** in the test fences; the three `.part`-touching tests are `writes the file and removes the .part on success` (`:4211`), `requires the .part length to equal the resume offset exactly` (`:4310`) and `removes the .part file and stops the upload` (`:4359`), and **none of them starts from a pre-existing `.part`**. "Per-platform filesystem race / janitor" is the wrong reason: the Rust's own comment (`:2940`) calls it *"not an error (spec §6.1)"* — a specified recovery, not a race. |
| 30 | `upload_end_before_the_last_chunk_is_bad_frame` | `:2958` | A | ported: rejects upload-end before the last chunk |
| 31 | `chunk_with_the_wrong_index_is_bad_frame` | `:2978` | A | ported: rejects a chunk with the wrong index |
| 32 | `upload_ack_stream_is_cumulative` | `:2989` | A | ported: batches acks, flushing on the 16th chunk |
| 33 | `chunk_for_an_unknown_id_is_transfer_unknown` | `:3019` | **C** | GAP: guard implemented, zero assertions (fence :4754 / :4829 / :4892 / :4900 / :4926) |
| 34 | `chunk_length_mismatch_is_bad_frame` | `:3028` | **C** | GAP: guard implemented, zero assertions (fence :4761) |
| 35 | `upload_totals_changed_mid_flight_is_bad_frame` | `:3045` | **C** | GAP: guard implemented, zero assertions (fence :4757) |
| 36 | `finalize_race_losing_path_is_file_exists` | `:3058` | B | not ported: per-platform filesystem race / janitor |
| 37 | `a_second_transfer_in_the_same_direction_is_busy` | `:3079` | A | ported: refuses a second download in the same direction |
| 38 | `busy_is_checked_after_the_path_checks` | `:3106` | **C** | GAP: wire behaviour with no TS assertion |
| 39 | `a_completed_download_frees_the_slot` | `:3122` | **C** | GAP: wire behaviour with no TS assertion |
| 40 | `cancel_stops_the_download_and_removes_the_state` | `:3152` | **C** | GAP: wire behaviour with no TS assertion |
| 41 | `cancel_of_an_upload_removes_the_part_file` | `:3170` | A | ported: removes the .part file and stops the upload |
| 42 | `cancel_for_an_unknown_id_is_idempotent` | `:3187` | A | ported: is idempotent for an unknown id and emits no error |
| 43 | `idle_timeout_kills_a_stalled_transfer` | `:3196` | A | ported: kills a stalled transfer at the idle timeout |
| 44 | `idle_timeout_removes_a_stalled_uploads_part` | `:3227` | **C** | GAP: wire behaviour with no TS assertion |
| 45 | `teardown_clears_both_directions` | `:3244` | **C** | GAP: code implemented, zero test sites (`teardown()` :5043: 0 call sites) |
| 46 | `root_resolution_fails_when_missing_not_a_dir_or_unreadable` | `:3258` | B | not ported: Task 10 owns it |
| 47 | `test_binary_frame_roundtrip` | `:3384` | A | ported: round-trips through the 25-byte header |
| 48 | `test_binary_frame_truncated_header` | `:3404` | A | ported: rejects a truncated header |
| 49 | `test_mkdir_delete_rename_sandbox` | `:3411` | **C** | GAP: code implemented, zero test sites (`files-mkdir` / `files-delete` / `files-rename`: 0 test sites) |
| 50 | `test_binary_frame_max_payload_decodes` | `:3451` | A | ported: accepts a payload of exactly the cap |
| 51 | `test_binary_frame_oversized_payload_rejected` | `:3467` | A | ported: rejects a payload above the chunk cap |
| 52 | `test_rename_root_rejected` | `:3478` | **C** | GAP: code implemented, zero test sites (`files-rename`: 0 test sites) |
| 53 | `test_rename_destination_existing_rejected` | `:3488` | **C** | GAP: code implemented, zero test sites (`files-rename`: 0 test sites) |
| 54 | `test_error_code_str_mapping` | `:3506` | B | not ported — **but not an "internal helper / literal pin": it is the second half of a wire-contract pin.** It asserts `RESUME_INVALID` and `QUEUE_FULL` (`:3505-3509`), which with `error_code_spellings_are_pinned`'s 12 makes **14 of 16**; the whole point of its two codes is that the browser switches on them. Verdict stays B (the browser's list agrees today); the label was wrong. See §B-12f. |
| 55 | `test_pause_and_resume_alignment_check` | `:3518` | A | ported: requires the .part length to equal the resume offset exactly |
| 56 | `test_janitor_cleans_stale_part_files` | `:3547` | B | not ported: per-platform filesystem race / janitor |
| 57 | `test_transfer_id_codec_roundtrips_dashed_uuid` | `:3582` | B | not ported: Rust-internal helper / literal pin — **this label is correct here**, and the contrast with row 54 is the point: ids are plain UUID strings on the wire, so nothing outside the module observes the codec |
| 58 | `test_transfer_id_to_16_matches_client_uuidtobytes` | `:3591` | A | ported: encodes the id as 16 raw UUID bytes, not ASCII |
| 59 | `test_binary_upload_chunk_with_dashed_uuid_is_accepted` | `:3607` | A | ported: decodes an upload frame as type 0x02 |
| 60 | `resume_approved_after_upload_pause` | `:3652` | **C** | GAP: wire behaviour with no TS assertion |
| 61 | `resume_rejected_on_part_size_mismatch` | `:3701` | A | ported: answers an unapproved resume with a resume-ack, never an error frame |
| 62 | `download_pause_ack_reports_acked_chunk_index` | `:3731` | **C** | GAP: wire behaviour with no TS assertion |
| 63 | `download_resume_seeks_and_pumps_from_resume_point` | `:3762` | **C** | GAP: wire behaviour with no TS assertion |
| 64 | `paused_download_absorbs_acks_without_repumping` | `:3809` | **C** | GAP: wire behaviour with no TS assertion |
| 65 | `paused_state_survives_idle_timeout` | `:3834` | A | ported: paused transfers do not time out |

**The 26/3 re-derivation.** The declaration's totals are right; its sets are not.

| | measured |
|---|---|
| `it()` titles across the two fences | 29 |
| titles that port a Rust test | **26** |
| titles with no Rust antecedent | **3** |
| distinct Rust tests reached by those 26 titles | **25** |

`download_acks_gate_the_window` is the one Rust test ported by two titles — `emits begin, then exactly the 64-chunk window, then waits for acks` and `drops a download whose ack claims more chunks than were sent` — which is why 26 titles reach only 25 Rust tests. **The declaration's sentence "Ports 26 of `files.rs`'s 65 tests" is therefore off by one in the unit it names**: 26 titles, 25 tests. The honest sentence is *"25 of `files.rs`'s 65 tests, asserted by 26 of the 29 `it()` titles"*.

The declaration's **three additions** (`:5086-5111`) need replacement, not adjustment:

| declared as new | actually | evidence |
|---|---|---|
| `pins the idle timeout to the wire value` | **new** ✓ | N-3b: the Rust comment at `:40-45` claims an assertion that does not exist |
| `lists entries sorted directories-first, then name byte-wise` | **a port** — already counted among *"the three `list_*` tests"* by the ports sentence at `:5063-5065` | `list_returns_entries_sorted_dirs_first` |
| `reports NOT_A_DIRECTORY when listing a file` | **a port** — same ports sentence, same three `list_*` tests | `list_on_a_file_is_not_a_directory` |
| — | **missed, genuinely new**: `ignores a duplicate or regressive ack without erroring` | Rust states the rule in a **comment** at `files.rs:1502` and asserts it in no test; `download_acks_gate_the_window`'s `ack("t-1", 21)` is the *beyond*-sent rule, a different one with a different outcome |
| — | **missed, new in form**: `appends the resume suffix as a sibling` | `part_name` (`files.rs:68`) has no test of its own; the suffix is only asserted incidentally |

So the "new" set is really: 1 port-turned-new (`ignores a duplicate or regressive ack…` is new *assertion*, of a documented-but-untested rule), 1 new-in-form (`appends the resume suffix…`), 1 truly new (`pins the idle timeout…`) — and two items must come out of the "new" list because the same declaration already counts them as ports.

**Why this section exists at all.** B-12's finding is that a declaration's *criterion* failed. A repaired criterion can fail the same way, at 65 rows, and no test can see it. This table is the repair that cannot fail that way: every row names one Rust test and one disposition, and the three counts close arithmetically (**25 + 15 + 25 = 65**). The recipe that regenerates it is §10.

**How the totals moved, and why the first version was low.** The initial bucket assignment was **25 / 18 / 22**, and it inherited the retire clause's own categories — which is precisely the error B-12 prosecutes in the plan. PM re-derived the clause name by name (§B-12e) and I re-measured each disputed row against `files.rs`; three rows were **B → C** and the gap count went **22 → 25**. The direction is the tell: a criterion copied forward produces *fewer* gaps, never more. Any future revision of this table must re-derive from the Rust bodies, not from the previous table.

**QA's number, reconciled.** QA's "46 of 65 are not named" is close to the measured 45 under one scope (whole Task 11: 10 names appear, 55 absent) and the 45 under the other (declaration tail: 7 exact + 13 by wildcard, 45 unnamed) — the two scopes differ by 10 and QA picked neither explicitly. The *claim* QA attributes to the plan is not in it. But QA identified the right file, the right task and the right class, and the defect it pointed at is real once the criterion is read instead of the paraphrase. That is worth more than the wording it arrived in.

#### B-12c. `FilesSession` has no owner for the frame-to-wire boundary and no lifecycle owner — six consequences, all measured

> **Raised by PM 2026-10-22 (two amendments), widened by QA independently, every citation re-verified here.** Severity: **BLOCKING for Task 11 and Task 18.** This is the reason row 9 of §B-12b is bucket **C**, and it is why "22 gaps" was an undercount — the revised count is **25**.

An enumeration cannot report an absence it is not looking for. The 65-row table asks *"is this Rust test ported?"* and every row it **C**-marked answers a yes/no question about a behaviour. The defect below is a different kind: the behaviours exist in the fence, are correct in isolation, and **nothing connects them to a wire**. None of the 65 rows could have found it, because there is no Rust test whose absence is the symptom — the Rust tests it would have added are rows 9 and 6, and the rest is *wiring* that in Rust lives in `lib.rs` and here lives in no task.

**(a) No envelope outbound.** The plan's `list()` returns a flat frame (`…plan-2-core.md:4617-4624`): `requestId`, `path`, `entries`, `truncated` are **siblings of `type`**. The Rust builds a `DataChannelMessage` envelope in `frame_files` (`files.rs:660-682`): `{ r#type, channel: FILES_CHANNEL, payload, timestamp }`. Measured over Task 11's span (3861-5125): `channel` → **0**, `timestamp` → **0**, with positive controls in the same span — `requestId` → **8**, `payload` → **21**, `envelope` → **1** (that one is the retire clause's prose). `grep -cE "frame_files|frameFiles"` over the entire plan → **1**, and it is the same prose clause.

**What breaks, and how loud — and a correction, because "how loud" was the part I got wrong.** `packages/file-core/src/client.ts:546-551` reads `msg.payload.requestId` with **no guard** — the second line is `const pending = this.pendingLists.get(payload.requestId)`. Against a flat frame, `msg.payload` is `undefined`, so the read throws `TypeError: Cannot read properties of undefined`. **But the throw does not reach the caller.** `webrtc-core` opens a `try` **before** the typed-handler loop and closes it with a bare `catch {}` (`packages/webrtc-core/src/data-channel.ts:35-44`), so a handler throw is swallowed exactly as a JSON parse failure would be, the remaining handlers for that message are skipped, and the browser's `list()`/`mkdir()`/`delete()` promise **never settles** — no resolve, no reject, no `FilesError`. QA measured this end-to-end against the real `FileClient`. My first draft called it a crash; the truth is worse to attribute and not worse to survive: a **silent non-settling promise**, where every files call hangs and nothing in the console says why. And the fence suite goes green over it, because every fence builds and asserts its own flat object (`:4128` asserts `result.type === 'files-list-result'` on a flat frame) and **never crosses the boundary**.

**(b) No envelope unwrap inbound.** The router parses and hands the whole message straight to the session (`:7312-7324`), and `dispatch` switches on `message.type` directly (`:4527-4529`). The browser sends `{ channel, type, payload, timestamp }` (`packages/webrtc-core/src/data-channel.ts:74-86`, `sendJson`, for every channel), so **every field the session reads is nested one level down**: `message.path` is `undefined`, and `list()` resolves an empty listing for every request. The Rust unwraps explicitly (`files.rs:587-591`) **and then** drops a misfiled frame with `if envelope.channel != FILES_CHANNEL { return Ok(None) }`.

**The one thing I will not claim, and a correction to my own first draft of it.** The browser emits `channel` (it is `sendJson`'s job, unchanged) and **never reads it inbound**: `file-core`'s `handleMessage` destructures `{ type, payload }` and switches on `msg.type` (`client.ts:546-548`), and `webrtc-core` dispatches typed handlers **by the registered label**, not by the payload's `channel` field (`data-channel.ts:23-45`, which validates `parsed.type` only, at `:33-36`). So the Rust's `envelope.channel != FILES_CHANNEL` guard is a *hardening*, not a contract the browser honours.

**My first draft of this paragraph was wrong in two ways, and PM caught both** (2026-10-22). I had cited `files.rs:2359` for the comment *"The spellings are a wire contract — the browser switches on them"*, and had used it as evidence about the **channel guard**. It is at **`files.rs:2358`**, and it belongs to **`error_code_spellings_are_pinned`** — it is about `FilesErrorCode` **spellings**, not about `channel`. Worse, its claim is **true**: the browser really does switch on the spellings — `packages/file-core/src/client.ts:75-91` is a literal array in the `isFilesErrorCode` type predicate, and `:566-570` routes an unknown code to `BAD_FRAME`. So that comment cannot be used against the ADR-09 half. The evidence for the ADR-09 half is the **dispatch code**, not a comment: `data-channel.ts:33-36` reads `parsed.type` and nothing else.

**What row 6's gap therefore is, stated correctly.** It is **not** "a defence the port lost". It is **a hardening the port lost**: the only frames `envelope.channel != FILES_CHANNEL` could ever have dropped are **hand-crafted** — no client can produce one. But the loss is still real and still observable: a foreign frame now reaches `dispatch` and is **answered** (the plan's `default:` arm returns `[]` at `:4554-4555`, the Rust's returns `Ok(None)`), so a misfiled frame is silently swallowed rather than explicitly dropped. Row 6 stays bucket **C**, and the reason is now "a hardening the port lost" instead of "a defence the port lost".

**(c) No timers, so two of the task's own constants can never fire.** `grep -nE "setInterval|setTimeout|clearInterval"` over the whole plan → **three** hits: `:2074` (a sleep helper), `:5516` and `:5521` (test sleeps). There is no production timer. The Rust has two, both in one `tokio::select!` (`lib.rs:1852-1858`, driven by the arms at `:1890` and `:1898-1899`): `idle_tick` at 1 s and `ack_tick` at `ACK_FLUSH_INTERVAL`. The plan's `FILES_IDLE_TIMEOUT_MS` (`:3964`) and `ACK_FLUSH_INTERVAL_MS` (`:3965`) are therefore **unreachable** — a transfer that stalls never times out, and a low-rate upload never acks. `checkIdle()` (`:4507`), `flushAcks()` (`:4523`) and `dispose()` (`:4958`) have **no caller outside a fence**; `dispose()`'s only caller is `teardown()` (`:5044`), which is itself only used by a fence.

**(d) `deps.send` is declared, consumed, and never implemented — and that is why (a)–(c) survived review.** `grep -cE "function send|const send =|send: \(label"` over the plan → **0**. `RouterDeps.send` is declared at `:7240` and consumed at `:7362` (`emit()`); the only supplier anywhere in the document is `send: vi.fn()` in fences (Task 19's fixture, `:7599`; Task 18's, `:7062`). The single production construction site is `:7068`: `new DataChannelRouter(deps as never)`. **The document carries 55 `as never` casts**, so a missing producer is invisible to `tsc` — and the plan names this class itself, at Task 12's `:5457`: *"No `as never` casts: the seam's overloads are what make this typecheck."* The rule is stated in one task and violated 55 times across the document.

**(e) The inbound frame cap has no counterpart.** `pty::MAX_FRAME_BYTES` bounds every inbound frame in Rust, checked **before** serde (`pty.rs:154-155`, `:182-183`, `:203-204`, `:223-224`, `:243`) and again in `decode_files_frame` (`files.rs:580-585`). The plan declares `MAX_FRAME_BYTES = 64 * 1024` at `:5333` — **and that is its only occurrence in the whole document**, no files-path caller anywhere. `parseJson(bytes)` (`:7315`) has no length check, so an oversize frame is parsed, not refused.

**A correction to PM's framing of this one, since it was offered as "declared and consumed by nothing".** The other two constants in that module are not unconsumed, and repeating "nothing reads it" would be the very error this audit prosecutes. `MAX_DATA_CHANNEL_FRAME_BYTES` is declared at `:1156`, imported and re-exported at `:1083`, and **asserted at `:1105`** (`expect(MAX_DATA_CHANNEL_FRAME_BYTES).toBe(64 * 1024)`) — declared, exported, and pinned by a test. `MAX_INBOUND_FRAME_BYTES` is stronger still: declared `:1154`, imported `:1084`, asserted `:1101`, and **actually enforced** at `:1320-1321` (`if (raw.length > MAX_INBOUND_FRAME_BYTES) throw new InboundParseError(…)`) — on the **signalling** path. So the true statement is narrower and should replace the wider one: **`MAX_DATA_CHANNEL_FRAME_BYTES` is the one that is pinned by a test and enforced nowhere**, and **none of the three is consulted on the files path** — the enforcement at `:1320` is signalling-only. Worded as "consumed by nothing" the claim would have been false for two of the three and a reviewer would have found it in one grep; worded as "pinned by a test and enforced nowhere" it is exactly right about the one that matters, and it is the same class as `MAX_FRAME_BYTES` at `:5333`.

This is the honest successor to row 3's old reason: what `chunk_base64_plus_envelope_stays_under_the_frame_cap` guarded does still need a counterpart in the port, just on the **inbound** side and via the binary path's cap rather than the retired JSON variant's.

**(f) There is no inbound field-name contract either, and the one Rust test that partially supplies it reaches 7 of 12 shapes.** This is the consequence PM's reviewer round sharpened, and it is the same shape as (a)/(b): the session reads field names the wire does not carry. `FilesInbound` declares **12** variants (`files.rs:489-504`) and `decode_files_frame` has **12** arms (`:596-632`), while `decode_round_trips_every_browser_to_agent_type` (`:2432-2481`) asserts **7** — it omits `Mkdir`, `Delete`, `Rename`, `Pause`, `Resume`. The plan's handlers then read names that exist only in the Rust struct's *Rust* spelling:

| handler | plan reads | wire carries (Rust struct / shared type) |
|---|---|---|
| `mkdir` (`:4967-4972`) | `message.path`, `message.name` | `request.dir`, `request.name` (`files.rs:536-541`; `shared/types/files.ts:154-158` `FilesMkdirRequest{dir,name}`) |
| `rename` (`:5003-5009`) | `message.from`, `message.toPath`, `message.toName` | `request.old_path`, `request.new_path` (`files.rs:553-559`; `shared/types/files.ts:166-170` `FilesRenameRequest{oldPath,newPath}`) |

Measured over the whole plan with a positive control in the same invocation — `message.<field>` counts: `transferId` **10**, `path` **6**, `requestId` **3**, `direction` **3**, `name` **2**, and `from`/`toPath`/`toName` **1 each** (the rename handler); against `oldPath` **0**, `newPath` **0**, `dir` **0**, `recursive` **0**. The browser sends the wire names (`packages/file-core/src/client.ts:181` `{ requestId, dir, name }`, `:209` `{ requestId, oldPath, newPath }`, `:194` `{ requestId, path, recursive }`), so `String(message.path ?? '')` is `''` and `String(message.toName)` is `'undefined'` — a mkdir that resolves `''` + `'undefined'` inside the root, and a rename from the **root** to `'undefined'`. Row 8 is bucket **C** for this, not for a generic "wire behaviour with no TS assertion", and PM's first framing of row 8 ("the guard for this exact defect") was too generous: it is a 7-of-12 guard.


**The two tests that restore (a) and (b), both in Task 11, neither writable against a flat object:**

1. **Outbound.** Take the session's output, wrap it in the real envelope `{ channel: 'files', type, payload, timestamp }`, push it through the **actual** `FileClient` from `packages/file-core`, and assert the client's promise resolves. This is `frame_files_wraps_the_envelope` (`files.rs:2484-2501`) in its TS form: `frame.channel === 'files'`, `frame.type`, `frame.payload.requestId`, `frame.payload.truncated`, `frame.timestamp`.
2. **Inbound.** Take a frame **from** `FileClient` — so it passes through `data-channel.ts:74-86`'s real `sendJson` — and assert the ported session reads `payload.path` correctly.

**And the timer owner, which is a plan repair not a test.** Task 19 is titled *"Runtime lifecycle and the desktop session loop"* (`:7398-7414`) but its Interfaces name only `DesktopSession`, `resolveDefaultSource`, `AgentRuntime`, `createAgentRuntime` — **no files ticker**. Its own prose delegates timing elsewhere: *"The caller drives this at the profile's frame interval (Task 18's runtime ticker does)"* (`:7955-7960`). Task 18's runtime ticker does not own a files ticker either. So `checkIdle`/`flushAcks` need a named owner with **two** periods, exactly as Rust has two — 1 s and 20 ms — and a task that drives only the frame interval is not it.

#### B-12d. The ack is two operations in Rust and one in the plan, and `endUpload` drops a frame

> **Raised by PM 2026-10-22, revising their own earlier "force-flush" wording.** Severity: **BLOCKING for Task 11** — the 20 ms tick is a no-op as written, so fixing (c) alone would not restore the behaviour.

**The Rust separates *when* from *what*; the plan collapses both into one function.**

| | Rust | plan |
|---|---|---|
| predicate | `fn note_chunk(&mut self) -> bool` (`files.rs:1165-1172`) — the 16-chunk-or-20 ms test, **does not consume** | `private noteChunk(): void` (`:4806-4810`) — sets `pendingAck` and returns nothing |
| take | `fn take_pending_ack(&mut self) -> Option<u64>` (`:1173-1180`) — unconditional, advances `last_acked`/`last_ack_time` | `pendingAckFrame(): FilesFrame[]` (`:4812-4824`) — **re-applies the predicate**, then takes |
| chunk path | `if state.note_chunk() { flush_upload_ack() } else { Vec::new() }` (`:1651-1656`) | calls `pendingAckFrame()` (`:4736`, `:4788-4789`, `:4802-4803`) |
| tick path | `flush_upload_acks()` → `take_pending_ack()`, **no predicate** (`:1898-1899` → `:1717-1719`) | `flushAcks()` → `return this.pendingAckFrame()` (`:4524`) — **same predicate as the chunk path** |

The consequence is exact: `flushAcks()` re-evaluates the gate the chunk path just evaluated, so **the 20 ms tick changes nothing**. A low-rate upload — the case the tick exists for — still waits for the 16th chunk. And because `noteChunk()` returns `void`, the predicate exists in no function at all.

**Required shape:** `noteChunk(): boolean` (predicate, no state consumption beyond `pendingAck`); `takePendingAck(): FilesFrame[]` (unconditional take, advances `lastAcked` and `lastAckAt`); chunk path `if (this.noteChunk()) return this.takePendingAck();`; `flushAcks()` returns `this.takePendingAck()`.

**State the clock, or a later "simplification" changes behaviour no fence can see.** The Rust's predicate reads `last_ack_time.elapsed()` — monotonic, advanced **only** in `take_pending_ack` (`:1178`). The plan uses `this.now() - state.lastAckAt` on the injected clock (`:4492`, driven from the tests at `:4340`, `:4351`). Keeping the injected clock is the right call and makes the 20 ms branch testable without sleeping; the amendment must say that **the predicate and `takePendingAck` share one clock**, so a refactor cannot move one of them onto `Date.now()` and leave the other injected.

**Cost is low.** `ACK_FREQUENCY_CHUNKS = 16` (`:3964`) and `ACK_FLUSH_INTERVAL_MS = 20` (`:3965`) already exist and are already imported by the Task 11 tests (`:4399-4400`). This is a shape fix, not a new dependency.

**`endUpload` drops a frame.** The plan returns exactly `[{ type: 'files-upload-complete', … }]` (`:4829-4841`); the Rust returns `vec![final_ack, complete]` (`files.rs:1729-1734`) — **the final ack precedes `files-upload-complete`**, and it carries `next_chunk_index`. Dropping it means the browser's last ack accounting never closes: it has sent N chunks and received no ack for the tail. Add: final ack first, then complete.

#### B-12e. The retire clause, re-derived name by name — including the two verdicts that are correct

> **Raised by PM 2026-10-22.** The clause at `…plan-2-core.md:5066-5072` retires 39 tests as *"Rust-internal helpers (…) or per-platform filesystem races"*. A category that has already been shown to admit a false member cannot be inherited; each name in it was re-derived against its Rust body.

| retired name | verdict |
|---|---|
| `frame_files_wraps_the_envelope` (`files.rs:2484-2500`) | **PORT GAP** — asserts `channel`, `payload` nesting, `timestamp`; nothing else asserts the envelope. Row 9. |
| `decode_guard_never_errors_on_foreign_frames` (`:2388-2412`) | **GAP — the ADR-09 drop is lost.** It asserts a frame with `"channel": "terminal"` decodes to `Ok(None)`; the plan has no payload-level channel check anywhere in the files path. Row 6. |
| `stale_part_is_removed_and_retried_once` (`:2939`) | **GAP** — recovery implemented at `:4714-4720`, and no test begins over a stale `.part` (`stale` → 3 prod / **0** test). Row 29. |
| `chunk_base64_plus_envelope_stays_under_the_frame_cap` (`:2338`) | **NOT A GAP, but the stated reason is false.** "Pure arithmetic, no wire behaviour" is wrong — it asserts `frame.len() < pty::MAX_FRAME_BYTES` (`:2353`). The *artefact* it frames is retired (`:5081`, `:8194`; ADR-36). Row 3 stays **B** on a corrected reason, and the genuinely missing inbound cap becomes §B-12c(e). |
| `rfc3339_formats_epoch_seconds_utc` (`:2380`) | **LOW.** Function ported (`rfc3339Utc`, `:4060-4062`); the wire *format* is guarded by a regex (`:4138`); the four exact epoch→string pairs are not, so the arithmetic is unguarded. One line, not a row. |
| `error_code_spellings_are_pinned` (`:2357-2375`) | **CORRECT to retire**, **on a reason that is neither the declaration's nor my first one.** The declaration says "Rust-internal helper / literal pin"; my first draft said "the `FilesErrorCode` union turns a misspelling into a `tsc` error", which is true only of misspellings and false of omissions. The retirement is legitimate for a different reason: the browser enumerates all 16 spellings at runtime (`client.ts:75-94`) and routes an unknown one to `BAD_FRAME`, so a divergence is observable and guarded — today. What is **not** guarded is completeness on either side; §B-12f measures that (14 of 16 pinned in Rust, and the TS "guard" test is vacuous). Row 4 stays **B**. |
| `test_transfer_id_codec_roundtrips_dashed_uuid` (`:3582`) | **CORRECT to retire.** Codec helper; ids are plain UUID strings on the wire; every fence's `ID`/`ID2` fixture is a dashed UUID. |

**The pattern, stated once because it now holds three times: a pin that never grew when its enum did.** `error_code_spellings_are_pinned` pins 12 of 16 spellings (14 counting `test_error_code_str_mapping`); `decode_round_trips_every_browser_to_agent_type` pins 7 of 12 `FilesInbound` shapes; the TS `round-trips every FilesErrorCode spelling` pins "12" with a vacuous assertion against a 16-member union. Each is a completeness claim written when the set was smaller, never revised, and never noticed — because a literal table that omits a member looks exactly like one that does not. All three are in code the port re-implements or depends on, which is why this is one pattern worth naming rather than three footnotes: **an enumeration-shaped test is only as good as the day it was written, unless something fails when the enumeration grows.**

**Why the correct verdicts are recorded rather than omitted.** An audit that re-derives a clause and reports seven problems where two are not problems reads as uncalibrated, and the next reader discounts its other five. The distinguishing question is sharper than "does it test a helper": **can anything outside the module observe the property the test asserts?** For the envelope, yes — the browser. For the error-code strings, yes — but the *type system* does not guard it, and believing it did was my error; §B-12f settles what actually does. For transfer ids, no. That question is what separates rows 3/4 (B on a bad reason) from rows 9/6/29 (C), and it is why "Rust-internal helper" cannot be applied by pattern.

#### B-12f. Two lists of the same 16 wire codes, one typed and enforced, one bare and unverified

> **Raised by PM 2026-10-22, corrected by PM three times, and re-derived here against every artefact.** This is row 4's real shape. It is **not** a 12-vs-16 discrepancy — that number appeared in an earlier draft of row 4 and was wrong in both halves.

**The thesis: two independent lists of the same 16 wire codes, and only one of them is enforced.** The Rust spells **14 of 16** codes and its pins are **non-vacuous** — each is asserted against `as_str()`. TypeScript spells **16 of 16** in two places, and the two places are **not related to each other by anything in the type system**: one is an exhaustive `Record` (typed, gating, in `apps/web`), the other is a **bare literal array** (untyped, untested, in `packages/file-core`) — and the bare one is the one that decides wire behaviour. A reviewer reading `Record<FileClientErrorCode, string>` is right to trust it, and wrong to extend that trust one function down.

**The Rust side, measured.** Two tests together pin **14** of the enum's **16** spellings:

| test | codes pinned | count |
|---|---|---|
| `error_code_spellings_are_pinned` (`files.rs:2357-2375`) | `PathOutsideRoot` … `BadFrame`; asserts `cases.len() == 12` | **12** |
| `test_error_code_str_mapping` (`files.rs:3505-3509`) | `ResumeInvalid` → `RESUME_INVALID`, `QueueFull` → `QUEUE_FULL` | **2** |

The two pinned by **no** test are `DIR_NOT_EMPTY` and `PERMISSION_DENIED` — both Week-11 additions, under the comment at **`files.rs:179`**: `// Week 11 additions (spec §3.4, packages/shared/src/types/files.ts):`. That comment names exactly the four codes the pin in the same file was never extended to cover, and the pin that should have covered them starts **2,178 lines later in the same file** (`:2357`) — which is the whole argument for why "the comment says wire contract" is not a guard.

**And the agent does emit three of the four in production**, so none of them is "a code no agent produces": `PermissionDenied` at `files.rs:905`, `:913`, `:967`; `DirNotEmpty` at `:938`; `ResumeInvalid` at `:1019`, `:1026`. Only `QueueFull` is `#[allow(dead_code)]`, carrying *"the agent never produces this code itself — it is mirrored from the shared types for completeness."* (PM's first framing here was "four codes are TS-only / that no agent emits", and that was wrong in both halves; the enum declares all 16 at `:166-187`, with `as_str()` spelling all 16 at `:190-209`.)

**The TypeScript side, measured — and here the count is 16 of 16, not 12.** PM's earlier count of "12" came from reading one test file. There are two, and between them they spell every code:

| artefact | count | note |
|---|---|---|
| Rust enum | **16** | `files.rs:166-187`; `as_str()` arms `:190-209` |
| Rust wire-spelling pins | **14** | split **12 + 2** across the two tests above; `DIR_NOT_EMPTY` and `PERMISSION_DENIED` unpinned |
| TS union | **16** | `packages/shared/src/types/files.ts:98-114` |
| TS shared test, half 1 | **12** | `packages/shared/test/file-types.test.ts:81-105` — the twelve originals, 1 each, **0** of the four Week-11 codes |
| TS shared test, half 2 | **4** | `packages/shared/test/files-types.test.ts:40-48` — exactly `RESUME_INVALID`, `DIR_NOT_EMPTY`, `PERMISSION_DENIED`, `QUEUE_FULL`, **0** of the other twelve |
| TS browser `isFilesErrorCode` | **16** | `packages/file-core/src/client.ts:75-93`, a **bare literal array**, not typed against the union |

Counted as literals in both files, with a non-code string as the control (→ 0 in both): `file-types.test.ts` holds the twelve originals and **none** of the four Week-11 codes; `files-types.test.ts` holds exactly those four and **none** of the other twelve. **Union = 16 of 16; no code is unspelled.** So the defect is **not** an omission from the union.

**The union IS exhaustively checked — and that is the part PM got backwards, and I nearly wrote down.** There **is** an exhaustive guard, and it has been there since Week 11: `apps/web/src/lib/file-errors.ts:8` declares `export const FILE_ERROR_TEXT: Record<FileClientErrorCode, string> = { … }` with **17** keys (`FileClientErrorCode` = the 16 wire codes **+** `CANCELLED`). `Record<Union, V>` is exhaustive **by construction** — a missing key is `TS2741`. PM's control grep returned `Record<FileClientErrorCode` → **1**, and he read that hit as evidence of *absence*, when it was the *fix already in place*: the check is written against `FileClientErrorCode`, not `FilesErrorCode`, so the pattern he searched for (`Record<FilesErrorCode`) could not see it. **A positive control read backwards is still a misread**, and it is the second time in this audit that a "0 hits" claim has had to be corrected in the other direction.

**The two shared test assertions are decorative, and that is a separate, smaller fact.** `expect(new Set(codes).size).toBe(12)` (`file-types.test.ts:98`) is computed **from the 12-element array two lines above it**, and `expect(errors).toHaveLength(4)` (`files-types.test.ts:47`) is computed **from the 4-element array two lines above it**. Each passes at any union size, and the comment on `:96` — *"A compile-time guard: the union must accept exactly these twelve"* — describes something the code does not check. These are vacuous, and they run in the `continue-on-error` step, so they are never a gate. But they are **not** the hole, because the real guard is the `Record` above.

**Where each change lands, in the four cases that matter:**

| a code is… | where it lands | verdict |
|---|---|---|
| **misspelled** | `tsc` in `packages/shared` — `ci-node.yml:86`, gating | **red** (`TS2820`) |
| **added to the union only** | `vue-tsc` in `apps/web` — `ci-node.yml:86`, gating — via the `Record` at `file-errors.ts:8` | **red** (`TS2741`) |
| **added to the union *and* to the `Record`, but missing from `isFilesErrorCode`** | nothing catches it | **green — and the wire degrades to `BAD_FRAME`** (`client.ts:566-570`) |
| **the union's size asserted** | `file-types.test.ts:98`, `files-types.test.ts:47` | green always — self-satisfying, and it runs in the `continue-on-error` step |

**So the hole is narrow, and it is exactly one artefact.** The union cannot grow without the build going red: `Record<FileClientErrorCode, string>` is the enforcement, and PM reproduced both polarities end-to-end on this branch (adding a code to the union alone → `vue-tsc` exit 2 with `TS2741`; adding it to the union *and* the `Record` → everything green). The mechanism control, in isolation: `const m: Record<'A'|'B'|'C', string> = { A, B }` → `error TS2741: Property 'C' is missing in type '{ A: string; B: string; }' but required in type 'Record<"A" | "B" | "C", string>'`. The exhaustiveness is real, not incidental.

What **is** unprotected is `isFilesErrorCode` (`client.ts:75-93`): two occurrences tree-wide — the definition at `:75` and the call at `:568` — and **no test references it** (`grep -rn "isFilesErrorCode"` over `packages/` + `apps/` → 2, both in `client.ts`; `packages/file-core/test/` holds 5 test files and none names it). It is a bare array that no type relates to the union, so it is the one list that can silently fall behind the other — and it is the one that decides what the browser does with an error code. The existing test at `packages/file-core/test/operations.test.ts:32` pins the **fallback** (`mkdir rejects with BAD_FRAME when the result carries an unknown error string`, asserted at `:41`) — i.e. it asserts that an *unknown* string degrades to `BAD_FRAME`, and says nothing about which strings are known.

**What the union itself proves.** Probed in both polarities with `Record<FilesErrorCode, true>` as the control, since a guard has to fail in *both* directions:

| change | result |
|---|---|
| a **misspelling** (`'BAD_FRME'`) | `TS2820: Type '"BAD_FRME"' is not assignable to type 'FilesErrorCode'. Did you mean '"BAD_FRAME"'?` — **caught** |
| an **omission** (assign a 2-member subset to `FilesErrorCode[]`) | **silent**, exit 0 — **not caught by the union** (caught by the `Record` in `apps/web`) |
| `Record<FilesErrorCode, true>` minus one key | `TS2741: Property 'QUEUE_FULL' is missing … but required in type 'Record<FilesErrorCode, true>'` — **caught** |
| `Record<FilesErrorCode, true>` plus a bogus key | `TS2353: Object literal may only specify known properties, and 'NOPE' does not exist in type 'Record<FilesErrorCode, true>'` — **caught** |

So the union guards **spellings**, and the `Record` guards **completeness** — which is why "the union makes a missing code a `tsc` error", an earlier justification of mine, was wrong in its mechanism while the *retirement verdict* still holds. And `FileClientErrorCode = FilesErrorCode | 'CANCELLED'` (`packages/file-core/src/errors.ts:7`; `CANCELLED` documented at `:3-6` as never appearing on the wire) is **not** a reason the fix is hard — `Record<FileClientErrorCode, …>` compiles fine over the 17-member union, because `CANCELLED` is one of the keys. Nobody reached for the trick because someone already did.

**Why it matters for the port, and where it stops mattering.** The Rust's two unpinned spellings are both reachable on the **plan's** wire: `PERMISSION_DENIED` at `:4985` (the root-delete guard) and via `errnoToCode` at `:3742` (`EACCES`/`EPERM`), `DIR_NOT_EMPTY` at `:4993` (non-empty directory). So a divergence in either string would be caught by **no Rust test** — and on the TypeScript side, the `Record` catches a *missing* code but **not** a wrong spelling in a list nobody types against, which is precisely `isFilesErrorCode`. The Rust's two unpinned codes are in code the port re-implements.

**Verdict, unchanged: row 4 stays B.** The property is observable (the browser switches on the spellings) and the browser's list agrees at 16 today, so the port does not *lose* a behaviour the browser relies on. What the port loses is the **pin** — and the two unpinned codes are on its own wire. The correct successor test, if PM wants one, is a `Record<FilesErrorCode, true>` exhaustiveness guard in `packages/shared` (which fails both when a code is added and when one is removed), **not** a re-port of the Rust literal table.

**Out of scope for Plan 2 — recorded so it does not enter the repair list.** The two decorative shared tests, and the untyped `isFilesErrorCode` array, live on `main`, are independent of the port, and are **not** Plan 2's to fix. They are recorded here for one reason: they are *why* the retirement of `error_code_spellings_are_pinned` was justified on a false premise — "the union is a compile-time guard" — even though the retirement's **verdict** still holds and the port-relevant finding is the 14-of-16 pin.


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

> **N-1/N-2/N-3 amendment (PM, 2026-10-21).** N-1 and N-2 are fixed at `14964c8`. One premise of N-2 needed correcting: Plan 2 has **never** contained a `signal.rs:NNN` citation — the stale numbers live in the Rust **comment** at `signal.rs:100-103`, so the inheritance risk was real but not an instance. PM added a blockquote to Task 3 stating the correct locations. N-3 stands. The source-side consequence is **B-11**, which PM found underneath N-3: Task 11's files list fence diverges from the Rust on seven counts.

> **N-6 amended.** N-6 was originally listed among the non-blocking findings as "both corrections are wrong in both directions". PM's re-measurement showed the "4→2" half was a **prediction of the after-state** that the implementation matched exactly, not a claim about the tree as it stood; my finding measured the tree before the rewrite landed and mistook "not changed yet" for "will not change". N-6 is corrected in place; its surviving half — the regex-over-`lib.rs` mechanism cannot outlive the Rust — is unaffected.

---

## 6. What the audit did not cover

- **Spec-side claims.** I read the spec for §3.3/§3.4/§3.5/§4.x/§9.x context but did not audit Plan 2's §refs against the spec section by section.
- **`apps/agent/test/session/packetizer.test.ts`.** Plan 1 Task 3 creates it; it is **not in the tree** (`apps/agent/src/session/` does not exist). Task 19 imports `packetizeAnnexB` from it. That is a Plan 1 execution gap, not a Plan 2 defect — but **Task 19 cannot run until Plan 1 Task 3 lands**, and the plan says so at line 69 ("Already written in Plan 1 Task 3. Do not recreate"), which is currently false. Flagging for PM as a Plan-1 status item.
- **Whether the fences would actually compile.** I counted and read; I did not typecheck a single fence.
- **Task 12's `emitChunks` behaviour change** is recorded (N-4) but not adjudicated — whether an agent-side 16 KiB splitter is wanted is an owner/spec question, not a docs question.
- ~~**Whether the werift TWCC estimator is usable for a 500 ms-tick encoder retarget**, and whether werift's `transport-cc` negotiation is reachable from the adapter's `PeerConnection`.~~ **CLOSED 2026-10-21** — both answered with measured values and verified in package source; see the table under §3 B-10. The headline: reachable via `senderBWE`, seed is `0` not 4 Mbps, the offer's `rtcp-fb` is echoed while `extmap` is not, and the estimator leaks entries unbounded on the port's own path.
- **Beyond `list()`, I did not audit the other files-protocol message shapes.** B-11 found the `list()` divergence; I did not check `files-download-begin`, `files-upload-ack`, `files-action-result` or the error frame against their Rust counterparts field by field. Given that B-11's shape survived a passing count-based gate, **the same failure is plausible in those** — that is the highest-value next sweep, and it is not done.
- **I did not audit every sentence of every declaration, only their counts and their named tests.** N-3a and N-3b are both defects in *prose* inside a declaration whose *counts* were exactly right (25 `it()` / 42 `expect()` as it then stood, re-walked). Task 11 is the largest and most prose-heavy declaration in the plan; it is plausible that the other 18 have sentences of the same kind. The fence-walker cannot find them — it counts `it(`/`expect(` and would report the count as a pass.
- **I typechecked and executed no fence.** PM's `180efe1` found three real defects in Task 12 by running the fences against the real `node-pty` — a UTF-8 corruption on the inbound path, a U+FFFD substitution on the outbound path, and a `PtyProcess.on` seam no real host could satisfy (visible as four `as never` casts). See §7.1: **this is the second failure class, and it is not one my method can rule out.**

---

## 7. One structural observation

The failure is not scattered. Three of the nine BLOCKING findings (B-1, B-2, B-9) are **counts that do not describe the tree**; two more (B-3, B-5) are **names that do not exist**; one (B-4) is **arithmetic stated backwards**; one (B-7, B-8) is **a surface enumerated incompletely on both sides**.

The common cause is visible in the plan's own history: T8's declaration is the one that is right, and it is right because `5ff4182` **re-derived** it after the RTP rewrite changed its fences. Every other task's number was written once and never re-derived against the fence it describes. The plan already knows the remedy — §"Corrections" is where R3 was derived three ways — it just has not been applied to the declarations.

A cheap, mechanical fix exists: for each task, count `it(` and `expect(` **inside the fences only** (not prose), write that number into the declaration, and re-run it whenever a fence moves. The counter I used for §2 is 40 lines of Python; it reproduces B-1 exactly.

### 7.1 The second class: a fence that has never been compiled or executed is not evidence that the code in it is correct

> **Added 2026-10-22 after PM's `180efe1`.** This audit's method was to read and count, and §6 says plainly that I typechecked no fence. PM's Task 12 work shows what that costs, and it upgrades a limitation into a finding about the plan as a class.

Three real defects in three consecutive tasks, all found the same way — **by extracting the fence and running it**, not by reading it:

| Task | Defect | How it would have surfaced |
|---|---|---|
| 10/11 | two logic bugs of the same origin | running the fences |
| 12 | `node-pty` defaults to `encoding: 'utf8'`, so `0xff` reaches `onData` already replaced by U+FFFD *before* base64 runs — the agent would faithfully encode corrupted bytes | running the real binding |
| 12 | `write(Buffer.from(bytes).toString('utf8'))` turns inbound `41 ff fe 42` into `41 ef bf bd ef bf bd 42` at the child | writing non-UTF-8 through it |
| 12 | `PtyProcess.on` typed `(arg: never) => void` — no real host is assignable to it, which is why the fence carried four `as never` casts | typechecking against the real host |

**The pattern worth recording: `as never` (or any cast that silences a seam) is a signal that the fence was typed to satisfy a test double rather than a real dependency.** The four casts in Task 12 were not incidental; they were the visible symptom of a seam no implementation could satisfy. A reviewer who treats a cluster of casts at one interface as a smell would have found this without running anything.

**This is a limitation of my audit, not a finding I can close.** I verified *what the fences say*; PM verified *that they run*. Both were necessary, and neither is sufficient: a fence can be arithmetically declared, semantically faithful to the Rust, **and** wrong about the library it calls. §6's "I did not typecheck a single fence" is therefore load-bearing reading, not a footnote.

---

## 8. Recommended disposition

**Do not execute Plan 2 as it stands.** B-1/B-2 mean no task's gate is trustworthy; B-3/B-5 mean two R-entries would record fabricated parity; B-7/B-8 mean two surfaces leave the Rust tree with no owner.

> **Applied.** PM closed all of these in `cebe659`; §9.1 records the independent re-verification. The one residual found during that verification (the "six retired noise rules" R-entry line) was closed in `72e8594`. A further eight revisions landed after that and are recorded in §9.0.
>
> **N-4 is no longer an owner question, and that correction is PM's.** `e9fe654` settles it by measurement: C12 and B40 already state 16 KiB as the wire contract, so the splitter is a contract the port must meet, not a behaviour it invents. My earlier framing ("whether the Node agent should split is a protocol question for the owner") was wrong for the reason the empirical §N-4 retraction gives — the Rust met that contract at its read buffer, so there was never a silent contract to reinterpret.
>
> **B-10, the auto-ABR loop, is the largest thing in the rewrite — and it is RULED (owner, 2026-10-22: it ships, as a full port).** §3. It was not a plan defect but a **ledger hole** — a live behaviour of the Rust agent with no B-row, no R-entry, no task, and no owner. The ruling is recorded in Plan 3's T8 (`…plan-3-desktop-retirement.md:231`). The original fourth question about the `transport-cc` SDP delta was **withdrawn**: `register_default_interceptors` already registers it, so there is nothing to decide there — but the Rust comment saying otherwise is wrong and should be corrected in T9. **The carry into Plan 3's T8 that this paragraph asked for landed (`c81ae4b`), and the ruling followed it.** The three sub-questions are now the implementing task's to answer in writing — the estimator divergence, the pacer (werift has none, so "full port" means building it), and the seed — and the seed is the one the ruling did not name.
>
> **B-11, N-3, N-3a and N-3b were all four closed by PM's `d471109`, as one declared before→after — which is what I recommended and what the sequencing required.** I re-verified the repair independently rather than accepting it: all seven `list()` divergences are fixed (path built with `join_rel` semantics, `isDirectory` from `stat`, real directory `size`, `rfc3339Utc(stat.mtimeMs)`, dirs-first `Buffer.compare`, per-entry `statSync` throwing, `readdirSync` inside a try mapped through `errnoToCode`); the three `list_*` tests are present (`:4118`, `:4145`, `:4155`); the phantom `drained .part before resume` is gone; and the declaration is **29 `it()` / 60 `expect()`**, which I recounted from the fences — **both exact**. N-3b's repair also does the thing I asked for rather than the vacuous thing: it asserts only the wire literal `30_000` and **states in a comment why the prod-equals-constant assertion is omitted** (`:4300-4305`), naming the `cfg(test)` divergence explicitly. That is better than what I proposed.
>
> **B-10 is settled, and what was open in this paragraph was the ruling, not the carrier.** `c81ae4b` put it in Plan 3's T8 (`:138`) with both landings spelled out, `78dd283`/`f95a921` corrected and tightened the evidence underneath it, and the owner **ruled on 2026-10-22 that it ships as a full port** — recorded in Plan 3's T8 at `:231`. I re-verified that evidence line by line (§9.0) and it holds, including the two facts that make "ship" expensive rather than free: werift has **no RTP pacer** (one `pacer` hit in the whole library, in SCTP), and its `SenderBandwidthEstimator` leaks its send history because the eviction loop runs over `Object.keys(sentInfo)` — four field names turned into `NaN` — and deletes nothing. `54b1c5c` correctly demoted the fourth question (the `transport-cc` SDP delta) from an owner decision to a settled fact, agreeing with §B-10's withdrawal of it. **What the ruling does not settle is who answers the remaining two:** Plan 3 assigns the estimator divergence and the pacer decision to the implementing task, and leaves the seed unstated — so they are written requirements now, not open questions to the owner, but a task that ignores them fails the item rather than deferring it.
>
> **N-4's *outcome* is settled and PM's reasoning for it improved.** `e9fe654` resolves it by measurement rather than deferral, which is the right method, and its `node-pty` evidence (8 MiB in 2 555 events, largest 18 433 bytes) is what justifies `emitChunks` when the Rust's own bound sat in its read buffer. What is still wrong is the mechanism sentence, which `844ba29` extended rather than repaired — see §N-4 below.
>
> **What this does not close.** **B-10 is ruled** (2026-10-22, it ships — Plan 3's T8 `:231`); its remaining sub-questions are now the implementing task's to answer in writing, not the owner's. **The "the Rust enforced nothing" claim now appears in three places across two plans plus the T8 preamble** (§N-4), and it is false as written; repairing it and repairing C12/B40's citations (§N-4a) are the same fix. **B-12 was raised 2026-10-22 and its plan-side content is drafted:** Task 11's criterion leaves **25 of 40 non-ports** uncovered, **seven of them guards the fence implements and no test trips**, three of its twelve dispatch arms have no test at all, and one of those — `files-delete` — silently dropped the `recursive` flag three other artefacts carry. **Bigger than any of those: `FilesSession` has no owner for the frame-to-wire boundary and no lifecycle owner (§B-12c)** — no envelope outbound, no unwrap inbound, no timers, `deps.send` declared and never implemented — so the port and the shipped browser cannot exchange a single files frame while every fence stays green; the ack shape (§B-12d), the retire-clause re-derivation (§B-12e) and the wire-spelling pin (§B-12f — the Rust pins 14 of 16 codes, TypeScript spells 16 of 16 in two lists of which only the typed one is enforced) complete the set. It is plan-side, in PM's lane, and it blocks **starting Task 11** for the same reason B-11 did. All repair items are now drafted in §B-12b…§B-12f — items 1, 3 and 4 ready to paste, and item 2 **ruled by the owner 2026-10-22** to honour `recursive` as the Rust does, so no part of B-12 is waiting on a ruling any more.

Suggested order for the amendments (all of them plan-side; per PM's ruling, I do not edit Plan 2):

1. Re-derive all 19 declarations from their fences (B-1, B-2). Mechanical, one pass.
2. Delete or re-name the 21 phantom test names against the real list in `apps/agent/src` (B-3). Task 18's six need the most attention: they are new tests, not ports.
3. Rewrite the retirement note from the real 10-rule table, and reconcile "none port" vs "six retire" (B-5).
4. Fix the `[200,300,450,675]` explanation to name the `1519.5` tie, not `1012.5` (B-4).
5. Decide B38's owner and move the six `main.rs` shell tests into a task, or write an explicit retirement (B-7).
6. Add `AGENT_DESKTOP_SOURCE`, `AGENT_DESKTOP_SELECT_TIMEOUT_MS`, `AGENT_DESKTOP_POLL_INTERVAL_MS`; remove `AGENT_COLS`/`AGENT_ROWS` or declare them a deliberate addition to the contract (B-8).
7. Correct 38 → 49 (B-9).
8. Move the `decisions.md` rulings into the plan text (B-6).
9. **B-12:** name all 65 (or restate the criterion so it partitions), implement `recursive` as the Rust does, add test sites for `files-mkdir` / `files-delete` / `files-rename` / `teardown()` / the seven unasserted guards, re-derive the 26-vs-25 count, **and give the frame-to-wire boundary an owner** — the two envelope tests in §B-12c, the two tick periods, and a real `deps.send` — plus the ack three-name shape and the `endUpload` final ack in §B-12d, and the two-list spelling problem in §B-12f — where the fix belongs in `packages/shared`/`packages/file-core`, not in Plan 2, so it is recorded and not repaired. **Items 1, 3 and 4 are drafted in §B-12b and need only paste + PM's acceptance. Item 2 is settled: the owner ruled 2026-10-22 to honour `recursive` (`remove_dir_all` when true, `DIR_NOT_EMPTY` only when false), so it is a fence repair rather than an owner question — the retirement path was considered and rejected, and §B-12a keeps the reasoning.**

---

## 9. Amendment log observed during this audit

The plan moved six times while I was reading it — and fifteen times in total before the audit closed. The first table is the window I audited; §9.0 records the rest, each verified against the tree rather than the commit message. Recording so PM can confirm ownership:

| Revision | Change |
|---|---|
| `406f968` | R3 derived three ways; the file's own arithmetic corrected |
| `8411480` | webrtc-core: the R-S3 coverage test made discriminating on the answer m-line order |
| `5ff4182` | **Task 19's video path connected to RTP** — `this.deps.send('desktop', …)` → `this.sendRtp(encoded.data)` via `packetizeAnnexB` + `RtpSenderSink`; T8's counts re-derived (and as a result T8 is the one correct declaration) |
| `44d5099` | CI filter breakage recorded; two Task 3 rulings |
| `0030391` | CI exclusion pointed at the renamed package |
| `a6d86e5`, `8a92601` | Step 0b rationale; `CONTRIBUTING.md` |

Findings B-3's Task 19 rows and the T19 count were **re-checked against `8a92601`** after `5ff4182` landed. Everything else was stable from `406f968` onward.

### 9.0 The rest of the log — `c989781` … `844ba29`

Nine further revisions landed after `72e8594` and were verified directly against the tree rather than accepted from the commit messages. The two that change a *finding* are `e9fe654`/`844ba29` (N-4, below); the rest are recorded here so the ledger is not silently partial.

| Revision | What it changed | Verified how |
|---|---|---|
| `c989781` | Plan 3 gained an obligation list — deferrals now have a destination instead of dying in prose | Read; the list is what §8's "what this does not close" needed |
| `e71c499` | `CONTRIBUTING.md` added to Plan 3 T3 alongside the CI filters | `CONTRIBUTING.md` exists at repo root; T3 `:87` carries the same-invariant sentence |
| `c81ae4b` | B-10 given its T8 carrier — the first half of what §8 asked for | Plan 3 `:138` |
| `78dd283`, `f95a921` | T8's ABR evidence corrected, then the wording tightened | Citations re-checked, below |
| `54b1c5c` | The `transport-cc` SDP bullet demoted from owner decision to settled fact — **agreed, and it resolves Q4 the way my audit did** (`§B-10`: the premise was wrong because `register_default_interceptors` already registers it) | Below |
| `9f74f0c` | The extmap rule restated as a conjunction, not a flag | Re-ran the reasoning against the probe output, below |
| `c692b77` | The probe citation pinned by sha256 | `sha256sum` matches: `probe.mjs` `9f155272…7649b46`, `output.txt` `f2fe9e5f…e5239d6b` |
| `d471109`, `180efe1`, `e9fe654`, `844ba29` | B-11/N-3 closure, Task 12's byte-fidelity repair, N-4's resolution | §8, §N-4, §N-4a, §7.1 |

**Citations in the new T8 material that I checked line by line, all correct:**

- `interceptor_registry.rs:717` — `.with(Slot::Pacer, PacerBuilder::new().build())`. Confirmed, and the surrounding doc at `:628` calls it *"paces departures"*, which is the claim T8 makes for it.
- `senderBWE.js:133-142` / `:134-140` — `rtpPacketSent(sentInfo)` then `Object.keys(sentInfo).map(Number).sort().filter(seq => seq < sentInfo.wideSeq).forEach(seq => delete this.sentInfos[seq])`. **The stated defect is real and the mechanism is exactly as described:** `sentInfo` is one packet's field names (`wideSeq`, `size`, `sendingAtMs`, `sentAtMs`, built at `rtpSender.js:612-616`), so `Object.keys` yields four strings, `Number()` turns each into `NaN`, and every `NaN` fails the filter — the eviction loop deletes nothing. `this.sentInfos[sentInfo.wideSeq] = sentInfo` then grows without bound.
- `rtpSender.js:693` — `this.receiverEstimatedMaxBitrate = feedback.bitrate`. Confirmed, and `grep -rn receiverEstimatedMaxBitrate` over `lib/` shows only the declaration, that write, and the `.d.ts` — **nothing reads it**, so "REMB is not an alternative" holds.
- **"werift has no RTP pacer"** — `grep -rniE 'pacer|pacing' lib/` excluding `.map` files returns **one** hit, in `sctp/src/sctp.js:1271` ("retransmission pacing is controlled by RTO/T3"), and **zero** in `lib/webrtc` or any RTP path. Confirmed as stated.
- `interceptor_registry.rs:676`/`:678`/`:686-692` — the `for kind in [Video, Audio]` loop, its `CongestionFeedback::Twcc` arm, and `register_header_extension(…, kind, None)`. All three confirmed.
- `rtc.rs:220`/`:235` and the audio claim — one `RtpCodecKind::Video` track; `grep -rniE 'audio' apps/agent/src/ --include=*.rs` returns **zero** hits. Confirmed, so "the audio half is dormant registration" is right.
- `media_engine.rs:917-946` — `update_header_extension`, whose body inserts a negotiated extension **only** when a local extension with the same URI exists. That is the Rust half of the conjunction, and it matches werift's `transceiverManager.js:265-266` filter one-for-one. The symmetric claim is correct.
- `peerConnection.js:1084-1087` — `headerExtensions: { audio: [], video: [] }`. Confirmed.
- `.superpowers/probes/be-twcc-sdp/output.txt` — the probe's own matrix is what T8 asserts: default config ⇒ extmap `NONE` for every offer; with `useTransportWideCC()` ⇒ `a=extmap:4` for an offer id of 4 and `a=extmap:7` for 7. Conjunction confirmed, id-from-offer confirmed.
- `report.json:30` vs `synthetic-offer.ts` — the captured offer carries `a=extmap:4 …transport-wide-cc…` and `a=rtcp-fb:<pt> transport-cc` on sixteen payloads; the fixture carries **only** `a=extmap-allow-mixed` and no `transport-cc` at all. **The gap T8 warns about is real**, and it is the same class as §7.1: a fixture that never exercised the extension cannot tell an implementer whether their config works.
- `ARCHITECTURE.md:970` — `- [x] GCC auto-ABR — target, verified via spike §3.7 (not an acceptance criterion)`. Confirmed: it describes the loop as **present behaviour**, which is why the "does not ship" branch of B-10 costs a doc amendment.

**One thing worth flagging back, and it is not a defect in PM's text — it is a residual in mine.** `54b1c5c` now separates the RTCP-FB half from the extmap half and says the former *"needs no local config either"*, with the probe showing `rtcp-fb` echo in the `fb only` row where extmap is still `NONE`. That is measured and correct. But it means the demoted bullet is settled by **two different mechanisms** — fb is echo-only, extmap is a conjunction — and the sentence "The old sentence 'the `extmap` id needs no decision' is true only of the id" is the only place both are held apart. An executor skimming the bullet could still take "no local config needed" from the fb half and apply it to the extmap half. The bullet already says otherwise, so this is a review note, not a finding.

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

### 9.2 Corrections to §B-12b raised by PM, 2026-10-22

Two claims in the first draft of §B-12b were wrong, and both were mine, not the plan's. Recorded here because a claimed measurement the next reader has no reason to re-run is the exact defect class this audit against others is about.

| Claim as first written | What is actually true |
|---|---|
| "the same declaration calls them ports at `:5100-5110` — *inside the same repair*" | **`:5100` and `:5104` are the additions list itself, not a ports call site.** `:5086` reads *"Three additions, each declared as new rather than counted as a port:"*, `:5100` is item 2 (`lists entries sorted…`), `:5104` is item 3 (`reports NOT_A_DIRECTORY…`). The **ports** sentence is at `:5063-5065` — *"…and the three `list_*` tests"*. The bucket rows in §B-12b also cited `:5100-5101` and `:5106-5110` for the same wrong reason; all four citations are corrected. |
| "§B-12b is strictly additive: 0 lines removed" | **18 lines were superseded and 181 added** (`git diff 1443a09 d58c052 --numstat` → `181 18`). The removed lines are the 24/41-era text the 22/40 text replaces. |

**The correction makes the contradiction larger, not smaller.** Because `list_returns_entries_sorted_dirs_first` (`files.rs:2703`) and `list_on_a_file_is_not_a_directory` (`:2730`) both exist, those two titles are genuinely ports — which is what the §B-12b bucket table says (rows 17 and 18, both **A**). So the declaration is internally contradictory at `:5063-5065` versus `:5100`/`:5104`, and the first draft of this section reproduced the same contradiction by repeating the declaration's "new" label while its own table marked the two rows ported. The table is the authority; the prose now cites `:5063-5065`.

**How the "0 lines removed" claim was produced, because the method matters more than the number.** I ran `diff <(grep -v "" /tmp/ev.md) …` and read `0` from the `<` side. `grep -v ""` outputs **zero lines** — it was diffing an empty file. A `-v` with an empty pattern matches nothing to exclude, so it emits nothing. The check had no positive control, and this is precisely the rule I apply to others' "0 hits" claims. The claim never reached the audit file or the commit message; it reached only my report to PM. The numstat above is the replacement, and it is stated as a swap — 18 superseded, 181 added — rather than as an addition.

---

### 9.3 Corrections raised 2026-10-22 by PM's reviewer rounds, and the ones of my own that they exposed

PM's independent reviewer put four defects in §10 and §B-12b to me in the first round. All four were real, and fixing them surfaced three more that were mine. A second round, on the frame-to-wire and spelling material, surfaced four more of mine and two of PM's. Recorded in full because the pattern — **a recipe that prints a number it did not compute** — is the exact defect this audit prosecutes in the plan, and I had **seven** of them.

| # | Claim as written | What is actually true | Method error |
|---|---|---|---|
| 1 | the guard recipe, as printed | It printed the **reverse** of its own conclusion: prod/test swapped for every row. `T='\n'.join(f for f in F if '.test.ts' in f)` buckets fence 3 — the **production** `// apps/agent/src/files/session.ts` — into **T**, because that fence's prose mentions `session.test.ts`. Fences classify `0:T 1:Q 2:T 3:T 4:?`; correct is `0:T 1:P 2:T 3:P 4:other`. | Classified by a substring of the body instead of the first line (the banner). The repaired recipe prints the classification as its own positive control, so a reader can see the bucketing before trusting the counts. |
| 2 | `ALREADY_EXISTS 3/1` | The token exists in **neither** side: `grep -c` → 0 in `plan-2-core`, 0 in `files.rs`. The Rust spells it `FILE_EXISTS` (8 hits in each, as the positive control). The printed "3/1" came from nowhere. | A pattern that matches nothing on either side prints zeros, and I reported a non-zero from a run I did not re-read. This is §9.2's lesson one level down: not a vacuous *check*, a vacuous *row*. |
| 3 | the 65 recipe: `grep -cE '^\s*(async )?fn [a-z0-9_]+\(\)'` → "65" | That command returns **68**. The count that returns **65** is `grep -cE '^\s*#\[(tokio::)?test'`. | Two different questions ("fns matching a pattern" vs "anchored test attributes") both plausible for the word "tests". The recipe now states which one it runs and why the other differs. |
| 4 | the `it()` recipe without `\b` | Returns **31**: it also matches `split('/')` at `:4639` and `:4862`, whose `it('/` looks like a title opener. With `\b` → **29**. | Missing word boundary in a pattern whose whole job is to identify `it(` tokens. |
| 5 | **mine, found while fixing #1** | `as never` is **55 over the whole plan** and **0 inside Task 11's span** — the cast that hides the missing `deps.send` is at `:7068`, in Task 18. A loop that reported 55 against the span would have been a wrong number attached to a right finding. | Scope drift between the pattern and the span it was run over. §10 now states the scope in the comment and gives the in-Task-18–19 count (14) as well. |
| 6 | **mine** | §B-12b's bucket totals **25 / 18 / 22** inherited the retire clause's own categories — the very error B-12 prosecutes. Correct: **25 / 15 / 25**. | I built the "independent" table by re-reading the clause it was meant to check. The direction is diagnostic: a copied criterion yields fewer gaps, never more. |
| 7 | **mine** | three bucket-B rows had reasons that do not survive reading the Rust body (rows 6, 9, 29), and a fourth (row 3) has a false reason but a right verdict. See §B-12b and §B-12e. | Same as #6 — the reason was inherited, not re-derived. |
| 8 | **mine, round two** — the "how loud" sentence in §B-12c(a) | I wrote that a flat frame makes `client.ts:549-551` throw a `TypeError` **inside the data-channel message handler**, and implied the caller sees it. It does throw, but the throw is **swallowed**: `webrtc-core/src/data-channel.ts:35-44` opens a `try` **before** the typed-handler loop and closes it with a bare `catch {}`, so a handler throw is discarded exactly as a JSON parse failure would be, the remaining handlers for that message are skipped, and the browser's `list()`/`mkdir()`/`delete()` promise **never settles**. QA measured it end-to-end against the real `FileClient`. The truth is a **silent non-settling promise**, not a crash — and a hang with no rejection is *harder* to attribute, not easier. | I described the mechanism one layer short: the throw happens, but I did not follow it to where the `catch {}` above it lands. I asserted a symptom ("crash") from a mid-stack observation. |
| 9 | **mine, round two** — "the union makes a misspelling a `tsc` error", used to justify retiring `error_code_spellings_are_pinned` | The union catches a **misspelling** (`TS2820`) and **not** an **omission** (a subset assignment type-checks silently, exit 0). Probed both polarities with a `Record<FilesErrorCode, true>` control, which fails in both directions (`TS2741` on a dropped key, `TS2353` on a bogus key). The justification was true about the half that does not matter and false about the half that does. The retirement's **verdict** still holds; its **reason** was never the true one. | I read "the type system knows these strings" as "the type system enforces these strings", and never probed the omission case. A claim about a *guard* needs the case that must fail. |
| 10 | **mine, round two** — §N-3's closing sentence and row 54 both called `test_error_code_str_mapping` "an internal helper / literal pin" | It is the **second half of a wire-contract pin**: it asserts `RESUME_INVALID` and `QUEUE_FULL` (`:3505-3509`), which the browser switches on, and with `error_code_spellings_are_pinned`'s 12 it makes **14 of 16**. A test classified by what its function *is* rather than by what it *protects* — the same failure mode §B-12e exists to correct, and I made it in two places at once. | Applied the clause's category ("internal helper") to a test whose subject is a browser-visible wire string. Row 54's **bucket** was right; its **label** was the error. |
| 11 | **PM's, retracted by PM** — "the Rust enum pins 12; four codes are TS-only" | The Rust enum declares **all 16** (`files.rs:166-187`, `as_str()` at `:190-209`) and the agent **emits** three of the four additions in production — `PermissionDenied` (`:905`, `:913`, `:967`), `DirNotEmpty` (`:938`), `ResumeInvalid` (`:1019`, `:1026`); only `QueueFull` is `#[allow(dead_code)]`. The real shape is a **14-of-16** pin split **12 + 2** across two Rust tests, against a TS side that spells **16 of 16**. §B-12f. | PM's own correction, recorded because the number reached my draft before the correction did. |
| 12 | **PM's, corrected by PM** — "`MAX_DATA_CHANNEL_FRAME_BYTES` is declared and consumed by nothing" | It is declared `:1156`, re-exported `:1083`, and **asserted** `:1105`; `MAX_INBOUND_FRAME_BYTES` is declared `:1154`, asserted `:1101` and **enforced** `:1320-1321`. The one that is pinned-but-unenforced is `MAX_DATA_CHANNEL_FRAME_BYTES`; and **none** of the three is consulted on the files path. §B-12c(e). | A wider claim than the measurement supports. Corrected to the narrower true statement — *"pinned by a test and enforced nowhere"* — which is also the one that matters. |
| 13 | **PM's, withdrawn by PM after QA's push-back** — "the union can grow to 40 members with every CI step reporting success", and "no exhaustive `Record` guard exists" | **Both halves are false, and the guard is the thing that reds the build.** `apps/web/src/lib/file-errors.ts:8` declares `FILE_ERROR_TEXT: Record<FileClientErrorCode, string>` with **17** keys, and `Record<Union, V>` is exhaustive by construction — adding a code to the union alone fails `vue-tsc` with `TS2741`. PM reproduced both polarities end-to-end (union alone → exit 2; union **and** `Record` → green). The second grep PM ran *did* find the guard — `Record<FileClientErrorCode` → 1 — and he read the hit as evidence of **absence**, because the pattern he searched for (`Record<FilesErrorCode`) names the *other* type. | The same failure mode as §9.2 and this table's rows 1-2, in its purest form: **a positive control read backwards**. The control did its job — it showed where the guard was — and was then read as proof there was no guard. The hole that survives is narrow and specific: `isFilesErrorCode` (`client.ts:75-93`), a bare array no type relates to the union, untested, and the one list that decides wire behaviour. §B-12f. |

**What I am *not* claiming, stated because PM's framing implied it.** PM's third amendment says restoring the envelope "moves the Task 11 partition from 26/39 to **27/38**", and that `frame_files_wraps_the_envelope` plus `decode_guard_never_errors_on_foreign_frames` are the two losses. Verified: **both are genuinely lost**, and rows 6 and 9 are now bucket **C** on exactly that evidence. But **four** rows moved to **C**, not two — row 29 (`stale_part_is_removed_and_retried_once`) is the third, on independently measured evidence, and row 3's reason changed without its bucket changing. The partition in this audit is **25 ported / 40 non-ported** with **25 gaps**; whether the repaired fence reaches "27 ported of 65" depends on the two tests landing, and I am not asserting the post-repair number as though it were measured today.

**TEST-INTEGRITY declaration for *this* change set — before → after, with the reason.** PM asked for this explicitly and left the ruling to me, so I am stating it rather than letting it be assumed:

| file | before | after | reason |
|---|---|---|---|
| `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-audit.md` | 0 code fences added, 0 test bodies | **0** — no `it()`, no `expect()`, no fence body added, removed, or skipped | These rounds touch only §10 recipe commands and §B-12b…§B-12f prose. The audit document contains no executable test suite; its only code is reproduction recipes in §10, and **six of those changed** (the guard recipe's fence classification, the 65-recipe's command, the `it()` recipe's `\b`, the `as never` scope, the spelling-per-code loop, and the `message.<field>` loop). Each is reprinted with its now-correct output above, and each was re-run before being written down. |
| plan 2 core / plan 3 / spec | **unchanged by me** | **unchanged** | PM applies all plan-side edits; I have not touched them, and every repair here is a paste-ready block for PM to land. |

So: **no `it()` count changes anywhere, because no test body changes anywhere.** The Task 11 declaration's own `29 it() / 59 expect()` is **not** edited by this round — PM's §B-12c repair will change it (two new envelope tests, and the ack split may add a third for the 20 ms branch), and that change needs its own before→after line **in the plan**, in the task it edits, at the time it lands. I am flagging it here so it cannot land undeclared: **§B-12c's two tests and §B-12d's tick test are additions to Task 11's fence and must move the declaration from 29/59 to whatever its fence then measures.**

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

# B-12: the partition criterion is not exhaustive
grep -cE '^\s*#\[(tokio::)?test' apps/agent/src/files.rs               # 65 anchored test attrs
# the 40's stated criterion covers 15; the 25 in neither category are listed in §3's B-12,
# and §B-12b enumerates all 65 into three buckets that close arithmetically (25 + 15 + 25).
# Scripts: /tmp/p2audit/partition65.py (§B-12b's table) and /tmp/p2audit/split.py (the 26/25/3).
#
# NOT the `fn` recipe: `grep -cE '^\s*(async )?fn [a-z0-9_]+\(\)'` returns **68**, because three
# fns outside the test module match the same pattern. Counting the `#[test]`/`#[tokio::test]`
# attribute is the count the section means (`anchored` = attribute-bearing), and it returns 65.
# Both numbers are honest; they answer different questions. State which one you ran.

# B-12b: the seven guards the fence implements and no test trips
#   Classify each fence by its FIRST LINE (the banner), not by a substring of its body.
#   The substring form `'.test.ts' in f` puts fence 3 — the PRODUCTION
#   `// apps/agent/src/files/session.ts` — in the TEST bucket, because that fence's prose
#   mentions `session.test.ts`. That is why the first version of this recipe printed the
#   reverse of its own conclusion.
python3 -I - <<'PY'
import re
P='/mnt/Data/Ponta/remote-platform/docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md'
L=open(P).read().split('\n')
s=next(i for i,l in enumerate(L) if l.startswith('### Task 11:'))
e=next(i for i,l in enumerate(L) if i>s and re.match(r'^### Task 1[2-9]:',l))
F=[];on=False;b=[]
for l in L[s:e]:
    if l.strip().startswith('```'):
        if on: F.append('\n'.join(b)); on=False
        else: on=True; b=[]
        continue
    if on: b.append(l)
def kind(f):
    h=f.split('\n')[0]
    if h.startswith('// apps/agent/src/'): return 'PROD'
    if h.startswith('// apps/agent/test/'): return 'TEST'
    return 'OTHER'
for i,f in enumerate(F):                      # positive control: print the classification
    print(f'fence {i}: {kind(f):5s} {f.split(chr(10))[0]}')
T='\n'.join(f for f in F if kind(f)=='TEST'); Q='\n'.join(f for f in F if kind(f)=='PROD')
for n,p in [('TRANSFER_UNKNOWN','TRANSFER_UNKNOWN'),('chunk-count','total chunk count changed'),
            ('chunk-len','chunk length does not match'),('FILE_TOO_LARGE','FILE_TOO_LARGE'),
            ('NOT_A_FILE','NOT_A_FILE'),('DIR_NOT_EMPTY','DIR_NOT_EMPTY'),('FILE_EXISTS','FILE_EXISTS')]:
    print(f'{n:16s} prod={len(re.findall(p,Q)):2d} test={len(re.findall(p,T)):2d}')
PY
#   fence 0: TEST  // apps/agent/test/files/protocol.test.ts
#   fence 1: PROD  // apps/agent/src/files/protocol.ts
#   fence 2: TEST  // apps/agent/test/files/session.test.ts
#   fence 3: PROD  // apps/agent/src/files/session.ts
#   fence 4: OTHER ./apps/agent/node_modules/.bin/vitest run test/files/protocol.test.ts …
#   -> TRANSFER_UNKNOWN 6/0, chunk-count 1/0, chunk-len 1/0, FILE_TOO_LARGE 2/0,
#      NOT_A_FILE 1/0, DIR_NOT_EMPTY 2/0, FILE_EXISTS 4/1.  Six guards, zero assertions
#      between them; the seventh is the root-delete guard at :4985.
#   NOT `ALREADY_EXISTS`. That token occurs **0 times** in the Rust (`grep -c` → 0 in
#   apps/agent/src/files.rs) and **0 times** in the plan; the Rust spells the code
#   `FILE_EXISTS` (8 hits in files.rs, and 8 in the plan as the positive control). The
#   earlier printed "ALREADY_EXISTS 3/1" came from a pattern that matches nothing on either
#   side — the exact shape of a vacuous negative check (§9.2, and the rule in
#   negative-check-needs-positive-control). The guard is real; its old name was not.

# B-12b: the 26/25/3 re-derivation — 29 titles, 26 are ports, 25 distinct Rust tests
#   `\b` is load-bearing: without it the pattern also matches `split('/')` at :4639 and :4862,
#   whose `it('/` looks like a title opener. Unbounded → 31; with `\b` → 29.
grep -oE "\bit\('[^']+'" <(sed -n '3861,5125p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md) | wc -l   # 29

# B-12c: the frame-to-wire boundary and the lifecycle owner
#   Every count below is over Task 11's span unless it says otherwise. Positive controls in the
#   SAME invocation prove the pattern works before a 0 is reported.
for pat in channel timestamp requestId payload envelope; do
  printf '%-12s %s\n' "$pat" "$(awk 'NR>=3861&&NR<=5125' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md | grep -c "$pat")"
done
#   -> channel 0 · timestamp 0 · requestId 8 · payload 21 · envelope 1
#      (the `envelope` hit is the retire clause's prose, not code)
echo -n "as never (WHOLE plan, NOT the span): "; grep -o "as never" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md | wc -l   # 55
#   The scope matters: Task 11's span contains **0** `as never` — the cast that hides the missing
#   `deps.send` is at :7068, in Task 18. Reporting 55 against the span would be a wrong number
#   for the right finding, which is the class this audit exists to catch.
awk 'NR>=7180&&NR<=8400' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md | grep -o "as never" | wc -l   # 14 in Tasks 18-19
grep -cE 'frame_files|frameFiles' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md   # 1 — also prose
grep -nE 'setInterval|setTimeout|clearInterval' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#   -> :2074 sleep helper, :5516 :5521 test sleeps. No production timer.
grep -cE 'function send|const send =|send: \(label' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md   # 0
grep -n 'new DataChannelRouter' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md    # :7068 only, `deps as never`
grep -n 'MAX_FRAME_BYTES' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md          # :5333 only — no files caller
sed -n '546,548p' packages/file-core/src/client.ts        # the browser reads msg.payload, unguarded
sed -n '74,86p' packages/webrtc-core/src/data-channel.ts  # sendJson builds the envelope for every channel
#   And the thing NOT claimed: the browser never reads `channel` inbound —
sed -n '546,548p' packages/file-core/src/client.ts         # destructures { type, payload } only

# B-12d: the ack is two operations in Rust, one in the plan
sed -n '1165,1180p' apps/agent/src/files.rs     # note_chunk -> bool, then take_pending_ack -> Option
sed -n '1651,1656p' apps/agent/src/files.rs     # chunk path: `if flush { flush_upload_ack() }`
sed -n '1729,1734p' apps/agent/src/files.rs     # vec![final_ack, complete] — the plan returns complete only
sed -n '4806,4824p;4523,4525p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#   -> noteChunk() is `void`; pendingAckFrame() both gates and takes; flushAcks() re-calls it,
#      so the 20 ms tick re-applies the gate the chunk path just evaluated.

# B-12e: the retire clause, name by name — the two CORRECT retirements, verified
grep -n 'export type FilesErrorCode' -A 6 docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md  # :3551 union
awk 'NR>=3861&&NR<=5125' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md \
  | grep -oE "'(PATH_OUTSIDE_ROOT|INVALID_PATH|NOT_FOUND|NOT_A_FILE|NOT_A_DIRECTORY|FILE_EXISTS|FILE_TOO_LARGE|TRANSFER_BUSY|TRANSFER_UNKNOWN|TRANSFER_TIMEOUT|IO_ERROR|BAD_FRAME)'" | sort -u | wc -l   # 9 in the whole span, 5 in the TEST fences
#   -> the union names all sixteen; the fences assert five. That is why the retirement is
#      legitimate — and why neither the declaration's reason nor my first one was the true one.
#      What the union does and does not prove is §B-12f's measurement, below.
grep -n "export function rfc3339Utc" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md   # :4059 — function ported
sed -n '4138,4139p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md                    # format guarded, arithmetic not
sed -n '5086,5111p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#   -> "Three additions, each declared as new rather than counted as a port:" (:5086), then
#      :5100 `lists entries sorted…` and :5104 `reports NOT_A_DIRECTORY…`.
#      The PORTS sentence is at :5063-5065 — "…and the three `list_*` tests" — so the two
#      additions are titles that same sentence already counts as ports. Note :5100/:5104 are
#      the additions list, NOT a second ports call site.
grep -n 'Duplicate/regressive' apps/agent/src/files.rs    # :1502 — a comment; no test asserts it
grep -n 'ack("t-1", 21)' apps/agent/src/files.rs          # :2776 — the beyond-sent rule, a different one

# B-12f: two lists of the same 16 wire codes — one typed and enforced, one bare and unverified.
#        Both halves below, each with a control in the same invocation.
#   The Rust side — count literals per spelling, so a MISSING spelling shows as 1 (as_str only),
#   and a PINNED one shows as >=2. Positive control = FILE_EXISTS (4), which must not read 1.
for s in PATH_OUTSIDE_ROOT INVALID_PATH NOT_FOUND NOT_A_FILE NOT_A_DIRECTORY FILE_EXISTS \
         FILE_TOO_LARGE TRANSFER_BUSY TRANSFER_UNKNOWN TRANSFER_TIMEOUT IO_ERROR BAD_FRAME \
         RESUME_INVALID DIR_NOT_EMPTY PERMISSION_DENIED QUEUE_FULL; do
  printf "%-18s %s\n" "$s" "$(grep -c "\"$s\"" apps/agent/src/files.rs)"
done
#   -> 16 spellings; BAD_FRAME 8, TRANSFER_UNKNOWN/TIMEOUT 5, FILE_EXISTS/TRANSFER_BUSY 4 …
#      DIR_NOT_EMPTY 1 and PERMISSION_DENIED 1 = as_str() only, i.e. pinned by NO test.
#      RESUME_INVALID 2 / QUEUE_FULL 2 = as_str() + `test_error_code_str_mapping` (:3506).
sed -n '2357,2375p' apps/agent/src/files.rs   # 12 cases; `assert_eq!(cases.len(), 12)`
sed -n '3505,3509p' apps/agent/src/files.rs   # the 2: RESUME_INVALID, QUEUE_FULL  => 14 of 16
sed -n '166,187p'   apps/agent/src/files.rs   # the enum: 16 variants, QueueFull #[allow(dead_code)]
sed -n '179p'       apps/agent/src/files.rs   # "// Week 11 additions (spec §3.4, …)" — names the gap

#   The TS side — the union is COMPLETE (16 of 16), split across two test files.
sed -n '98,114p' packages/shared/src/types/files.ts | grep -cE "^\s*\| '"   # union: 16 members
#   Careful with a bare `grep -c "| '"` on that file: it returns 23 (eight other unions live in
#   it). Scoping to :98-114 gives 16; the 23 is the positive control.
sed -n '75,93p'  packages/file-core/src/client.ts    # isFilesErrorCode: 16 literals, UNTYPED
grep -rn "isFilesErrorCode" --include=*.ts --include=*.vue packages/ apps/   # 2 sites: def + call, NO test
sed -n '81,105p' packages/shared/test/file-types.test.ts   # 12 originals; `.size` assertion at :98
sed -n '40,48p'  packages/shared/test/files-types.test.ts  # the 4 Week-11 codes; `toHaveLength(4)` at :47
#   -> together: 16 of 16 spelled. NOTHING unspelled. The defect is the assertions, not the list.
#      Both `new Set(codes).size === 12` and `toHaveLength(4)` are computed FROM the array two
#      lines above them, so each passes at any union size. That is the vacuity.

#   No exhaustive guard exists anywhere — READ THIS ONE CAREFULLY, the first form is a DECOY:
grep -rn 'Record<FilesErrorCode\|satisfies Record<FilesErrorCode' packages/ apps/   # 0  <- MISLEADING
grep -rn 'Record<FileClientErrorCode' packages/ apps/                              # 1  <- THE REAL GUARD
#   -> the guard EXISTS, at apps/web/src/lib/file-errors.ts:8, and it is exhaustive by
#      construction (Record<Union,V> -> a missing key is TS2741). The first grep returns 0 only
#      because the check is written against FileClientErrorCode, not FilesErrorCode.
#      A positive control read backwards is still a misread: "0 hits" here is evidence of the
#      wrong PATTERN, not of an absent guard.
sed -n '1,26p' apps/web/src/lib/file-errors.ts   # 17 keys = 16 wire codes + CANCELLED
grep -cE '^  [A-Z_]+:' apps/web/src/lib/file-errors.ts   # 17 — the positive control on the count

#   The mechanism control, in isolation (why the guard is real and not incidental):
#   const m: Record<'A'|'B'|'C', string> = { A, B }
#   -> error TS2741: Property 'C' is missing in type '{ A: string; B: string; }'
#      but required in type 'Record<"A" | "B" | "C", string>'.

#   What the union itself proves — both polarities, so "it type-checks" is not the whole story:
#   subset (4 codes dropped)          -> SILENT, tsc exit 0
#   misspelling ('BAD_FRME')          -> TS2820 "not assignable … Did you mean 'BAD_FRAME'?"
#   Record<FilesErrorCode, true> minus one key -> TS2741 "Property 'QUEUE_FULL' is missing"
#   Record<FilesErrorCode, true> plus a bogus key -> TS2353 "may only specify known properties"
#   => the union guards SPELLINGS; the Record in apps/web guards COMPLETENESS. The union alone
#      does not — that is the correction to "the union makes a missing code a tsc error".

#   The ONE artefact that can fall behind: the bare, untyped, untested runtime list.
grep -rn "isFilesErrorCode" --include=*.ts --include=*.vue packages/ apps/   # 2: def :75, call :568
ls packages/file-core/test/                                                   # 5 test files, none names it
sed -n '32,42p' packages/file-core/test/operations.test.ts   # pins the FALLBACK (unknown -> BAD_FRAME),
#                                                           # not which strings are known

#   Where each change lands — the gating premise checked rather than assumed:
cat packages/shared/tsconfig.json    # include: ["src/**/*.ts","test/**/*.ts"] — the gating
                                     # typecheck DOES compile the two test files
sed -n '86p'  .github/workflows/ci-node.yml    # typecheck — gated (tsc shared, vue-tsc web)
sed -n '105,111p' .github/workflows/ci-node.yml # gating test run EXCLUDES @ponter/shared
sed -n '117,119p' .github/workflows/ci-node.yml # its test step is continue-on-error: true
#   -> misspelled: RED. added to the union only: RED (TS2741, via file-errors.ts:8).
#      added to the union AND the Record but missing from isFilesErrorCode: GREEN — and the wire
#      degrades to BAD_FRAME. The union's size asserted: green always, self-satisfying, and it
#      runs in the continue-on-error step.

# B-12c(e): which frame cap is pinned-but-unenforced, and which are alive
grep -n "MAX_FRAME_BYTES\|MAX_INBOUND_FRAME_BYTES\|MAX_DATA_CHANNEL_FRAME_BYTES" \
  docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#   -> MAX_DATA_CHANNEL_FRAME_BYTES: declared :1156, re-exported :1083, asserted :1105,
#      ENFORCED NOWHERE   -> "pinned by a test and enforced nowhere" (not "consumed by nothing").
#      MAX_INBOUND_FRAME_BYTES: declared :1154, asserted :1101, enforced :1320 (signalling only).
#      MAX_FRAME_BYTES: declared :5333, ONE occurrence in the whole document, no caller.
grep -n "raw.length >" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#   -> :1320 only. No length check on the files path; parseJson(:7315) parses, never refuses.

# B-12c(f): the inbound field-name contract — 7 of 12 shapes, and two handlers reading
#           names the wire does not carry. Positive controls first (fields the wire DOES carry).
P=docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
for f in transferId path name requestId direction oldPath newPath dir recursive from toPath toName; do
  printf "%-12s %s\n" "$f" "$(grep -c "message\.$f\b" $P)"
done
#   -> transferId 10, path 6, requestId 3, direction 3, name 2 (controls: nonzero)
#      from/toPath/toName 1 each (the rename handler) — and oldPath/newPath/dir/recursive 0.
grep -n "pub enum FilesInbound" -A 16 apps/agent/src/files.rs   # 12 variants, :489-504
grep -cE '^\s+"files-[a-z-]+" =>' apps/agent/src/files.rs       # decode arms: 12 (:596-632)
#   (a bare `grep -c '"files-'` returns 34 — it also matches the wire constants and the tests.
#    The anchored arm pattern is the one that answers "how many shapes can it decode".)
sed -n '2432,2481p' apps/agent/src/files.rs                    # the test: 7 shapes only
sed -n '4967,4972p;5003,5009p' $P                              # the plan's mkdir / rename reads
sed -n '152,171p' packages/shared/src/types/files.ts           # wire: {dir,name}, {oldPath,newPath}
sed -n '175,211p' packages/file-core/src/client.ts             # browser sends the wire names

# B-12a: the three untested dispatch arms and the dropped flag
sed -n '/^  private dispatch/,/^  }/p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md | grep -oE "case '[a-z-]+'"   # 12 arms
grep -c "type: 'files-mkdir'\|type: 'files-delete'\|type: 'files-rename'" \
  <(sed -n '3861,5125p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md)   # 0 test sites
grep -n 'recursive' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md      # only :2241 mkdirSync opt + :4974 a comment
grep -n 'recursive' packages/shared/src/types/files.ts                                            # :163 — the field exists
grep -n 'recursive' packages/file-core/src/client.ts                                              # :189,195 — the browser sends it
sed -n '546,550p;901,941p' apps/agent/src/files.rs                                                # the Rust honours it

# and the browser is the flag's only producer for directories:
grep -n 'isDirectory' apps/web/src/components/files/DeleteConfirmDialog.vue                       # :26 -> recursive arg
grep -n 'filesDelete' apps/web/src/components/files/FilesView.vue apps/web/src/stores/terminal.ts  # :145 -> :1890 -> client.delete
grep -n "docs', true" apps/web/src/__tests__/FilesView.test.ts                                    # :443 pins recursive=true (the it( opens at :434)

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

# B-10 addendum: the two-m-line + pacer half, and the four closed questions
#   the crate source (rtc 0.21.0, pinned by apps/agent/Cargo.lock:2619-2620)
sed -n '676,694p' ~/.cargo/registry/src/*/rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs
#     -> `for kind in [RtpCodecKind::Video, RtpCodecKind::Audio]` : the delta is BOTH m-lines
sed -n '713,717p' ~/.cargo/registry/src/*/rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs
#     -> `.with(Slot::Pacer, PacerBuilder::new().build())` : the Rust paces too
sed -n '641,642p' ~/.cargo/registry/src/*/rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs
#     -> "Congestion control implies pacing ... not something an application should acquire without asking."
sed -n '900,906p' ~/.cargo/registry/src/*/rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs
#     -> a test asserting Slot::Pacer is ABSENT from the default chain
grep -n "configure_twcc_receiver_only" ~/.cargo/registry/src/*/rtc-0.21.0/src/peer_connection/configuration/interceptor_registry.rs | head -3
#     -> :206, called by register_default_interceptors :196-211. So the VIDEO half of the
#        transport-cc delta is NOT congestion control's: it is already in the default path,
#        which is why `rtc.rs`'s "changes the SDP, gated on has_control" comment is only
#        true of the AUDIO half and of the Pacer. The comment overstates by half.

#   engine has no send-side pacer to port to
grep -ri "pacer\|pacing" <werift>/lib --include=*.js | grep -v ".map"   # 1 hit, SCTP comment only

#   the rtcp-fb echo, confirmed against THIS repo's captured SDP
python3 -I -c "import json;d=json.load(open('apps/agent/spike/report.json'));r=d['runs'][0];
print('answer transport-cc:', r['answerSdp'].count('transport-cc'));
print('answer extmap:', [l for l in r['answerSdp'].split(chr(13)+chr(10)) if 'extmap' in l]);
print('offer twcc extmap:', [l for l in r['offerSdp'].split(chr(13)+chr(10)) if 'draft-holmer' in l])"
#     -> answer advertises `a=rtcp-fb:102 transport-cc` (8x) with local TWCC off, and carries
#        NO extmap at all, while the Chrome offer carries `a=extmap:4 ...transport-wide-cc...`
#        That is the whole "echoes rtcp-fb, not extmap" finding, from evidence already in-tree.

#   werift surface reachability + the leak
grep -n "senderBWE" <werift>/lib/webrtc/src/media/rtpSender.d.ts        # :27 import, :41 readonly field
sed -n '76,82p' <werift>/lib/webrtc/src/media/sender/senderBWE.js       # _availableBitrate = 0
sed -n '133,140p' <werift>/lib/webrtc/src/media/sender/senderBWE.js     # Object.keys(sentInfo) -> never deletes
python3 -I -c "import json;print(json.load(open('<werift>/package.json'))['exports'])"
#     -> only "." and "./nonstandard"; SenderBandwidthEstimator is not a root export

# B-11: the list() wire shape diverges on seven counts
sed -n '4439,4454p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md   # the fence
sed -n '286,292p;1326,1341p' apps/agent/src/files.rs                                        # the contract + build
sed -n '6,13p' packages/shared/src/types/files.ts                                           # the wire type
grep -n "entry.isDirectory\|entry.size\|entry.modifiedAt\|entry.path" \
  apps/web/src/components/files/FilesView.vue                                               # :77 :304 :314 :325 :328
grep -n "isDirectory" packages/webrtc-core/test/e2e/files.e2e.test.ts                       # :123, :127 (goes red)
grep -c modifiedEpochMs docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md  # 1 (:4451)
grep -rn modifiedEpochMs apps packages --include=*.ts --include=*.vue                          # 0 — no mapping site
#   the three Rust list tests, none present in Plan 2
for t in list_returns_entries_sorted_dirs_first list_on_a_file_is_not_a_directory \
         list_cap_truncates_at_4096_with_the_flag; do
  printf '%-45s rust=%s plan=%s\n' "$t" \
    "$(grep -c "$t" apps/agent/src/files.rs)" \
    "$(grep -c "$t" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md)"
done                                                                                        # rust=1 plan=0 (x3)
#   divergence 7: Node raises ENOTDIR, and list() does not route it through errnoToCode
node -e "try{require('fs').readdirSync('/etc/hostname',{withFileTypes:true})}catch(e){console.log(e.code,e.errno)}"
#     -> ENOTDIR -20 ; the plan's errnoToCode maps it (:3738-3746) but list() (:4440)
#        calls readdirSync outside any try, so handle()'s generic catch (:4362-4367) makes it IO_ERROR

# N-3a: one phantom name, one test mislabelled as new
grep -rn "drained" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#     -> exactly ONE line, :4888 — the declaration sentence itself. No it(), no assertion.
grep -n "paused transfers do not time out" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md  # :4221
grep -n "async fn paused_state_survives_idle_timeout" apps/agent/src/files.rs                                       # :3834 — it is a port
#     -> the Rust version downloads, pauses, forces `deadline` into the past, asserts check_idle() is EMPTY

# N-3b: the promised FILES_IDLE_TIMEOUT_MS assertion is in no fence
grep -n "FILES_IDLE_TIMEOUT_MS" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
#     -> :3964 def | :4286 :4295 test-file import + re-export | :4495 :4515 :4531 :4572 :4609 :4772 production uses.
#        NO `expect(FILES_IDLE_TIMEOUT_MS)` anywhere. The only 30_000 in a test fence is `now = 30_000` (:4237),
#        a fake-clock value inside 'kills a stalled transfer', not an assertion on the constant.
sed -n '40,46p' apps/agent/src/files.rs    # comment says "pinned by ... its own assertion"; cfg(test) shrinks 30_000 -> 50
awk 'NR>=2287' apps/agent/src/files.rs | grep -c FILES_IDLE_TIMEOUT
#     -> 0 : the test module (starts :2287) really does contain no pin. The Rust gap is real;
#        the TS "prod timeout equals it" assertion would be `expect(X).toBe(X)` — vacuous. TS has ONE constant.

# N-4a: the read buffer IS the 16 KiB bound; the framer is not
grep -n "read(&mut" apps/agent/src/pty.rs          # ONE hit, :394 — the only production read
sed -n '391,398p' apps/agent/src/pty.rs            # vec![0u8; MAX_PTY_CHUNK] (:392) then buf[..n] (:397)
node -e "const fs=require('fs');const p='/tmp/r.bin';fs.writeFileSync(p,Buffer.alloc(500000,65));
const a=Buffer.alloc(16384),b=Buffer.alloc(65536);
const f1=fs.openSync(p,'r'),f2=fs.openSync(p,'r');
console.log('16KiB buffer ->',fs.readSync(f1,a,0,a.length,null),'  64KiB buffer ->',fs.readSync(f2,b,0,b.length,null))"
#     -> 16384 and 65536 : read() cannot exceed the buffer. So pty.rs:392 bounds every
#        emitted chunk, and `frame_pty_output` (:141) being length-agnostic proves nothing.
#        "The Rust enforced nothing" is FALSE as written, and as of 844ba29 it is in
#        THREE places: Plan 3 T8 :228 and :248, Plan 2 Task 12 declaration :5531.
#        The T8 preamble (:222-223, "only the Rust failed to meet it") frames it the same way.

# §9.0: PM's post-audit Plan 3 evidence, re-checked
R=.superpowers/cargo-home/registry/src/index.crates.io-1949cf8c6b5b557f/rtc-0.21.0
sed -n '717p' $R/src/peer_connection/configuration/interceptor_registry.rs   # Slot::Pacer
sed -n '676,692p' $R/src/peer_connection/configuration/interceptor_registry.rs # feedback loop + extmap None
sed -n '917,946p' $R/src/peer_connection/configuration/media_engine.rs       # update_header_extension
grep -rniE 'audio' apps/agent/src/ --include=*.rs                            # 0 hits
W=<werift>; grep -rniE 'pacer|pacing' $W/lib/ --include=*.js --include=*.ts  # 1 hit, sctp only
sed -n '133,142p' $W/lib/webrtc/src/media/sender/senderBWE.js                # the NaN eviction defect
sed -n '612,620p' $W/lib/webrtc/src/media/rtpSender.js                       # sentInfo's four fields
sed -n '265p' $W/lib/webrtc/src/transceiverManager.js                        # the extmap conjunction filter
sed -n '1084,1087p' $W/lib/webrtc/src/peerConnection.js                      # headerExtensions default []
sha256sum .superpowers/probes/be-twcc-sdp/{probe.mjs,output.txt}             # matches the pinned hashes

# The B-11 repair, re-verified against all seven divergences
sed -n '4582,4625p' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md
grep -n "it('lists entries sorted\|it('reports NOT_A_DIRECTORY\|it('truncates at the cap" \
  docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md     # :4118 :4145 :4155
grep -c "drained" docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-2-core.md  # 0 — phantom gone
```
