# Drop macOS Platform Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove macOS as a supported platform from the whole repository — every macOS code path, build target, CI job, and living-doc claim — so the tree honestly targets Windows + Linux only, recording the decision as ADR-78.

**Architecture:** Deletion, not gating. Agent `cfg` predicates are narrowed (macOS was the only excluded non-musl unix target, so `all(unix, not(target_os = "macos"), not(target_env = "musl"))` becomes `all(unix, not(target_env = "musl"))`); macOS-only functions and their unit tests are deleted outright; the desktop crate's keyring feature is switched off Apple; CI matrices drop their macOS legs and all `.dmg`/`darwin`/`APPLE_*` handling. No behavior changes for Windows or Linux.

**Tech Stack:** Rust (`apps/agent`, `apps/desktop/src-tauri`), Tauri v2, GitHub Actions, Vue 3 (`apps/web`), Markdown docs.

**Spec:** `docs/superpowers/specs/2026-10-13-drop-macos-support-design.md`

## Global Constraints

- **No behavior change** for Windows or Linux. Every remaining code path must behave exactly as today.
- **No server changes.** `apps/server` stores `platform` as free-form `TEXT`; nothing validates or enumerates it (`apps/server/src/db/schema.ts:52`). Existing `platform = 'macos'` rows are left untouched.
- **No `apps/mobile` changes** (empty placeholder, no macOS references).
- **No rewrite of historical records:** `docs/superpowers/{specs,plans}/*`, `docs/demos/*`, `docs/spikes/*`, `docs/notes/*`, `docs/security/*` stay as written.
- **TEST-INTEGRITY:** the only test change is the deletion of **5** Rust unit tests whose subject code is deleted. Net test delta is exactly **−5**. No other test file changes. Every deletion is declared in Task 2 / Task 3 with before→after counts.
- **Commit attribution:** NEVER add a `Co-authored-by` trailer. Author identity: `Ngo Tuan Anh <ngotuananh2101@gmail.com>`.
- **Language:** all code, identifiers, comments, commit messages, and repo docs in **English**.
- **Keyring:** the manifest must keep a feature that enables the `v1` API — `features = ["v1"]`. A store-only feature list does **not** compile (`keyring 4.2.0` `src/lib.rs:32` `compile_error!`). `apple-native-keyring-store` remains in `Cargo.lock` (target-gated optional dep) and that is correct.
- **Sweep allow-list:** after the change, `grep -rniE "macos|darwin|apple|\.icns|videotoolbox"` may hit only: historical docs, `Cargo.lock`, and the two `-apple-system` CSS font tokens (`apps/web/src/style.css:12`, `apps/desktop/src/style.css:12`).

## Review Focus

These are the input classes / failure modes the spec implies but that no *new* test pins; each is covered by an existing test, a compile gate, or the Task 4 sweep. Most likely to bite first:

1. **A Linux capture permission error** (e.g. `"permission denied"`) now returns the string **verbatim** — the deleted macOS branch used to append "Screen Recording in System Settings". Pinned by the preserved `capture_error_unknown_passthrough` test (same `else { err.to_string() }` branch) — the pass-through contract is unchanged.
2. **The Linux/Windows keychain backend still resolves** after the keyring feature change. Pinned by the preserved `keychain.rs::round_trips_a_secret` (runs on Linux here; the Windows leg is proven by CI).
3. **Windows autostart is untouched** by the autostart.rs deletion. Pinned by the preserved `windows_run_add_args_exact` / `windows_run_delete_args_exact`; the Linux round-trip tests pin the file helpers.
4. **`cursor_in_frame` is `false` on every remaining target** (it was `cfg!(target_os = "macos")` = `false` on Windows/Linux already, so no change). Pinned by the preserved `frame_desktop_sources` test, which asserts both directions on the pure function.
5. **No `.dmg` / `darwin` / `APPLE_*` survives in CI** — a leftover would break `latest.json` assembly or the release asset assert. Pinned by the Task 4 sweep step and §8 checklist.

---

## Task 1: Agent — narrow macOS `cfg`s and drop macOS comments

**Files:**
- Modify: `apps/agent/src/cursor.rs:8,125,126`
- Modify: `apps/agent/src/lib.rs:2031,2162,2188,2349-2354,2406,2408,2477-2478`
- Modify: `apps/agent/src/desktop.rs:357-359,1848-1852,2730-2733`
- Modify: `apps/agent/src/input.rs:352-361,435,438,544-545`
- Modify: `apps/agent/Cargo.toml:78,82`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `desktop::frame_desktop_sources(sources, input_enabled, peer_verified, cursor_in_frame, timestamp_ms)` keeps its exact signature; the production call site in `lib.rs` now passes the literal `false` for `cursor_in_frame`.

- [ ] **Step 1: Narrow the cursor module gate and reword its docs**

In `apps/agent/src/cursor.rs`, change line 126 from:

```rust
#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]
pub mod platform {
```

to:

```rust
#[cfg(all(unix, not(target_env = "musl")))]
pub mod platform {
```

Then reword line 8 (the module doc) from `//! target (CI builds Windows and macOS too); only the X11 backend is cfg-gated` to:

```rust
//! target (CI builds Windows too); only the X11 backend is cfg-gated
```

and line 125 from `/// musl (terminal-only artifact) and is absent on macOS/Windows.` to:

```rust
/// musl (terminal-only artifact) and is absent on Windows.
```

- [ ] **Step 2: Narrow the four `lib.rs` gates and hard-code the cursor flag**

In `apps/agent/src/lib.rs`, change line 2031 from `        cfg!(target_os = "macos"),` to:

```rust
        false,
```

Change the three identical `#[cfg(all(unix, not(target_os = "macos"), not(target_env = "musl")))]` gates (lines 2162, 2354, 2408) and the negated gate (line 2406) to the macOS-free predicate:

- line 2162 → `    #[cfg(all(unix, not(target_env = "musl")))]`
- line 2354 → `    #[cfg(all(unix, not(target_env = "musl")))]`
- line 2406 → `    #[cfg(not(all(unix, not(target_env = "musl"))))]`
- line 2408 → `    #[cfg(all(unix, not(target_env = "musl")))]`

Reword the two comments:

- line 2188 (`// macOS/Windows/musl, where dc_rx is simply never awaited).`) →
  ```rust
        // Windows/musl, where `dc_rx` is simply never awaited).
  ```
- lines 2349-2352 (the four-line cursor-poller-task comment) →
  ```rust
    // BE-T12: cursor poller task. Runs only on non-musl unix (Linux);
    // on Windows the desktop module does not exist at all. `None` on those
    // targets keeps every CI build compiling clean (Ruling BE-T12-R2).
  ```
- lines 2477-2478 →
  ```rust
    // outlives the session. `cursor_task` is `None` on Windows/musl where
    // it was never spawned (Ruling BE-T12-R2).
  ```

- [ ] **Step 3: Reword `desktop.rs` comments (comments only — assertions unchanged)**

In `apps/agent/src/desktop.rs`, the capture-thread rationale currently reads
(lines 356-360):

```rust
/// **Why a dedicated thread.** `xcap`'s capture objects are not `Send` on every
/// platform — verified by compiling `is_send::<xcap::VideoRecorder>()` for
/// `x86_64-apple-darwin` (fails: `Retained<AVCaptureSession>` is not `Send`)
/// and `is_send::<xcap::Monitor>()` for `x86_64-pc-windows-msvc` (fails:
/// `HMONITOR` wraps a raw pointer) — while `supervise_sessions` runs in a
```

Replace **lines 357-359** (keeping the Windows example that continues onto
line 360) with:

```rust
/// platform — verified by compiling `is_send::<xcap::Monitor>()` for
/// `x86_64-pc-windows-msvc` (fails:
```

Reword the `cursor_in_frame` doc (lines 1848-1852) to:

```rust
/// `cursor_in_frame` is ADR-45's flag. With macOS dropped it is always `false`
/// at the production call site (no target composites the cursor in-frame any
/// more). It stays a parameter (not a hard-coded `false`) so the unit test can
/// pin both directions.
```

**Do NOT touch the assertions.** In the `frame_desktop_sources` test, reword only the 4-line comment at lines 2730-2733 to:

```rust
        // ADR-45: `cursorInFrame` is pinned in BOTH directions. The framing
        // function must render whatever it is given — asserted true and false
        // to pin both branches.
```

The `assert_eq!(value["payload"]["cursorInFrame"], true);` and
`assert_eq!(cursor_out["payload"]["cursorInFrame"], false);` lines and the two
`frame_desktop_sources(...)` calls stay byte-identical. This is **not** a test
change.

- [ ] **Step 4: Collapse the enigo settings branch in `input.rs`**

In `apps/agent/src/input.rs`, replace lines 352-361:

```rust
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
```

with:

```rust
            let settings = enigo::Settings::default();
```

Reword line 435 from ``/// `#[cfg(target_os = "windows")]`-only (referencing them on Linux/macOS`` to:

```rust
    /// `#[cfg(target_os = "windows")]`-only (referencing them on Linux
```

and line 438 from `/// on all five agent targets.` to `/// on all agent targets.`

In the `map_code_routes_letters_and_digits_through_unicode` test comment, lines 544-545 currently read:

```rust
            // variant, so `Key::A`/`Key::Digit0` would not compile on Linux or
            // macOS. Do not "optimise" this back to the letter variants.
```

Replace those two lines with:

```rust
            // variant, so `Key::A`/`Key::Digit0` would not compile on Linux.
            // Do not "optimise" this back to the letter variants.
```

(dropping the dangling `macOS.` fragment; the surrounding sentence about `#[cfg(target_os = "windows")]`-only and `DigitN` stays, and the assertions below are untouched).

- [ ] **Step 5: Reword the two dependency comments in `apps/agent/Cargo.toml`**

- line 78 → `# Windows-only dependencies, and on Linux the default backend is used.`
- line 82 → `# (Task 2). Only linked on Windows; on Linux these code paths are`

- [ ] **Step 6: Verify the agent still builds, lints, formats, and tests green**

Run (from `apps/agent`):

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Expected: `cargo test` reports **269 passed** (263 lib + 6 main) — **unchanged** from the pre-change baseline. `0 failed`, `4 ignored`. `cargo fmt --check` and clippy exit 0.

- [ ] **Step 7: Confirm no macOS token remains in the agent**

Run (from repo root):

```bash
grep -rniE "macos|darwin|apple" apps/agent/src apps/agent/Cargo.toml
```

Expected: **no output** (the `apple` in `apps/agent/Cargo.toml` was only in the two comments now reworded; `apps/agent/Cargo.lock` already has zero hits and is not in this path list).

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/cursor.rs apps/agent/src/lib.rs apps/agent/src/desktop.rs \
        apps/agent/src/input.rs apps/agent/Cargo.toml
git commit -m "refactor(agent): drop macOS cfg branches and comments"
```

---

## Task 2: Desktop — delete macOS autostart (and its 3 tests)

**Files:**
- Modify: `apps/desktop/src-tauri/src/autostart.rs` (constants `:19-22`, `macos_launch_agents_dir` `:46-57`, `render_macos_plist` `:78-97`, `resolve_autostart_location` `:190-194`, dispatch arms `:229-238`, `:291-295`, unsupported-arm predicates `:205`, `:261`, `:311`, module doc `:12`, tests `:369-380`, `:400-408`)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolve_autostart_location()` now has exactly three definitions — `#[cfg(target_os = "linux")]`, `#[cfg(windows)]`, and the `#[cfg(not(any(target_os = "linux", target_os = "windows")))]` fallback. `set_autostart_in` / `is_autostart_enabled_in` keep their signatures.

**TEST-INTEGRITY declaration (this file):** deletes **3** tests —
`macos_launch_agents_dir_home`, `macos_launch_agents_dir_none`,
`render_macos_plist_contains_binary_and_label` — because their subjects
(`macos_launch_agents_dir()`, `render_macos_plist()`) are deleted. File test
count **15 → 12**.

- [ ] **Step 1: Delete the macOS constants**

In `apps/desktop/src-tauri/src/autostart.rs`, delete lines 19-22:

```rust
/// macOS LaunchAgent label.
pub const MACOS_LABEL: &str = "com.ponter.desktop";
/// macOS LaunchAgent filename.
pub const MACOS_ENTRY_FILE: &str = "com.ponter.desktop.plist";
```

Reword the module doc line 12 from `//! No new crates (R2): Linux/macOS use std::fs/std::path; Windows uses` to:

```rust
//! No new crates (R2): Linux uses `std::fs`/`std::path`; Windows uses
```

- [ ] **Step 2: Delete `macos_launch_agents_dir` and `render_macos_plist`**

Delete lines 46-57 (`/// macOS LaunchAgents dir. ... }`) and lines 78-97 (`/// The macOS LaunchAgent plist body (pure). ... }`). The neighbouring `render_linux_desktop_entry` and `windows_run_add_args` stay untouched.

- [ ] **Step 3: Delete the macOS `resolve_autostart_location` definition**

Delete lines 190-194:

```rust
#[cfg(target_os = "macos")]
fn resolve_autostart_location() -> (PathBuf, &'static str) {
    let home = std::env::var("HOME").ok();
    (macos_launch_agents_dir(home.as_deref()), MACOS_ENTRY_FILE)
}
```

Change the unsupported-target predicate at line 205 from
`#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]`
to:

```rust
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
```

- [ ] **Step 4: Delete the two macOS dispatch arms**

In `set_autostart_in`, delete lines 229-238 (the `#[cfg(target_os = "macos")] { ... render_macos_plist ... }` block). In `is_autostart_enabled_in`, delete lines 291-295 (the `#[cfg(target_os = "macos")] { ... entry_exists(dir, MACOS_ENTRY_FILE) }` block).

Change the unsupported predicates at lines 261 and 311 from
`#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]`
to `#[cfg(not(any(target_os = "linux", target_os = "windows")))]`.

- [ ] **Step 5: Delete the 3 macOS tests**

Delete lines 369-380:

```rust
    // R10 test 2: macos_launch_agents_dir.
    #[test]
    fn macos_launch_agents_dir_home() {
        let p = macos_launch_agents_dir(Some("/home/user"));
        assert_eq!(p, PathBuf::from("/home/user/Library/LaunchAgents"));
    }

    #[test]
    fn macos_launch_agents_dir_none() {
        let p = macos_launch_agents_dir(None);
        assert_eq!(p, PathBuf::from(".").join("Library").join("LaunchAgents"));
    }
```

and lines 400-408:

```rust
    // R10 test 4: render_macos_plist.
    #[test]
    fn render_macos_plist_contains_binary_and_label() {
        let plist = render_macos_plist(Path::new("/opt/ponter/ponter-desktop"));
        assert!(plist.contains("/opt/ponter/ponter-desktop"));
        assert!(plist.contains("RunAtLoad"));
        assert!(plist.contains(MACOS_LABEL));
        assert!(plist.contains("ProgramArguments"));
    }
```

Each deletion leaves two adjacent blank lines (line 368 + 381, and 399 + 409). Collapse each pair to a single blank line so the file stays `cargo fmt`-clean.

Leave the `// R10 test 3: render_linux_desktop_entry.` and `// R10 test 5:` comments in place (the numbering is a historical label; renumbering is out of scope).

- [ ] **Step 6: Verify the desktop crate compiles and its tests are exactly 3 fewer**

Run (from `apps/desktop/src-tauri`):

```bash
cargo fmt --check
cargo test --locked
```

Expected: `test result: ok. 102 passed` (105 − 3), `0 failed`. `cargo fmt --check` exits 0. Note the full desktop suite is not yet at its final count — Task 3 deletes 2 more.

- [ ] **Step 7: Confirm no macOS token remains in autostart.rs**

```bash
grep -niE "macos|apple|plist" apps/desktop/src-tauri/src/autostart.rs
```

Expected: **no output**.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/autostart.rs
git commit -m "refactor(desktop): remove macOS autostart entry (ADR-78)"
```

---

## Task 3: Desktop — keyring feature, bundle icon, wizard, devices, README

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml:25`
- Modify: `apps/desktop/src-tauri/tauri.conf.json:43`
- Modify: `apps/desktop/src-tauri/src/keychain.rs:4`
- Modify: `apps/desktop/src-tauri/src/commands/wizard.rs:58,67-71,325-335`
- Modify: `apps/desktop/src-tauri/src/commands/devices.rs:246,250`
- Modify: `apps/desktop/src/stores/wizard.ts:21`
- Modify: `apps/desktop/README.md:75`

**Interfaces:**
- Consumes: `keychain::{set_secret,get_secret,delete_secret}` — signatures unchanged; only the underlying keyring feature changes.
- Produces: `map_capture_error(&str) -> String` now has a single Wayland/portal branch plus the verbatim `else`. `device_platform() -> String` matches `linux` / `windows` / `other`.

**TEST-INTEGRITY declaration (this file):** deletes **2** tests —
`capture_error_macos_guidance`, `capture_error_permission_guidance` — because the
macOS guidance branch they assert is deleted. File test count **21 → 19**.
Combined with Task 2, the desktop crate goes **105 → 100** (**net −5**).

- [ ] **Step 1: Switch the keyring feature off Apple**

In `apps/desktop/src-tauri/Cargo.toml`, change line 25 from:

```toml
keyring = { version = "4.2.0", features = ["apple-native-keyring-store"] }
```

to:

```toml
keyring = { version = "4.2.0", default-features = false, features = ["v1"] }
```

`v1` enables the Windows Credential Manager and Linux Secret Service (zbus) stores and is the only feature that provides the `keyring::Entry` API. Do **not** replace `["v1"]` with a bare store list — it will not compile. `Cargo.lock` needs no edit (the resolved dependency set is identical).

- [ ] **Step 2: Remove the `.icns` bundle icon**

In `apps/desktop/src-tauri/tauri.conf.json`, delete the icon line at `:43` (and the trailing comma on the preceding line). The `bundle.icon` array becomes:

```json
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.ico"
    ]
```

Leave `icons/icon.icns` on disk (deleting the binary is unnecessary and would only churn the diff).

- [ ] **Step 3: Reword the keychain doc comment**

In `apps/desktop/src-tauri/src/keychain.rs`, change line 4 from `//! abstracts away the platform (macOS Keychain, Windows Credential Manager,` to:

```rust
//! abstracts away the platform (Windows Credential Manager,
```

The `round_trips_a_secret` test stays byte-identical.

- [ ] **Step 4: Delete the macOS branch in `map_capture_error` and its 2 tests**

In `apps/desktop/src-tauri/src/commands/wizard.rs`, delete lines 67-71 (the whole `else if` arm):

```rust
    } else if lower.contains("screen recording")
        || lower.contains("permission")
        || lower.contains("denied")
    {
        format!("{err}; on macOS, grant Screen Recording in System Settings, then re-probe.")
```

so the function body reads:

```rust
pub fn map_capture_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("portal") || lower.contains("wayland") {
        format!(
            "{err}; Wayland capture is portal-dependent (recorded limitation ADR-27/45). \
             Try X11/XWayland or grant the screen-capture portal access."
        )
    } else {
        err.to_string()
    }
}
```

Reword the doc comment at line 58 from `/// Wayland/portal errors and macOS permission errors get platform-specific` to:

```rust
/// Wayland/portal errors get platform-specific
```

Then delete the two tests at lines 325-335:

```rust
    #[test]
    fn capture_error_macos_guidance() {
        let m = map_capture_error("Screen Recording permission denied");
        assert!(m.contains("Screen Recording in System Settings"));
    }

    #[test]
    fn capture_error_permission_guidance() {
        let m = map_capture_error("permission denied");
        assert!(m.contains("Screen Recording in System Settings"));
    }
```

The Wayland tests (`capture_error_wayland_portal_note`, `capture_error_wayland_only`) and `capture_error_unknown_passthrough` stay.

- [ ] **Step 5: Remove the `macos` arm from `device_platform`**

In `apps/desktop/src-tauri/src/commands/devices.rs`, delete line 250 (`        "macos" => "macos".to_string(),`) and reword the doc at line 246 from `/// \`"linux" | "macos" | "windows"\`.` to:

```rust
/// `"linux" | "windows"`.
```

The `other => other.to_string()` fallback stays.

- [ ] **Step 6: Reword the wizard store doc comment**

In `apps/desktop/src/stores/wizard.ts`, change line 21 from ` * reflects the real OS entry. macOS uses a LaunchAgent plist; Windows uses` to:

```ts
 * reflects the real OS entry. Windows uses
```

- [ ] **Step 7: Drop the macOS config path from the desktop README**

In `apps/desktop/README.md`, delete line 75 (`- **macOS:** \`~/Library/Application Support/com.ponter.desktop/config.json\``).

- [ ] **Step 8: Verify the desktop crate is green at exactly −5 and the web build still typechecks**

Run (from `apps/desktop/src-tauri`):

```bash
cargo fmt --check
cargo test --locked
```

Expected: `test result: ok. 100 passed` (105 − 5), `0 failed`. `cargo fmt --check` exits 0.

Then (from repo root):

```bash
pnpm --filter @ponter/desktop typecheck
```

Expected: exit 0.

- [ ] **Step 9: Confirm no macOS token remains in the desktop crate**

```bash
grep -rniE "macos|apple|\.icns" apps/desktop/src apps/desktop/src-tauri/src \
  apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json apps/desktop/README.md
```

Expected: **no output** (the `-apple-system` token is in `style.css`, which is not in this list and is intentionally kept).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json \
        apps/desktop/src-tauri/src/keychain.rs \
        apps/desktop/src-tauri/src/commands/wizard.rs \
        apps/desktop/src-tauri/src/commands/devices.rs \
        apps/desktop/src/stores/wizard.ts apps/desktop/README.md
git commit -m "refactor(desktop): drop Apple keyring feature, macOS wizard guidance, macOS device platform (ADR-78)"
```

---

## Task 4: CI — drop the macOS legs from both build workflows

**Files:**
- Modify: `.github/workflows/build-agent.yml:100,119-120,142-153`
- Modify: `.github/workflows/build-desktop.yml:7,15-21,71,87,91-92,139-145,208-214,259-284,346,348,405-406,444,491`

**Interfaces:**
- Consumes: nothing.
- Produces: `build-agent.yml` matrix has 4 targets; `build-desktop.yml` matrix has 2 OS legs; `latest.json` `targetFor()` has no `darwin` branch.

- [ ] **Step 1: Trim the agent build matrix to 4 targets**

In `.github/workflows/build-agent.yml`:

- line 100 → `  # Cross-platform build + package matrix (4 targets).`
- delete lines 119-120 (`          - x86_64-apple-darwin`, `          - aarch64-apple-darwin`)
- delete the two `include` entries at lines 142-153:

```yaml
          - target: x86_64-apple-darwin
            os: macOS
            arch: x64
            runner: macos-14
            pkg_ext: tar.gz
            bin_name: ponter-agent
          - target: aarch64-apple-darwin
            os: macOS
            arch: arm64
            runner: macos-14
            pkg_ext: tar.gz
            bin_name: ponter-agent
```

(The `x86_64-pc-windows-msvc` include entry begins on line 154 and is untouched.)

Leave the `verify` job (fmt/clippy/test/build on `ubuntu-latest`) untouched.

- [ ] **Step 2: Trim the desktop matrix and its header comments**

In `.github/workflows/build-desktop.yml`:

- line 7 → drop `.dmg`: `#   installers (.deb + .AppImage / .msi + .exe), uploads them as`
- header signing note (lines 15-21) → remove the `APPLE_*` names and the "macOS signing" reference, so the block reads:

```yaml
# NOTE: this workflow is BUILD-ONLY for this phase (ADR-56 / PM decision #1).
# Signing is deferred — see the commented "Windows signing" block below where
# the env vars / secrets would be wired in:
#   WINDOWS_CERTIFICATE / WINDOWS_CERTIFICATE_PASSWORD (Authenticode).
# Add these secrets to the repo, then uncomment the signing steps.
```

- line 71 → `  # Build + bundle matrix across Linux / Windows.`
- line 87 → `        os: [ubuntu-latest, windows-latest]`
- delete the `macos-14` include entry (lines 91-92):

```yaml
          - os: macos-14
            runner: macos-14
```

- [ ] **Step 3: Remove the commented macOS signing block**

Delete lines 139-145:

```yaml
      # macOS signing (PM decision #1: build-only this phase).
      # To enable notarization/signing, add the secrets below and uncomment:
      # env:
      #   APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
      #   APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
      #   APPLE_ID: ${{ secrets.APPLE_ID }}
      #   APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
```

Leave the `Build (Tauri bundle)` step that follows.

- [ ] **Step 4: Remove the macOS dmg upload step**

Delete lines 208-214:

```yaml
      - name: Upload macOS dmg artifact
        if: ${{ runner.os == 'macOS' }}
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1
        with:
          name: ponter-desktop-macos-dmg
          path: ${{ env.WORKSPACE }}/src-tauri/target/release/bundle/dmg/*
          if-no-files-found: error
          retention-days: 7
```

- [ ] **Step 5: Trim the Linux installer assert**

Rename the step and drop `.dmg`/`.app` from its glob. Replace the step header at line 259 and the `find`/comment block (lines 263-284) so it reads:

```yaml
      - name: Assert installer artifacts (Linux)
        if: ${{ runner.os != 'Windows' }}
        run: |
          set -e
          BUNDLE="src-tauri/target/release/bundle"
          echo "Bundle dir contents:"
          ls -la "$BUNDLE"
          # Tauri emits installers in type-specific subdirs (deb/, rpm/, appimage/).
          # Check only those flat installer files.
          # Use `wc -b` for cross-platform size (GNU/BSD stat differ in flags).
          find "$BUNDLE" -type f \
            ! -name '*.sha256' \
            \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \
               -o -name '*.msi' -o -name '*.exe' \) \
            -print0 | while IFS= read -r -d '' f; do
            sz=$(wc -c < "$f")
            echo "  $f  ($sz bytes)"
            if [ "$sz" -lt 10240 ]; then
              echo "::error::File $f is smaller than 10 KB ($sz bytes)"
              exit 1
            fi
          done
          echo "Installer artifact check PASSED (Linux)."
```

(The Windows assert step below it is untouched.)

- [ ] **Step 6: Drop `.dmg` from the release asset assert**

In the `Assert release installer assets exist` step (release job), remove `-o -name '*.dmg'` from **both** `find` invocations (lines ~345 and ~348), so they read:

```bash
          find dist -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \
            -o -name '*.msi' -o -name '*.exe' \) -print || true
          count=$(find dist -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \
            -o -name '*.msi' -o -name '*.exe' \) | wc -l)
```

- [ ] **Step 7: Drop `darwin` from `latest.json` assembly and the release glob**

- Comment at line 406 → `        #   windows-x86_64-msi), NOT target triples.` (remove the `darwin-aarch64-app,` example).
- Delete the `targetFor` branch at line 444:

```javascript
            if (/\.dmg$/.test(f))            return { os: "darwin",  arch: "aarch64", bundle: "app" };
```

- Delete the release upload glob at line 491: `            dist/**/*.dmg`.

- [ ] **Step 8: Verify the workflows are valid YAML and macOS-free**

Run (from repo root):

```bash
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/build-agent.yml','.github/workflows/build-desktop.yml']]; print('YAML OK')"
grep -niE "macos|darwin|apple|\.dmg" .github/workflows/build-agent.yml .github/workflows/build-desktop.yml
```

Expected: `YAML OK`, then **no grep output**.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/build-agent.yml .github/workflows/build-desktop.yml
git commit -m "ci: drop macOS build legs and dmg handling (ADR-78)"
```

---

## Task 5: Web — remove the macOS option from the register dialog

**Files:**
- Modify: `apps/web/src/components/agent/RegisterAgentDialog.vue:18,35,243-255`

**Interfaces:**
- Consumes: nothing.
- Produces: `platform` is `Ref<'linux' | 'windows'>`.

- [ ] **Step 1: Narrow the union type**

In `apps/web/src/components/agent/RegisterAgentDialog.vue`, change line 35 from:

```ts
const platform = ref<'linux' | 'macos' | 'windows'>('linux');
```

to:

```ts
const platform = ref<'linux' | 'windows'>('linux');
```

- [ ] **Step 2: Delete the macOS button block**

Delete lines 243-255 (the whole second `<button>`):

```html
              <button
                type="button"
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-xs font-medium transition-colors"
                :class="
                  platform === 'macos'
                    ? 'border-primary bg-primary/10 text-primary shadow-xs'
                    : 'border-border bg-card hover:bg-secondary/60 text-muted-foreground'
                "
                @click="platform = 'macos'"
              >
                <Laptop class="w-4 h-4" />
                <span>macOS</span>
              </button>
```

Leave the surrounding `grid grid-cols-3` container and the Linux/Windows buttons untouched (two buttons in a 3-column grid is acceptable; changing layout is out of scope). Delete the now-orphaned blank line so the Linux and Windows buttons are separated by a single blank line (removing 243-255 leaves line 242 and line 256 both blank — drop one).

- [ ] **Step 3: Drop the now-unused `Laptop` import**

Delete line 18 (`  Laptop,`) from the `@lucide/vue` import. (Verified: `Laptop` is referenced only inside the deleted block.)

- [ ] **Step 4: Verify lint, typecheck, and the dialog test still pass**

Run (from repo root):

```bash
pnpm --filter @ponter/web lint
pnpm --filter @ponter/web typecheck
pnpm --filter @ponter/web test -- RegisterAgentDialog
```

Expected: all exit 0; the `RegisterAgentDialog` suite is **unchanged** in count and green (it exercises `linux`/`windows` only).

- [ ] **Step 5: Confirm no macOS token remains in the dialog**

```bash
grep -niE "macos|macOS|Laptop" apps/web/src/components/agent/RegisterAgentDialog.vue
```

Expected: **no output**.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/RegisterAgentDialog.vue
git commit -m "feat(web): drop macOS option from register-agent dialog (ADR-78)"
```

---

## Task 6: Docs — living docs, ADR-78, and the §8 trail (PR 2, docs-only)

**Files:**
- Modify: `README.md:37`
- Modify: `docs/ARCHITECTURE.md:126,1022,1024,1146-1147` + §8 trail (`:1036`)
- Modify: `docs/guides/agent-setup.md:3,222-226`
- Modify: `docs/guides/self-hosting.md:107`
- Modify: `docs/guides/development.md:329`

**Interfaces:** none (docs-only).

**TEST-INTEGRITY:** no test files change in this task.

- [ ] **Step 1: README — drop macOS from the desktop-shell list**

In `README.md`, line 37 → `│   ├── desktop/           # Tauri 2.0 cross-platform desktop shell (Linux, Windows)`

- [ ] **Step 2: ARCHITECTURE — fix the agent platform label and the signing notes**

In `docs/ARCHITECTURE.md`:

- line 126 — keep the ASCII-box width by padding with spaces:

```text
│   │ (Windows / Linux)                     │    │ Port 3478, Relays: 49152-49200    │   │
```

- line 1022 — replace `macOS/Windows code-signing` with `Windows code-signing` (rest of the sentence unchanged).
- line 1024 — remove `darwin-aarch64-app, ` from the example key list so it reads `(e.g. \`linux-x86_64-deb\`, \`windows-x86_64-msi\`)`.
- delete lines 1146-1147 (the two `cargo build --release --target *-apple-darwin` lines).

- [ ] **Step 3: ARCHITECTURE — record ADR-78 and the §8 trail entry**

Immediately after the §8 backlog-drain blockquote (line 1036), add two blockquotes:

```markdown
> **Phase 9: Platform consolidation — macOS dropped (2026-10-13).** **ADR-78 — Drop macOS Platform Support.** macOS is removed as a supported platform for the agent and the desktop app; the repository targets **Windows (x86_64-pc-windows-msvc) and Linux (x86_64/aarch64 gnu, x86_64 musl)** only. *Rationale:* distribution on macOS requires Developer ID signing + notarization from a paid Apple Developer Program account the owner does not have; without it Gatekeeper blocks the app and unsigned binaries do not launch on Apple Silicon. Windows (SmartScreen "Run anyway") and Linux (no OS signing) ship without an account. All macOS `cfg` branches, the `apple-native-keyring-store` keyring feature, the macOS autostart (LaunchAgent) code, the `.icns` bundle icon, the macOS CI matrix legs + `.dmg`/`darwin`/`APPLE_*` handling, and the macOS option in the web register dialog are **deleted, not disabled**. *Rejected:* keeping macOS behind a default-off flag (leaves the code in the tree), keeping macOS CI (wastes runner minutes on un-shippable code). *Consequence:* re-adding macOS later requires re-authoring the deleted code; the exact deleted surface is recoverable from git history and from `docs/superpowers/specs/2026-10-13-drop-macos-support-design.md` §4. Existing server rows with `platform = 'macos'` are left untouched (the column is free-form text).

> **§8 trail (ADR-78):** code+CI PR `<PR1-NUMBER>` `<PR1-SHA>` (drop macOS from agent cfg, desktop keyring/autostart/wizard, CI matrices, web dialog); docs PR `<PR2-NUMBER>` `<PR2-SHA>` (ADR-78 + living-doc updates).
```

Replace the `<PR1-NUMBER>` / `<PR1-SHA>` / `<PR2-NUMBER>` / `<PR2-SHA>` placeholders with the real numbers and squash SHAs **after** both PRs merge (this is the last edit before the docs PR is finalized). While the docs PR is open, use the PR number from the PR1 URL and its head SHA; the BA fills the squash SHA on merge.

- [ ] **Step 4: agent-setup guide — drop macOS from the platform sentence and delete its section**

In `docs/guides/agent-setup.md`:

- line 3 → `Detailed guide on building, configuring, and operating the native Rust Desktop Agent (\`apps/agent\`) on Linux and Windows.`
- delete the whole `## 7. macOS LaunchDaemon (Pending)` section (lines 222-226, including the trailing `---` separator):

```markdown
## 7. macOS LaunchDaemon (Pending)

macOS daemon deployment will be supported in Phase 3.

---
```

Renumber the following headings so the guide stays sequential: `## 8. Security Considerations` → `## 7. Security Considerations`, `## 9. Troubleshooting` → `## 8. Troubleshooting`. (No inbound anchor links reference these headings — verified.)

- [ ] **Step 5: self-hosting guide — delete the macOS config-path bullet**

In `docs/guides/self-hosting.md`, delete line 107 (`- macOS: \`~/Library/Application Support/com.ponter.desktop/config.json\``).

- [ ] **Step 6: development guide — drop `.dmg on macOS`**

In `docs/guides/development.md`, line 329 → `(\`.deb\` + \`.AppImage\` + \`.rpm\` on Linux, \`.msi\` + \`.exe\` on Windows).`

- [ ] **Step 7: Run the full verification sweep**

Run (from repo root):

```bash
grep -rniE "macos|darwin|apple|\.icns|videotoolbox" \
  README.md docs/ARCHITECTURE.md docs/guides docs/README.md \
  apps/agent/src apps/agent/Cargo.toml \
  apps/desktop/src apps/desktop/src-tauri/src apps/desktop/src-tauri/Cargo.toml \
  apps/desktop/src-tauri/tauri.conf.json apps/desktop/README.md \
  apps/web/src .github/workflows
```

Expected: the **only** hits are the two `-apple-system` CSS font tokens (`apps/web/src/style.css:12`, `apps/desktop/src/style.css:12`), which are intentionally kept. Any `macos`/`darwin`/`.dmg`/`.icns`/`videotoolbox` hit is a defect.

Then run prettier over the changed docs:

```bash
pnpm exec prettier --check README.md docs/ARCHITECTURE.md docs/guides/agent-setup.md \
  docs/guides/self-hosting.md docs/guides/development.md
```

Expected: exit 0 (or `--write` the offenders and re-check).

- [ ] **Step 8: Confirm zero Vietnamese characters in the changed docs**

```bash
grep -rlP '[\x{1EA0}-\x{1EFF}]' README.md docs/ARCHITECTURE.md docs/guides/agent-setup.md \
  docs/guides/self-hosting.md docs/guides/development.md || echo "no VI chars"
```

Expected: `no VI chars`.

- [ ] **Step 9: Commit**

```bash
git add README.md docs/ARCHITECTURE.md docs/guides/agent-setup.md \
        docs/guides/self-hosting.md docs/guides/development.md
git commit -m "docs: record macOS removal (ADR-78) and update living docs"
```

---

## Post-Plan: Delivery (2 PRs)

- **PR 1** = Tasks 1-5 (code + CI). Test files change (5 Rust tests removed) ⇒ **QA binding verdict required**. CI must be green on the agent workflow (4 targets) and the desktop workflow (2 OS legs).
- **PR 2** = Task 6 (docs-only). SonarCloud only; no QA binding. Add the §8 trail entry's real PR numbers/SHAs here.
- Review chain: implementer → independent reviewer → QA binding (PR 1) → BA docs audit → PM cross-check → owner merge. All CI green required.
- Zero `Co-authored-by` trailers in every commit.

## §8 Verification Checklist (final, for QA / PM cross-check)

1. The Task 6 Step 7 sweep returns only the two `-apple-system` CSS tokens.
2. `apps/agent`: `cargo fmt --check` + `cargo clippy --all-targets --locked -- -D warnings` + `cargo test --locked` all green; test count **269** (unchanged).
3. `apps/desktop/src-tauri`: `cargo fmt --check` + `cargo test --locked` green; test count **100** (was 105).
4. `keychain.rs::round_trips_a_secret` green on Linux (Windows leg via CI).
5. `build-agent.yml` matrix has exactly 4 targets, none `*-apple-darwin`.
6. `build-desktop.yml` matrix has exactly 2 OS legs; no `.dmg`, no `darwin`, no `APPLE_*`.
7. `RegisterAgentDialog.vue` union is `'linux' | 'windows'`; no macOS button; no `Laptop` import.
8. Net test delta is exactly −5; no other test file changed.
9. `README.md` / `docs/ARCHITECTURE.md` / guides state Windows + Linux only.
10. Zero `Co-authored-by` trailers; zero Vietnamese characters in changed docs.
