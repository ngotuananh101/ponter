# Ponter Desktop

Native GUI desktop client for the Ponter remote-desktop platform, built with pure Rust using [`eframe`](https://github.com/emilk/egui/tree/master/crates/eframe) and [`egui`](https://github.com/emilk/egui).

- **Crate:** `ponter-desktop` — standalone Rust binary (no WebKit, GTK, webview, or Node runtime).
- **Identifier:** `com.ponter.desktop` · **Version:** `0.1.0`
- **Supported Platforms:** Linux (x86_64) and Windows (x86_64) (ADR-78).

## Architecture & ADRs

The native shell implements:

- **ADR-79 (Native egui/eframe Desktop Shell):** Replaces legacy Tauri v2 and Vue 3 frontend with a pure Rust crate, eliminating webview and Node runtime dependencies.
- **ADR-80 (Minisign-Verified Self-Updater):** Verifies cryptographic signatures against embedded public keys prior to binary replacement via `self_replace`.
- **ADR-81 (Independent Tray Thread):** Runs tray icon and context menus on a dedicated thread (StatusNotifierItem over D-Bus via `ksni` on Linux without GTK; Win32 notification area via `tray-icon` on Windows).
- **ADR-82 (Push-Primary Fleet with Polling Fallback):** Connects to `/api/ws/browser` via ticket minted from `POST /api/ws/ticket` listening for `fleet-changed` notifications, with automatic fallback to periodic polling if WebSocket is unavailable.

## Prerequisites

- **Rust toolchain:** `>= 1.85.0` (stable).
- **Linux system dependencies:** `libx11-dev`, `libxcb1-dev` (or distro equivalent) for native windowing. No GTK or WebKit required.

## Development

Run the desktop client in development:

```bash
cargo run --manifest-path apps/desktop/Cargo.toml
```

Run test suite (160 unit tests):

```bash
cargo test --locked --manifest-path apps/desktop/Cargo.toml
```

Check formatting and linter:

```bash
cargo fmt --manifest-path apps/desktop/Cargo.toml --check
cargo clippy --manifest-path apps/desktop/Cargo.toml --all-targets --locked -- -D warnings
```

## Building Artifacts

### Linux

- **AppImage:**
  ```bash
  apps/desktop/scripts/make-appimage.sh
  ```
- **Debian package (.deb):**
  ```bash
  cargo deb --manifest-path apps/desktop/Cargo.toml
  ```
- **RPM package (.rpm):**
  ```bash
  cargo generate-rpm --manifest-path apps/desktop/Cargo.toml
  ```

### Windows

- **Portable executable:**
  ```bash
  cargo build --release --manifest-path apps/desktop/Cargo.toml
  ```
- **NSIS Installer:**
  ```bash
  makensis apps/desktop/installer.nsi
  ```
- **MSI Installer (WiX):**
  ```bash
  cargo wix --manifest-path apps/desktop/Cargo.toml
  ```

## Configuration & Continuity Invariants

User preferences and connection state are persisted in `config.json` inside the standard application config directory for `com.ponter.desktop`. Only non-secret settings are stored on disk; access tokens remain in memory, and the refresh token and agent credentials are kept in the OS keychain (ADR-52):

- **Linux:** `~/.config/com.ponter.desktop/config.json`
- **Windows:** `%APPDATA%\com.ponter.desktop\config.json`

Server URL resolution follows the four-level precedence chain:

1. Runtime environment variable `PONTER_SERVER_URL`
2. Persisted setting in `config.json`
3. Build-time default `PONTER_DEFAULT_SERVER_URL`
4. Fallback default `http://localhost:8787`

Agent identity keys are stored in `ponter/agent-identity.pkcs8` under `XDG_CONFIG_HOME` (or `~/.config`).
