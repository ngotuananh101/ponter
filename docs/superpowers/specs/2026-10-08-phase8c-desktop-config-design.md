# Phase 8c: Desktop Server Configuration, Persistence, Login Ordering & Dark Mode — Design Spec

- **Status:** Draft (owner-approved scope 2026-10-08; spec pending review)
- **Phase:** 8 (extension — workstream **8c**; sibling of 8a self-build and 8b TURN)
- **Related:** `apps/desktop/src-tauri/src/state.rs`, `apps/desktop/src-tauri/src/commands/wizard.rs`, `apps/desktop/src-tauri/src/commands/login.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/App.vue`, `apps/desktop/src/views/{LoginView,WizardView}.vue`, `apps/desktop/src/stores/{auth,wizard}.ts`, `apps/desktop/src/style.css`, `.github/workflows/build-desktop.yml`, `apps/web/src/composables/useTheme.ts` (parity source), `docs/guides/self-hosting.md`.

---

## 1. Why 8c, and what "done" means here

Phase 7 shipped the desktop app (`ponter-desktop`). Three defects surfaced when the owner tried to point a built installer at a self-hosted server, plus one visual gap:

1. **The server URL is effectively fixed at `localhost`.** `AppState::new()` reads `PONTER_SERVER_URL` and falls back to `http://localhost:8787` (`state.rs:31-33`). The build workflow sets no such variable, so a downloaded installer always starts pointed at localhost.
2. **The wizard's server step is unreachable — a hard dead-end.** `App.vue` renders `LoginView` first; `login` authenticates against `state.server_url` (the localhost default). On a machine with no server at localhost, login fails, so the user never reaches `WizardView` (where the server URL is entered). The only escape is setting `PONTER_SERVER_URL` in the environment before launching — not something a GUI user can do.
3. **Wizard settings do not survive a restart.** `save_wizard_settings` writes `AppState.server_url` / `allow_input` in memory only (`wizard.rs:5-6,143`). The Phase 7 plan promised persistence would land in a later task (`2026-10-07-phase7-agent-desktop-app.md:503`); it did not. Every launch re-enters the server URL and the input-gate preference.
4. **Dark mode is inert.** `style.css` defines a full `.dark { … }` token block and `@custom-variant dark`, but nothing ever adds the `.dark` class to the document — there is no theme composable, no `prefers-color-scheme` handling, and no toggle. The app renders light-only. The web app has the missing piece (`useTheme.ts` + `ThemeToggle.vue`); the desktop app does not.

**"Done" for 8c means:**

1. A freshly built installer points at a **build-time default server URL** supplied by the operator (baked at compile), with no environment variable needed.
2. A user can **enter the server URL in the GUI before logging in**, and the value **persists across restarts**.
3. The wizard's input-gate preference **persists across restarts**.
4. The desktop app **follows the OS dark/light preference** and lets the user toggle it, matching the web app's behaviour.

---

## 2. Current state, re-verified against the tree at `6a568c0`

| Concern | Today | Evidence |
|---|---|---|
| Server URL source | runtime `PONTER_SERVER_URL`, fallback `http://localhost:8787` | `state.rs:31-33` |
| Build-time URL | none | `build-desktop.yml` has no `PONTER_*`/`VITE_*` env |
| Login order | login **before** wizard | `App.vue`: `LoginView v-if="!isAuthenticated"` then `WizardView v-else-if="!completed"` |
| Settings persistence | memory only | `wizard.rs:143` "runtime only — no disk persistence"; only `fs::write` in the crate is `autostart.rs:133` |
| Theme | `.dark {}` tokens exist, never applied | `style.css:9,102`; no `classList`/`useTheme`/`matchMedia` in `apps/desktop/src` |
| Web parity | `useTheme.ts` (localStorage `remote.theme` + `matchMedia` + `.dark` on `<html>`) + `ThemeToggle.vue` | `apps/web/src/composables/useTheme.ts` |
| Storage constraint (R8) | production desktop frontend code must contain **no** webview-storage reference | `2026-10-07-phase7-agent-desktop-app.md:440`; tests assert `storageLength === 0` |

---

## 3. Architecture decisions (ADR-64 to ADR-68)

### ADR-64: Server URL resolution is a four-level precedence chain

Resolve the server URL in this order, first non-empty wins:

1. **Runtime env** `PONTER_SERVER_URL` — operator/debug override; highest precedence, never persisted.
2. **Persisted config** — the value the user saved in the GUI (ADR-65).
3. **Build-time default** — a compile-time constant baked from `PONTER_DEFAULT_SERVER_URL` (ADR-67); empty when unset.
4. **`http://localhost:8787`** — development fallback, unchanged.

Rationale: existing deployments that set `PONTER_SERVER_URL` keep working byte-for-byte (level 1 unchanged); a self-builder gets a sensible installer default (level 3); an end user can correct it in the GUI and have it stick (level 2). A whitespace-only value at any level is treated as unset.

### ADR-65: Settings persist as a JSON file in the Tauri app-config directory

`serverUrl`, `allowInput`, and `theme` are written to `<app_config_dir>/config.json` (e.g. `~/.config/com.ponter.desktop/config.json` on Linux), via `tauri::Manager::path().app_config_dir()`. No new dependency: `serde_json` + `std::fs` (already used in `autostart.rs`). The file is created lazily on first save; a missing or unparseable file is treated as "no persisted config" (never a hard error — a corrupt config must not brick startup). The access token and refresh token remain memory/keychain-only (ADR-52 unchanged) — **no secret is ever written to this file**.

`PersistedConfig` is `{ server_url: Option<String>, allow_input: bool, theme: Option<String> }` (all fields `#[serde(default)]` so an older/partial file still loads). `AppState` gains a `config_path: Option<PathBuf>` (set during `.setup()` where `app.handle()` exists) and a `persisted: Mutex<PersistedConfig>`. Startup order: load file → apply to `server_url` / `allow_input` / initial `theme` → resolve server URL via ADR-64.

### ADR-66: The server step moves before login — flow becomes Server → Login → Setup → Devices

`App.vue`'s render order becomes:

```
ServerSetupView   v-if="!config.hasServerUrl || config.editing"
LoginView         v-else-if="!auth.isAuthenticated"
WizardView        v-else-if="!wizard.completed"   (steps: capture → inputGate → autoStart)
DevicesView       v-else
```

The wizard's `server` step is extracted into a standalone `ServerSetupView` (reusing the existing server-step UI: input + probe + continue) backed by a `config` store and the existing `probe_server` command. The wizard state machine drops `server` and starts at `capture`. This removes the dead-end: the user configures the server **first**, so `login` always targets a reachable URL.

`hasServerUrl` means "a real source supplied the URL" (runtime env, persisted value, or non-empty build-time default) — **not** "the resolved URL is non-empty", which is always true because of the localhost fallback. `LoginView` shows a small "Server: `<url>` · Change" affordance that sets `config.editing = true`, so a user whose configured server is wrong or unreachable can return to `ServerSetupView` instead of being stuck at a failing login. This is the second half of the dead-end fix.

`save_wizard_settings` is replaced by `save_config` (serverUrl + allowInput → file), called from the server step and the wizard's input-gate step respectively.

### ADR-67: The build-time default is compiled in via `option_env!` and set from a repo variable

Rust `option_env!("PONTER_DEFAULT_SERVER_URL")` captures the variable at compile time — the correct Tauri-v2 mechanism (the framework does not interpolate `tauri.conf.json`; see ADR-61 for the same constraint). `.github/workflows/build-desktop.yml` passes `PONTER_DEFAULT_SERVER_URL: ${{ vars.PONTER_DEFAULT_SERVER_URL || '' }}` into the `tauri build` step's `env`. Unset ⇒ `None` ⇒ level 3 skipped ⇒ behavior identical to today. Documented in `docs/guides/self-hosting.md` §3 so a fork sets the repo variable before building.

### ADR-68: Dark mode ports the web *behaviour* but persists via the config file, not webview storage

The desktop app is bound by the **R8 storage gate** (`2026-10-07-phase7-agent-desktop-app.md:440`): production frontend code under `apps/desktop/src` must contain **no** `localStorage`/`sessionStorage`/`indexedDB` reference (the gate greps for those names and requires the result to be empty; test files are exempt). The web composable persists the theme in `localStorage`, so it **cannot be copied verbatim**.

`apps/desktop/src/composables/useTheme.ts` therefore mirrors the web *behaviour* — `theme: Ref<'light'|'dark'>`, `isDark`, `toggle()`, `set()`, `matchMedia('(prefers-color-scheme: dark)')` as the initial value when no preference is stored, and the `.dark` class toggled on `document.documentElement` with `flush: 'sync'` — but its **persistence goes through the Rust config file** (`theme` field added to `PersistedConfig`, ADR-65), read at startup and written on `set()` via `invoke('save_config', …)`. No webview storage is touched. A `ThemeToggle` control (ported from web, using `packages/ui-components` Button) is added to the desktop shell. The existing `.dark {}` token block in `style.css` is the styling target and is unchanged.

Resolved initial theme, in order: (1) persisted `theme` in config; (2) OS `prefers-color-scheme`; (3) `light`.

---

## 4. Scope decisions

**In scope:**
- Server-URL precedence chain (ADR-64) + build-time default (ADR-67).
- JSON persistence of `serverUrl` + `allowInput` (ADR-65).
- Login-order change: `ServerSetupView` before `LoginView` (ADR-66).
- Dark mode: `useTheme` composable + toggle (ADR-68).
- Docs: `docs/guides/self-hosting.md` (§3 server URL — add the build-time variable) and `docs/guides/development.md` if it documents the desktop flow.
- Tests for every behaviour above (Rust unit/integration + frontend Vitest).

**Out of scope:**
- Any change to `apps/web`, `apps/server`, `apps/agent`, `packages/**`.
- Reworking the wizard's capture/input-gate/auto-start steps beyond dropping `server`.
- Keychain/secret handling (ADR-52 unchanged).
- Multi-server profiles / server list (one active server URL only).
- Theme sync between desktop and web (each is local).

---

## 5. Component changes

| File | Change |
|---|---|
| `apps/desktop/src-tauri/src/config.rs` (new) | `PersistedConfig { server_url: Option<String>, allow_input: bool, theme: Option<String> }`; `load_config(path) -> PersistedConfig` (missing/corrupt ⇒ default); `save_config(path, cfg)`; `resolve_server_url(runtime_env, persisted, build_default) -> String` (pure, unit-tested). |
| `apps/desktop/src-tauri/src/state.rs` | Add `config_path: Option<PathBuf>` + `persisted: Mutex<PersistedConfig>`; `AppState::new()` no longer reads env directly — a `with_config(path)` constructor loads the file and applies ADR-64. |
| `apps/desktop/src-tauri/src/lib.rs` | In `.setup()`, compute `app_config_dir()`, build `AppState` with it, register `get_config`/`save_config` commands. |
| `apps/desktop/src-tauri/src/commands/wizard.rs` | Replace `save_wizard_settings` with `get_config` + `save_config` (read/write the file + update `AppState`); keep `probe_server`. |
| `apps/desktop/src-tauri/src/commands/mod.rs` | Register the new commands. |
| `apps/desktop/src/App.vue` | Four-stage flow per ADR-66. |
| `apps/desktop/src/views/ServerSetupView.vue` (new) | Server input + probe + continue (extracted from `WizardView` step 1). |
| `apps/desktop/src/stores/config.ts` (new) | `serverUrl`, `allowInput`, `theme`, `hasServerUrl`, `editing`, `load()`, `save()` via `invoke('get_config'/'save_config')`. |
| `apps/desktop/src/stores/wizard.ts` | Drop the `server` step; start at `capture`; `finish()` calls `save_config` for `allowInput`. |
| `apps/desktop/src/composables/useTheme.ts` (new) | Theme behaviour (matchMedia initial + `.dark` class), persisted via the config store — **no webview storage** (R8). |
| `apps/desktop/src/components/ThemeToggle.vue` (new) | Toggle control (uses `packages/ui-components` Button). |
| `.github/workflows/build-desktop.yml` | Pass `PONTER_DEFAULT_SERVER_URL` into the build step. |
| `docs/guides/self-hosting.md` | §3: document the build-time repo variable. |

---

## 6. Testing strategy

**Rust (`apps/desktop/src-tauri`):**
- `resolve_server_url` truth table: all four precedence levels + whitespace-only treated as unset + empty build default skipped.
- `load_config`: missing file ⇒ default; corrupt JSON ⇒ default (no panic); valid ⇒ parsed; partial JSON (missing `theme`) ⇒ loads with defaults for absent fields.
- `save_config` round-trip: write then load equals written; parent dir created if absent.
- Login-order guard: a test asserting `login` reads the resolved URL (via `AppState` after `with_config`).
- Test-integrity: any modified test declares `#[test]` before → after.

**Frontend (Vitest, `apps/desktop`):**
- `config` store: `hasServerUrl` false when unset; `save()` calls `invoke('save_config', …)`.
- `App.vue` flow: renders `ServerSetupView` when no server; `LoginView` when server set but unauthenticated; `WizardView` when authenticated and incomplete; `DevicesView` when complete.
- `wizard` store: starts at `capture`; `finish()` persists `allowInput`.
- `useTheme`: initial value from the persisted config when present; else from `matchMedia`; `toggle()` flips, writes `.dark` on `<html>`, and calls `invoke('save_config', …)` — **and the storage gate still holds**: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` must stay **EMPTY**.
- Test-integrity: report `it()`/`expect()` before → after for every touched test file.

---

## 7. Risks and stop conditions

1. **`app_config_dir` unavailable / unwritable.** Mitigation: treat a failed path resolution as "no persistence" and continue with the ADR-64 chain; log once; never crash startup. Stop condition: if persistence cannot be made reliable on any target OS, 8c ships levels 1/3/4 + dark mode and persistence is deferred.
2. **Login-order regression breaks the Phase 7 wizard flow.** Mitigation: the flow change is covered by an explicit `App.vue` test matrix; the wizard's own state-machine tests are updated (server step removed) with declared before→after counts.
3. **Build-time variable not plumbed on a fork.** Mitigation: documented in `self-hosting.md` §3; unset is a safe no-op.
4. **Theme flash on startup (FOUC).** Mitigation: apply the theme as early as possible — read the persisted theme from the config store during app init (before mount) and toggle `.dark` at module load, same as web; a small residual flash on first paint is a known Tauri/Vite tradeoff, documented.
5. **Scope creep into sharing code with web.** Mitigation: the composable is ported, not extracted into a shared package; a shared extraction is a separate task if ever wanted.
6. **R8 storage-gate regression.** The web composable persists via `localStorage`; a naive port would trip the R8 gate. Mitigation: theme persistence goes through `config.json` (ADR-65/68), and the exit gates re-run the storage grep.

---

## 8. Definition of done — exit gates

- `cargo test` (desktop) green, including the new config/URL tests; `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` clean.
- `pnpm --filter @ponter/desktop test` green, including the flow matrix and theme tests.
- `pnpm format:check` / `turbo run lint` / `turbo run typecheck` green.
- **R8 storage gate still empty:** `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` returns nothing.
- `build-desktop.yml` builds on all three OSes with `PONTER_DEFAULT_SERVER_URL` unset (no regression) — the 3-OS matrix is the check.
- A manual smoke (or a documented reproduction) shows: fresh install → server prompt → login → wizard; restart preserves the server URL and the input-gate choice; the theme follows the OS and the toggle sticks.
- Docs updated; no change to `apps/web`, `apps/server`, `apps/agent`, `packages/**`, or any `ui/**` path.

---

## 9. Explicitly out of scope

- Renaming the project or changing author identity (ADR-60 still binds).
- The 8a self-build workstream and the 8b TURN workstream (separate, already shipped/merged).
- Any server-side or protocol change; the desktop client's wire behaviour is unchanged.
- A server-profile manager, SSO, or account switching.
