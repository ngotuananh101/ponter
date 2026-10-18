# Ponter Desktop

Desktop client for the Ponter remote-desktop platform, built with Electron 35 and Vue 3. The Electron main process supervises a bundled Rust `ponter-agent` binary sidecar for high-performance screen capture, WebRTC media streaming, and input injection.

- **Package:** `@ponter/desktop`
- **Identifier:** `com.ponter.desktop` · **Version:** `0.1.0`
- **Supported Platforms:** Linux (x86_64) and Windows (x86_64) (ADR-78).

## Architecture & ADRs

The desktop shell implements:

- **ADR-85 (Electron Desktop Shell with Vue 3 Renderer):** Replaces legacy egui shell with an Electron architecture pairing a Node.js 24 ESM main process with a Vue 3 renderer leveraging `@ponter/ui-components` and Pinia stores. Strictly-typed IPC bridge exposes `window.ponter` (`PonterDesktopApi`) via Electron `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). The main window defaults to 800x600 with 480x500 minimum dimensions and suppresses the native application menu to keep setup and login flows compact.
- **ADR-86 (Rust Agent Binary Sidecar Supervision):** Spawns and supervises the native `ponter-agent` binary sidecar with bounded exponential backoff (1s -> 2s -> 4s -> 8s -> 16s -> max 30s) and graceful SIGTERM/SIGKILL termination.
- **ADR-87 (Auto-Update — IMPLEMENTED):** Auto-update is implemented via `UpdaterManager` in the Electron main process wrapping `electron-updater`, performing non-blocking startup and on-demand checks against GitHub Releases, broadcasting update status events (`desktop:update-status`) to the renderer, and exposing 4 IPC channels (`desktop:check-for-updates`, `desktop:download-update`, `desktop:quit-and-install`, `desktop:get-update-status`). Release workflows generate and attach `latest*.yml` metadata feeds alongside installer artifacts. Implemented in PR #141 `8dd9620`, closing follow-up issue #136.
- **ADR-88 (Shared Design Layer Integration):** Desktop renderer directly consumes shared `@ponter/ui-components` design tokens (`tokens.css`), presentational components (`LoginForm`, `RegisterForm`, `ThemeToggle`), and shared `useTheme` with an IPC-backed storage adapter.
- **Keychain & Credential Isolation (ADR-13, ADR-52, R8):** Access tokens are stored strictly in memory (`inMemoryAccessToken`). Refresh tokens and agent credentials (`device_credential_${id}`) are encrypted with Electron `safeStorage`. Sidecar credentials are provided exclusively via the `AGENT_CREDENTIAL` environment variable to prevent disclosure in process lists (ADR-13).
- **Fleet Synchronization & Polling Fallback (ADR-82):** Primary WebSocket push via `/api/ws/ticket` with automatic failover to 5s polling upon connection drop or 403 Origin rejection.
- **Issue #107 (Auth-Death Classification):** Stable 401 classification clears refresh tokens, while non-fatal errors (e.g. 403 `AGENT_LIMIT_REACHED` or transient network errors) preserve session state and retry via `retryOnceOn401`.

## Prerequisites

- **Node.js:** `>= 24.0.0`
- **pnpm:** `>= 10.0.0`
- **Rust toolchain:** `>= 1.85.0` (to build the `ponter-agent` binary in `apps/agent/`)

## Development

Run the desktop client in development with hot module replacement (HMR):

```bash
pnpm --filter @ponter/desktop dev
```

Run the Vitest test suite (24 test suites, 264 tests):

```bash
pnpm --filter @ponter/desktop test
```

Typecheck main, preload, and renderer processes:

```bash
pnpm --filter @ponter/desktop typecheck
```

Format checking:

```bash
pnpm format:check
```

## Packaging & Building Installers

Before packaging, ensure the Rust `ponter-agent` sidecar binary is compiled and copied into `apps/desktop/resources/`:

### Linux

```bash
# Build Rust agent sidecar
cargo build --release --locked --manifest-path apps/agent/Cargo.toml
mkdir -p apps/desktop/resources
cp apps/agent/target/release/ponter-agent apps/desktop/resources/ponter-agent

# Build & package Electron installers (.deb, .rpm, .AppImage)
pnpm --filter @ponter/desktop build
pnpm --filter @ponter/desktop package
```

Outputs in `apps/desktop/dist/`:

- `ponterdesktop_<version>_amd64.deb`
- `ponterdesktop-<version>.x86_64.rpm`
- `ponterdesktop-<version>.AppImage`

The packaged artifact names use the space-free `productName` (`ponterdesktop`),
which keeps the generated filenames and the Linux install directory free of
spaces. On install:

- **Install directory:** `/opt/ponterdesktop` (electron-builder derives it as
  `/opt/${sanitizeFileName(productName)}`).
- **Executable:** `/opt/ponterdesktop/ponter` (from `linux.executableName`),
  exposed on `PATH` via the `/usr/bin/ponter` symlink shipped by the `.deb`/`.rpm`
  packages.
- **Desktop entry:** `Name=Ponter Desktop`, `Exec=/opt/ponterdesktop/ponter %U`
  (the friendly label is restored with `linux.desktop.Name`; see
  `electron-builder.yml`).

The RPM package uses a guarded `afterRemove` scriptlet (`apps/desktop/build/after-remove.sh`)
that exits early when `$1 != 0` to preserve files on upgrade, and on uninstallation
unregisters the `/opt/ponterdesktop/ponter` alternative, removes the `/usr/bin/ponter` link,
and refreshes the desktop and MIME databases without failing package removal when an optional
system utility is unavailable.

### Windows

```powershell
# Build Rust agent sidecar
cargo build --release --locked --manifest-path apps/agent/Cargo.toml
mkdir -p apps/desktop/resources
copy apps/agent/target/release/ponter-agent.exe apps/desktop/resources/ponter-agent.exe

# Build & package Electron installers (.exe)
pnpm --filter @ponter/desktop build
pnpm --filter @ponter/desktop package
```

Outputs in `apps/desktop/dist/`:

- `ponterdesktop-Setup-<version>.exe`
- `ponterdesktop-Portable-<version>.exe`

The Windows installers keep the friendly `Ponter Desktop` Start Menu shortcut
and Apps & features entry via the `nsis.shortcutName` / `nsis.uninstallDisplayName`
overrides (the global `productName` is the space-free `ponterdesktop`).

## Configuration & Precedence

Non-secret user preferences are persisted in `config.json` inside the platform application data directory:

- **Linux:** `~/.config/com.ponter.desktop/config.json`
- **Windows:** `%APPDATA%\com.ponter.desktop\config.json`

Server URL resolution follows the four-level precedence chain (ADR-64):

1. Runtime environment variable `PONTER_SERVER_URL`
2. Persisted setting in `config.json`
3. Build-time default `PONTER_DEFAULT_SERVER_URL`
4. Fallback default `http://localhost:8787`

Credentials and tokens are never stored in `config.json` or renderer web storage (localStorage/sessionStorage/IndexedDB).

### Runtime Server URL Application & Preference Isolation (Issue #150 / PR #151)

- **Dynamic Reconfiguration Without Restart:** Modifying the server URL in Server Setup takes effect immediately in the running application session without requiring a restart. The main process applies the change via `applyServerUrlChange()`:
  - Repoints the shared `ApiClient` via `HttpClient.setBaseUrl(newUrl)`.
  - Increments the monotonic `serverGeneration` counter in `SessionTokenStorage`, which discards any in-flight refresh responses from the old host and prevents cross-host token writes.
  - Purges local session tokens from memory and the system keychain without dispatching network calls to the old host.
  - Reconnects `FleetManager` by terminating the active WebSocket connection or clearing polling intervals, then reconnecting to `/api/ws/ticket` on the new server.
- **Preference Save Isolation:** Saving user preferences (such as theme or `allowInput`) sends only their respective fields to `ConfigManager.save()`. The configuration manager preserves raw persisted settings and does not overwrite or wipe the configured `serverUrl` with the localhost fallback.

### Local Device Identity & Agent Supervision Controls (Issue #154 / PR #155)

- **Local Device Identity Resolution:** The desktop app recognizes the machine's local device by persisting `localAgentId` in `config.json` and verifying that the corresponding `device_credential_${id}` exists in the OS keychain via `DeviceManager.getLocalAgentId()`. Missing or invalid keychain credentials automatically reset stale local IDs, and `DeviceManager.registerDevice()` cleans up orphaned server rows via `purgeOrphanAgent()` to prevent duplicate device entries.
- **Direct UI and System Tray Controls:** Users can start or stop the local agent sidecar directly from `DevicesView.vue` (which displays a distinct "This device" badge and running/stopped state) and the system tray context menu (`Agent: <status>`, `Start Agent` / `Stop Agent`). Both surfaces update synchronously on status changes.
- **Serialized Agent Supervision (`AgentControlService`):** Centralizes all sidecar lifecycle operations on a single serialized task queue (enforcing clean stops before starts):
  - **Early Exit Health Watch:** Monitors the spawned process across a 2000ms grace period to catch immediate startup failures (e.g. identity file corruption, missing binary) and capture stderr diagnostics.
  - **Crash and Buffer Deadlock Prevention:** Listens for child process `'error'` events to prevent unhandled Electron main-process crashes, and ignores child stdout (`stdio: ['ignore', 'ignore', 'pipe']`) to prevent the operating system pipe buffer (~64KB) from filling and deadlocking the agent.
- **Sticky Auto-Start:** Persists the `agentAutoStart` preference flag across sessions, automatically starting the sidecar on application launch if registered and configured.
- **Safe Server Switching:** When switching servers via `applyServerUrlChange()`, any running agent is safely halted via `agentControl.stop()` before credentials are removed and local device identity is reset.

### Session Persistence & Auto-Restore (Issue #156 / PR #158)

- **Remember Me & Username Retention:** `LoginView.vue` provides a "Remember me" checkbox (defaulting to enabled) and automatically persists the last successfully authenticated username as `savedUsername` in `config.json`. On subsequent launches, the username field is prefilled automatically.
- **Silent Session Auto-Restore on Boot:** When `rememberMe !== false` and a refresh token exists in the OS keychain, `App.vue` invokes `auth.restoreSession()` on launch via the `desktop:restore-session` IPC channel:
  - `SessionManager.restoreSession()` calls `refreshSession()` to silently exchange the stored refresh token for a fresh access token and validates user identity via `apiClient.users.me()`.
  - Authenticated sessions navigate immediately to `DevicesView.vue` (or `WizardView.vue` if initial device setup is pending) without flashing `LoginView.vue`.
  - Integrates with generation-aware token storage (PR #151): checks `apiClient.http.storage.getRefreshToken()`, respects `PURGED (-1)` sentinels to prevent restoring invalidated credentials, and purges credentials on 401 response.
- **Explicit Logout / Remember Me Disabled:** When `rememberMe === false`, closing and reopening the application lands directly on `LoginView.vue` with `savedUsername` prefilled, but does not auto-restore the session, ensuring a full password prompt is required.
