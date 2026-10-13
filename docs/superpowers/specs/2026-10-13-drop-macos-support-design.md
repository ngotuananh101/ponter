# Drop macOS Platform Support — Design Spec

- **Status:** Draft (under user review)
- **Phase:** Platform consolidation (Windows + Linux only)
- **Related:** `apps/agent/src/{lib,cursor,desktop,input}.rs`, `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json}`, `apps/desktop/src-tauri/src/{autostart,keychain}.rs`, `apps/desktop/src-tauri/src/commands/{wizard,devices}.rs`, `.github/workflows/{build-agent,build-desktop}.yml`, `apps/web/src/components/agent/RegisterAgentDialog.vue`, `README.md`, `docs/ARCHITECTURE.md`, `docs/guides/{agent-setup,self-hosting,development}.md`.

---

## 1. Context & Motivation

The owner has decided to drop macOS as a supported platform across the whole
repository. The driver is concrete and non-negotiable: shipping a usable macOS
build requires **Developer ID signing + notarization**, which requires a paid
Apple Developer Program account the owner does not have. Without it, Gatekeeper
blocks the app ("developer cannot be verified") and, on Apple Silicon, an
unsigned app will not launch at all. This is the **only** platform where the
absence of a developer account actually blocks distribution:

- **Windows:** unsigned builds run. A downloaded installer triggers a
  SmartScreen "unknown publisher" prompt, which is cosmetic and bypassable
  ("More info → Run anyway"). No account required.
- **Linux:** no OS-level signing requirement at all. `.deb` / `.rpm` /
  `.AppImage` / raw binaries run as-is. No account required.
- **Auto-update:** uses the Tauri updater's **minisign** signature, whose keypair
  is generated locally with `tauri signer generate` — free, no account. Unrelated
  to OS code-signing.

Because macOS is the sole blocking platform and the owner cannot build for it,
keeping macOS code, CI jobs, and documentation in the repo adds cost with no
shippable benefit: macOS CI runners consume minutes on every agent/desktop
change, and the code carries `#[cfg(target_os = "macos")]` branches that can
never be exercised or released.

**Goal:** remove macOS support entirely and honestly, so the repository
consistently targets **Windows + Linux only** — no dead platform branches, no
macOS CI runners, no documentation that claims macOS support — while recording
the decision and its rationale so it can be reversed deliberately later.

---

## 2. Scope

### In scope

- `apps/agent` — macOS `cfg` branches and macOS-only doc comments.
- `apps/desktop` — macOS autostart, keychain backend, bundle icon, wizard
  guidance, device platform arm.
- CI — macOS targets in `build-agent.yml`; the macOS matrix leg, `.dmg`
  artifact handling, `darwin` manifest branch, and macOS signing comments in
  `build-desktop.yml`.
- `apps/web` — the `macos` option in `RegisterAgentDialog`.
- Living documentation that asserts macOS support.
- A new ADR recording the decision.

### Out of scope (explicit non-goals)

- **No behavior change** for Windows or Linux. Every remaining code path must be
  byte-for-byte equivalent in behavior to today.
- **No data migration.** The server's `platform` column is free-form `TEXT`
  (verified: `apps/server/src/db/schema.ts:52` `platform: text('platform')`, and
  `apps/server/src/routes/agents.ts:38` `platform?: string`) — there is no hard
  union to shrink and no validation to relax. Existing rows with
  `platform = 'macos'` are left untouched (owner: "not concerned").
- **No server changes.** The server does not enumerate or validate platforms; it
  stores and groups whatever string it receives. Nothing to remove.
- **No `apps/mobile` changes.** That app is an empty placeholder (no source
  files) and contains no macOS references.
- **No rewrite of historical records.** `docs/superpowers/{specs,plans}/*`,
  `docs/demos/*`, `docs/spikes/*`, `docs/notes/*`, and `docs/security/*` are
  point-in-time records; they stay as written.
- **No new GUI / viewer work.** This is the standalone "clean up macOS" task
  (item A), independent of the native-app and viewer tasks (items B and C).

---

## 3. Architecture Decision — ADR-78: Drop macOS Platform Support

- **Decision:** macOS is removed as a supported platform for the agent and the
  desktop app. The repository targets **Windows (x86_64-pc-windows-msvc) and
  Linux (x86_64/aarch64 gnu, x86_64 musl)** only. All macOS-specific code paths,
  build targets, CI jobs, and living documentation are deleted, not disabled.
- **Rationale:** Distribution on macOS requires a paid Apple Developer Program
  account for signing/notarization; without it Gatekeeper blocks the app and
  unsigned binaries will not launch on Apple Silicon. The owner does not have
  that account and does not intend to obtain one. Keeping un-shippable platform
  code imposes ongoing CI cost and maintenance surface.
- **Alternatives rejected:**
  - *Keep macOS behind a default-off feature flag.* Rejected — leaves all macOS
    code in the tree and does not achieve "clean up"; the owner asked for
    removal, not gating.
  - *Keep macOS CI, drop only the runtime code.* Rejected — CI would still spend
    macOS runner minutes building code that cannot be released.
  - *Sign/notarize with a free account.* Not possible — Apple Developer Program
    is paid; there is no free tier that permits notarization.
- **Consequences:**
  - (+) Smaller tree, simpler `cfg` expressions, faster CI (no macOS runners).
  - (+) Documentation matches reality.
  - (−) Re-adding macOS later requires re-authoring the deleted code; the
    decision and the exact deleted surface are recoverable from git history and
    from §4 below.
- **Recovery:** the removal lands as one or two squash commits; `git log` /
  `git show` on those commits recovers every deleted line. §4 enumerates the
  deleted surface so a future re-introduction is a guided task, not an
  archaeology exercise.

---

## 4. Detailed Changes

### 4.1 `apps/agent` (Rust)

Five source files carry macOS conditionals. All are **narrowing of existing
`cfg` expressions** or removal of macOS-only branches — no logic is rewritten.

| File | Current | Change |
|---|---|---|
| `src/cursor.rs:126` | `#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]` on `pub mod platform` | Drop `not(target_os = "macos")` → `#[cfg(all(unix, not(target_env = "musl")))]` |
| `src/lib.rs:2354` | `#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]` (cursor poller task) | Same narrowing |
| `src/lib.rs:2162` | `#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]` (cursor source clone) | Same narrowing |
| `src/lib.rs:2406`, `:2408` | `#[cfg(not(all(unix, not(target_os = "macos"), not(target_env = "musl"))))]` / positive arm | Both narrowed to the macOS-free predicate |
| `src/lib.rs:2031` | `cfg!(target_os = "macos")` passed as `cursor_in_frame` to `frame_desktop_sources` | Replace with literal `false` |
| `src/desktop.rs:1848-1850` | Doc comment: `cursor_in_frame` is `cfg!(target_os = "macos")` | Update comment: the flag is always `false` now (cursor is never captured in-frame) |
| `src/input.rs:355-360` | `#[cfg(target_os = "macos")]` enigo `Settings { open_prompt_to_get_permissions: false, .. }` + `#[cfg(not(target_os = "macos"))]` default | Delete the macOS arm; keep `let settings = enigo::Settings::default();` unconditionally |
| `src/desktop.rs:358` | Doc comment referencing `x86_64-apple-darwin` build failure | Reword without the macOS reference (keep the `Send` rationale) |
| `src/cursor.rs:8,125` | Doc comments naming macOS | Reword to "non-Linux unix (musl)" |

**Important — the `frame_desktop_sources` unit test is NOT changed.** The test at
`desktop.rs:2730-2745` pins `cursorInFrame` in **both** directions by calling the
framing function with `true` and `false` directly. It tests the function's
contract (render whatever it is given), not the production call site. Hardcoding
the call site to `false` does not affect it. This is deliberate: the two-branch
assertion is a property of the pure function and must be preserved.

### 4.2 `apps/desktop` (Tauri backend)

- **`src-tauri/Cargo.toml`:**
  - `keyring = { version = "4.2.0", features = ["apple-native-keyring-store"] }`
    → `keyring = { version = "4.2.0", default-features = false, features = ["windows-native-keyring-store", "zbus-secret-service-keyring-store"] }`.
    The `keyring 4.2.0` default feature set is `v1 = [apple, windows, zbus]`; the
    new config keeps Windows (Credential Manager) and Linux (Secret Service via
    zbus) and drops Apple. Verified against the crate's `[features]` table.
  - Remove any macOS-only dependency lines if present (none beyond the keyring
    feature are macOS-specific).
- **`src-tauri/tauri.conf.json`:** remove `"icons/icon.icns"` from
  `bundle.icon`. `targets: "all"` stays — it now resolves to the Linux + Windows
  bundle set.
- **`src-tauri/src/autostart.rs`:** delete `MACOS_LABEL`, `MACOS_ENTRY_FILE`,
  `macos_launch_agents_dir()`, `render_macos_plist()`, and every
  `#[cfg(target_os = "macos")]` / `#[cfg(not(any(...)))]` arm that references
  them (6 `cfg` sites). The platform dispatch collapses to Linux + Windows. The
  `#[cfg(not(any(target_os = "linux", target_os = "windows")))]` unsupported
  arms remain (they still cover unknown targets).
- **`src-tauri/src/keychain.rs`:** doc comment only — drop "macOS Keychain" from
  the list of abstracted stores.
- **`src-tauri/src/commands/wizard.rs`:** remove the macOS branch in the capture
  error guidance (`:71`) and the macOS guidance test (`:326`).
- **`src-tauri/src/commands/devices.rs:250`:** remove the `"macos" => "macos"`
  arm from `device_platform()`; keep `linux` / `windows` / `other`.
- **`apps/desktop/README.md`:** remove the macOS config-path line (`:75`).

### 4.3 CI

- **`.github/workflows/build-agent.yml`:**
  - Remove the two `*-apple-darwin` matrix targets (`:119-120`) and their two
    `include` entries (`:142-151`). Matrix shrinks from 6 to 4 targets
    (`x86_64/aarch64-linux-gnu`, `x86_64-linux-musl`, `x86_64-pc-windows-msvc`).
  - Remove any macOS-specific steps (e.g. codesign, `.dmg` packaging) if present
    in the agent workflow.
- **`.github/workflows/build-desktop.yml`:**
  - Matrix `os: [ubuntu-latest, macos-14, windows-latest]` → `[ubuntu-latest, windows-latest]`; drop the `macos-14` `include` entry.
  - Remove the "Upload macOS dmg artifact" step (`:208-214`).
  - Remove `.dmg` from the installer-assert glob and the `macos-14` special-case
    comment (`:259-284`).
  - Remove the `darwin` branch in the `latest.json` assembly script (`:444`) and
    the `dist/**/*.dmg` upload path (`:491`).
  - Remove the commented "macOS signing" secret block (`:139-145`) and the
    `APPLE_*` secret names from the header comment (`:16-19`).
  - Keep the `windows` + `linux` branches untouched.

### 4.4 `apps/web`

- **`RegisterAgentDialog.vue`:** narrow the union
  `ref<'linux' | 'macos' | 'windows'>('linux')` → `ref<'linux' | 'windows'>('linux')`
  (`:35`); remove the macOS button block (`:247-254`). The default stays `linux`.
- **Tests:** `RegisterAgentDialog.test.ts` already exercises `linux` and
  `windows` only (no `macos` case exists), so **no test change is required**.
  Verified by grep: the test file contains no `macos` reference.

### 4.5 `apps/server`

No changes. `platform` is free-form text; nothing validates or enumerates it.

### 4.6 Documentation

**Living docs — updated:**

| File | Line | Change |
|---|---|---|
| `README.md` | 37 | Drop `macOS` from the desktop-shell platform list → `(Linux, Windows)` |
| `docs/ARCHITECTURE.md` | 126 | Drop `macOS` from the agent platform label → `(Windows / Linux)` |
| `docs/ARCHITECTURE.md` | 1022 | Reword the "Limitations" note: signing is Windows-only now; drop the macOS signing reference |
| `docs/ARCHITECTURE.md` | 1024 | Keep ADR-57 example keys but drop the `darwin-aarch64-app` example |
| `docs/ARCHITECTURE.md` | 1146-1147 | Delete the two `*-apple-darwin` build lines |
| `docs/guides/agent-setup.md` | 3 | Drop `macOS` from the supported-platform sentence |
| `docs/guides/agent-setup.md` | 222-224 | Delete the "macOS LaunchDaemon (Pending)" section |
| `docs/guides/self-hosting.md` | 107 | Delete the macOS config-path bullet |
| `docs/guides/development.md` | 329 | Drop `.dmg on macOS` from the bundle list |
| `docs/ARCHITECTURE.md` | §8 trail | Append the new PR(s) to the §8 trail block (see §7) |

**Historical records — untouched:** all `docs/superpowers/{specs,plans}/*`,
`docs/demos/*`, `docs/spikes/*`, `docs/notes/*`, `docs/security/*`. These record
what was true when written; rewriting them would falsify the record.

---

## 5. Testing & TEST-INTEGRITY Declaration

This change **deletes tests whose subject code is deleted**. Per the
TEST-INTEGRITY rule, every test change is declared before→after with a reason.
No test is deleted to make a suite pass; each deleted test's subject no longer
exists.

### Deleted tests (subject code removed)

| File | Test(s) | Count | Reason |
|---|---|---|---|
| `apps/desktop/src-tauri/src/autostart.rs` | `macos_launch_agents_dir_home`, `macos_launch_agents_dir_none`, `render_macos_plist_contains_binary_and_label` | 3 | `macos_launch_agents_dir()` and `render_macos_plist()` are deleted with the macOS support |
| `apps/desktop/src-tauri/src/commands/wizard.rs` | `capture_error_macos_guidance` | 1 | The macOS guidance branch is deleted |

**Net test count delta:** −4 tests (all Rust unit tests, all covering
deleted macOS-only code).

### Preserved tests (explicitly NOT changed)

- `desktop.rs` `frame_desktop_sources` test — pins `cursorInFrame` both ways on
  the **pure function**; the call site becomes a literal `false` but the function
  contract is unchanged. No edit.
- All Linux autostart tests (`linux_autostart_*`, `render_linux_desktop_entry_*`,
  `file_helpers_round_trip_in_temp_dir`, `set_autostart_in_round_trip_in_temp_dir`,
  `is_autostart_enabled_in_false_when_not_present`) — unchanged.
- All Windows autostart tests (`windows_run_add_args_exact`,
  `windows_run_delete_args_exact`) — unchanged.
- `keychain.rs` `round_trips_a_secret` — unchanged (keyring feature swap must not
  break it).
- `RegisterAgentDialog.test.ts` — unchanged (already Windows/Linux only).

### New verification required (not a test change, a build gate)

- `apps/agent` must **compile and pass tests** on Linux **and** Windows after the
  `cfg` narrowing.
- `apps/desktop` must **compile and pass tests** on Linux **and** Windows after
  the keyring feature swap (the real risk: the Secret Service / Credential
  Manager backends must still link and resolve).
- CI proves the Windows leg; the Linux leg is proven locally and in CI.

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Keyring feature swap breaks Linux or Windows keychain at runtime | Low | High | Explicitly re-enable `windows-native-keyring-store` + `zbus-secret-service-keyring-store`; the `round_trips_a_secret` test must stay green on both; CI builds both legs |
| A macOS reference is missed (code, CI, or docs) | Medium | Low | A verification checklist (§8) greps for `macos\|darwin\|apple\|\.icns\|videotoolbox` across code + CI + living docs; the only allowed hits are in historical docs |
| `cfg` narrowing changes behavior on an unintended target | Low | Medium | The narrowed predicate is a strict subset of the old one for Windows/Linux; the unit tests for the affected modules stay green |
| Windows CI is the only automated proof (no local Windows) | Medium | Medium | The desktop matrix already builds Windows; PR CI is the gate; the Linux leg is verified locally |

---

## 7. Delivery Plan (2 PRs)

Split by the repository's existing convention of separating code/CI from docs.

**PR 1 — code + CI (non-docs):**
- `apps/agent/src/{cursor,lib,desktop,input}.rs`
- `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json}` +
  `src/{autostart,keychain}.rs` + `src/commands/{wizard,devices}.rs`
- `.github/workflows/{build-agent,build-desktop}.yml`
- `apps/web/src/components/agent/RegisterAgentDialog.vue`
- Triggered CI: the agent + desktop workflows (both now Windows/Linux only) plus
  the standard Node checks. **QA binding verdict required** (test files change:
  4 Rust tests removed).

**PR 2 — docs:**
- `README.md`, `docs/ARCHITECTURE.md` (living sections + §8 trail), the three
  `docs/guides/*` files, and the new ADR-78 (recorded in the spec/ARCHITECTURE
  per repo convention).
- Docs-only ⇒ SonarCloud only, no QA binding (precedent: #108/#111/#113/#114).

The §8 trail entry for PR 1 and PR 2 is added in PR 2 (docs), consistent with
how prior merges recorded their trail.

---

## 8. Verification Checklist (for QA / PM cross-check)

1. `grep -rniE "macos|darwin|apple|\.icns|videotoolbox"` across `apps/**`,
   `.github/workflows/**`, and living docs returns **zero** hits outside
   `docs/superpowers/**`, `docs/demos/**`, `docs/spikes/**`, `docs/notes/**`,
   `docs/security/**`, `node_modules`, `target`, and `vendor`.
2. `apps/agent` builds + tests pass on Linux; CI's Windows leg passes.
3. `apps/desktop` builds + tests pass on Linux; CI's Windows leg passes.
4. `keychain.rs::round_trips_a_secret` green on Linux and Windows.
5. `build-agent.yml` matrix has exactly 4 targets, none `*-apple-darwin`.
6. `build-desktop.yml` matrix has exactly 2 OS legs (`ubuntu-latest`,
   `windows-latest`); no `.dmg`, no `darwin`, no `APPLE_*`.
7. `RegisterAgentDialog.vue` union is `'linux' | 'windows'`; no macOS button.
8. Net test delta is exactly −4 (the four declared macOS tests); no other test
   file changed.
9. `README.md` / `ARCHITECTURE.md` / guides state Windows + Linux only.
10. Zero `Co-authored-by` trailers in the commits.
