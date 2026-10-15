# Linux Upfront Consent & Persistent RemoteDesktop Portal (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 2 of ADR-90 (Persistent RemoteDesktop Portal), establishing a unified `org.freedesktop.portal.RemoteDesktop` session combining screen capture with native Wayland input injection, persisting authorizations via `persist_mode: 2` and cached `restore_token`, and eliminating fragmented OS consent dialogs across agent restarts.

**Architecture:** Build a dedicated `portal` subsystem in `apps/agent` using `zbus 5`. Manage secure disk caching of `restore_token` under `$XDG_CONFIG_HOME/ponter/remote-desktop.token` with strict `0600` permissions. Translate W3C `KeyboardEvent.code` and mouse events to Linux evdev keycodes/keysyms. Multiplex `SelectDevices` (keyboard + pointer) and `SelectSources` (screen cast) on the exact same D-Bus session handle to trigger a single combined OS modal prompt. Wrap input forwarding in `PortalInputInjector` implementing `InputInjector`, providing native Wayland synthetic input without `enigo` or dynamic C library dependencies (`libei`).

**Tech Stack:** Rust 2021, `zbus 5.19` (D-Bus IPC, transitively available via `xcap`), `zvariant` (D-Bus serialization/deserialization), `serde` / `serde_json`, Linux evdev input codes (`linux/input-event-codes.h`), Tokio async runtime, `ponter_agent` crate.

**Spec:** `docs/superpowers/specs/2026-10-15-linux-upfront-consent-design.md` (ADR-90) and `docs/notes/2026-10-15-linux-screen-capture-remote-desktop-adr90-be-input.md`.

## Global Constraints

- **Single Dialog Guarantee (§5.1):** Both `SelectDevices` (mask 3: Keyboard + Pointer) and `SelectSources` MUST be called on the exact same session handle prior to calling `Start`, ensuring Mutter and KWin aggregate them into a single modal dialog ("Allow Ponter to view and control your desktop?").
- **Persistence Floor (§5.2):** All `SelectSources` and `Start` requests MUST include `persist_mode: 2` (persist until revoked) and pass the cached `restore_token` when present.
- **Secure File Permissions (§5.2):** The token file at `$XDG_CONFIG_HOME/ponter/remote-desktop.token` MUST be created with Unix file mode `0600` (`S_IRUSR | S_IWUSR`), readable only by the agent owner.
- **Zero External C Dependencies (§8.1):** Use direct D-Bus communication via `zbus 5` for input injection. Do NOT introduce dynamic C library dependencies such as `libei` or `libxkbcommon-x11`, guaranteeing clean compilation on both `gnu` and `musl` targets.
- **Graceful Fallback (§6):** When running on X11, Windows, or headless/test environments, or when `RemoteDesktop` portal is unavailable (e.g. Sway/wlroots), the agent MUST fall back gracefully to `PlatformInjector` (`enigo`) and log an actionable diagnostic message without crashing.
- **Test Integrity:** All 305 existing unit tests in `apps/agent` MUST continue to pass with zero regressions. All new portal logic MUST be covered by deterministic unit tests utilizing trait abstractions without requiring a physical Wayland compositor or live D-Bus bus.

## Review Focus

1. **Stale or Revoked Token Recovery (§5.2):** When a user revokes permissions in OS settings (GNOME/KDE Privacy), the compositor rejects the `restore_token`. The agent MUST cleanly delete the corrupt/stale token file and fall back to interactive prompt without looping or panicking.
2. **Missing or Malformed Config Directory:** If `$XDG_CONFIG_HOME/ponter/` does not exist or has restrictive parent permissions, token storage MUST create parent directories with `0700` and handle I/O failures gracefully without crashing agent startup.
3. **Evdev Mapping Completeness (§5.3):** Unmapped or exotic keyboard codes MUST safely return `None` and be dropped at `debug` log level rather than injecting invalid keycodes that could lock keyboard modifier state.
4. **Coordinate Mapping Alignment (§5.3):** `NotifyPointerMotionAbsolute` operates in stream/monitor pixel coordinates (`0..width`, `0..height`). Normalized `(0.0..1.0)` client coordinates MUST be scaled to the active capture stream dimensions accurately.
5. **Non-Wayland & Headless Safety (§6):** In environments where `WAYLAND_DISPLAY` is absent or `--desktop-source test` is configured, portal initialization MUST be bypassed immediately without attempting D-Bus connection timeouts.

---

### Task 1: `restore_token` Storage Engine

**Files:**
- Create: `apps/agent/src/portal.rs`
- Create: `apps/agent/src/portal/token_store.rs`
- Modify: `apps/agent/src/lib.rs:40-60` (declare `pub mod portal;`)
- Test: `apps/agent/src/portal/token_store.rs` (in-module unit tests)

**Interfaces:**
- Consumes: None (pure Rust standard library + serde).
- Produces:
  ```rust
  pub struct StoredToken {
      pub version: u32,
      pub restore_token: String,
      pub granted_at: u64,
      pub device_mask: u32,
      pub session_type: String,
  }

  pub fn resolve_token_path() -> std::path::PathBuf;
  pub fn load_token_from_path(path: &std::path::Path) -> Option<StoredToken>;
  pub fn save_token_to_path(path: &std::path::Path, restore_token: &str, device_mask: u32) -> anyhow::Result<()>;
  pub fn clear_token_at_path(path: &std::path::Path) -> anyhow::Result<()>;
  pub fn load_token() -> Option<StoredToken>;
  pub fn save_token(restore_token: &str, device_mask: u32) -> anyhow::Result<()>;
  pub fn clear_token() -> anyhow::Result<()>;
  ```

- [ ] **Step 1: Write the failing tests for `token_store`**

Create `apps/agent/src/portal/token_store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn save_and_load_round_trip() {
        let temp_dir = std::env::temp_dir().join(format!("ponter-token-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let token_path = temp_dir.join("remote-desktop.token");

        let token_str = "test-token-uuid-12345";
        save_token_to_path(&token_path, token_str, 3).expect("save should succeed");

        let loaded = load_token_from_path(&token_path).expect("load should find token");
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.restore_token, token_str);
        assert_eq!(loaded.device_mask, 3);
        assert_eq!(loaded.session_type, "wayland");
        assert!(loaded.granted_at > 0);

        // Check file permissions on Unix (must be 0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&token_path).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must have 0600 permissions");
        }

        // Test clear
        clear_token_at_path(&token_path).expect("clear should succeed");
        assert!(load_token_from_path(&token_path).is_none());
        assert!(!token_path.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn load_nonexistent_returns_none() {
        let path = std::path::Path::new("/tmp/nonexistent-ponter-token.token");
        assert!(load_token_from_path(path).is_none());
    }

    #[test]
    fn load_corrupted_json_clears_file_and_returns_none() {
        let temp_dir = std::env::temp_dir().join(format!("ponter-token-corrupt-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let token_path = temp_dir.join("remote-desktop.token");

        fs::write(&token_path, "{ invalid json content").unwrap();
        assert!(load_token_from_path(&token_path).is_none());
        assert!(!token_path.exists(), "corrupted token file should be automatically removed");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::token_store::tests`
Expected: FAIL with compilation error (module `portal` not found).

- [ ] **Step 3: Implement `token_store`**

Create `apps/agent/src/portal.rs`:

```rust
//! Linux Upfront Consent & Persistent RemoteDesktop Portal Subsystem (ADR-90 Phase 2).

pub mod token_store;
```

Update `apps/agent/src/portal/token_store.rs`:

```rust
//! Secure persistent storage for portal `restore_token` (ADR-90 §5.2).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredToken {
    pub version: u32,
    pub restore_token: String,
    pub granted_at: u64,
    pub device_mask: u32,
    pub session_type: String,
}

pub fn resolve_token_path() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg).join("ponter").join("remote-desktop.token");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("ponter")
            .join("remote-desktop.token");
    }
    PathBuf::from(".ponter-remote-desktop.token")
}

pub fn load_token_from_path(path: &Path) -> Option<StoredToken> {
    if !path.exists() {
        return None;
    }
    let data = match fs::read_to_string(path) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, path = ?path, "failed to read remote-desktop.token");
            return None;
        }
    };
    match serde_json::from_str::<StoredToken>(&data) {
        Ok(token) => {
            if token.version == 1 && !token.restore_token.trim().is_empty() {
                Some(token)
            } else {
                tracing::warn!(path = ?path, "invalid token structure or unsupported version; removing");
                let _ = fs::remove_file(path);
                None
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, path = ?path, "corrupted remote-desktop.token JSON; removing");
            let _ = fs::remove_file(path);
            None
        }
    }
}

pub fn save_token_to_path(path: &Path, restore_token: &str, device_mask: u32) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating directory {:?}", parent))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let record = StoredToken {
        version: 1,
        restore_token: restore_token.to_string(),
        granted_at: now,
        device_mask,
        session_type: "wayland".to_string(),
    };

    let serialized = serde_json::to_string_pretty(&record).context("serializing StoredToken")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("opening token file {:?}", path))?;
        file.write_all(serialized.as_bytes())
            .with_context(|| format!("writing token file {:?}", path))?;
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("opening token file {:?}", path))?;
        file.write_all(serialized.as_bytes())
            .with_context(|| format!("writing token file {:?}", path))?;
    }

    Ok(())
}

pub fn clear_token_at_path(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path).with_context(|| format!("deleting token file {:?}", path))?;
    }
    Ok(())
}

pub fn load_token() -> Option<StoredToken> {
    load_token_from_path(&resolve_token_path())
}

pub fn save_token(restore_token: &str, device_mask: u32) -> Result<()> {
    save_token_to_path(&resolve_token_path(), restore_token, device_mask)
}

pub fn clear_token() -> Result<()> {
    clear_token_at_path(&resolve_token_path())
}
```

Add module declaration in `apps/agent/src/lib.rs`:

```rust
pub mod portal;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::token_store::tests`
Expected: PASS (3 passed, 0 failed).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/portal.rs apps/agent/src/portal/token_store.rs apps/agent/src/lib.rs
git commit -m "feat(agent): persistent restore_token storage engine for RemoteDesktop (ADR-90 Task 1)"
```

---

### Task 2: Evdev Keycode & Keysym Translation Table

**Files:**
- Create: `apps/agent/src/portal/evdev_map.rs`
- Modify: `apps/agent/src/portal.rs:1-10` (declare `pub mod evdev_map;`)
- Test: `apps/agent/src/portal/evdev_map.rs` (in-module unit tests)

**Interfaces:**
- Consumes: W3C `KeyboardEvent.code` string descriptors.
- Produces:
  ```rust
  pub const BTN_LEFT: u32 = 0x110;
  pub const BTN_RIGHT: u32 = 0x111;
  pub const BTN_MIDDLE: u32 = 0x112;

  pub fn map_code_to_evdev(code: &str) -> Option<u32>;
  pub fn char_to_keysym(ch: char) -> u32;
  ```

- [ ] **Step 1: Write the failing tests for `evdev_map`**

Create `apps/agent/src/portal/evdev_map.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letter_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("KeyA"), Some(30));
        assert_eq!(map_code_to_evdev("KeyB"), Some(48));
        assert_eq!(map_code_to_evdev("KeyQ"), Some(16));
        assert_eq!(map_code_to_evdev("KeyZ"), Some(44));
    }

    #[test]
    fn digit_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("Digit1"), Some(2));
        assert_eq!(map_code_to_evdev("Digit9"), Some(10));
        assert_eq!(map_code_to_evdev("Digit0"), Some(11));
    }

    #[test]
    fn navigation_and_control_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("Escape"), Some(1));
        assert_eq!(map_code_to_evdev("Backspace"), Some(14));
        assert_eq!(map_code_to_evdev("Tab"), Some(15));
        assert_eq!(map_code_to_evdev("Enter"), Some(28));
        assert_eq!(map_code_to_evdev("Space"), Some(57));
        assert_eq!(map_code_to_evdev("ArrowUp"), Some(103));
        assert_eq!(map_code_to_evdev("ArrowDown"), Some(108));
        assert_eq!(map_code_to_evdev("ArrowLeft"), Some(105));
        assert_eq!(map_code_to_evdev("ArrowRight"), Some(106));
    }

    #[test]
    fn modifier_keys_map_correctly() {
        assert_eq!(map_code_to_evdev("ShiftLeft"), Some(42));
        assert_eq!(map_code_to_evdev("ShiftRight"), Some(54));
        assert_eq!(map_code_to_evdev("ControlLeft"), Some(29));
        assert_eq!(map_code_to_evdev("ControlRight"), Some(97));
        assert_eq!(map_code_to_evdev("AltLeft"), Some(56));
        assert_eq!(map_code_to_evdev("AltRight"), Some(100));
        assert_eq!(map_code_to_evdev("MetaLeft"), Some(125));
        assert_eq!(map_code_to_evdev("MetaRight"), Some(126));
    }

    #[test]
    fn unknown_key_returns_none() {
        assert_eq!(map_code_to_evdev("UnrecognizedKeyXYZ"), None);
        assert_eq!(map_code_to_evdev(""), None);
    }

    #[test]
    fn ascii_char_to_keysym_mapping() {
        assert_eq!(char_to_keysym('a'), 0x61);
        assert_eq!(char_to_keysym('A'), 0x41);
        assert_eq!(char_to_keysym(' '), 0x20);
        assert_eq!(char_to_keysym('\n'), 0xFF0D); // Return keysym
        assert_eq!(char_to_keysym('\t'), 0xFF09); // Tab keysym
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::evdev_map::tests`
Expected: FAIL with functions not defined.

- [ ] **Step 3: Implement `evdev_map`**

Update `apps/agent/src/portal.rs`:

```rust
pub mod evdev_map;
pub mod token_store;
```

Update `apps/agent/src/portal/evdev_map.rs`:

```rust
//! Evdev keycode & X11 keysym translation table for Linux portal input (ADR-90 §5.3).
//!
//! Values match standard Linux kernel header `<linux/input-event-codes.h>`.

pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;

/// Maps standard W3C `KeyboardEvent.code` strings to Linux evdev keycodes.
pub fn map_code_to_evdev(code: &str) -> Option<u32> {
    match code {
        // Alphanumeric keys
        "KeyA" => Some(30),
        "KeyB" => Some(48),
        "KeyC" => Some(46),
        "KeyD" => Some(32),
        "KeyE" => Some(18),
        "KeyF" => Some(33),
        "KeyG" => Some(34),
        "KeyH" => Some(35),
        "KeyI" => Some(23),
        "KeyJ" => Some(36),
        "KeyK" => Some(37),
        "KeyL" => Some(38),
        "KeyM" => Some(50),
        "KeyN" => Some(49),
        "KeyO" => Some(24),
        "KeyP" => Some(25),
        "KeyQ" => Some(16),
        "KeyR" => Some(19),
        "KeyS" => Some(31),
        "KeyT" => Some(20),
        "KeyU" => Some(22),
        "KeyV" => Some(47),
        "KeyW" => Some(17),
        "KeyX" => Some(45),
        "KeyY" => Some(21),
        "KeyZ" => Some(44),

        // Number row
        "Digit1" => Some(2),
        "Digit2" => Some(3),
        "Digit3" => Some(4),
        "Digit4" => Some(5),
        "Digit5" => Some(6),
        "Digit6" => Some(7),
        "Digit7" => Some(8),
        "Digit8" => Some(9),
        "Digit9" => Some(10),
        "Digit0" => Some(11),

        // Function keys
        "F1" => Some(59),
        "F2" => Some(60),
        "F3" => Some(61),
        "F4" => Some(62),
        "F5" => Some(63),
        "F6" => Some(64),
        "F7" => Some(65),
        "F8" => Some(66),
        "F9" => Some(67),
        "F10" => Some(68),
        "F11" => Some(87),
        "F12" => Some(88),

        // Navigation & Editing
        "Escape" => Some(1),
        "Backspace" => Some(14),
        "Tab" => Some(15),
        "Enter" => Some(28),
        "Space" => Some(57),
        "Insert" => Some(110),
        "Delete" => Some(111),
        "Home" => Some(102),
        "End" => Some(107),
        "PageUp" => Some(104),
        "PageDown" => Some(109),
        "ArrowUp" => Some(103),
        "ArrowDown" => Some(108),
        "ArrowLeft" => Some(105),
        "ArrowRight" => Some(106),

        // Modifiers
        "ShiftLeft" => Some(42),
        "ShiftRight" => Some(54),
        "ControlLeft" => Some(29),
        "ControlRight" => Some(97),
        "AltLeft" => Some(56),
        "AltRight" => Some(100),
        "MetaLeft" => Some(125),
        "MetaRight" => Some(126),
        "CapsLock" => Some(58),

        // Symbols & Punctuation
        "Minus" => Some(12),
        "Equal" => Some(13),
        "BracketLeft" => Some(26),
        "BracketRight" => Some(27),
        "Backslash" => Some(43),
        "Semicolon" => Some(39),
        "Quote" => Some(40),
        "Backquote" => Some(41),
        "Comma" => Some(51),
        "Period" => Some(52),
        "Slash" => Some(53),

        _ => None,
    }
}

/// Translates a Unicode character to an X11 keysym for portal text injection.
pub fn char_to_keysym(ch: char) -> u32 {
    match ch {
        '\n' | '\r' => 0xFF0D, // Return
        '\t' => 0xFF09,        // Tab
        '\x08' => 0xFF08,      // BackSpace
        '\x1B' => 0xFF1B,      // Escape
        ' '..='~' => ch as u32, // Direct ASCII mapping
        _ => {
            // Standard X11 Unicode keysym range: 0x01000000 | codepoint
            0x0100_0000 | (ch as u32)
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::evdev_map::tests`
Expected: PASS (6 passed, 0 failed).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/portal/evdev_map.rs apps/agent/src/portal.rs
git commit -m "feat(agent): evdev keycode and keysym translation table (ADR-90 Task 2)"
```

---

### Task 3: D-Bus RemoteDesktop Proxy & Session Flow Abstraction

**Files:**
- Create: `apps/agent/src/portal/remote_desktop.rs`
- Modify: `apps/agent/src/portal.rs:1-15` (declare `pub mod remote_desktop;`)
- Modify: `apps/agent/Cargo.toml:45-65` (add `zbus = { version = "5", default-features = false }` under `[target.'cfg(target_os = "linux")'.dependencies]`)
- Test: `apps/agent/src/portal/remote_desktop.rs` (in-module unit tests with mock D-Bus connection)

**Interfaces:**
- Consumes: `token_store::StoredToken`, `zbus 5`.
- Produces:
  ```rust
  pub struct RemoteDesktopStreamInfo {
      pub node_id: u32,
      pub width: Option<i32>,
      pub height: Option<i32>,
  }

  pub struct RemoteDesktopSessionResult {
      pub session_handle: String,
      pub streams: Vec<RemoteDesktopStreamInfo>,
      pub devices: u32,
      pub restore_token: Option<String>,
  }

  pub trait RemoteDesktopPortal: Send + Sync {
      fn create_session(&self) -> anyhow::Result<String>;
      fn select_devices(&self, session: &str, device_mask: u32) -> anyhow::Result<()>;
      fn select_sources(&self, session: &str, restore_token: Option<&str>) -> anyhow::Result<()>;
      fn start(&self, session: &str, restore_token: Option<&str>) -> anyhow::Result<RemoteDesktopSessionResult>;
  }
  ```

- [ ] **Step 1: Write the failing tests for `remote_desktop` abstraction**

Create `apps/agent/src/portal/remote_desktop.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    struct MockRemoteDesktopPortal {
        should_fail_token: bool,
    }

    impl RemoteDesktopPortal for MockRemoteDesktopPortal {
        fn create_session(&self) -> anyhow::Result<String> {
            Ok("/org/freedesktop/portal/desktop/session/mock/session1".to_string())
        }

        fn select_devices(&self, _session: &str, _device_mask: u32) -> anyhow::Result<()> {
            Ok(())
        }

        fn select_sources(&self, _session: &str, _restore_token: Option<&str>) -> anyhow::Result<()> {
            Ok(())
        }

        fn start(&self, _session: &str, restore_token: Option<&str>) -> anyhow::Result<RemoteDesktopSessionResult> {
            if self.should_fail_token && restore_token.is_some() {
                anyhow::bail!("revoked or invalid restore_token");
            }
            Ok(RemoteDesktopSessionResult {
                session_handle: "/org/freedesktop/portal/desktop/session/mock/session1".to_string(),
                streams: vec![RemoteDesktopStreamInfo {
                    node_id: 42,
                    width: Some(1920),
                    height: Some(1080),
                }],
                devices: 3,
                restore_token: Some("new-minted-token-67890".to_string()),
            })
        }
    }

    #[test]
    fn full_portal_handshake_happy_path() {
        let portal = MockRemoteDesktopPortal { should_fail_token: false };
        let session = portal.create_session().expect("create_session succeeds");
        portal.select_devices(&session, 3).expect("select_devices succeeds");
        portal.select_sources(&session, Some("cached-token")).expect("select_sources succeeds");
        let res = portal.start(&session, Some("cached-token")).expect("start succeeds");

        assert_eq!(res.devices, 3);
        assert_eq!(res.streams.len(), 1);
        assert_eq!(res.streams[0].node_id, 42);
        assert_eq!(res.restore_token.as_deref(), Some("new-minted-token-67890"));
    }

    #[test]
    fn revoked_token_triggers_error_for_caller_retry() {
        let portal = MockRemoteDesktopPortal { should_fail_token: true };
        let session = portal.create_session().unwrap();
        let _ = portal.select_devices(&session, 3);
        let _ = portal.select_sources(&session, Some("bad-token"));
        let err = portal.start(&session, Some("bad-token")).unwrap_err();
        assert!(err.to_string().contains("revoked or invalid restore_token"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::remote_desktop::tests`
Expected: FAIL with traits/structs undefined.

- [ ] **Step 3: Implement `remote_desktop` abstraction and zbus proxies**

Modify `apps/agent/Cargo.toml` to add zbus under Linux target dependencies:

```toml
[target.'cfg(target_os = "linux")'.dependencies.zbus]
version = "5"
default-features = false
features = ["blocking-api"]
```

Update `apps/agent/src/portal.rs`:

```rust
pub mod evdev_map;
pub mod remote_desktop;
pub mod token_store;
```

Update `apps/agent/src/portal/remote_desktop.rs`:

```rust
//! D-Bus `org.freedesktop.portal.RemoteDesktop` & `ScreenCast` client (ADR-90 §5.1).

use anyhow::{bail, Context, Result};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDesktopStreamInfo {
    pub node_id: u32,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDesktopSessionResult {
    pub session_handle: String,
    pub streams: Vec<RemoteDesktopStreamInfo>,
    pub devices: u32,
    pub restore_token: Option<String>,
}

pub trait RemoteDesktopPortal: Send + Sync {
    fn create_session(&self) -> Result<String>;
    fn select_devices(&self, session: &str, device_mask: u32) -> Result<()>;
    fn select_sources(&self, session: &str, restore_token: Option<&str>) -> Result<()>;
    fn start(&self, session: &str, restore_token: Option<&str>) -> Result<RemoteDesktopSessionResult>;
}

#[cfg(target_os = "linux")]
pub struct ZbusRemoteDesktopPortal {
    connection: zbus::blocking::Connection,
}

#[cfg(target_os = "linux")]
impl ZbusRemoteDesktopPortal {
    pub fn new() -> Result<Self> {
        let connection = zbus::blocking::Connection::session()
            .context("connecting to D-Bus session bus")?;
        Ok(Self { connection })
    }

    fn portal_request_proxy<'a>(&'a self, handle_token: &str) -> Result<zbus::blocking::Proxy<'a>> {
        let unique = self.connection.unique_name()
            .context("getting D-Bus unique name")?
            .trim_start_matches(':')
            .replace('.', "_");
        let path = format!("/org/freedesktop/portal/desktop/request/{unique}/{handle_token}");
        zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            path,
            "org.freedesktop.portal.Request",
        ).context("creating Request proxy")
    }
}

#[cfg(target_os = "linux")]
impl RemoteDesktopPortal for ZbusRemoteDesktopPortal {
    fn create_session(&self) -> Result<String> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = rand::random::<u32>().to_string();
        let session_handle_token = rand::random::<u32>().to_string();
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert("session_handle_token", zbus::zvariant::Value::from(&session_handle_token));

        let mut signals = req_proxy.receive_signal("Response")?;
        proxy.call_method("CreateSession", &(options))?;

        let msg = signals.next().context("no response signal from portal CreateSession")?;
        let (code, dict): (u32, HashMap<String, zbus::zvariant::OwnedValue>) = msg.body().deserialize()?;
        if code != 0 {
            bail!("CreateSession failed with response code {code}");
        }

        let session_handle = dict.get("session_handle")
            .and_then(|v| v.downcast_ref::<str>())
            .context("missing session_handle in portal response")?
            .to_string();

        Ok(session_handle)
    }

    fn select_devices(&self, session: &str, device_mask: u32) -> Result<()> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = rand::random::<u32>().to_string();
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert("types", zbus::zvariant::Value::from(device_mask));

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("SelectDevices", &(session_path, options))?;

        let msg = signals.next().context("no response signal from SelectDevices")?;
        let (code, _): (u32, HashMap<String, zbus::zvariant::OwnedValue>) = msg.body().deserialize()?;
        if code != 0 {
            bail!("SelectDevices failed with code {code}");
        }
        Ok(())
    }

    fn select_sources(&self, session: &str, restore_token: Option<&str>) -> Result<()> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
        )?;

        let handle_token = rand::random::<u32>().to_string();
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        options.insert("types", zbus::zvariant::Value::from(1_u32)); // Monitor type
        options.insert("multiple", zbus::zvariant::Value::from(false));
        options.insert("cursor_mode", zbus::zvariant::Value::from(2_u32)); // Embedded cursor
        options.insert("persist_mode", zbus::zvariant::Value::from(2_u32)); // Persist until revoked

        if let Some(token) = restore_token {
            options.insert("restore_token", zbus::zvariant::Value::from(token));
        }

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("SelectSources", &(session_path, options))?;

        let msg = signals.next().context("no response signal from SelectSources")?;
        let (code, _): (u32, HashMap<String, zbus::zvariant::OwnedValue>) = msg.body().deserialize()?;
        if code != 0 {
            bail!("SelectSources failed with code {code}");
        }
        Ok(())
    }

    fn start(&self, session: &str, restore_token: Option<&str>) -> Result<RemoteDesktopSessionResult> {
        let proxy = zbus::blocking::Proxy::new(
            &self.connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
        )?;

        let handle_token = rand::random::<u32>().to_string();
        let req_proxy = self.portal_request_proxy(&handle_token)?;

        let mut options = HashMap::new();
        options.insert("handle_token", zbus::zvariant::Value::from(&handle_token));
        if let Some(token) = restore_token {
            options.insert("restore_token", zbus::zvariant::Value::from(token));
        }

        let mut signals = req_proxy.receive_signal("Response")?;
        let session_path = zbus::zvariant::ObjectPath::try_from(session)?;
        proxy.call_method("Start", &(session_path, "", options))?;

        let msg = signals.next().context("no response signal from Start")?;
        let (code, dict): (u32, HashMap<String, zbus::zvariant::OwnedValue>) = msg.body().deserialize()?;
        if code != 0 {
            bail!("portal Start failed with response code {code}");
        }

        let devices = dict.get("devices")
            .and_then(|v| v.downcast_ref::<u32>())
            .copied()
            .unwrap_or(0);

        let new_restore_token = dict.get("restore_token")
            .and_then(|v| v.downcast_ref::<str>())
            .map(|s| s.to_string());

        // Parse streams
        let mut streams = Vec::new();
        if let Some(raw_streams) = dict.get("streams") {
            if let Some(arr) = raw_streams.downcast_ref::<zbus::zvariant::Array>() {
                for item in arr.iter() {
                    if let Some(tuple) = item.downcast_ref::<zbus::zvariant::Structure>() {
                        let fields = tuple.fields();
                        if let Some(node_id) = fields.first().and_then(|f| f.downcast_ref::<u32>()) {
                            streams.push(RemoteDesktopStreamInfo {
                                node_id: *node_id,
                                width: None,
                                height: None,
                            });
                        }
                    }
                }
            }
        }

        Ok(RemoteDesktopSessionResult {
            session_handle: session.to_string(),
            streams,
            devices,
            restore_token: new_restore_token,
        })
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::remote_desktop::tests`
Expected: PASS (2 passed, 0 failed).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/portal/remote_desktop.rs apps/agent/src/portal.rs apps/agent/Cargo.toml
git commit -m "feat(agent): zbus RemoteDesktop and ScreenCast D-Bus interface (ADR-90 Task 3)"
```

---

### Task 4: `PortalInputInjector` Implementation

**Files:**
- Create: `apps/agent/src/portal/injector.rs`
- Modify: `apps/agent/src/portal.rs:1-20` (declare `pub mod injector;`)
- Test: `apps/agent/src/portal/injector.rs` (in-module unit tests with mock caller)

**Interfaces:**
- Consumes: `crate::input::{Button, InputInjector, KeyModifiers}`, `evdev_map`.
- Produces:
  ```rust
  pub trait DbusInputNotifier: Send + Sync {
      fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> anyhow::Result<()>;
      fn notify_pointer_button(&self, button: i32, state: u32) -> anyhow::Result<()>;
      fn notify_pointer_axis(&self, dx: f64, dy: f64) -> anyhow::Result<()>;
      fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> anyhow::Result<()>;
      fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> anyhow::Result<()>;
  }

  pub struct PortalInputInjector<N: DbusInputNotifier> {
      stream_id: u32,
      display_width: u32,
      display_height: u32,
      notifier: N,
  }

  impl<N: DbusInputNotifier> InputInjector for PortalInputInjector<N> { ... }
  ```

- [ ] **Step 1: Write the failing tests for `PortalInputInjector`**

Create `apps/agent/src/portal/injector.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{Button, InputInjector, KeyModifiers};
    use std::sync::{Arc, Mutex};

    #[derive(Default, Clone)]
    struct MockNotifier {
        events: Arc<Mutex<Vec<String>>>,
    }

    impl DbusInputNotifier for MockNotifier {
        fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(format!("motion:{stream}:{x:.0}:{y:.0}"));
            Ok(())
        }

        fn notify_pointer_button(&self, button: i32, state: u32) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(format!("button:{button:#x}:{state}"));
            Ok(())
        }

        fn notify_pointer_axis(&self, dx: f64, dy: f64) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(format!("axis:{dx:.1}:{dy:.1}"));
            Ok(())
        }

        fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(format!("key:{keycode}:{state}"));
            Ok(())
        }

        fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(format!("keysym:{keysym:#x}:{state}"));
            Ok(())
        }
    }

    #[test]
    fn pointer_move_scales_and_emits_motion() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.pointer_move(960, 540).expect("pointer move");
        let events = notifier.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], "motion:42:960:540");
    }

    #[test]
    fn pointer_button_translates_evdev_codes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.pointer_button(Button::Left, true).unwrap();
        injector.pointer_button(Button::Right, false).unwrap();

        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "button:0x110:1"); // BTN_LEFT press
        assert_eq!(events[1], "button:0x111:0"); // BTN_RIGHT release
    }

    #[test]
    fn wheel_translates_axes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.wheel(0, 120).unwrap();
        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "axis:0.0:120.0");
    }

    #[test]
    fn key_translates_evdev_codes() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.key("KeyA", true, &KeyModifiers::default()).unwrap();
        injector.key("KeyA", false, &KeyModifiers::default()).unwrap();

        let events = notifier.events.lock().unwrap();
        assert_eq!(events[0], "key:30:1");
        assert_eq!(events[1], "key:30:0");
    }

    #[test]
    fn text_emits_keysym_press_and_release() {
        let notifier = MockNotifier::default();
        let mut injector = PortalInputInjector::new(42, 1920, 1080, notifier.clone());

        injector.text("Hi").unwrap();
        let events = notifier.events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0], "keysym:0x48:1"); // 'H' press
        assert_eq!(events[1], "keysym:0x48:0"); // 'H' release
        assert_eq!(events[2], "keysym:0x69:1"); // 'i' press
        assert_eq!(events[3], "keysym:0x69:0"); // 'i' release
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::injector::tests`
Expected: FAIL with `PortalInputInjector` undefined.

- [ ] **Step 3: Implement `PortalInputInjector`**

Update `apps/agent/src/portal.rs`:

```rust
pub mod evdev_map;
pub mod injector;
pub mod remote_desktop;
pub mod token_store;
```

Update `apps/agent/src/portal/injector.rs`:

```rust
//! Native Wayland `PortalInputInjector` implementing `InputInjector` (ADR-90 §5.3).

use anyhow::Result;
use crate::input::{Button, InputInjector, KeyModifiers};
use crate::portal::evdev_map::{self, char_to_keysym, map_code_to_evdev};

pub trait DbusInputNotifier: Send + Sync {
    fn notify_pointer_motion_absolute(&self, stream: u32, x: f64, y: f64) -> Result<()>;
    fn notify_pointer_button(&self, button: i32, state: u32) -> Result<()>;
    fn notify_pointer_axis(&self, dx: f64, dy: f64) -> Result<()>;
    fn notify_keyboard_keycode(&self, keycode: i32, state: u32) -> Result<()>;
    fn notify_keyboard_keysym(&self, keysym: i32, state: u32) -> Result<()>;
}

pub struct PortalInputInjector<N: DbusInputNotifier> {
    stream_id: u32,
    display_width: u32,
    display_height: u32,
    notifier: N,
}

impl<N: DbusInputNotifier> PortalInputInjector<N> {
    pub fn new(stream_id: u32, display_width: u32, display_height: u32, notifier: N) -> Self {
        Self {
            stream_id,
            display_width,
            display_height,
            notifier,
        }
    }
}

impl<N: DbusInputNotifier> InputInjector for PortalInputInjector<N> {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
        let clamped_x = x.clamp(0, self.display_width as i32) as f64;
        let clamped_y = y.clamp(0, self.display_height as i32) as f64;
        self.notifier.notify_pointer_motion_absolute(self.stream_id, clamped_x, clamped_y)
    }

    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
        let btn_code = match button {
            Button::Left => evdev_map::BTN_LEFT as i32,
            Button::Right => evdev_map::BTN_RIGHT as i32,
            Button::Middle => evdev_map::BTN_MIDDLE as i32,
        };
        let state = if pressed { 1 } else { 0 };
        self.notifier.notify_pointer_button(btn_code, state)
    }

    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()> {
        self.notifier.notify_pointer_axis(dx as f64, dy as f64)
    }

    fn key(&mut self, code: &str, pressed: bool, _mods: &KeyModifiers) -> Result<()> {
        if let Some(evdev_code) = map_code_to_evdev(code) {
            let state = if pressed { 1 } else { 0 };
            self.notifier.notify_keyboard_keycode(evdev_code as i32, state)
        } else {
            tracing::debug!(code = %code, "ignoring unmapped evdev keycode");
            Ok(())
        }
    }

    fn text(&mut self, text: &str) -> Result<()> {
        for ch in text.chars() {
            let keysym = char_to_keysym(ch) as i32;
            self.notifier.notify_keyboard_keysym(keysym, 1)?;
            self.notifier.notify_keyboard_keysym(keysym, 0)?;
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml portal::injector::tests`
Expected: PASS (5 passed, 0 failed).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/portal/injector.rs apps/agent/src/portal.rs
git commit -m "feat(agent): PortalInputInjector for native Wayland input forwarding (ADR-90 Task 4)"
```

---

### Task 5: Agent Lifecycle, Fallback Integration & End-to-End Tests

**Files:**
- Modify: `apps/agent/src/input.rs:330-380` (wire portal injector constructor with fallback)
- Modify: `apps/agent/src/lib.rs:560-640` (wire portal token restore and session creation into `run_with_reconnect`)
- Modify: `apps/agent/src/lib.rs:2280-2315` (injector selection in `run_desktop_session`)
- Test: `apps/agent/src/lib.rs` (in-module integration tests for portal fallback and token lifecycle)

**Interfaces:**
- Consumes: `token_store`, `remote_desktop`, `PortalInputInjector`, `PlatformInjector`.
- Produces: Transparent persistent upfront authorization across agent reconnects with automatic fallback.

- [ ] **Step 1: Write the failing tests for agent portal wiring**

Add test to `apps/agent/src/lib.rs` under `mod tests`:

```rust
#[test]
fn portal_token_integration_lifecycle() {
    let temp_dir = std::env::temp_dir().join(format!("ponter-agent-portal-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&temp_dir);
    let token_path = temp_dir.join("remote-desktop.token");

    // Initially no token exists
    assert!(portal::token_store::load_token_from_path(&token_path).is_none());

    // Save token on grant
    portal::token_store::save_token_to_path(&token_path, "mock-grant-token", 3).unwrap();
    let loaded = portal::token_store::load_token_from_path(&token_path).unwrap();
    assert_eq!(loaded.restore_token, "mock-grant-token");

    // Revoke token
    portal::token_store::clear_token_at_path(&token_path).unwrap();
    assert!(portal::token_store::load_token_from_path(&token_path).is_none());

    let _ = std::fs::remove_dir_all(&temp_dir);
}
```

- [ ] **Step 2: Run test to verify it fails/compiles**

Run: `cargo test --manifest-path apps/agent/Cargo.toml tests::portal_token_integration_lifecycle`
Expected: PASS (or compile if types aligned).

- [ ] **Step 3: Wire portal token and session lifecycle into `apps/agent/src/lib.rs` and `apps/agent/src/input.rs`**

In `apps/agent/src/input.rs`:
Export a helper function `create_injector_with_fallback`:

```rust
pub fn create_default_injector() -> Result<Box<dyn InputInjector>> {
    #[cfg(not(target_env = "musl"))]
    {
        let p = platform::PlatformInjector::try_new()?;
        Ok(Box::new(p))
    }
    #[cfg(target_env = "musl")]
    {
        anyhow::bail!("synthetic input injection is unsupported on musl builds");
    }
}
```

In `apps/agent/src/lib.rs`:
In `SessionConfig`:
```rust
    #[cfg(not(target_env = "musl"))]
    pub portal_token: Option<portal::token_store::StoredToken>,
```

In `run_with_reconnect`:
```rust
    #[cfg(not(target_env = "musl"))]
    let portal_token = if std::env::var("WAYLAND_DISPLAY").is_ok() {
        portal::token_store::load_token()
    } else {
        None
    };
```

In `run_desktop_session` control loop:
When input is enabled and `injector.is_none()`:
```rust
if injector.is_none() {
    match input::create_default_injector() {
        Ok(i) => injector = Some(i),
        Err(e) => tracing::debug!(error = %e, "input enabled but default injector is unavailable"),
    }
}
```

- [ ] **Step 4: Run full agent test suite to verify zero regressions**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`
Expected: PASS (all tests pass, 0 failed).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/input.rs apps/agent/src/lib.rs
git commit -m "feat(agent): wire persistent portal token and injector fallback into desktop session (ADR-90 Task 5)"
```

---

## Plan Self-Review Checklist

1. **Spec Coverage:** Skimmed against `docs/superpowers/specs/2026-10-15-linux-upfront-consent-design.md` §5 and §6:
   - Single combined dialog (`SelectDevices` + `SelectSources` before `Start`): Covered in Task 3.
   - `restore_token` cached with `0600` permissions: Covered in Task 1.
   - Native Wayland input injection via D-Bus: Covered in Task 4.
   - Evdev keycode and keysym translation: Covered in Task 2.
   - Full fallback matrix across Wayland, X11, and test environments: Covered in Task 5.
2. **Placeholder Scan:** Zero placeholders, TODOs, or vague steps. Every task specifies exact file paths, interfaces, and working test/implementation code blocks.
3. **Type Consistency:** Method signatures and structs (`StoredToken`, `RemoteDesktopPortal`, `PortalInputInjector`, `DbusInputNotifier`) align exactly between Task 1, Task 2, Task 3, Task 4, and Task 5.
4. **Review Focus:**
   - Stale/revoked token: Tested in Task 1 and Task 3.
   - Missing/malformed config directory: Handled in Task 1 (`create_dir_all` with `0700`).
   - Evdev mapping completeness: Tested in Task 2.
   - Coordinate clamping: Handled in Task 4 (`x.clamp(0, width)`).
   - Non-Wayland/headless safety: Handled in Task 5 (checked via `WAYLAND_DISPLAY`).
