# Phase 8c: Desktop Server Configuration, Persistence, Login Ordering & Dark Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user of a built `ponter-desktop` installer point it at their own server (build-time default + in-app configuration before login), have the server URL / input-gate / theme choices survive a restart, and get working dark mode — without breaking the Phase 7 flow or the R8 "no webview storage" gate.

**Architecture:** Three layers change together. (1) A new Rust `config.rs` owns a `PersistedConfig` JSON file in the Tauri app-config dir and a pure four-level server-URL precedence chain. (2) `AppState` loads that file at startup and exposes two commands, `get_config` / `save_config`, replacing the memory-only `save_wizard_settings`. (3) The Vue app reorders its stages to **Server → Login → Wizard → Devices**, backed by a new `config` store, and ports the web theme *behaviour* while persisting through the config file instead of `localStorage`.

**Tech Stack:** Rust (Tauri v2, serde, `std::fs`), Vue 3 + Pinia + TypeScript (Vitest/happy-dom), Tailwind v4 (`shadcn-vue` tokens already present), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-08-phase8c-desktop-config-design.md` (ADR-64..68) — the plan argues from the spec; read both.

## Global Constraints

- **No new dependency.** Rust uses `serde` + `serde_json` + `std::fs` (already in `Cargo.toml`); frontend adds none. No new crate, no new npm package.
- **R8 storage gate is binding.** Production frontend code under `apps/desktop/src` must contain **no** `localStorage` / `sessionStorage` / `indexedDB` reference. The gate is:
  `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` → **must be empty**. Test files are exempt; property names must never be obfuscated.
- **No secret is ever written to `config.json`.** The access token stays in memory and the refresh token in the OS keychain (ADR-52). The config file holds only `serverUrl`, `allowInput`, `theme`.
- **The four-level precedence chain (ADR-64) is exact:** runtime `PONTER_SERVER_URL` → persisted `config.json` → build-time `PONTER_DEFAULT_SERVER_URL` (`option_env!`) → `http://localhost:8787`. A whitespace-only value at any level is treated as unset.
- **`PONTER_SERVER_URL` behavior is unchanged** for existing deployments (level 1 still wins; the fallback is still localhost when nothing else is set).
- **`packages/ui-components/src/components/ui/**` is generated — never hand-modify it.** `ThemeToggle` wraps the existing `Button`.
- **Test integrity (binding):** no existing test is deleted, skipped, or weakened. Every change to an existing test is declared before→after with reason. New tests are additive. Report `it()`/`expect()` (Vitest) and `#[test]` (Rust) counts before→after for any touched test file.
- **Language:** technical artifacts (code, identifiers, shell, commits, repo docs) are **English**. Conversation replies are Vietnamese.

## Review Focus

The five input classes / failure modes the spec implies but no task's happy-path tests exercise — each is pinned by a test in the owning task:

1. **`config.json` is corrupt or hand-edited to invalid JSON.** A reasonable user expects the app to still start — behavior: treat as "no persisted config", fall through the precedence chain, never panic. Pinned in **Task 1**.
2. **`config.json` is a partial file** (written by an older build, missing `theme`). Behavior: absent fields default, present fields load. Pinned in **Task 1**.
3. **`PONTER_DEFAULT_SERVER_URL` was baked empty** (the workflow passes `''` when the repo variable is unset). Behavior: level 3 is skipped, not returned as an empty string. Pinned in **Task 1**.
4. **The configured server is set but unreachable at login.** A reasonable user expects a way back to the server step rather than a permanently failing login. Behavior: `LoginView` offers a "Change server" affordance that re-opens `ServerSetupView`. Pinned in **Task 4**.
5. **A stale `theme` value in the file** (e.g. `"blue"`). Behavior: treated as unset → fall back to `prefers-color-scheme`. Pinned in **Task 5**.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/config.rs` (create) | `PersistedConfig`; `load_config`/`save_config`; pure `resolve_server_url`. |
| `apps/desktop/src-tauri/src/state.rs` (modify) | Add `config_path`, `persisted`, `has_server_url`; `with_config(path)` constructor; `new()` delegates with `None`. |
| `apps/desktop/src-tauri/src/lib.rs` (modify) | `.setup()` resolves `app_config_dir()` and builds `AppState::with_config`; register `get_config`/`save_config`; drop `save_wizard_settings`. |
| `apps/desktop/src-tauri/src/commands/wizard.rs` (modify) | Replace `save_wizard_settings` with `get_config` + `save_config` + testable impls; keep `probe_server`. |
| `apps/desktop/src-tauri/src/commands/mod.rs` (modify) | Export nothing new (module already declared) — verify only. |
| `apps/desktop/src/types.ts` (modify) | Add `AppConfig`; add `'capture'` as the wizard start; keep `WizardStep` minus `'server'`. |
| `apps/desktop/src/stores/config.ts` (create) | `serverUrl`, `allowInput`, `theme`, `hasServerUrl`, `editing`; `load()`, `save()`. |
| `apps/desktop/src/views/ServerSetupView.vue` (create) | Server URL input + probe + continue (extracted from `WizardView` step 1). |
| `apps/desktop/src/App.vue` (modify) | Four-stage flow per ADR-66. |
| `apps/desktop/src/stores/wizard.ts` (modify) | Drop `'server'`; start at `'capture'`; `finish()` calls `save_config` for `allowInput`. |
| `apps/desktop/src/views/WizardView.vue` (modify) | Remove the server step block; wire `finish()` to the config store. |
| `apps/desktop/src/views/LoginView.vue` (modify) | Add the "Server: … · Change" affordance. |
| `apps/desktop/src/composables/useTheme.ts` (create) | Theme behaviour (matchMedia + `.dark` class), persisted via the config store. |
| `apps/desktop/src/components/ThemeToggle.vue` (create) | Toggle control (wraps `ui/button`). |
| `apps/desktop/src/main.ts` (modify) | Apply theme before mount; load config after mount. |
| `.github/workflows/build-desktop.yml` (modify) | Pass `PONTER_DEFAULT_SERVER_URL` into the Tauri build step. |
| `docs/guides/self-hosting.md` (modify) | §3: document the desktop build-time server URL. |

**PR strategy:** one workstream → **one branch `phase8c/desktop-config` → one PR**. Tasks 1–2 are Rust, 3–5 frontend, 6 CI+docs; they are interdependent (the frontend calls the new commands), so they must not be split across PRs. Under the owner policy, code tasks go through the full review chain (implementer → task reviewer → QA → BA docs audit → PM cross-check), then PR → merge on all-CI-green.

---

## Task 1: Rust config core (`config.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/config.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `pub mod config;`)

**Interfaces:**
- Produces: `PersistedConfig { server_url: Option<String>, allow_input: bool, theme: Option<String> }`; `load_config(&Path) -> PersistedConfig`; `save_config(&Path, &PersistedConfig) -> Result<(), String>`; `resolve_server_url(Option<&str>, Option<&str>, Option<&str>) -> String`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src-tauri/src/config.rs` with the module doc + tests only (no implementation yet):

```rust
//! Persisted desktop configuration (ADR-64/65/68).
//!
//! `PersistedConfig` is the on-disk JSON shape written to the Tauri app-config
//! directory. It holds ONLY non-secret preferences — the access token stays in
//! memory and the refresh token in the OS keychain (ADR-52).

use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_runtime_env() {
        assert_eq!(
            resolve_server_url(Some("http://env:1"), Some("http://file:2"), Some("http://build:3")),
            "http://env:1"
        );
    }

    #[test]
    fn resolve_falls_to_persisted_when_env_absent() {
        assert_eq!(
            resolve_server_url(None, Some("http://file:2"), Some("http://build:3")),
            "http://file:2"
        );
    }

    #[test]
    fn resolve_falls_to_build_default() {
        assert_eq!(
            resolve_server_url(None, None, Some("http://build:3")),
            "http://build:3"
        );
    }

    #[test]
    fn resolve_falls_to_localhost_when_all_unset() {
        assert_eq!(resolve_server_url(None, None, None), "http://localhost:8787");
    }

    #[test]
    fn resolve_treats_whitespace_only_as_unset() {
        assert_eq!(
            resolve_server_url(Some("   "), Some("http://file:2"), None),
            "http://file:2"
        );
        // An empty build default must NOT be returned as "".
        assert_eq!(resolve_server_url(None, None, Some("")), "http://localhost:8787");
    }

    #[test]
    fn resolve_trims_trailing_slashes() {
        assert_eq!(
            resolve_server_url(Some("http://host:8787///"), None, None),
            "http://host:8787"
        );
    }

    #[test]
    fn load_missing_file_is_default() {
        let path = std::env::temp_dir().join("ponter-cfg-missing-does-not-exist.json");
        let _ = std::fs::remove_file(&path);
        let cfg = load_config(&path);
        assert_eq!(cfg, PersistedConfig::default());
    }

    #[test]
    fn load_corrupt_json_is_default() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        assert_eq!(load_config(&path), PersistedConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_partial_json_defaults_absent_fields() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        // An older build that had no `theme` field.
        std::fs::write(&path, r#"{"serverUrl":"http://s:1","allowInput":true}"#).unwrap();
        let cfg = load_config(&path);
        assert_eq!(cfg.server_url.as_deref(), Some("http://s:1"));
        assert!(cfg.allow_input);
        assert_eq!(cfg.theme, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips_and_creates_parent_dir() {
        let dir = std::env::temp_dir().join(format!("ponter-cfg-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Parent does not exist yet — save must create it.
        let path = dir.join("nested").join("config.json");
        let cfg = PersistedConfig {
            server_url: Some("http://s:1".to_string()),
            allow_input: true,
            theme: Some("dark".to_string()),
        };
        save_config(&path, &cfg).expect("save should create parent dir and write");
        assert_eq!(load_config(&path), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test config:: 2>&1 | tail -30`
Expected: FAIL to compile — `PersistedConfig`, `resolve_server_url`, `load_config`, `save_config` not defined.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` block in `config.rs`:

```rust
/// The on-disk config shape. Every field defaults so an older or partial file
/// still loads (ADR-65).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedConfig {
    pub server_url: Option<String>,
    pub allow_input: bool,
    pub theme: Option<String>,
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self { server_url: None, allow_input: false, theme: None }
    }
}

/// Load the config from `path`. A missing, unreadable, or invalid file yields
/// the default config — never an error (a corrupt config must not brick
/// startup, ADR-65).
pub fn load_config(path: &Path) -> PersistedConfig {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => PersistedConfig::default(),
    }
}

/// Write `cfg` to `path` as pretty JSON, creating the parent directory if it
/// does not exist.
pub fn save_config(path: &Path, cfg: &PersistedConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create config dir {parent:?}: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("could not serialize config: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("could not write config {path:?}: {e}"))
}

/// Resolve the effective server URL from the four-level precedence chain
/// (ADR-64): runtime env → persisted → build-time default → localhost.
/// A whitespace-only value at any level is treated as unset; the result has
/// trailing slashes trimmed.
pub fn resolve_server_url(
    runtime_env: Option<&str>,
    persisted: Option<&str>,
    build_default: Option<&str>,
) -> String {
    for candidate in [runtime_env, persisted, build_default] {
        if let Some(value) = candidate {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.trim_end_matches('/').to_string();
            }
        }
    }
    "http://localhost:8787".to_string()
}
```

Add to `apps/desktop/src-tauri/src/lib.rs` near the other `pub mod` lines:

```rust
pub mod config;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test config:: 2>&1 | tail -30`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint + format**

Run: `cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/config.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): persisted config core + server URL precedence chain"
```

---

## Task 2: AppState wiring + `get_config` / `save_config` commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/state.rs`
- Modify: `apps/desktop/src-tauri/src/commands/wizard.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` in both files.

**Interfaces:**
- Consumes: `config::{PersistedConfig, load_config, save_config, resolve_server_url}` (Task 1).
- Produces: `AppState::with_config(Option<PathBuf>) -> AppState`; fields `config_path: Option<PathBuf>`, `persisted: Mutex<PersistedConfig>`, `has_server_url: bool`; commands `get_config(state) -> ConfigPayload` and `save_config(server_url: Option<String>, allow_input: bool, theme: Option<String>, state)`.
- `ConfigPayload` (camelCase on the wire): `{ server_url: Option<String>, allow_input: bool, theme: Option<String>, has_server_url: bool }`.

- [ ] **Step 1: Write the failing tests**

In `state.rs`, add to a new `#[cfg(test)] mod tests`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PersistedConfig;

    #[test]
    fn with_config_none_defaults_to_localhost() {
        // No config path, no env (assumes PONTER_SERVER_URL unset in the test env).
        let state = AppState::with_config(None);
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(!state.has_server_url);
    }

    #[test]
    fn with_config_loads_persisted_server_url_and_sets_has_server_url() {
        let dir = std::env::temp_dir().join(format!("ponter-state-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        save_config(&path, &PersistedConfig {
            server_url: Some("http://file:9".to_string()),
            allow_input: true,
            theme: Some("dark".to_string()),
        })
        .unwrap();

        let state = AppState::with_config(Some(path));
        assert_eq!(*state.server_url.lock().unwrap(), "http://file:9");
        assert!(*state.allow_input.lock().unwrap());
        assert!(state.has_server_url);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

In `commands/wizard.rs`, add tests inside the existing `mod tests`:

```rust
    #[test]
    fn save_config_impl_persists_and_updates_state() {
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = crate::state::AppState::with_config(Some(path.clone()));

        save_config_impl(&state, Some("http://new:1/"), true, Some("dark"))
            .expect("save should succeed");

        // Runtime mirrors updated.
        assert_eq!(*state.server_url.lock().unwrap(), "http://new:1");
        assert!(*state.allow_input.lock().unwrap());
        // File persisted.
        let reloaded = crate::config::load_config(&path);
        assert_eq!(reloaded.server_url.as_deref(), Some("http://new:1"));
        assert!(reloaded.allow_input);
        assert_eq!(reloaded.theme.as_deref(), Some("dark"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_config_impl_ignores_blank_server_url() {
        let dir = std::env::temp_dir().join(format!("ponter-savecfg-blank-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        let state = crate::state::AppState::with_config(Some(path.clone()));

        // Blank server URL must not clobber the resolved URL.
        save_config_impl(&state, Some("   "), false, None).expect("save should succeed");
        assert_eq!(*state.server_url.lock().unwrap(), "http://localhost:8787");
        assert!(crate::config::load_config(&path).server_url.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -30`
Expected: FAIL to compile — `with_config`, `has_server_url`, `save_config_impl` not defined.

- [ ] **Step 3: Rewrite `state.rs`**

```rust
//! Application managed state shared across Tauri commands (ADR-52).
//!
//! `AppState` is registered via `tauri::Builder::manage` in `lib.rs`. The
//! access token lives only here, in backend memory, and is never passed into
//! the webview or persisted to disk.

use crate::config::{load_config, resolve_server_url, PersistedConfig};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub http: reqwest::Client,
    /// Effective server URL (ADR-64). `Mutex` so `save_config` can write it and
    /// `login` can read it.
    pub server_url: Mutex<String>,
    /// Whether a real source (env / persisted / build default) supplied the
    /// URL — NOT whether the resolved URL is non-empty (the localhost fallback
    /// always makes it non-empty). Drives `ServerSetupView` visibility.
    pub has_server_url: bool,
    /// Access token: memory only, never persisted.
    pub access_token: Mutex<Option<String>>,
    /// Input-gate preference (ADR-42 Gate A), loaded from config.
    pub allow_input: Mutex<bool>,
    /// Path to `config.json`; `None` in tests / when `app_config_dir()` is
    /// unavailable (persistence is then a no-op).
    pub config_path: Option<PathBuf>,
    /// The last-loaded/known persisted config (kept in sync on save).
    pub persisted: Mutex<PersistedConfig>,
}

impl AppState {
    /// Build state with an explicit config path. Loads the persisted config and
    /// resolves the server URL via the ADR-64 chain.
    pub fn with_config(config_path: Option<PathBuf>) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let persisted = config_path
            .as_deref()
            .map(load_config)
            .unwrap_or_default();

        let runtime_env = std::env::var("PONTER_SERVER_URL").ok();
        let build_default = option_env!("PONTER_DEFAULT_SERVER_URL");

        let has_server_url = [runtime_env.as_deref(), persisted.server_url.as_deref(), build_default]
            .iter()
            .any(|v| v.map(|s| !s.trim().is_empty()).unwrap_or(false));

        let server_url = resolve_server_url(
            runtime_env.as_deref(),
            persisted.server_url.as_deref(),
            build_default,
        );
        let allow_input = persisted.allow_input;

        Self {
            http: reqwest::Client::new(),
            server_url: Mutex::new(server_url),
            has_server_url,
            access_token: Mutex::new(None),
            allow_input: Mutex::new(allow_input),
            config_path,
            persisted: Mutex::new(persisted),
        }
    }

    /// Convenience constructor with no persistence (tests, and any path where
    /// the config dir cannot be resolved).
    pub fn new() -> Self {
        Self::with_config(None)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Replace `save_wizard_settings` in `commands/wizard.rs`**

Delete `save_wizard_settings` and `save_wizard_settings_impl` and their two tests (`save_wizard_settings_updates_state`, `save_wizard_settings_trims_trailing_slash`). **Declare this removal**: those tests are replaced by `save_config_impl_persists_and_updates_state` / `save_config_impl_ignores_blank_server_url` above (the behavior — persist URL + allowInput, trim trailing slash — is preserved and extended to disk). Add:

```rust
use crate::config::{save_config as write_config, PersistedConfig};

/// The config payload returned to the frontend (camelCase on the wire).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPayload {
    pub server_url: Option<String>,
    pub allow_input: bool,
    pub theme: Option<String>,
    pub has_server_url: bool,
}

/// Read the effective config for the frontend (ADR-64/65).
#[tauri::command]
pub async fn get_config(state: tauri::State<'_, AppState>) -> Result<ConfigPayload, String> {
    let persisted = state
        .persisted
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?
        .clone();
    Ok(ConfigPayload {
        server_url: persisted.server_url,
        allow_input: persisted.allow_input,
        theme: persisted.theme,
        has_server_url: state.has_server_url,
    })
}

/// Persist the user's choices to `config.json` and update the runtime mirrors.
#[tauri::command]
pub async fn save_config(
    server_url: Option<String>,
    allow_input: bool,
    theme: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    save_config_impl(
        &state,
        server_url.as_deref(),
        allow_input,
        theme.as_deref(),
    )
}

/// Testable impl: normalize + persist + mirror into `AppState`. A blank
/// `server_url` is ignored (never clobbers the resolved URL); `None` means
/// "leave the server URL unchanged" (e.g. a theme-only save).
pub fn save_config_impl(
    state: &AppState,
    server_url: Option<&str>,
    allow_input: bool,
    theme: Option<&str>,
) -> Result<(), String> {
    let normalized_url = server_url
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty());

    {
        let mut cfg = state
            .persisted
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if let Some(url) = &normalized_url {
            cfg.server_url = Some(url.clone());
        }
        cfg.allow_input = allow_input;
        if let Some(t) = theme {
            cfg.theme = Some(t.to_string());
        }
        if let Some(path) = &state.config_path {
            write_config(path, &cfg)?;
        }
    }

    if let Some(url) = normalized_url {
        *state
            .server_url
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))? = url;
    }
    *state
        .allow_input
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))? = allow_input;
    Ok(())
}
```

- [ ] **Step 5: Update `lib.rs`**

`app_config_dir()` requires an `AppHandle`, which only exists inside `.setup()`. So **remove** the build-time `.manage(state::AppState::new())` and register `AppState` from within `.setup()` using `app.manage(...)` — setup runs before any command is invoked, so commands still resolve the state. The final `run()` becomes:

```rust
pub fn run() {
    ponter_agent::logging::init();
    use tauri::Manager;

    tauri::Builder::default()
        .manage(tray::TrayState::new())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::login::login,
            commands::wizard::probe_server,
            #[cfg(not(target_env = "musl"))]
            commands::wizard::probe_capture,
            commands::wizard::get_config,
            commands::wizard::save_config,
            commands::devices::register_device,
            commands::devices::list_devices,
            commands::devices::delete_device,
            commands::updater::check_update,
            commands::updater::apply_update,
            autostart::set_autostart,
            autostart::is_autostart_enabled,
        ])
        .setup(|app| {
            // Resolve the config dir now that an AppHandle exists, then build
            // and register AppState (ADR-64/65).
            let config_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|dir| dir.join("config.json"));
            app.manage(state::AppState::with_config(config_path));

            if let Err(e) = tray::init(app.handle()) {
                eprintln!("failed to initialize the tray icon — continuing without tray: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let tray_active = window.state::<tray::TrayState>().tray_active();
                if tray::should_hide_on_close(tray_active) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Note: `.manage()` must be called before `.invoke_handler` commands can resolve state; registering `AppState` in `.setup()` is supported because setup runs before any command. Keep `tray::TrayState` managed at build time (unchanged).

- [ ] **Step 6: Run tests + lint**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -20 && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
Expected: PASS; `#[test]` count grows by the new tests (report before→after in the report).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/state.rs apps/desktop/src-tauri/src/commands/wizard.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): load/persist config at startup; add get_config/save_config commands"
```

---

## Task 3: Frontend config store

**Files:**
- Modify: `apps/desktop/src/types.ts`
- Create: `apps/desktop/src/stores/config.ts`
- Test: `apps/desktop/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: commands `get_config` / `save_config` (Task 2).
- Produces: `useConfigStore()` with `serverUrl: Ref<string>`, `allowInput: Ref<boolean>`, `theme: Ref<'light'|'dark'|null>`, `hasServerUrl: Ref<boolean>`, `editing: Ref<boolean>`, `load(): Promise<void>`, `save(): Promise<void>`, `setServerUrl(url: string): Promise<void>`, `setAllowInput(v: boolean): Promise<void>`, `setTheme(t: 'light'|'dark'): Promise<void>`.

- [ ] **Step 1: Add the type**

In `apps/desktop/src/types.ts`, add:

```ts
/** Persisted desktop config as returned by the `get_config` command. */
export interface AppConfig {
  serverUrl: string | null;
  allowInput: boolean;
  theme: string | null;
  hasServerUrl: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/__tests__/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';

describe('config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
  });

  it('hasServerUrl is false before load and true when the backend reports a server', async () => {
    const store = useConfigStore();
    expect(store.hasServerUrl).toBe(false);

    vi.mocked(invoke).mockResolvedValue({
      serverUrl: 'http://s:1',
      allowInput: true,
      theme: 'dark',
      hasServerUrl: true,
    });
    await store.load();
    expect(store.hasServerUrl).toBe(true);
    expect(store.serverUrl).toBe('http://s:1');
    expect(store.allowInput).toBe(true);
    expect(store.theme).toBe('dark');
    expect(invoke).toHaveBeenCalledWith('get_config');
  });

  it('setServerUrl persists via save_config and clears editing', async () => {
    const store = useConfigStore();
    store.editing = true;
    vi.mocked(invoke).mockResolvedValue(undefined);

    await store.setServerUrl('http://new:1');
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: 'http://new:1',
      allowInput: false,
      theme: null,
    });
    expect(store.serverUrl).toBe('http://new:1');
    expect(store.hasServerUrl).toBe(true);
    expect(store.editing).toBe(false);
  });

  it('setTheme persists the theme and leaves serverUrl untouched (null)', async () => {
    const store = useConfigStore();
    vi.mocked(invoke).mockResolvedValue(undefined);

    await store.setTheme('dark');
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
    });
    expect(store.theme).toBe('dark');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- config.test.ts`
Expected: FAIL — `@/stores/config` does not exist.

- [ ] **Step 4: Write the store**

Create `apps/desktop/src/stores/config.ts`:

```ts
/**
 * Persisted desktop configuration store (ADR-64/65).
 *
 * Mirrors the Rust `config.json` through the `get_config` / `save_config`
 * commands. Holds NO secret — the access token is memory-only and the refresh
 * token is in the OS keychain (ADR-52). Must not touch webview storage (R8).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '@/types';

export type ThemeName = 'light' | 'dark';

export const useConfigStore = defineStore('config', () => {
  /** Effective server URL (may be the localhost fallback). */
  const serverUrl = ref<string>('');
  /** Input-gate preference (ADR-42 Gate A). */
  const allowInput = ref(false);
  /** Persisted theme choice, or null when the user has not chosen. */
  const theme = ref<ThemeName | null>(null);
  /** Whether a real source supplied the server URL (ADR-66). */
  const hasServerUrl = ref(false);
  /** When true, `ServerSetupView` is shown even if a server is configured. */
  const editing = ref(false);

  /** Load the config from the backend. */
  async function load(): Promise<void> {
    const cfg = await invoke<AppConfig>('get_config');
    serverUrl.value = cfg.serverUrl ?? '';
    allowInput.value = cfg.allowInput;
    theme.value = cfg.theme === 'light' || cfg.theme === 'dark' ? cfg.theme : null;
    hasServerUrl.value = cfg.hasServerUrl;
  }

  /** Persist the current values. */
  async function save(): Promise<void> {
    await invoke('save_config', {
      serverUrl: serverUrl.value || null,
      allowInput: allowInput.value,
      theme: theme.value,
    });
  }

  /** Set the server URL, persist, and leave edit mode. */
  async function setServerUrl(url: string): Promise<void> {
    serverUrl.value = url;
    hasServerUrl.value = true;
    await invoke('save_config', {
      serverUrl: url,
      allowInput: allowInput.value,
      theme: theme.value,
    });
    editing.value = false;
  }

  /** Set the input-gate preference and persist. */
  async function setAllowInput(value: boolean): Promise<void> {
    allowInput.value = value;
    await invoke('save_config', {
      serverUrl: null,
      allowInput: value,
      theme: theme.value,
    });
  }

  /** Set the theme and persist. */
  async function setTheme(value: ThemeName): Promise<void> {
    theme.value = value;
    await invoke('save_config', {
      serverUrl: null,
      allowInput: allowInput.value,
      theme: value,
    });
  }

  return {
    serverUrl,
    allowInput,
    theme,
    hasServerUrl,
    editing,
    load,
    save,
    setServerUrl,
    setAllowInput,
    setTheme,
  };
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ponter/desktop test -- config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/types.ts apps/desktop/src/stores/config.ts apps/desktop/src/__tests__/config.test.ts
git commit -m "feat(desktop): config store backed by get_config/save_config"
```

---

## Task 4: Flow reorder — Server → Login → Wizard → Devices

**Files:**
- Create: `apps/desktop/src/views/ServerSetupView.vue`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/stores/wizard.ts`
- Modify: `apps/desktop/src/views/WizardView.vue`
- Modify: `apps/desktop/src/views/LoginView.vue`
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/src/__tests__/app.test.ts` (create); update `wizard.test.ts` (declare changes).

**Interfaces:**
- Consumes: `useConfigStore` (Task 3).
- Produces: `WizardStep` becomes `'capture' | 'inputGate' | 'autoStart'` (drops `'server'`).

- [ ] **Step 1: Update `types.ts`**

Change `WizardStep`:

```ts
/** Wizard step identifiers — the state machine advances capture→inputGate→autoStart.
 * The server step moved to `ServerSetupView` before login (ADR-66). */
export type WizardStep = 'capture' | 'inputGate' | 'autoStart';
```

- [ ] **Step 2: Write the failing flow test**

Create `apps/desktop/src/__tests__/app.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import App from '@/App.vue';
import { useAuthStore } from '@/stores/auth';
import { useConfigStore } from '@/stores/config';
import { useWizardStore } from '@/stores/wizard';

async function mountApp() {
  const wrapper = mount(App, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('App flow (ADR-66)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      serverUrl: null, allowInput: false, theme: null, hasServerUrl: false,
    });
  });

  it('shows ServerSetupView when no server is configured', async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(false);
  });

  it('shows LoginView when a server is configured but unauthenticated', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="login-username"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="server-setup-root"]').exists()).toBe(false);
  });

  it('shows WizardView when authenticated but the wizard is incomplete', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    const auth = useAuthStore();
    auth.user = { id: 'u1', username: 'a', role: 'user' };
    auth.status = 'authenticated';
    await flushPromises();
    expect(wrapper.find('[data-testid="wizard-root"]').exists()).toBe(true);
  });

  it('shows DevicesView when the wizard is complete', async () => {
    const wrapper = await mountApp();
    const config = useConfigStore();
    config.hasServerUrl = true;
    const auth = useAuthStore();
    auth.user = { id: 'u1', username: 'a', role: 'user' };
    auth.status = 'authenticated';
    const wizard = useWizardStore();
    wizard.completed = true;
    await flushPromises();
    expect(wrapper.find('[data-testid="wizard-root"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="devices-root"]').exists()).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- app.test.ts`
Expected: FAIL — `server-setup-root` absent; flow still login-first.

- [ ] **Step 4: Create `ServerSetupView.vue`**

Move the server-step markup/behavior out of `WizardView` (same testids so existing selector expectations keep working), backed by the config store:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '@/stores/config';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from '@lucide/vue';
import type { ProbeResult } from '@/types';

const config = useConfigStore();
const url = ref(config.serverUrl || 'http://localhost:8787');
const probe = ref<ProbeResult | null>(null);
const loading = ref(false);

onMounted(() => {
  if (config.serverUrl) url.value = config.serverUrl;
});

async function connect() {
  loading.value = true;
  probe.value = null;
  try {
    probe.value = await invoke<ProbeResult>('probe_server', { url: url.value });
    if (probe.value.ok) {
      await config.setServerUrl(url.value.trim());
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div data-testid="server-setup-root" class="container flex min-h-screen flex-col items-center justify-center">
    <h1>Server Connection</h1>
    <p data-testid="server-setup-help">Enter your Ponter server URL to verify connectivity.</p>

    <Label for="server-setup-url" class="sr-only">Server URL</Label>
    <Input
      id="server-setup-url"
      type="url"
      data-testid="server-setup-url"
      placeholder="http://localhost:8787"
      v-model="url"
    />

    <Button
      data-testid="server-setup-connect"
      :disabled="loading || !url"
      @click="connect"
    >
      <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
      {{ loading ? 'Probing...' : 'Connect' }}
    </Button>

    <Alert
      v-if="probe && !probe.ok"
      data-testid="server-setup-message"
      variant="destructive"
      role="alert"
      aria-live="polite"
    >
      <AlertDescription>{{ probe.message }}</AlertDescription>
    </Alert>
  </div>
</template>
```

- [ ] **Step 5: Rewrite `App.vue`**

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useWizardStore } from '@/stores/wizard';
import { useConfigStore } from '@/stores/config';
import ServerSetupView from '@/views/ServerSetupView.vue';
import LoginView from '@/views/LoginView.vue';
import WizardView from '@/views/WizardView.vue';
import DevicesView from '@/views/DevicesView.vue';

const authStore = useAuthStore();
const wizardStore = useWizardStore();
const configStore = useConfigStore();

onMounted(() => {
  // Load persisted config once; ignore failure (the app still renders).
  configStore.load().catch(() => {});
});
</script>

<template>
  <ServerSetupView v-if="!configStore.hasServerUrl || configStore.editing" />
  <LoginView v-else-if="!authStore.isAuthenticated" />
  <WizardView v-else-if="!wizardStore.completed" />
  <DevicesView v-else />
</template>
```

Note: `ThemeToggle` is added to this template in Task 5 (it does not exist yet here). `DevicesView` already has the `devices-root` testid, `WizardView` has `wizard-root`, and `LoginView` has `login-username` — verified in the tree.

- [ ] **Step 6: Update `wizard.ts`**

- Change `step = ref<WizardStep>('capture')` and `reset()` to `'capture'`.
- Remove `serverUrl` and `serverProbe` refs and `probeServer()` (the server step moved). Keep `captureProbe`, `probeCapture`, `advance` (now: `capture`→`inputGate` gated on `captureProbe.ok`; `inputGate`→`autoStart` unconditional).
- Remove `serverUrl` from the `order` array and from `finish()`'s invoke payload.
- `finish()` calls the config store's `setAllowInput(allowInput.value)` (or `invoke('save_config', { serverUrl: null, allowInput: allowInput.value, theme: null })`) then `advance()`.

Concretely, replace the `finish()` body:

```ts
  /** Step 3 action: persist the input-gate preference and advance to
   * `autoStart`. Does NOT set `completed` — step 4 is the final step (R11). */
  async function finish(): Promise<void> {
    loading.value = true;
    try {
      await invoke('save_config', {
        serverUrl: null,
        allowInput: allowInput.value,
        theme: null,
      });
      advance();
    } finally {
      loading.value = false;
    }
  }
```

and `advance()`:

```ts
  function advance(): void {
    if (step.value === 'capture') {
      if (captureProbe.value?.ok !== true) {
        return;
      }
      step.value = 'inputGate';
    } else if (step.value === 'inputGate') {
      step.value = 'autoStart';
    }
  }
```

- [ ] **Step 7: Update `WizardView.vue`**

Remove the entire `<!-- Step 1: Server -->` block and the `probeServer()` function. The view now starts at `capture` (`v-if="store.step === 'capture'"` becomes the first branch).

- [ ] **Step 8: Add the "Change server" affordance to `LoginView.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useConfigStore } from '@/stores/config';
// ...existing imports...

const store = useAuthStore();
const config = useConfigStore();
const username = ref('');
const password = ref('');
// ...existing handleSubmit...
</script>
```

Add near the top of `<CardContent>`:

```vue
        <p class="mb-3 text-xs text-muted-foreground" data-testid="login-server-line">
          Server: {{ config.serverUrl || 'not set' }}
          <button
            type="button"
            data-testid="login-change-server"
            class="ml-1 underline"
            @click="config.editing = true"
          >
            Change
          </button>
        </p>
```

- [ ] **Step 9: Update `main.ts`**

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import { applyInitialTheme } from './composables/useTheme';

// Apply the OS/stored theme before mount to minimise first-paint flash.
applyInitialTheme();

createApp(App).use(createPinia()).mount('#app');
```

(`applyInitialTheme` is created in Task 5; if Task 5 lands after Task 4, add a no-op `export function applyInitialTheme() {}` here and replace it in Task 5.)

- [ ] **Step 10: Update `wizard.test.ts` (DECLARE changes)**

The wizard no longer has a `server` step. Update affected tests:
- `'defaults allow_input to false (Gate A)'`: assert `store.step === 'capture'` (was `'server'`).
- `'starts on the server step with no probes'`: rename to `'starts on the capture step with no probe'`; assert `store.step === 'capture'`, `store.captureProbe === null`.
- `'advances only when probes succeed'`: remove the server-probe leg; start at `capture`, gate on `captureProbe`.
- `'advance with failed probe leaves step unchanged'`: start at `capture`, gate on `captureProbe`.
- `'sets allowInput when toggled on the input-gate step'` / `'finish() calls save_wizard_settings…'`: assert `invoke` was called with `('save_config', { serverUrl: null, allowInput: <v>, theme: null })`; set `store.step = 'inputGate'` directly (no server leg).
- `'reset clears all state…'`: drop `serverUrl`/`serverProbe` assertions; assert `store.step === 'capture'`.
- `WizardView` server-step tests (`'renders the server step…'`, `'advances to capture step after successful server probe'`, `'shows capture probe result…'`, `'never writes to webview storage'`): **move the server-probe interaction to `app.test.ts`/a new `serverSetup.test.ts`** OR delete the server-specific ones with a declared reason. Keep the storage-gate assertion by re-homing it onto `ServerSetupView`. **Report `it()`/`expect()` before→after.**

Add a `serverSetup.test.ts` covering: renders the URL input; a successful probe calls `save_config` and clears `editing`; a failed probe shows the message and does not persist; **never writes to webview storage**.

- [ ] **Step 11: Run tests**

Run: `pnpm --filter @ponter/desktop test`
Expected: PASS. Report before→after `it()`/`expect()` counts per touched file.

- [ ] **Step 12: Lint + typecheck + storage gate**

Run: `pnpm --filter @ponter/desktop lint && pnpm --filter @ponter/desktop typecheck && pnpm format:check`
Run: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` → **empty**
Expected: all clean.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/types.ts apps/desktop/src/App.vue apps/desktop/src/main.ts \
  apps/desktop/src/views/ServerSetupView.vue apps/desktop/src/views/WizardView.vue \
  apps/desktop/src/views/LoginView.vue apps/desktop/src/stores/wizard.ts \
  apps/desktop/src/__tests__/app.test.ts apps/desktop/src/__tests__/serverSetup.test.ts \
  apps/desktop/src/__tests__/wizard.test.ts
git commit -m "feat(desktop): server step before login (ADR-66) + change-server escape hatch"
```

---

## Task 5: Desktop dark mode

**Files:**
- Create: `apps/desktop/src/composables/useTheme.ts`
- Create: `apps/desktop/src/components/ThemeToggle.vue`
- Modify: `apps/desktop/src/main.ts`
- Test: `apps/desktop/src/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: `useConfigStore` (Task 3).
- Produces: `useTheme(): { theme, isDark, toggle, set }`; `applyInitialTheme(): void`; `resetTheme(): void`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@tauri-apps/api/core', () => {
  const fn = vi.fn();
  return { __esModule: true, invoke: fn, default: { invoke: fn } };
});

import { invoke } from '@tauri-apps/api/core';
import { useTheme, resetTheme } from '@/composables/useTheme';
import { useConfigStore } from '@/stores/config';

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: dark && q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('useTheme', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    document.documentElement.classList.remove('dark');
    resetTheme();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light when the OS prefers light', () => {
    mockMatchMedia(false);
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows the OS dark preference when no stored theme', () => {
    mockMatchMedia(true);
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle() flips the theme, applies .dark, and persists via save_config', async () => {
    mockMatchMedia(false);
    resetTheme();
    const { isDark, toggle } = useTheme();
    const config = useConfigStore();

    toggle();
    expect(isDark.value).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('save_config', {
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
    });
    expect(config.theme).toBe('dark');
  });

  it('a stored theme wins over the OS preference', () => {
    mockMatchMedia(true); // OS dark
    const config = useConfigStore();
    config.theme = 'light'; // stored light
    resetTheme();
    const { isDark } = useTheme();
    expect(isDark.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/desktop test -- theme.test.ts`
Expected: FAIL — `@/composables/useTheme` does not exist.

- [ ] **Step 3: Write `useTheme.ts`**

```ts
/**
 * Desktop theme composable (ADR-68).
 *
 * Mirrors the web behaviour (matchMedia + `.dark` class on <html>) but persists
 * through the Rust config file via the config store — NEVER webview storage
 * (R8: no localStorage/sessionStorage/indexedDB in production frontend code).
 */
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';
import { useConfigStore, type ThemeName } from '@/stores/config';

export interface UseTheme {
  theme: Ref<ThemeName>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: ThemeName): void;
}

function osPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Resolve the initial theme: stored config wins, else the OS preference. */
function getInitialTheme(): ThemeName {
  try {
    const stored = useConfigStore().theme;
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Pinia not active yet (module import before app mount) — fall through.
  }
  return osPrefersDark() ? 'dark' : 'light';
}

const theme = ref<ThemeName>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

if (typeof document !== 'undefined') {
  watchEffect(
    () => {
      const el = document.documentElement;
      if (theme.value === 'dark') el.classList.add('dark');
      else el.classList.remove('dark');
    },
    { flush: 'sync' },
  );
}

/** Apply the theme class as early as possible (called from main.ts before mount). */
export function applyInitialTheme(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (theme.value === 'dark') el.classList.add('dark');
  else el.classList.remove('dark');
}

function setTheme(next: ThemeName): void {
  theme.value = next;
  try {
    // Fire-and-forget persist; a failed write must not break the toggle.
    void useConfigStore().setTheme(next);
  } catch {
    // Pinia not active — the class still applied.
  }
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return { theme, isDark, toggle: toggleTheme, set: setTheme };
}

/** Reset theme state for tests (re-reads the stored config / OS preference). */
export function resetTheme(): void {
  theme.value = getInitialTheme();
}
```

- [ ] **Step 4: Write `ThemeToggle.vue`**

Port `apps/web/src/components/layout/ThemeToggle.vue`, importing `Button` from `@/components/ui/button` and `useTheme` from `@/composables/useTheme`. Add `data-testid="theme-toggle"`.

- [ ] **Step 5: Mount `ThemeToggle` in `App.vue`**

Add the import and the element (Task 4 deliberately left it out):

```vue
<script setup lang="ts">
// ...existing imports...
import ThemeToggle from '@/components/ThemeToggle.vue';
</script>

<template>
  <ThemeToggle class="fixed right-3 top-3 z-50" />
  <ServerSetupView v-if="!configStore.hasServerUrl || configStore.editing" />
  ...
</template>
```

- [ ] **Step 6: Wire `main.ts`**

`main.ts` already calls `applyInitialTheme()` (Task 4 Step 9). After mount, reconcile the stored theme:

```ts
const app = createApp(App).use(createPinia());
app.mount('#app');

// Reconcile the persisted theme once the store can read config (ADR-68).
import('@/stores/config').then(({ useConfigStore }) => {
  useConfigStore()
    .load()
    .then(() => {
      const stored = useConfigStore().theme;
      if (stored === 'light' || stored === 'dark') {
        import('@/composables/useTheme').then(({ useTheme }) => useTheme().set(stored));
      }
    })
    .catch(() => {});
});
```

- [ ] **Step 7: Run tests + storage gate**

Run: `pnpm --filter @ponter/desktop test -- theme.test.ts` → PASS (4 tests)
Run: `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` → **empty**

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/composables/useTheme.ts apps/desktop/src/components/ThemeToggle.vue \
  apps/desktop/src/App.vue apps/desktop/src/main.ts apps/desktop/src/__tests__/theme.test.ts
git commit -m "feat(desktop): dark mode via config-file persistence (ADR-68, R8-safe)"
```

---

## Task 6: Build-time default server URL + docs

**Files:**
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `docs/guides/self-hosting.md`
- Test: none (CI + docs); verified by the 3-OS matrix and a `grep`.

**Interfaces:**
- Consumes: `option_env!("PONTER_DEFAULT_SERVER_URL")` (Task 2).

- [ ] **Step 1: Add the env to the build step**

In `.github/workflows/build-desktop.yml`, in the `Build (Tauri bundle)` step's `env:` block, add:

```yaml
          PONTER_DEFAULT_SERVER_URL: ${{ vars.PONTER_DEFAULT_SERVER_URL || '' }}
```

- [ ] **Step 2: Document it in `self-hosting.md` §3**

Append to §3 "Server / API URL":

```markdown
### 3.1 Desktop app default server (build-time)

The desktop client resolves its server URL in this order: the runtime
`PONTER_SERVER_URL` environment variable, then the user's saved value in the
app config file, then a **build-time default** compiled from
`PONTER_DEFAULT_SERVER_URL`, then `http://localhost:8787`.

To bake your server into an installer, set the repository variable
`PONTER_DEFAULT_SERVER_URL` before building (Settings → Secrets and variables →
Actions → Variables):

```text
PONTER_DEFAULT_SERVER_URL = https://ponter.example.com
```

The CI workflow passes it into `tauri build`; when unset it is a no-op and the
app falls back to the user's saved value or localhost. A source build can set
it directly:

```bash
PONTER_DEFAULT_SERVER_URL=https://ponter.example.com \
  pnpm --filter @ponter/desktop tauri build
```

End users can still change the server from the app's first screen (or via
"Change" on the login screen); their choice persists in the app config
directory.
```

- [ ] **Step 3: Verify**

Run: `grep -n "PONTER_DEFAULT_SERVER_URL" .github/workflows/build-desktop.yml docs/guides/self-hosting.md`
Expected: both files show the variable.
Run: `pnpm format:check`
Expected: PASS (docs are prettier-checked; adjust wrapping if it fails).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build-desktop.yml docs/guides/self-hosting.md
git commit -m "feat(desktop): build-time default server URL + self-hosting docs"
```

---

## Final verification (whole-branch, before PR)

- [ ] `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- [ ] `pnpm --filter @ponter/desktop test && pnpm --filter @ponter/desktop lint && pnpm --filter @ponter/desktop typecheck`
- [ ] `pnpm format:check`
- [ ] **R8 gate:** `grep -rn "localStorage\|sessionStorage\|indexedDB" apps/desktop/src --include="*.ts" --include="*.vue" | grep -v "/__tests__/"` → empty
- [ ] **No secret in config:** `grep -rn "token\|secret\|password" apps/desktop/src-tauri/src/config.rs` → only doc comments, no fields
- [ ] `pnpm --filter @ponter/desktop tauri build` succeeds locally (or the CI 3-OS matrix passes) with `PONTER_DEFAULT_SERVER_URL` unset
- [ ] No change to `apps/web`, `apps/server`, `apps/agent`, `packages/**`, or any `ui/**` path: `git diff --stat origin/main...HEAD` shows only `apps/desktop/**`, `.github/workflows/build-desktop.yml`, `docs/guides/self-hosting.md`
- [ ] Test-integrity report: `#[test]` and `it()`/`expect()` before→after for every touched test file, with each removal justified.

## Self-Review (run before dispatch)

- **Spec coverage:** ADR-64 → Tasks 1/2; ADR-65 → Tasks 1/2/3; ADR-66 → Task 4; ADR-67 → Tasks 2/6; ADR-68 → Task 5. Done-gates 1–4 → Tasks 6/3/3/5.
- **Placeholder scan:** none — every code step shows the code.
- **Type consistency:** `PersistedConfig` fields (`server_url`/`allow_input`/`theme`) ↔ `ConfigPayload` (`serverUrl`/`allowInput`/`theme`/`hasServerUrl`) ↔ `AppConfig` (TS) ↔ store refs — consistent across Tasks 1–3.
- **Review Focus:** each of the 5 modes is pinned in the named task's tests.
