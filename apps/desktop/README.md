# PonterDesktop

Ponter remote-desktop client. The desktop app is built with
[Tauri v2](https://tauri.app/) (Rust backend) + [Vue 3](https://vuejs.org/) +
[Pinia](https://pinia.vuejs.org/) + [shadcn-vue](https://www.shadcn-vue.com/)
(reka-ui).

- **Crate:** `ponter_desktop` (lib `ponter_desktop_lib`) — Rust/Tauri backend.
- **Identifier:** `com.ponter.desktop` · **Version:** `0.1.0`

## Prerequisites

- **Node** `>= 24` and **pnpm** `>= 12` (repo pins `packageManager: pnpm@12.6.0`).
- A **Rust toolchain (stable)** is required for the Tauri backend.
  There is a `rust-toolchain.toml` only under `apps/agent/`; the desktop crate
  has no toolchain pin of its own.
- No `.nvmrc` / `.node-version` at the repository root.

## Development

```bash
pnpm --filter @ponter/desktop tauri dev
```

Behind the scenes this runs `pnpm dev` (Vite dev server at
`http://localhost:1420`) as the `beforeDevCommand`, with the Tauri window
loading that URL during development.

### Available scripts (from `apps/desktop/package.json`)

| Script      | Command                          |
| ----------- | -------------------------------- |
| `dev`       | `vite`                           |
| `build`     | `vue-tsc --noEmit && vite build` |
| `preview`   | `vite preview`                   |
| `tauri`     | `tauri`                          |
| `lint`      | `eslint .`                       |
| `typecheck` | `vue-tsc --noEmit`               |
| `test`      | `vitest run`                     |

> The Tauri CLI is provided by `@tauri-apps/cli` (v2).

## Building

```bash
pnpm --filter @ponter/desktop tauri build
```

This runs `pnpm build` (the `beforeBuildCommand`) which type-checks and bundles
the Vue app into `../dist` (`frontendDist`), then the Tauri bundler produces the
platform-native artifacts.

### Build-time default server

The backend is compiled with the environment variable
`PONTER_DEFAULT_SERVER_URL`. At runtime the effective server URL is resolved
from a four-level precedence chain:

1. Runtime env `PONTER_SERVER_URL`
2. Persisted `config.json`
3. Build-time default `PONTER_DEFAULT_SERVER_URL`
4. Fallback `http://localhost:8787`

See [Self-hosting guide — §3.1](docs/guides/self-hosting.md#31-server-url-and-config-precedence)
for the full precedence table and usage notes.

## Configuration

User preferences are persisted in `config.json` inside the OS Tauri app-config
directory for `com.ponter.desktop`. Only non-secret fields are stored on disk;
the access token stays in memory and the refresh token lives in the OS
keychain (ADR-52).

- **Linux:** `~/.config/com.ponter.desktop/config.json`
- **macOS:** `~/Library/Application Support/com.ponter.desktop/config.json`
- **Windows:** `%APPDATA%\com.ponter.desktop\config.json`

See [Self-hosting guide — §3.1](docs/guides/self-hosting.md#31-server-url-and-config-precedence)
for config location details.

## Source layout

- `src/` — Vue 3 application (Pinia stores, views, shadcn-vue components).
- `src-tauri/` — Rust/Tauri backend:
  - `commands/` — Tauri commands exposed to the frontend.
  - `config.rs` — persisted config shape + resolution logic.
  - `state.rs`, `keychain.rs`, `tray.rs`, `autostart.rs` — session state, OS
    keychain, tray icon, and autostart helpers.

## Further reading

- Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Self-hosting guide: [docs/guides/self-hosting.md](docs/guides/self-hosting.md)

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/)
  - [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar)
  - [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
