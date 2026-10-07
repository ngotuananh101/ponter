# Phase 7: Agent Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the `ponter-agent` runtime as a cross-platform Tauri 2.0 desktop app — account login, device registration/management, a verified setup wizard, tray + auto-start, native installers, and signed auto-update.

**Architecture:** Refactor `apps/agent` into a library (`src/lib.rs`, `AgentRuntime` API) plus a thin CLI (`src/main.rs`, unchanged behaviour). A new Tauri app at `apps/desktop` (Rust backend in `src-tauri/`, Vue 3 + Vite frontend in `src/`) embeds the runtime in-process, stores secrets in the OS keychain, and ships native installers. Execution is layered L0-L5; each layer is a stop-safe boundary.

**Tech Stack:** Rust 1.98.1 (agent lib), Tauri 2.0 (desktop shell), Vue 3.5 + Vite 8 + TypeScript 6 + Vitest 5 (frontend), pnpm 12 workspace, GitHub Actions (3-OS matrix), `keyring`-family crate for the OS secret store, Tauri updater.

**Spec:** `docs/superpowers/specs/2026-10-07-phase7-agent-desktop-app-design.md` (ADR-50 through ADR-58). The spec is the authority; this plan argues from it.

## Global Constraints

- **Rust toolchain:** `1.98.1` (pinned in `apps/agent/rust-toolchain.toml`); `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` must pass.
- **Node/pnpm:** Node `>=24`, pnpm `12.6.0` (root `package.json` `engines`).
- **CLI compatibility (ADR-50):** the `ponter-agent` binary's flags, log lines, and WS behaviour are **unchanged**. `build-agent.yml` verify gate and the cross-language E2E are the regression net.
- **No secret in webview storage (ADR-52):** the agent credential and refresh token live in the OS keychain; never `localStorage`/`IndexedDB`/`sessionStorage`.
- **Input gate default is CLOSED (ADR-42/ADR-53):** the wizard's input toggle defaults off; Gate A (operator) + Gate B (peer identity) both required.
- **`apps/web/src/components/ui/` is generated** — never hand-modified; new files byte-identical from the `reka-vega` registry (project rule).
- **No server or wire changes:** registration/login/device CRUD reuse existing endpoints; the signaling protocol, WS2 identity, and E2EE are untouched.
- **Owned files per task** — a task edits only the files its **Files:** block names.

## Owner Actions (gating — the owner must do these; the plan cannot)

These are the points where the plan stops and the **owner** must act. Each is surfaced again at its task.

1. **Updater signing keypair — required before L5 / Task 11.** Run `tauri signer generate` to create a keypair; keep the **private** key + password as CI secrets (e.g. `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); the **public** key is compiled into the app. Without this, L5 cannot ship. → Task 11 Step 0.
2. **macOS code-signing + notarization (recommended for L4 distribution).** A Developer ID Application certificate + notarization credentials are needed for a `.dmg` users can open without a Gatekeeper warning. Optional for a build-only artifact; required for a real public release. → Task 9/10.
3. **Windows code-signing certificate (recommended for L4 distribution).** An Authenticode certificate avoids SmartScreen warnings on the `.msi`. Optional for a build-only artifact. → Task 9/10.

> The owner has asked to be **reminded at the exact step** each key is needed. Surface item 1 before Task 11 begins; surface items 2-3 before Task 9/10.

## Review Focus

The failure modes the spec implies but no single task's happy-path test covers — each gets a test in the owning task:

1. **A stale credential silently connects with the wrong identity** — after re-registering a device, the app must use the new credential and the WS2 identity binding must still hold (Task 6 test: re-register swaps the keychain value; proof-of-possession still verifies).
2. **The input gate defaults open after a refactor** — a mutation that flips the default to `true` must turn a test red (Task 5 test + mutation check).
3. **A secret leaks to the webview** — an assertion that no credential/refresh token is written to webview storage (Task 3/4 test).
4. **The updater accepts an unsigned or older manifest** — mutation to skip the version check or signature check must turn a test red (Task 11 test).
5. **Auto-start writes a broken entry** — the generated `.desktop`/LaunchAgent/registry value must point at the real installed binary path and be removable (Task 8 test).

---

## File Map

| File | Responsibility |
|---|---|
| `apps/agent/src/lib.rs` | **New** crate root; `AgentRuntime` (start/stop/status/events) + module re-exports. |
| `apps/agent/src/main.rs` | **Refactor** to thin CLI over `AgentRuntime`. |
| `apps/agent/Cargo.toml` | Add `[lib]`; keep `[[bin]]`. |
| `apps/desktop/src-tauri/Cargo.toml` | **New** Tauri backend crate; path-dep on `ponter-agent`. |
| `apps/desktop/src-tauri/src/main.rs` | **New** Tauri entry. |
| `apps/desktop/src-tauri/src/lib.rs` | **New** command registration. |
| `apps/desktop/src-tauri/src/commands/*.rs` | **New** login, register_device, wizard_probe, autostart, updater commands. |
| `apps/desktop/src-tauri/src/keychain.rs` | **New** OS secret store wrapper. |
| `apps/desktop/src-tauri/tauri.conf.json` | **New** window/CSP/capabilities/bundle/updater config. |
| `apps/desktop/src-tauri/capabilities/default.json` | **New** minimal capability set. |
| `apps/desktop/src/` | **New** Vue app: `App.vue`, `views/LoginView.vue`, `views/WizardView.vue`, `views/DevicesView.vue`, `stores/*`. |
| `apps/desktop/package.json` | Replace stub scripts with real dev/build/lint/typecheck/test. |
| `apps/desktop/vite.config.ts`, `tsconfig.json`, `index.html` | **New** frontend build. |
| `apps/desktop/src/**/__tests__/*.test.ts` | **New** Vitest specs. |
| `.github/workflows/build-desktop.yml` | **New** 3-OS build + bundle + release. |
| `apps/web/src/components/security/EncryptionByChannelDialog.vue` | **Edit** width → `sm:max-w-2xl` (same-variant override of the generated `sm:max-w-md` default). |
| `apps/web/src/__tests__/EncryptionByChannelDialog.test.ts` | **Edit** pin the width class. |
| `docs/spikes/2026-10-07-phase7-tauri-spike.md` | **New** L0 spike findings. |

---

## Tasks

### Layer 0: Feasibility Spike (gating)

### Task 0: Widen the "Encryption by Channel" dialog (owner request — ships first)

**Files:**
- Modify: `apps/web/src/components/security/EncryptionByChannelDialog.vue`
- Test: `apps/web/src/__tests__/EncryptionByChannelDialog.test.ts`

**Interfaces:**
- Consumes: the existing `DialogContent` (`@/components/ui/dialog`), currently `class="max-w-2xl"`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `EncryptionByChannelDialog.test.ts`:

```ts
it('overrides the default sm:max-w-md so the wider sm:max-w-2xl width applies', async () => {
  const wrapper = mountDialog(true);
  await wrapper.vm.$nextTick();

  const content = wrapper.find('[data-test="encryption-by-channel-dialog"]');
  const classes = content.classes();
  expect(classes).toContain('sm:max-w-2xl');
  expect(classes).not.toContain('sm:max-w-md'); // default was REPLACED by the merge (core regression pin)
  expect(classes).not.toContain('max-w-3xl'); // broken unprefixed approach removed
  expect(classes).toContain('max-w-[calc(100%-2rem)]'); // mobile cap default survives the merge
});
```
> Note: the `mountDialog` helper (defined at the top of the test file) supplies the `Teleport` stub that `DialogPortal` requires; a raw `mount(...)` without it would not render the dialog content.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web exec vitest run src/__tests__/EncryptionByChannelDialog.test.ts`
Expected: FAIL — content carries the unprefixed `max-w-2xl`, not `sm:max-w-2xl`.

- [ ] **Step 3: Widen the dialog**

In `EncryptionByChannelDialog.vue`, change:

```html
<DialogContent class="max-w-2xl" data-test="encryption-by-channel-dialog">
```

to:

```html
<DialogContent
  class="sm:max-w-2xl"
  data-test="encryption-by-channel-dialog"
>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web exec vitest run src/__tests__/EncryptionByChannelDialog.test.ts`
Expected: PASS (all dialog tests, including the new width test).

- [ ] **Step 5: Run the full web suite (no regression)**

Run: `pnpm --filter @ponter/web test`
Expected: PASS — 307 tests green (Gate G2 in `e2ee-claims.test.ts` unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/security/EncryptionByChannelDialog.vue apps/web/src/__tests__/EncryptionByChannelDialog.test.ts
git commit -m "fix(web): make Encryption by Channel dialog width apply via sm:max-w-2xl"
```

> **Correction (Task 0b).** The first attempt set an unprefixed `class="max-w-3xl"` on `DialogContent` (commit `998bc95`, shipped as `9f1efba`). It never applied: the generated `DialogContent` default is the **`sm:`-variant** `sm:max-w-md`, and tailwind-merge treats an unprefixed `max-w-*` as a different group, so `sm:max-w-md` kept winning at ≥640px. The fix (commit `6e9c97f`) passes the **same-variant** `sm:max-w-2xl`, which tailwind-merge replaces the default with — effective width 42rem (2xl) at ≥640px. Lesson: when overriding a generated component's width via `class`, match the variant of the default you are replacing.

---

### Task 1: L0 spike — Tauri shell embeds the agent runtime (GATING)

**Files:**
- Create: `apps/desktop/src-tauri/` (minimal Tauri app)
- Create: `docs/spikes/2026-10-07-phase7-tauri-spike.md`

**Interfaces:**
- Consumes: a stub `AgentRuntime` (defined in Task 2; for the spike, a placeholder `start()/stop()` that logs).
- Produces: the decision "embedding works on Linux" recorded in the spike doc; **blocks all of L1+** (ADR-58).

- [ ] **Step 1: Scaffold a minimal Tauri 2.0 app**

Run (from `apps/desktop`):

```bash
pnpm dlx create-tauri-app@latest --template vue-ts --manager pnpm --yes
```

Then trim to a single window that logs "runtime start requested" from a Rust command. Verify the Tauri 2.0 version pinned is `2.x`.

- [ ] **Step 2: Add a placeholder runtime call in the Tauri backend**

In `apps/desktop/src-tauri/src/lib.rs`, register one command:

```rust
#[tauri::command]
fn spike_start() -> String {
    // Placeholder for AgentRuntime::start(); proves the backend can host
    // the runtime call in-process.
    "runtime start requested".to_string()
}
```

- [ ] **Step 3: Run the shell under Xvfb on Linux**

```bash
Xvfb :99 -screen 0 1280x1024x24 &
DISPLAY=:99 pnpm tauri dev   # or `tauri build` then run the binary
```

Expected: the app window opens, the command returns, no WebKitGTK/capture-stack link error.

- [ ] **Step 4: Record the spike outcome**

Write `docs/spikes/2026-10-07-phase7-tauri-spike.md` with: Tauri version resolved, the Linux system deps required, the exact command that booted the shell, and the verdict **PASS / FAIL**. If FAIL, state which part of ADR-50 must be revisited.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop docs/spikes/2026-10-07-phase7-tauri-spike.md pnpm-lock.yaml
git commit -m "spike(desktop): Tauri shell embedding feasibility (L0 gate)"
```

**Stop condition:** if the spike FAILs, stop and report — do not start L1.

---

### Layer 1: Refactor + Shell + Login + Keychain

### Task 2: Split `apps/agent` into a library plus a thin CLI (ADR-50)

**Files:**
- Create: `apps/agent/src/lib.rs`
- Modify: `apps/agent/src/main.rs`
- Modify: `apps/agent/Cargo.toml`

**Interfaces:**
- Consumes: the existing modules (`cursor`, `desktop`, `e2ee`, `files`, `identity`, `input`, `logging`, `pty`, `rtc`, `shell_policy`, `signal`) and `SessionConfig`/`run_with_reconnect`.
- Produces: `ponter_agent::AgentRuntime` with `start(config: RuntimeConfig) -> Result<RuntimeHandle>`, `RuntimeHandle::stop()`, and `RuntimeHandle::status() -> RuntimeStatus` — consumed by Task 3's Tauri backend.

- [ ] **Step 1: Add the lib target**

In `apps/agent/Cargo.toml`:

```toml
[lib]
name = "ponter_agent"
path = "src/lib.rs"

[[bin]]
name = "ponter-agent"
path = "src/main.rs"
```

- [ ] **Step 2: Move module declarations into `lib.rs`**

Create `apps/agent/src/lib.rs` holding the `mod` declarations currently at the top of `main.rs` (lines ~10-28), made `pub` where the Tauri backend needs them, plus:

```rust
pub mod identity;

pub struct RuntimeConfig {
    pub agent_id: String,
    pub server: String,
    pub credential: String,
    pub identity_path: std::path::PathBuf,
    pub allow_input: bool,
    // ... remaining Cli fields needed at runtime
}

pub struct AgentRuntime { /* handle to the reconnect loop */ }

impl AgentRuntime {
    pub async fn start(_config: RuntimeConfig) -> anyhow::Result<Self> { todo!() }
    pub async fn stop(&self) -> anyhow::Result<()> { todo!() }
}
```

- [ ] **Step 3: Reduce `main.rs` to a thin CLI**

`main.rs` keeps `Cli` (clap) and `resolve_credential`/`resolve_shell`/`resolve_identity_path`, then builds `RuntimeConfig` and calls `AgentRuntime::start(...)`. Behaviour (flags, log lines) unchanged.

- [ ] **Step 4: Move `run_with_reconnect`/`SessionConfig` behind the runtime**

Relocate the reconnect loop into `lib.rs` (or a `runtime` module) so `AgentRuntime::start` owns it; `main.rs` awaits it.

- [ ] **Step 5: Verify the refactor is behaviour-preserving**

Run (from `apps/agent`):

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Expected: all green. Then run the cross-language E2E (unchanged file) — green.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/Cargo.toml apps/agent/src/lib.rs apps/agent/src/main.rs
git commit -m "refactor(agent): split into lib + thin CLI (ADR-50)"
```

**Stop condition:** if `build-agent.yml` verify or E2E cannot be made green, revert the split and report — ADR-50 is reopened.

---

### Task 3: Tauri backend skeleton + OS keychain wrapper (ADR-51, ADR-52)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/keychain.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`, `capabilities/default.json`

**Interfaces:**
- Consumes: `ponter_agent::AgentRuntime` (Task 2).
- Produces: `keychain::set_secret(service, account, value)`, `keychain::get_secret(...)`, `keychain::delete_secret(...)` — consumed by Tasks 4, 6.

- [ ] **Step 1: Write the failing keychain test**

In `src-tauri/src/keychain.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_a_secret() {
        let svc = "ponter-test";
        set_secret(svc, "acct", "value-1").unwrap();
        assert_eq!(get_secret(svc, "acct").unwrap().as_deref(), Some("value-1"));
        delete_secret(svc, "acct").unwrap();
        assert_eq!(get_secret(svc, "acct").unwrap(), None);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keychain`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the keychain wrapper**

Use a `keyring`-family crate; map errors to `anyhow`. `set_secret` writes to the OS store (Secret Service / Keychain / Credential Manager).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keychain`
Expected: PASS (skip on a headless CI without a secret service — gate the test with an env guard and document it).

- [ ] **Step 5: Lock down Tauri config**

In `tauri.conf.json`: set a strict CSP (no `unsafe-eval`, no remote origins); in `capabilities/default.json`, grant only the commands this app uses.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): Tauri backend skeleton + keychain wrapper (ADR-51/52)"
```

---

### Task 4: Account login over `POST /api/auth/login`; token to keychain (ADR-52)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/login.rs`
- Create: `apps/desktop/src/views/LoginView.vue`, `apps/desktop/src/stores/auth.ts`
- Test: `apps/desktop/src/**/__tests__/login.test.ts`

**Interfaces:**
- Consumes: `keychain::set_secret` (Task 3); `POST /api/auth/login` (existing server).
- Produces: a `login(email, password)` Tauri command returning the user profile; the refresh token stored in the keychain; access token in backend memory.

- [ ] **Step 1: Write the failing frontend test**

```ts
it('shows an error and stores nothing when login fails', async () => {
  // mock the invoke('login') to reject
  // assert error text rendered AND no keychain call recorded
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test`
Expected: FAIL — LoginView not implemented.

- [ ] **Step 3: Implement the login command + view**

Backend: `login` command POSTs to `/api/auth/login`, on success stores the refresh token via `keychain::set_secret`, holds the access token in a `State`. Frontend: `LoginView.vue` form calling `invoke('login', ...)`.

- [ ] **Step 4: Add the no-secret-in-webview assertion**

```ts
it('never writes a secret to webview storage', () => {
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test && pnpm --filter @ponter/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/login.rs apps/desktop/src
git commit -m "feat(desktop): account login + keychain token storage (ADR-52)"
```

---

### Layer 2: Wizard + Device Management

### Task 5: Setup wizard with real verification (ADR-53)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/wizard.rs`
- Create: `apps/desktop/src/views/WizardView.vue`, `apps/desktop/src/stores/wizard.ts`
- Test: `apps/desktop/src/**/__tests__/wizard.test.ts`

**Interfaces:**
- Consumes: the agent `desktop` capture path (probe), `keychain` (Task 3).
- Produces: `probe_server(url) -> ProbeResult`, `probe_capture() -> ProbeResult`, wizard state machine.

- [ ] **Step 1: Write the failing wizard-state test**

```ts
it('defaults the input gate to closed', () => {
  const s = createWizardState();
  expect(s.allowInput).toBe(false);
});

it('blocks advancing past the server step until the probe succeeds', async () => {
  // probe rejects -> cannot advance
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- wizard`
Expected: FAIL.

- [ ] **Step 3: Implement the wizard steps + probes**

Steps: server (probe reachability), screen permission (real capture probe via the agent path), input gate (default off, ADR-42 wording), auto-start (delegates to Task 8). Each step has a verify action, not just an input.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test -- wizard`
Expected: PASS.

- [ ] **Step 5: Mutation check (load-bearing default)**

Temporarily flip `allowInput` default to `true`; confirm the default-closed test goes RED; revert.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/wizard.rs apps/desktop/src
git commit -m "feat(desktop): verified setup wizard (ADR-53)"
```

---

### Task 6: Device registration + management (ADR-54)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/devices.rs`
- Create: `apps/desktop/src/views/DevicesView.vue`
- Test: `apps/desktop/src/**/__tests__/devices.test.ts`

**Interfaces:**
- Consumes: `POST /api/agents`, `GET /api/agents`, `DELETE /api/agents/:id` (existing); `keychain` (Task 3); agent identity (WS2).
- Produces: `register_device(...)` returning the created agent; credential written to the keychain.

- [ ] **Step 1: Write the failing test**

```ts
it('stores the one-time credential in the keychain, not the webview', async () => {
  // mock invoke('register_device') returning { agent, credential }
  // assert keychain set called with the credential AND localStorage empty
});

it('uses the new credential after re-registration', async () => {
  // re-register -> the keychain value is replaced
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- devices`
Expected: FAIL.

- [ ] **Step 3: Implement registration + device list/delete**

Reuse the existing endpoints; write the credential to the keychain immediately; the list/delete view mirrors the web dashboard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test -- devices`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/devices.rs apps/desktop/src
git commit -m "feat(desktop): device registration + management (ADR-54)"
```

---

### Layer 3: Tray + Auto-start

### Task 7: Tray icon with connection state (ADR-55)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/tray.rs`
- Test: `apps/desktop/src-tauri/src/tray.rs` (unit)

**Interfaces:**
- Consumes: `AgentRuntime::status()` (Task 2).
- Produces: tray menu actions (Start/Stop/Open/Quit); window close hides to tray.

- [ ] **Step 1: Write the failing state-mapping test**

```rust
#[test]
fn maps_runtime_status_to_tray_label() {
    assert_eq!(tray_label(&RuntimeStatus::Connected), "Connected");
    assert_eq!(tray_label(&RuntimeStatus::Disconnected), "Disconnected");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml tray`
Expected: FAIL.

- [ ] **Step 3: Implement the tray + label mapping**

Wire the tray menu to start/stop the runtime; closing the window hides (does not stop).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml tray`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/tray.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): tray icon + lifecycle (ADR-55)"
```

---

### Task 8: Auto-start per platform (ADR-55)

**Files:**
- Create: `apps/desktop/src-tauri/src/autostart.rs`
- Test: `apps/desktop/src-tauri/src/autostart.rs` (unit)

**Interfaces:**
- Consumes: the installed binary path.
- Produces: `set_autostart(bool)`, `is_autostart_enabled() -> bool`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn generated_entry_points_at_the_binary() {
    let entry = render_autostart_entry(Path::new("/opt/ponter/ponter-desktop"));
    assert!(entry.contains("/opt/ponter/ponter-desktop"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml autostart`
Expected: FAIL.

- [ ] **Step 3: Implement per-platform entries**

Linux `~/.config/autostart/*.desktop`; macOS LaunchAgent/`SMAppService`; Windows registry `Run`. Render is pure (unit-tested); install/uninstall is the side effect.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml autostart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/autostart.rs
git commit -m "feat(desktop): per-platform auto-start (ADR-55)"
```

---

### Layer 4: Packaging + 3-OS CI

### Task 9: Bundle configuration per platform (ADR-56)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the built frontend + backend.
- Produces: bundler targets `.deb`/`.AppImage` (Linux), `.dmg` (macOS), `.msi` (Windows).

> **⚠ REMIND THE OWNER (distribution signing).** For a public release, macOS needs a Developer ID cert + notarization and Windows needs an Authenticode cert; without them the installers build but show Gatekeeper/SmartScreen warnings. Ask the owner whether to configure signing now (production) or ship build-only artifacts for this phase.

- [ ] **Step 1: Configure bundle targets**

In `tauri.conf.json` `bundle.targets`, set the platform targets and app identifier/version.

- [ ] **Step 2: Build locally on Linux**

Run: `pnpm --filter @ponter/desktop tauri build`
Expected: a `.deb` and `.AppImage` produced under `src-tauri/target/release/bundle/`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "build(desktop): bundle targets for linux/macos/windows (ADR-56)"
```

---

### Task 10: `build-desktop.yml` — 3-OS build + release (ADR-56)

**Files:**
- Create: `.github/workflows/build-desktop.yml`

**Interfaces:**
- Consumes: `apps/desktop` + `apps/agent`.
- Produces: installer artifacts on a matrix; attached to a GitHub Release on tag.

- [ ] **Step 1: Write the workflow**

Matrix `ubuntu-latest` / `macos-14` / `windows-latest`; install pnpm + Rust 1.98.1 + Tauri Linux system deps; run `pnpm install`, build the frontend, then `tauri build`; upload bundle artifacts; on tag, create a release.

- [ ] **Step 2: Add a post-build artifact check**

Assert each expected installer file exists and is non-trivial in size; fail the job otherwise.

- [ ] **Step 3: Path-filter the workflow**

Trigger on `apps/desktop/**`, `apps/agent/**`, and the workflow file itself.

- [ ] **Step 4: Verify on a branch push**

Run: push a branch touching `apps/desktop/**`; watch all three OS jobs.
Expected: all green; artifacts present.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-desktop.yml
git commit -m "ci(desktop): 3-OS build + bundle + release (ADR-56)"
```

---

### Layer 5: Auto-update

### Task 11: Tauri updater with signed manifest (ADR-57)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/commands/updater.rs`
- Test: `apps/desktop/src-tauri/src/commands/updater.rs` (unit)

**Interfaces:**
- Consumes: the Tauri updater plugin + a signed `latest.json` manifest.
- Produces: `check_update() -> Option<UpdateInfo>`, `apply_update()`; refuses unsigned/older manifests.

> **⏸ OWNER ACTION REQUIRED BEFORE THIS TASK.** Generate the updater keypair with `tauri signer generate`, store the private key + password as CI secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and give the public key to the implementer to compile in. **Pause and remind the owner here** — do not start Task 11 until the key exists.

- [ ] **Step 0: Owner generates the updater keypair (BLOCKING)**

Owner runs `tauri signer generate -w ~/.tauri/ponter.key`; adds the private key + password as CI secrets; shares only the **public** key for `tauri.conf.json` `plugins.updater.pubkey`.

- [ ] **Step 1: Write the failing decision test**

```rust
#[test]
fn refuses_an_older_version() {
    assert!(should_apply("1.0.0", "0.9.0").is_none());
}

#[test]
fn refuses_an_unsigned_manifest() {
    assert!(verify_manifest(unsigned_manifest()).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updater`
Expected: FAIL.

- [ ] **Step 3: Implement the updater**

Compile in the **public** updater key; set the manifest endpoint in `tauri.conf.json`; the decision function compares semver and verifies the signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updater`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Temporarily skip the signature check; confirm the unsigned-manifest test goes RED; revert. Do the same for the version check.

- [ ] **Step 6: Wire the release to publish the manifest**

Update `build-desktop.yml` to emit and sign `latest.json` on tag (private key from a CI secret).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/updater.rs apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml .github/workflows/build-desktop.yml
git commit -m "feat(desktop): signed auto-update (ADR-57)"
```

**Stop condition:** L5 does not start until the owner provides the updater signing keypair as a CI secret (ADR-57 owner action).

---

## Self-Review

**1. Spec coverage:**
- ADR-50 (lib/bin) → Task 2. ADR-51 (Vue+Tauri, CSP) → Tasks 1, 3. ADR-52 (keychain, login) → Tasks 3, 4. ADR-53 (wizard) → Task 5. ADR-54 (registration) → Task 6. ADR-55 (tray/auto-start) → Tasks 7, 8. ADR-56 (packaging/CI) → Tasks 9, 10. ADR-57 (updater) → Task 11. ADR-58 (layers) → the layer structure itself. Spec §5.1 (dialog width) → Task 0. Spec §6 mutation discipline → Tasks 5, 11 mutation checks + Task 4 no-secret assertion. No gap.

**2. Placeholder scan:** `AgentRuntime` is stubbed with `todo!()` **only** in Task 2 Step 2 as the interface signature, then implemented in Task 2 Steps 3-4 — the implementer sees the full task text, not a bare `todo!()`. Spike and CI tasks are inherently exploratory and name their concrete artifact/verdict. No "add error handling"/"similar to Task N" placeholders.

**3. Type consistency:** `AgentRuntime::start/stop/status`, `RuntimeConfig`, `RuntimeStatus`, `keychain::set_secret/get_secret/delete_secret`, `probe_server/probe_capture`, `register_device`, `set_autostart/is_autostart_enabled`, `should_apply/verify_manifest` are named once and reused consistently across tasks.

**4. Review Focus:** five items, each mapped to an owning-task test: (1) re-registration credential swap → Task 6; (2) input-gate default → Task 5 mutation; (3) secret-to-webview → Tasks 3/4; (4) updater refuse → Task 11 mutation; (5) auto-start entry path → Task 8.

## Execution Handoff

Per ADR-58, execute **layer by layer** (L0 → L5); each layer is a stop-safe boundary. Task 0 ships first and is independent. L0 (Task 1) gates L1; if it fails, stop and report.
