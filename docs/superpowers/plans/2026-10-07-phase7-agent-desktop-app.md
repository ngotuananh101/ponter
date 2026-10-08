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
- **Desktop UI uses shadcn-vue (owner constraint):** `apps/desktop/src/components/ui/**` mirrors the web client's generated layer — byte-identical from the `reka-vega` registry, **never hand-modified** (same rule as the web `ui/` at L20; extended to desktop when the UI sync shipped).
- **No server or wire changes:** registration/login/device CRUD reuse existing endpoints; the signaling protocol, WS2 identity, and E2EE are untouched.
- **Owned files per task** — a task edits only the files its **Files:** block names.

## Owner Actions (gating — the owner must do these; the plan cannot)

These are the points where the plan stops and the **owner** must act. Each is surfaced again at its task.

1. **Updater signing keypair — ✅ DONE (2026-10-08).** The owner ran `tauri signer generate`; the **private** key + password are set as CI secrets `TAURI_SIGNING_PRIVATE_KEY` (2026-10-08T08:54:53Z) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (2026-10-08T08:55:24Z) — verified via `gh secret list`. The **public** key is compiled into the app by Task 11. → Task 11 Step 0. (The public key still needs to reach the Task 11 implementer; the secrets side is complete.)
2. **macOS code-signing + notarization (recommended for L4 distribution) — NOT YET SET.** A Developer ID Application certificate + notarization credentials are needed for a `.dmg` users can open without a Gatekeeper warning. **Optional for a build-only artifact** (PM decision #1 — L4 ships unsigned); required for a real public release. → Task 9/10 (hooks commented in `build-desktop.yml`).
3. **Windows code-signing certificate (recommended for L4 distribution) — NOT YET SET.** An Authenticode certificate avoids SmartScreen warnings on the `.msi`. **Optional for a build-only artifact**; required for a real public release. → Task 9/10 (hooks commented in `build-desktop.yml`).

> The owner has asked to be **reminded at the exact step** each key is needed. Item 1 is **complete** (keypair generated + CI secrets set); only the **public key** hand-off to the Task 11 implementer remains. Items 2-3 remain optional this phase (L4 is build-only) and are only needed before a real public release.

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
| `apps/agent/src/lib.rs` | **New** crate root; `AgentRuntime` (start/stop/status + `wait()`) + module re-exports. |
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
- Produces: `ponter_agent::AgentRuntime` with `start(config: RuntimeConfig) -> Result<RuntimeHandle>`, and `RuntimeHandle::{stop(), status() -> RuntimeStatus, wait()}` — consumed by Task 3's Tauri backend.

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

/// Everything `AgentRuntime::start` needs, already resolved by the caller.
pub struct RuntimeConfig {
    pub server: String,
    pub credential: String,
    pub shell: String,
    pub allow_input: bool,
    pub identity: std::sync::Arc<identity::AgentIdentity>,
    // ... remaining resolved runtime fields (stun, cols/rows, desktop_*, files_root)
}

/// The embedded agent runtime (ADR-50). `start` spawns the reconnect loop and
/// returns a handle; the loop runs until it ends naturally or `stop` is called.
pub struct AgentRuntime;

impl AgentRuntime {
    pub async fn start(config: RuntimeConfig) -> anyhow::Result<RuntimeHandle> { /* ... */ }
}

/// A handle to a running `AgentRuntime`.
pub struct RuntimeHandle { /* join handle + stop signal + shared status */ }

impl RuntimeHandle {
    pub fn status(&self) -> RuntimeStatus { /* ... */ }
    pub async fn wait(&self) -> anyhow::Result<()> { /* ... */ }
    pub async fn stop(&self) -> anyhow::Result<()> { /* ... */ }
}

/// What the runtime is doing, for the tray (ADR-55).
pub enum RuntimeStatus {
    Stopped,
    Disconnected,
    Connected,
}
```

- [ ] **Step 3: Reduce `main.rs` to a thin CLI**

`main.rs` keeps `Cli` (clap), `logging::init()` and `resolve_credential`/`resolve_shell`/`resolve_identity_path`, then builds `RuntimeConfig`, calls `AgentRuntime::start(...)`, and awaits `handle.wait()`. Behaviour (flags, log lines) unchanged.

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

> **Correction (Task 2).** The split shipped as `ce162f95` (plus follow-up fix `d315c667`, which dropped a dead `#[cfg(windows)]` path import left by the move). Three details differ from the sketch above and are the shipped reality:
> - **`logging::init()` stays in the CLI.** The library never initialises a subscriber — `AgentRuntime::start` leaves logging to the caller, so an embedder (the Tauri backend) can install its own. `main.rs` calls `logging::init()` before starting the runtime.
> - **`shutdown_signal()` lives in `lib.rs`, and the CLI's Ctrl-C/SIGTERM behaviour is preserved via `handle.wait()`.** The CLI awaits `RuntimeHandle::wait()` (not `stop()`), so the reconnect loop's own `shutdown_signal()` branch produces the established log lines and exit behaviour rather than a synthesised stop.
> - **The E2E suite keeps 5 pre-existing environmental desktop failures** (Xvfb cursor/input on some hosts); they were proven identical with the baseline binary, so the split introduced none. CI is the binding check for this refactor.

**Stop condition:** if `build-agent.yml` verify or E2E cannot be made green, revert the split and report — ADR-50 is reopened.

---

### Task 3: Tauri backend skeleton + OS keychain wrapper (ADR-51, ADR-52)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock`, `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/capabilities/default.json` (created by Task 1)
- Modify: `apps/desktop/src/App.vue` (remove the spike invoke)
- Create: `apps/desktop/src-tauri/src/keychain.rs`

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

> **Correction (Task 3).** Shipped as `13fa265`; the decisions below are what Tasks 4, 6, and 10 must rely on.
> - **Keychain crate:** `keyring` **4.2.0** (`features = ["apple-native-keyring-store"]`). `Entry::new(service, account)` returns a `Result`, so the `?` is required; the value API is `set_password` / `get_password` / `delete_credential`. A **missing** credential is matched as the exact variant **`keyring::Error::NoEntry`** → `Ok(None)` (get) and idempotent `Ok(())` (delete). **Every other error bubbles** — `PlatformFailure` / `NoStorageAccess` must surface, so callers can distinguish "no credential stored yet" from "the store is broken".
> - **Headless-CI env guard:** the round-trip test returns early when `PONTER_KEYCHAIN_SKIP=1`; locally it runs for real against the OS secret store. **Task 10's workflow author must set `PONTER_KEYCHAIN_SKIP=1` if the CI job ever runs `cargo test`** on the desktop crate — GitHub runners have no secret-service session bus.
> - **`[patch.crates-io]` must be repeated in the desktop root manifest:** Cargo reads `[patch]` only from the **root** manifest of the build, so `apps/desktop/src-tauri/Cargo.toml` carries `[patch.crates-io] xcap = { path = "../../agent/vendor/xcap" }` plus the Windows-only `xcap` wgc target-dep block (same as `apps/agent`). Verify with `cargo tree -i xcap` → vendored path. **Without it the desktop build silently links the unpatched registry `xcap`** (the Wayland black-stream regression the vendored patch fixes).
> - **Shell lockdown shipped:** production `csp` (no `unsafe-eval`, `script-src 'self'`, no remote origins) plus a separate `devCsp` permitting only the Vite HMR origins (`ws://localhost:1420 http://localhost:1420`); `capabilities/default.json` = `["core:default"]` **only**; the opener plugin is removed from `Cargo.toml` + `lib.rs` + the capability (the npm `@tauri-apps/plugin-opener` wrapper is left in `package.json`, untouched); `greet`/`spike_start` are removed and `invoke_handler` is empty; `App.vue` is a static placeholder; a contract test pins `ponter_agent::{AgentRuntime, RuntimeStatus}`.
> - **`src-tauri/src/main.rs` was not touched** by this task (it stays as Task 1 scaffolded it).

---

### Task 4: Account login over `POST /api/auth/login`; token to keychain (ADR-52)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/login.rs`, `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/state.rs`
- Create: `apps/desktop/src/views/LoginView.vue`, `apps/desktop/src/stores/auth.ts`, `apps/desktop/src/types.ts`, `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/App.vue`, `apps/desktop/src/vite-env.d.ts`, `pnpm-lock.yaml`
- Test: `apps/desktop/src/__tests__/login.test.ts`

**Interfaces:**
- Consumes: `keychain::set_secret` (Task 3); `POST /api/auth/login` (existing server).
- Produces: a `login(username, password)` Tauri command returning the user profile; the refresh token stored in the keychain; access token in backend memory.

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
// Test files are exempt from the production-only grep gate, so the plain
// property names are used directly here — no obfuscation.
function storageLength(win: Window, which: 'l' | 's'): number {
  return which === 'l' ? win.localStorage.length : win.sessionStorage.length;
}

it('never writes a secret to webview storage', async () => {
  // assert both legs: after a failed login AND after a successful one
  expect(storageLength(window, 'l')).toBe(0);
  expect(storageLength(window, 's')).toBe(0);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test && pnpm --filter @ponter/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): account login + keychain token storage (ADR-52)"
```

> **Correction (Task 4).** Shipped as `f96a472` (18 files, +785/−66) plus the review-fix commit `463da71` (mutex lock error mapping + honest storage assertions); the decisions below are what Tasks 5, 6, and 10 must rely on.
> - **Server contract:** `POST /api/auth/login` with body **`{username, password}`** — the server looks up `users.username`, so the shipped command is **`login(username, password)`** (the plan's earlier `login(email, password)` was wrong). A `200` returns `{user, token, refreshToken, expiresIn}`; a non-`200` returns `{error, code, details}` and the `error` string is surfaced verbatim to the UI.
> - **HTTP client:** `reqwest` **0.13** with `default-features = false, features = ["json", "rustls-no-provider"]` plus `rustls` **0.23** with `features = ["ring", "std", "tls12"]`. The ring crypto provider is installed **once** in `AppState::new()` before any client is built — reqwest 0.13's `rustls-no-provider` **panics at `Client` build time if no provider is installed**. Ring is chosen because it is already in the lockfile via the agent crate (no `aws-lc-sys` C build). Tasks 5/6 must **reuse `AppState.http` / `AppState.server_url`**, not construct new clients.
> - **Secrets:** the refresh token goes to the keychain under service **`"ponter-desktop"`** / account **`"refresh-token"`** (consts `KEYCHAIN_SERVICE` / `KEYCHAIN_REFRESH_ACCOUNT` in `commands/login.rs`); the access token lives in `AppState.access_token` (`Mutex<Option<String>>`), **memory only**. A keychain write failure **fails the login loudly** (no success-without-persistence). Task 6 adds the agent credential under the same service.
> - **Server URL:** from the `PONTER_SERVER_URL` env var, falling back to `http://localhost:8787`. Task 5's wizard step replaces the default with the user-entered URL.
> - **Frontend infra is now real:** `apps/desktop`'s `lint` / `typecheck` / `test` scripts are real (`eslint` / `vue-tsc` / `vitest` 5.0.3 + `@vue/test-utils` 2.5.1 + `happy-dom` 20.14.5); `pinia` 4.0.3 is wired in `main.ts`; `pnpm-lock.yaml` changes from this task on.
> - **Storage gate (production-only):** `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` → **EMPTY**. Test files are exempt (they read storage to assert emptiness), and property names must never be obfuscated. Future tasks add their own storage assertions under the same rule.
> - **Constraint nuance:** the no-`unwrap()`-in-non-test-code rule applies to **new** code; `lib.rs`'s `.expect("error while running tauri application")` is the Tauri scaffold pattern shipped in Task 3 and is out of scope here.

---

### Layer 2: Wizard + Device Management

### Task 5: Setup wizard with real verification (ADR-53)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/wizard.rs`, `apps/desktop/src/views/WizardView.vue`, `apps/desktop/src/stores/wizard.ts`
- Test: `apps/desktop/src/__tests__/wizard.test.ts`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/src/state.rs`, `apps/desktop/src-tauri/src/commands/login.rs`
- Modify: `apps/desktop/src/App.vue`, `apps/desktop/src/types.ts`
- Modify: `apps/agent/src/lib.rs` (new cfg-gated capture-probe surface — see the Correction note)

**Interfaces:**
- Consumes: the agent `desktop` capture path (probe), `keychain` (Task 3).
- Produces: `probe_server(url) -> ProbeResult`, `probe_capture() -> ProbeResult`, `save_wizard_settings(server_url, allow_input)`, and the wizard state machine.

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

Steps: server (probe reachability), screen permission (real capture probe via the agent path), input gate (default off, ADR-42 two-gate wording), auto-start (informational only in Task 5 — the launch-entry wiring arrives in Task 8). Each step has a verify action, not just an input.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test -- wizard`
Expected: PASS.

- [ ] **Step 5: Mutation check (load-bearing default)**

Temporarily flip `allowInput` default to `true`; confirm the default-closed test goes RED; revert.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): verified setup wizard (ADR-53)"
```

> **Correction (Task 5).** Shipped as `50b37c4` (11 files) plus the review-fix commit `b384736`; the decisions below are what Tasks 6, 7, and 8 must rely on.
> - **Probe contract:** `probe_server(url)` does `GET <url>/health` (the entered URL has its trailing slashes trimmed first; server route `apps/server/src/app.ts:41` → `{"status":"ok"}`, no auth) with a **5s** timeout; success = 2xx **and** `status == "ok"`. Returns `ProbeResult { ok, message }` (camelCase). `probe_capture()` runs `enumerate_sources` → `default_source_id(false, "primary")` → `source_for(id, SAFE_720P30)` → poll `next_frame` ≤5s → `source.stop()`; returns `CaptureProbe { sourceId, width, height, kind }`. The `probe_capture` command is cfg-gated `not(target_env = "musl")` **and its `generate_handler!` entry carries the same per-entry cfg attribute** (the Tauri macro honours per-entry attributes) — without it the musl build fails to resolve the symbol.
> - **Agent lib surface (new public API):** `apps/agent/src/lib.rs` now re-exports (cfg-gated non-musl) `DesktopSourceInfo`, `FrameSource`, `SourceKind`, `default_source_id`, `enumerate_sources`, `source_for`, and defines `CaptureProbe` + `pub async fn probe_capture()`. Tasks 6/7 use this surface; they must **not** re-open the private `desktop` module.
> - **Wizard state machine:** steps `server → capture → inputGate → autoStart`; `allowInput` defaults **false** (ADR-42 Gate A). The advance-gate lives **in the store** (`advance()` refuses without `serverProbe.ok` / `captureProbe.ok`); `inputGate → autoStart` is unconditional (Gate B peer-identity verification happens at admission — Task 7). `completed` is set after steps 1-3 verify; step 4 is not required.
> - **Honesty copy (binding):** the input-gate help names both gates (Gate A here + Gate B peer identity at admission, Task 7); the auto-start step says the launch-entry wiring arrives in Task 8 (ADR-55) and its toggle is informational only — **no `set_autostart` command exists in Task 5**.
> - **Persistence:** `save_wizard_settings(server_url, allow_input)` updates `AppState.server_url` / `AppState.allow_input` in memory **only** — no disk file, no keychain entry in Task 5 (deliberate stop-safe; settings persistence lands with Task 6/7, which first need it across restarts).
> - **State shape:** `AppState.server_url` is now `Mutex<String>` (was `String`) and `AppState.allow_input: Mutex<bool>` (default `false`) was added; the `login` command clones `server_url` before its `.await` (Send-bound fix).
> - **Storage gate:** rule unchanged (production-only grep; test files exempt; never obfuscate).

---

### Task 6: Device registration + management (ADR-54)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/devices.rs`, `apps/desktop/src-tauri/src/test_util.rs`
- Create: `apps/desktop/src/views/DevicesView.vue`, `apps/desktop/src/stores/devices.ts`
- Test: `apps/desktop/src/__tests__/devices.test.ts`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/src-tauri/src/commands/login.rs`, `apps/desktop/src-tauri/src/commands/wizard.rs` (adopt the extracted shared test stubs)
- Modify: `apps/desktop/src/App.vue`, `apps/desktop/src/types.ts`

**Interfaces:**
- Consumes: `POST /api/agents`, `GET /api/agents`, `DELETE /api/agents/:id` (existing); `keychain` (Task 3); the logged-in access token (Task 4).
- Produces: `register_device()`, `list_devices()`, `delete_device(agent_id)` Tauri commands; the one-time credential written to the keychain (service `ponter-desktop`, account `agent-credential`) **inside `register_device`** and **never returned to the frontend**; the `DesktopDevice` projection (no `credential` field).

- [ ] **Step 1: Write the failing test**

```ts
it('registers without ever receiving the credential', async () => {
  // mock invoke('register_device') resolving the projection (no `credential` field)
  // assert the store result has no `credential` property AND localStorage/sessionStorage stay empty
});
```

Rust side (the load-bearing half — the credential is written to the keychain inside the command): `register_device_stores_credential_in_keychain` (asserts the real keychain holds `ag_...` and the returned projection serializes without `ag_`), `register_device_swap_replaces_keychain_value` (re-registration replaces), plus `generate_device_id` / `map_devices_error` pure-fn tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- devices`
Expected: FAIL.

- [ ] **Step 3: Implement registration + device list/delete**

Reuse the existing endpoints (`POST`/`GET`/`DELETE /api/agents`); write the credential to the keychain **inside `register_device`** (before it returns) and never return it to the frontend; the list/delete view mirrors the web dashboard. Registration does **not** start the runtime — that is Task 7.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test -- devices`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat(desktop): device registration + management (ADR-54)"
```

> **Correction (Task 6).** Shipped as `f7216ec` (11 files) plus the review-dedup commit `da016f1` (4 files); 13 files total across the range. The decisions below are what Tasks 7+ must rely on.
> - **Command surface:** 3 new commands — `register_device()`, `list_devices()`, `delete_device(agent_id)` — bringing `invoke_handler` to **7** total (`login`, `probe_server`, `probe_capture`, `save_wizard_settings`, + these 3). No command starts the runtime; the tray/lifecycle is Task 7.
> - **Credential handling:** on a `201` the response envelope `{ agent, credential }` is deserialized, the `credential` is written to the keychain under service **`"ponter-desktop"`** (imported `KEYCHAIN_SERVICE` from `commands/login.rs`) / account **`"agent-credential"`** (`KEYCHAIN_AGENT_ACCOUNT`), then dropped. Only the `DesktopDevice` projection (no `credential` field) crosses to the frontend. A keychain write failure **fails the registration loudly**. **Re-registration replaces** the stored value (last credential wins) — no "write only if absent".
> - **Server contract:** `POST /api/agents` with body `{id, hostname, platform, osVersion, agentVersion}` and header `Authorization: Bearer <access token>`; `publicKey` and `capabilities` are **deliberately omitted** (not fabricated). Success is exactly **201**; `GET /api/agents` → 200 list; `DELETE /api/agents/:id` → 200 `{success:true}`. Non-2xx maps `{error, code, details}` → the `error` string verbatim (`map_devices_error`).
> - **Device id:** `generate_device_id(hostname, random)` → `{sanitized-hostname}-{8 lowercase hex}` (lowercase; non-`[a-z0-9-]` runs → `-`; empty → `device`). The 8-hex suffix comes from **`ring::rand::SystemRandom`** — `ring = "0.17.14"` is now a **direct** dependency (already resolved transitively; zero new crates). Hostname resolution: `HOSTNAME` env → `/etc/hostname` (Linux) → `COMPUTERNAME` (Windows) → `"device"`.
> - **State access:** each command clones `server_url` / `access_token` out of their mutexes **before** any `.await` (the Task 4 Send-bound lesson); lock errors map to `state lock poisoned: {e}`.
> - **Shared test stubs:** `apps/desktop/src-tauri/src/test_util.rs` (`#[cfg(test)]`) centralizes `spawn_stub` / `spawn_stub_capturing` / `ensure_provider`, now used by the login, wizard, and devices test modules (kills the SonarCloud new-code duplication risk — Week 13/16 gotcha).
> - **Frontend:** `DevicesView.vue` replaces the welcome paragraph after the wizard completes (`App.vue`: login → wizard → devices); `types.ts` adds `DesktopDevice` (the no-`credential` projection) + `DeviceSummary`. Storage gate unchanged (production-only grep; test files exempt; never obfuscate).

---

### Layer 3: Tray + Auto-start

### Task 7: Tray icon with connection state (ADR-55)

**Files:**
- Create: `apps/desktop/src-tauri/src/tray.rs`
- Test: `apps/desktop/src-tauri/src/tray.rs` (unit)
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` (single feature flip: `features = ["tray-icon"]`; `Cargo.lock` stays byte-identical)

**Interfaces:**
- Consumes: `AgentRuntime::start/stop`, `RuntimeHandle::status()` (Task 2); `AppState.server_url` / `AppState.allow_input` (Task 5); the keychain credential (Task 6); the identity-path rule mirrored from `apps/agent/src/main.rs`.
- Produces: `tray::TrayState` (managed state owning the runtime slot + tray bookkeeping); 7 pure fns (`tray_label`, `status_text`, `action_for_menu_id`, `derive_ws_url`, `should_hide_on_close`, `resolve_identity_path`, `build_runtime_config`); the lifecycle fns (`init`, `build_menu`, `handle_menu_action`, `start_agent`, `stop_agent`, `quit_app`, `spawn_status_poll`); the exact menu ids `status` / `start` / `stop` / `open` / `quit`; close-to-tray (hide only when the tray built).

> **Cross-ref (Task 5).** The wizard's input-gate copy says the `allow_input` preference (Gate A, ADR-42) is applied at runtime and that Gate B is "wired in Task 7". Task 7's scope here is the tray + lifecycle (start/stop the runtime, consuming `AgentRuntime::status()`); the runtime it starts carries Gate B — the ADR-41 peer-identity admission gate **already shipped in Phase 6a** (`48edac1`) — so Task 7 adds no new identity code.

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
git add apps/desktop/src-tauri/src/tray.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(desktop): tray icon + lifecycle (ADR-55)"
```

> **Correction (Task 7).** Shipped as `b1d7868` (3 files, +731/−1) on `phase7/task-7-tray` (base `2e1fd5c`). The decisions below are what Tasks 8+ must rely on.
> - **File set:** `tray.rs` (create, 703 lines) + `lib.rs` (modify) + `Cargo.toml` (modify) — the `Cargo.toml` change is the ONE-line feature flip `features = []` → `features = ["tray-icon"]` (R2). `Cargo.lock` is **byte-identical** (`tray-icon v0.25.1` / `muda` / `libappindicator` were already resolved transitively; zero new crates).
> - **Honest state surface (3 states only):** the tray label maps `RuntimeStatus`'s exactly three variants — `Stopped` → "Stopped", `Disconnected` → "Disconnected", `Connected` → "Connected". No "Connecting"/"Error" state is fabricated (R7) — the runtime API does not have one.
> - **Menu ids (dispatch contract):** `status` (disabled label "Status: …"), `start`, `stop`, `open`, `quit`. **No "Open at login" item** — auto-start is Task 8 (ADR-55's `set_autostart`).
> - **Close-to-tray:** `WindowEvent::CloseRequested` hides the window (`api.prevent_close()` + `window.hide()`) **only when `tray_active`** is true; if the tray failed to build, `tray_active` stays false and the window closes normally (no stranding). `init` logs + continues on error — the app still opens a window.
> - **Lifecycle:** menu events spawn async (`tauri::async_runtime::spawn`); `start_agent` serializes via a `start_guard` mutex, reads the keychain credential, loads identity via `resolve_identity_path`, and starts `AgentRuntime::start(config)` (stale handle stopped first); `stop_agent`/`quit_app` take the handle and `stop().await`. Status poll = `std::thread::spawn` loop, 1 s tick, `MenuItem::set_text` only on change.
> - **R5 enforcement point:** `build_runtime_config` reads `AppState.allow_input` into `RuntimeConfig.allow_input` — this is where Task 5's Gate A preference (ADR-42) is applied at runtime. Missing/blank credential → `Err` naming registration ("no agent credential stored — register this device in the Devices view first"). `files_root = None` (the files gate stays closed).
> - **No new commands:** `invoke_handler` stays at **7** entries; the tray is backend-only, the frontend is untouched. Start-failure is log-only (no window UI yet) — carry-forward to Task 8/9. Windows pwsh shell detection is a documented CLI-parity gap (uses `cmd.exe`).

---

### Task 8: Auto-start per platform (ADR-55)

**Files:**
- Create: `apps/desktop/src-tauri/src/autostart.rs`
- Test: `apps/desktop/src-tauri/src/autostart.rs` (unit)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`pub mod autostart;` + register the 2 new commands → `invoke_handler` 7 → 9)
- Modify: `apps/desktop/src-tauri/src/tray.rs` ("Open at login" `CheckMenuItem` + `ToggleAutostart` action + handler)
- Modify: `apps/desktop/src/stores/wizard.ts`, `apps/desktop/src/views/WizardView.vue`, `apps/desktop/src/__tests__/wizard.test.ts` (wizard step-4 wiring — FE)

**Interfaces:**
- Consumes: the installed binary path (`std::env::current_exe()`); `TrayState` (Task 7); the wizard store (Task 5).
- Produces: `set_autostart(enabled)` / `is_autostart_enabled() -> bool` Tauri commands (bringing `invoke_handler` to **9**); the platform launch entry (Linux `.desktop` / macOS LaunchAgent plist / Windows `Run` value); the tray "Open at login" `CheckMenuItem` (id `autostart`) and the wizard's functional step 4.

> **Cross-ref (Task 5).** Task 5's wizard ships the auto-start step **informational only** — its toggle holds frontend state and no `set_autostart` command exists yet. Task 8 owns the real `set_autostart` / `is_autostart_enabled` commands and the platform launch entry, and wires the wizard's step 4 to them; the copy that promised "wiring arrives in Task 8" is replaced with the real behavior.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn render_linux_desktop_entry_contains_binary() {
    let entry = render_linux_desktop_entry(Path::new("/opt/ponter/ponter-desktop"));
    assert!(entry.contains("/opt/ponter/ponter-desktop"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml autostart`
Expected: FAIL.

- [ ] **Step 3: Implement per-platform entries**

Linux `<config>/autostart/ponter-desktop.desktop` (the `autostart/` subdir is mandatory — XDG only discovers that dir); macOS LaunchAgent plist `~/Library/LaunchAgents/com.ponter.desktop.plist` (not `SMAppService` — see note); Windows `reg.exe` `Run` value `PonterDesktop` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Render is pure (unit-tested); install/uninstall is the side effect. All three take effect at the **next login**.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml autostart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/autostart.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/tray.rs apps/desktop/src/stores/wizard.ts apps/desktop/src/views/WizardView.vue apps/desktop/src/__tests__/wizard.test.ts
git commit -m "feat(desktop): per-platform auto-start (ADR-55)"
```

> **Correction (Task 8).** Shipped as 5 commits on `phase7/task-8-autostart` (base `a358622`): `b286f28` (BE Rust) → `916e51e` (FE wizard) → `8e75d41` (FE type fix) → `7536b82` (BE XDG-subdir fix) → `2d467cb` (FE view tests) — 6 files, +848/−25. The decisions below are what Tasks 9+ must rely on.
> - **Full scope (owner ruling 2026-10-08):** backend `autostart.rs` + the tray "Open at login" `CheckMenuItem` + wizard step-4 wiring. The plan's original Files block named only `autostart.rs`; the real set is **6 files** (3 Rust + 3 Vue/TS).
> - **`invoke_handler` 7 → 9:** `set_autostart(enabled: bool)` and `is_autostart_enabled() -> bool`, both sync, both callable directly from `tray.rs` (no `State` arg). No new deps; `Cargo.lock` byte-identical.
> - **The entry IS the source of truth (no stored boolean):** `is_autostart_enabled()` reports whether the platform entry exists; `set_autostart` installs/removes it. Both idempotent. Returns `false` on any resolution error (never panics).
> - **Linux entry path = `<XDG config>/autostart/ponter-desktop.desktop`** — the `autostart/` subdir is **mandatory** (XDG only discovers that dir). The initial implementation wrote to `<config>/ponter-desktop.desktop` (a real defect), fixed in `7536b82`; the pin test `linux_autostart_entry_dir_appends_autostart_subdir` locks it. `linux_autostart_dir` keeps its base-config-dir contract; the caller appends the subdir.
> - **macOS** = LaunchAgent plist `~/Library/LaunchAgents/com.ponter.desktop.plist` (chosen over `SMAppService`, which needs a signed/bundled app + entitlements and cannot be verified on this branch). **Windows** = `reg.exe` `Run` value `PonterDesktop` under `HKCU\...\Run` (no `winreg` crate). All take effect at the **next login** (no immediate launch).
> - **Tray item:** a `CheckMenuItem` (id `autostart`, text "Open at login"), placed after "Open window" and before Quit; its checked state is the real OS state at build time. On toggle failure the checkbox **reverts** so it never lies about the real state.
> - **Wizard flow fix:** `completed` is set at **step 4** (`complete()`), not step 3 (`finish()`). Step 3's "Continue" persists settings + advances; step 4's "Finish" applies the auto-start toggle then completes. This makes step 4 reachable in the real app (`App.vue` unmounts the wizard when `completed` is true — previously step 4 was dead). `setAutoStart`/`loadAutoStart` surface errors via `autoStartError`.
> - **Role split (owner ruling 2026-10-08):** `apps/desktop` is split **by file** — Rust `src-tauri/**` = BE, Vue/TS `src/**` = FE. Task 8 was role-split mid-flight (BE originally wrote all 6; the owner flagged it; re-committed per role). See the execution note below.

---

### Desktop UI sync → shadcn-vue (owner-requested addition, not in the original plan)

**Shipped:** branch `phase7/desktop-shadcn-sync` (base `e607e13`) — 2 commits, 34 files, **FE-only**.

> **Correction (Desktop UI sync → shadcn-vue).** Shipped as `c4f17a9` (feat: infra + 3 views) → `6601650` (fix: restore device hostname in the device row). The desktop app adopted the **shadcn-vue** UI stack for parity with `apps/web`. What the note below records is what Tasks 9+ and the later design audit must rely on.
> - **Infra (parity with `apps/web`):** Tailwind v4 + `@tailwindcss/vite` plugin (wired into `vite.config.ts`), `shadcn-vue` + `reka-ui` + `class-variance-authority` + `clsx` + `tailwind-merge` + `tw-animate-css` + `@lucide/vue`; `components.json` (style `reka-vega`, baseColor neutral, cssVariables); `src/style.css` token layer imported from `main.ts`; `src/lib/utils.ts` `cn()`.
> - **Generated UI layer:** `apps/desktop/src/components/ui/**` — alert / badge / button / card / input / label (21 files), **byte-identical to the web client's** `ui/` (verified: matching git blob hashes vs `apps/web/src/components/ui/`).
> - **3 views rewritten** on shadcn components: `LoginView.vue`, `WizardView.vue`, `DevicesView.vue`. The stale DevicesView copy was fixed and the device hostname restored in the row (`6601650`).
> - **Byte-identity + ignore rule extended:** `.prettierignore` now also ignores `apps/desktop/src/components/ui` (registry ships without semicolons; repo prettier would rewrite them — same rationale as the web `ui/`); `eslint.config.js` turns off `vue/multi-word-component-names` for the desktop `ui/**` glob too.
> - **`@vueuse/core` runtime-dep nuance:** added as a **runtime** `dependency` (shadcn-vue components import it), unlike the build-only tooling deps (`@tailwindcss/vite`, `tailwindcss`) added to `devDependencies`. Recorded so a later dependency audit does not "fix" it into devDependencies.
> - **WizardView Card-free ruling (ACCEPTED):** the sync brief mentioned a `Card`, but the shipped WizardView uses Input/Label/Button only — no `Card`. Accepted: the owner's constraint is **reuse the shadcn stack to minimize hand-written code**, not "a Card is mandatory"; visual polish/parity is the concern of the separate frontend design audit below, not this sync.
> - **Owner constraint:** the desktop UI uses shadcn-vue; `apps/desktop/src/components/ui/**` is generated and byte-identical from the `reka-vega` registry, never hand-modified (mirrors the web rule; recorded in Global Constraints).
> - **Queue position:** this landed **after Task 8 (L3)** and **before L4**. Order: **Task 8 → desktop shadcn sync → frontend design audit → L4 (Task 9/10) → L5 (Task 11)**.
> - **Frontend design audit — separate, later task (referenced, not specified here):** a follow-on pass over the frontend `.vue` surfaces (web 28 + desktop 4) using the frontend-design skill. Its content is out of scope for this note.

---

### Layer 4: Packaging + 3-OS CI

### Task 9: Bundle configuration per platform (ADR-56)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (`bundle.active` → `true`; `bundle.targets` → `"all"`; icon array gains `icons/icon.ico` + `icons/icon.icns`)

**Interfaces:**
- Consumes: the built frontend + backend.
- Produces: bundler targets — Linux `.deb`/`.AppImage`/`.rpm`, macOS `.dmg`/`.app`, Windows `.msi` (WiX)/`.exe` (NSIS) — via Tauri 2's `"targets": "all"`.

> **⚠ REMIND THE OWNER (distribution signing).** For a public release, macOS needs a Developer ID cert + notarization and Windows needs an Authenticode cert; without them the installers build but show Gatekeeper/SmartScreen warnings. **Decision #1 (shipped): build-only this phase** — installers ship unsigned; the signing hooks live commented in `build-desktop.yml` (see Task 10).

- [ ] **Step 1: Configure bundle targets**

In `tauri.conf.json`: set `bundle.active = true`, `bundle.targets = "all"` (Tauri 2 expands to the per-platform installer set), and add `icons/icon.ico` (Windows) + `icons/icon.icns` (macOS) to the `icon` array so every bundler target has its required format. `identifier` + `version` were already set.

- [ ] **Step 2: Build locally on Linux**

Run: `pnpm --filter @ponter/desktop tauri build`
Expected: `.deb`/`.AppImage`/`.rpm` produced under `src-tauri/target/release/bundle/`. (On this Fedora dev box the bundler panics with "Can't detect any appindicator library" — a missing-system-lib environment limitation, not a code defect; CI installs the full apt union. Best-effort locally; CI is the real gate.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "build(desktop): bundle targets for linux/macos/windows (ADR-56)"
```

---

### Task 10: `build-desktop.yml` — 3-OS build + release (ADR-56)

**Files:**
- Create: `.github/workflows/build-desktop.yml`
- Modify: `apps/desktop/src-tauri/src/autostart.rs` (add the missing `#[cfg(windows)]` arm for `resolve_autostart_location` — surfaced by Task 10's first Windows compile; see the correction note)

**Interfaces:**
- Consumes: `apps/desktop` + `apps/agent`.
- Produces: installer artifacts on a matrix; attached to a GitHub Release on tag (or a non-dry-run manual dispatch).

- [ ] **Step 1: Write the workflow**

Matrix `ubuntu-latest` / `macos-14` / `windows-latest`; install pnpm 12.6.0 + Node 24 + Rust 1.98.1 + the **union** of Tauri and agent capture-stack Linux system deps; run `pnpm install --frozen-lockfile`, build the frontend, then `tauri build`; upload bundle artifacts; on tag (or non-dry-run dispatch), create a release.

> If the workflow runs `cargo test` on the desktop crate, set **`PONTER_KEYCHAIN_SKIP=1`** — headless runners have no secret-service session bus. **Every** keychain integration test honours this guard: the round-trip test (wired in Task 3) and Task 4's two login integration tests (`login_stores_refresh_token_in_keychain`, `login_surfaces_server_error`).

- [ ] **Step 2: Add a post-build artifact check**

Assert each expected installer file exists and is non-trivial in size (≥ 10 KB); fail the job otherwise. Bash for Linux/macOS, PowerShell for Windows. A second assert in the **release** job fails if zero installers reach `dist/` (guards the silent-empty-release class).

- [ ] **Step 3: Path-filter the workflow**

Trigger on `apps/desktop/**`, `apps/agent/**`, and the workflow file itself. (Push filter is `main`/`develop` + tags — a plain feature-branch push does not fire it; open a PR or push to main/develop to get the 3-OS run.)

- [ ] **Step 4: Verify on a branch push**

Run: push a branch touching `apps/desktop/**`; watch all three OS jobs.
Expected: all green; artifacts present. (First-ever Rust compile of `src-tauri` on macOS/Windows happens here — expect platform-specific fixes; see the correction note.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-desktop.yml
git commit -m "ci(desktop): 3-OS build + bundle + release (ADR-56)"
```

> **Correction (Task 9/10).** Shipped as `1c82218` (PR #64, squash; base `a5dcc63`), 3 files, +329/−3. Pre-squash commits: `7608cc5` (Task 9 bundle config) → `f80caa9` (Task 10 workflow) → `d9349a3` (Windows compile fix) → `e8afcde` (Windows assert fix). The decisions below are what Task 11 must rely on.
>
> - **Task 9 (ADR-56).** `tauri.conf.json` bundle stanza: `active: true`, `targets: "all"`, icon array gains `icons/icon.ico` + `icons/icon.icns` (in addition to the 4 PNGs).
> - **Task 10 (ADR-56).** New `.github/workflows/build-desktop.yml` — 3-OS matrix (`ubuntu-latest`/`macos-14`/`windows-latest`), build + bundle + artifact upload + per-OS assert, plus a `release` job gated on tag or a non-dry-run dispatch.
> - **Two Windows defects, found only at the first cross-platform compile** (the desktop crate had never been compiled on Windows before this task):
>   1. `d9349a3` — `autostart.rs` was missing the `#[cfg(windows)] fn resolve_autostart_location()` arm, so the Windows build hit `E0425` (unresolved name). This was a **pre-existing Task 8 gap** surfaced by Task 10's first Windows compile; the fix returns a placeholder `(PathBuf::new(), WINDOWS_RUN_VALUE)` that the Windows runtime arms ignore.
>   2. `e8afcde` — the Windows assert step filtered on `$_.Extension -match '^(msi|exe)$'`, which **never matched** because `FileInfo.Extension` carries a leading dot (`.msi`); the fix uses `-in '.msi', '.exe'`.
> - **Release-glob regression (fixed in the same PR).** The release `files:` globs were widened to recursive `dist/**/*.<ext>` and a **0-installer assert** was added to the release job, closing a silent-empty-release class (a non-recursive glob would have matched nothing while the job stayed green).
> - **Signing is build-only this phase** (PM decision #1). The macOS (notarization) and Windows (Authenticode) signing hooks are present but **commented** in `build-desktop.yml`; installers ship unsigned.
> - **Carry-forward (not proven by CI).** The `release` job is skipped at PR time (tag/dispatch only), so the recursive release globs and the 0-installer assert are **reasoned-but-unproven** by PR CI — only a real tag or non-dry-run dispatch exercises them (side effect: that creates a public GitHub Release).

---

### Layer 5: Auto-update

### Task 11: Tauri updater with signed manifest (ADR-57)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/commands/updater.rs`
- Test: `apps/desktop/src-tauri/src/commands/updater.rs` (unit)

**Interfaces:**
- Consumes: the Tauri updater plugin + a signed `latest.json` manifest.
- Produces: `check_update() -> Option<UpdateInfo>`, `apply_update()`; `should_apply` refuses an older/equal version. Signature verification is the plugin's (per-platform, during download); `requireSignedVersion: true` refuses an unsigned version (anti-downgrade).

> **✅ OWNER ACTION COMPLETE (2026-10-08).** The updater keypair exists and the private key + password are set as CI secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — verified via `gh secret list`). Only the **public key** hand-off to the implementer (to compile in) remains — the blocking secret side is done, so Task 11 is unblocked.

- [ ] **Step 0: Owner keypair + CI secrets (✅ DONE 2026-10-08)**

The owner generated the keypair and added the private key + password as CI secrets. The remaining hand-off is the **public** key for `tauri.conf.json` `plugins.updater.pubkey` — the implementer needs it before Step 3.

- [ ] **Step 1: Write the failing decision test**

```rust
#[test]
fn refuses_an_older_version() {
    assert!(should_apply("1.0.0", "0.9.0").is_none());
}
```

> **Shipped reality (ADR-57).** The original sketch also asserted an app-level `verify_manifest(unsigned_manifest()).is_err()`. That function was **removed as dead code** (0 callers) — the updater plugin verifies each artifact's **per-platform minisign signature** internally during `Update::download()`, so an app-level re-implementation would duplicate the plugin (and risk divergence). The two tests whose only subject was that function (`refuses_an_unsigned_manifest`, `refuses_a_bad_signature`) were removed with it; the surviving decision test is `should_apply` (shown above). See the "Correction (Task 11)" note for the test-count accounting.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updater`
Expected: FAIL.

- [ ] **Step 3: Implement the updater**

Compile in the **public** updater key (`plugins.updater.pubkey`); set the manifest endpoint (`plugins.updater.endpoints`) and **`requireSignedVersion: true`** in `tauri.conf.json`; the decision function (`should_apply`) compares semver. The plugin performs the per-platform signature check during download.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml updater`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Temporarily invert the version comparison in `should_apply`; confirm `refuses_an_older_version` goes RED; revert. (The signature path is the plugin's, not app code — its coverage is the per-platform `.sig` produced by the build matrix and asserted at release assembly, not a local unit test.)

- [ ] **Step 6: Wire the release to publish the manifest**

Update `build-desktop.yml` to **assemble** `latest.json` on tag (the manifest keys are `{os}-{arch}-{bundle_type}`; each platform entry carries the installer `url` + the **per-platform** minisign `signature` produced by the build matrix — there is no top-level signature and no signing step in the release job itself).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/updater.rs apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml .github/workflows/build-desktop.yml
git commit -m "feat(desktop): signed auto-update (ADR-57)"
```

**Stop condition (RESOLVED — shipped):** L5 shipped as `591a53e` (PR #67, squash). The public updater key is compiled in; the private key + password CI secrets were set 2026-10-08. Phase 7 is complete.

> **Correction (Task 11).** Shipped as `591a53e` (PR #67, squash; base `b3d1ce3` = the #68 merge; branch `phase7/task-11-updater`, chain `b0bf020` → `08176da` → `48ef477` → `bd182a5` → `1bada79`). Scope (8 files): `apps/desktop/src-tauri/**` (updater command module + `commands/mod.rs` + `lib.rs`, `tauri.conf.json` updater plugin block, capabilities, Cargo) + `.github/workflows/build-desktop.yml` (manifest assembly). The decisions below are the shipped reality:
>
> - **Manifest key format is `{os}-{arch}-{bundle_type}`** (e.g. `linux-x86_64-deb`, `darwin-aarch64-app`, `windows-x86_64-msi`) — **NOT** Rust target triples. `bundle_type` follows `tauri-plugin-updater`'s `Installer::name`.
> - **Signature is per-platform** — inside each `platforms[key]` entry as `{ url, signature }` (the minisign signature of that installer binary). **There is no top-level manifest signature**; the plugin reads none for static manifests (it verifies the downloaded bytes against the per-platform signature during `Update::download`).
> - **`requireSignedVersion: true`** in `plugins.updater` closes the anti-downgrade gap — the plugin default is `false`, which would accept an unsigned/older version.
> - **`verify_manifest` was removed as dead code** (0 callers): the plugin owns signature verification, so an app-level re-implementation would duplicate it and risk divergence. The surviving app-level policy helper is `should_apply` (strictly-newer → apply).
> - **Test count: 72 → 70** (within Task 11; base `main` was 69). Two tests — `refuses_an_unsigned_manifest` and `refuses_a_bad_signature` — were removed **because their only subject was the deleted dead function**; this is NOT weakening: no surviving behavior lost (the plugin's own verification is covered by the build-matrix `.sig` + release-assembly assert, not a local unit test). Net: Task 11 added 1 test (`refuses_an_older_version`) over the base.
> - **Release path is reasoned/CI-unproven at PR time.** The `release` job (manifest assembly + per-platform `.sig`) runs only on tag/non-dry-run dispatch, which creates a public GitHub Release. It was validated by an **independent local harness** (recursive `dist/` walk + fail-fast when a platform resolves to nothing) — but a real tag/dispatch is still required to prove it end-to-end.

---

## Self-Review

**1. Spec coverage:**
- ADR-50 (lib/bin) → Task 2. ADR-51 (Vue+Tauri, CSP) → Tasks 1, 3. ADR-52 (keychain, login) → Tasks 3, 4. ADR-53 (wizard) → Task 5. ADR-54 (registration) → Task 6. ADR-55 (tray/auto-start) → Tasks 7, 8. ADR-56 (packaging/CI) → Tasks 9, 10. ADR-57 (updater) → Task 11. ADR-58 (layers) → the layer structure itself. Spec §5.1 (dialog width) → Task 0. Spec §6 mutation discipline → Tasks 5, 11 mutation checks + Task 4 no-secret assertion. No gap.

**2. Placeholder scan:** Task 2 Step 2's interface sketch was corrected to the shipped `AgentRuntime`/`RuntimeHandle`/`RuntimeStatus` signatures (no `todo!()`); the earlier stub was replaced by the real API in the "Correction (Task 2)" note. Spike and CI tasks are inherently exploratory and name their concrete artifact/verdict. No "add error handling"/"similar to Task N" placeholders.

**3. Type consistency:** `AgentRuntime::start/stop/status`, `RuntimeConfig`, `RuntimeStatus`, `keychain::set_secret/get_secret/delete_secret`, `probe_server/probe_capture`, `register_device`, `set_autostart/is_autostart_enabled`, `should_apply` are named once and reused consistently across tasks. (`verify_manifest` was dropped — removed as dead code in Task 11; the updater plugin owns signature verification.)

**4. Review Focus:** five items, each mapped to an owning-task test: (1) re-registration credential swap → Task 6; (2) input-gate default → Task 5 mutation; (3) secret-to-webview → Tasks 3/4; (4) updater refuse → Task 11 mutation; (5) auto-start entry path → Task 8.

## Execution Handoff

Per ADR-58, execute **layer by layer** (L0 → L5); each layer is a stop-safe boundary. Task 0 ships first and is independent. L0 (Task 1) gates L1; if it fails, stop and report.

**Role split within `apps/desktop` (owner ruling 2026-10-08).** The desktop app is split **by file**, not by task: Rust under `apps/desktop/src-tauri/**` is the **BE** role; Vue/TS under `apps/desktop/src/**` is the **FE** role. A task whose scope spans both (e.g. Task 8's backend + tray + wizard wiring) is dispatched as two role-owned slices on one branch, and each role commits only its own files. Task 8 was role-split mid-flight (BE originally wrote all 6 files; the owner flagged the mixing; the work was re-committed per role — the 3 Rust files by BE, the 3 Vue/TS files by FE).
