# Ponter Desktop

Desktop client for the Ponter remote-desktop platform, built with Electron 35 and Vue 3. The Electron main process supervises a bundled Rust `ponter-agent` binary sidecar for high-performance screen capture, WebRTC media streaming, and input injection.

- **Package:** `@ponter/desktop`
- **Identifier:** `com.ponter.desktop` · **Version:** `0.1.0`
- **Supported Platforms:** Linux (x86_64) and Windows (x86_64) (ADR-78).

## Architecture & ADRs

The desktop shell implements:

- **ADR-85 (Electron Desktop Shell with Vue 3 Renderer):** Replaces legacy egui shell with an Electron architecture pairing a Node.js 24 ESM main process with a Vue 3 renderer leveraging `@ponter/ui-components` and Pinia stores. Strictly-typed IPC bridge exposes `window.ponter` (`PonterDesktopApi`) via Electron `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
- **ADR-86 (Rust Agent Binary Sidecar Supervision):** Spawns and supervises the native `ponter-agent` binary sidecar with bounded exponential backoff (1s -> 2s -> 4s -> 8s -> 16s -> max 30s) and graceful SIGTERM/SIGKILL termination.
- **ADR-87 (electron-updater Replaces minisign Self-Updater):** Releases publish `latest.yml` manifests for electron-updater on GitHub Releases, replacing legacy minisign and `latest.json`.
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

Run the Vitest test suite (15 test suites, 126 tests):

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

- `ponter-desktop_<version>_amd64.deb`
- `ponter-desktop-<version>.x86_64.rpm`
- `ponter-desktop-<version>.AppImage`

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

- `ponter-desktop Setup <version>.exe`

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
