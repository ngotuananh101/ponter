# Electron Desktop Shell Migration (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Rust `egui`/`eframe` desktop client in `apps/desktop` with an Electron application whose renderer is Vue 3 built on the shared `@ponter/ui-components` design system, supervising `ponter-agent` as a bundled child sidecar process, with native capabilities (keychain, config, updater, tray, autostart, single-instance) implemented via Electron APIs.

**Architecture:** Electron main process (Node 24 ESM) owns window management, native OS integrations, and child process supervision of the bundled `ponter-agent` binary. The renderer is a Vue 3 + Vite Single Page Application importing design tokens and presentational components directly from `@ponter/ui-components`. Preload script exposes a strictly typed `contextBridge` (`window.ponter`) with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a rigid Content Security Policy. Auto-update is governed by `electron-updater` reading `latest.yml` from GitHub Releases.

**Tech Stack:** Electron 35.0.0, electron-vite 4.0.0, electron-builder 25.1.8, Vue 3.5.43, Pinia 4.0.3, Tailwind CSS 4.3.3, `@tailwindcss/vite` 4.3.3, `@ponter/ui-components` (workspace), `@ponter/api-client` (workspace), `@ponter/shared` (workspace), `@ponter/webrtc-core` (workspace), Vitest 5.0.3, `@vue/test-utils` 2.5.1, happy-dom 20.14.5, TypeScript 6.0.3, pnpm 12.6.0, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-14-electron-desktop-migration-design.md` (ADR-85..88)

---

## Global Constraints

- **Node >= 24, pnpm >= 12** (root `package.json` `engines`).
- **No macOS platform support** (ADR-78). Build matrix and targets strictly cover Linux (x86_64) and Windows (x86_64).
- **Do NOT edit generated shadcn-vue primitives** under `packages/ui-components/src/components/ui/**`.
- **Renderer Security Gate:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, zero direct node/electron module access from renderer.
- **IPC Interface Seam:** Renderer only interacts with main process via `window.ponter` (`src/shared/ipc-types.ts`).
- **Credential & Token Security (ADR-13, ADR-52, R8):**
  - Access tokens stay in memory only.
  - Refresh tokens and agent credentials (`ag_...`) are stored exclusively in the OS keychain via Electron `safeStorage`. They are NEVER written to disk in plain text and NEVER stored in webview storage (`localStorage`/`sessionStorage`/`IndexedDB`).
  - Device credentials are passed to the agent sidecar strictly via the `AGENT_CREDENTIAL` environment variable (never CLI arguments, preventing `ps` inspection per ADR-13).
- **Configuration & Storage Isolation (ADR-64, ADR-65):** `config.json` is stored at `$XDG_CONFIG_HOME/com.ponter.desktop/config.json` (Linux) / `%APPDATA%\com.ponter.desktop\config.json` (Windows) and read/written exclusively by the main process.
- **Server URL Precedence (ADR-64):** Runtime `PONTER_SERVER_URL` env > persisted `config.json` > build-time `PONTER_DEFAULT_SERVER_URL` > `http://localhost:8787`.
- **Agent Sidecar Preserved (ADR-50, ADR-86):** The Rust agent crate (`apps/agent`) is untouched. The binary is compiled during CI and bundled as `extraResources` into `resources/ponter-agent`.
- **All technical writing in English** (code, comments, commit messages, documentation). Conversation replies stay in Vietnamese.
- **Commit messages:** No `Co-authored-by` trailers, author only: `Ngo Tuan Anh <ngotuananh2101@gmail.com>`.
- **Prettier formatting check:** Mandatory gating via `pnpm format:check`.

---

## Review Focus

1. **Corrupt or Missing `config.json` at Startup:** Main process must fall back to default configuration without throwing unhandled exceptions, and the renderer `App.vue` must complete the startup-flash gate (`configLoaded = true`).
2. **OS Keychain (`safeStorage`) Unavailable:** When running in headless environments or Linux without a Secret Service daemon, `safeStorage.isEncryptionAvailable()` returns false; main process services must return descriptive typed errors instead of crashing or leaking plain-text secrets.
3. **401 Unauthorized Auth-Death Classification (Issue #107):** During background device refresh or API calls, `retryOnceOn401` must execute exactly one token refresh attempt. If refresh fails with 401 (`UNAUTHORIZED`), keychain credentials must be cleared and an auth-fatal error returned to redirect the user to `LoginView`. Transient errors (5xx/network) must not clear credentials.
4. **Agent Sidecar Unexpected Exit & Crashloop Prevention:** If the child `ponter-agent` process exits abnormally, `AgentSupervisor` must emit an `error` status to the renderer and apply bounded exponential backoff (1s -> 2s -> 4s -> ... -> max 30s) instead of tight-loop respawning.
5. **Fleet WebSocket 403 Origin Rejection (ADR-82):** Main process fleet synchronization must seamlessly transition from WebSocket push to periodic polling (~5s interval) upon encountering an origin rejection or connection drop, with mutual exclusion ensuring both layers are never active simultaneously.

---

## Test Parity Matrix (TEST-INTEGRITY)

### TEST-INTEGRITY Declaration

- **Before:** `apps/desktop` native `egui`/`eframe` suite = **164 Rust unit tests**.
- **After:** **168+ Vitest unit/integration tests** across the Electron main process and Vue 3 renderer suites.
- **Reason:** The 164 Rust tests are removed **strictly together with the `egui` shell code they test**. All product and architectural requirements (ADR-52 keychain, ADR-64/65 config, ADR-66 route gate, ADR-78 platform, ADR-81 tray, ADR-82 fleet push, Issue #107 auth-fatal rules, and PR #96..98 flicker/polling semantics) are re-established with 100% parity in Vitest.

### Comprehensive Test Mapping Table

| Rust Test Module (`apps/desktop/src/`) | Tests | Target Vitest Suite | Covered Behaviors & Invariants |
|---|---|---|---|
| `app::tests` | 3 | `src/main/__tests__/config.test.ts`<br>`src/renderer/__tests__/serverSetup.test.ts` | Server config persistence, deadlock prevention, navigation transition to saved state. |
| `autostart::tests` | 13 | `src/main/__tests__/autostart.test.ts`<br>`src/renderer/__tests__/wizard.test.ts` | Autostart directory resolution (XDG vs home), desktop file generation, spaced path quoting, round-trip enable/disable. |
| `core::agent_host::tests` | 6 | `src/main/__tests__/agent-supervisor.test.ts` | Sidecar environment configuration assembly, missing credential validation, identity path resolution. |
| `core::auth::tests` | 6 | `src/main/__tests__/session.test.ts`<br>`src/renderer/__tests__/login.test.ts` | Keychain key names, refresh token storage via `safeStorage`, server error parsing, logout cleanup. |
| `core::config::tests` | 13 | `src/main/__tests__/config.test.ts` | Default input gate closed, fallback on corrupt/missing JSON, 4-tier precedence resolution, slash/whitespace trimming. |
| `core::devices::tests` | 17 | `src/main/__tests__/devices.test.ts`<br>`src/renderer/__tests__/devices.test.ts` | Device listing, credential removal from responses, keychain storage for agent tokens, `retryOnceOn401` single retry, Issue #107 401 classification. |
| `core::error::tests` | 2 | `src/main/__tests__/session.test.ts` | Stable `AUTH_FAILED` prefix validation, authentication error predicate classification. |
| `core::fleet_ws::tests` | 10 | `src/main/__tests__/fleet.test.ts` | WebSocket URL transformation (`ws://`/`wss://`), ticket minting, mutual exclusion between push and poll layers, 403 fallback. |
| `core::keychain::tests` | 2 | `src/main/__tests__/keychain.test.ts` | `safeStorage` secret round-trip, missing key handling (`null` return). |
| `core::session::tests` | 9 | `src/main/__tests__/session.test.ts` | 401/403 fatal classification, transient error bypass, refresh token rotation, `retryOnceOn401` recovery. |
| `core::state::tests` | 3 | `src/main/__tests__/config.test.ts` | App identifier `com.ponter.desktop`, persisted server URL resolution, localhost fallback. |
| `core::updater::tests` | 10 | `src/main/__tests__/updater.test.ts` | Platform asset selection, semver evaluation (`should_apply`), update rejection on older or equal versions. |
| `core::wizard::tests` | 17 | `src/main/__tests__/config.test.ts`<br>`src/renderer/__tests__/wizard.test.ts`<br>`src/renderer/__tests__/serverSetup.test.ts` | `allowInput` default false, health probe body validation, network error handling, config persistence. |
| `theme::tests` | 8 | `src/renderer/__tests__/theme.test.ts`<br>`packages/ui-components/.../useTheme.test.ts` | Light/dark resolution, system theme detection, token differences, persistence adapter dispatch. |
| `tray::tests` | 12 | `src/main/__tests__/tray.test.ts` | Menu action mapping, WebSocket URL derivation, hide-on-close toggle, runtime status formatting. |
| `ui::components::tests` | 4 | `packages/ui-components/.../LoginForm.test.ts`<br>`packages/ui-components/.../RegisterForm.test.ts` | Input height parity, headless DOM rendering. |
| `ui::devices::tests` | 2 | `src/renderer/__tests__/devices.test.ts` | Online/offline device status badge labels. |
| `ui::login::tests` | 4 | `src/renderer/__tests__/login.test.ts` | Form validation, whitespace trimming, empty password rejection. |
| `ui::server_setup::tests` | 5 | `src/renderer/__tests__/serverSetup.test.ts` | URL validation, protocol requirement (`http`/`https`), whitespace trimming. |
| `ui::settings::tests` | 1 | `src/renderer/__tests__/wizard.test.ts` | Autostart UI label matching active state. |
| `ui::tests` | 1 | `src/renderer/__tests__/app.test.ts` | Gate-based view progression: ServerSetup -> Login -> SetupWizard -> Devices. |
| `ui::wizard::tests` | 10 | `src/renderer/__tests__/wizard.test.ts` | 3-step sequence, capture gate enforcement, boundary clamping. |
| **Total Rust Tests** | **164** | **Total Planned Vitest Tests** | **168+** (98 renderer + 70 main process) |

---

## Task Decomposition

### Task 1: Scaffolding Monorepo & Electron-Vite Configs

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/tsconfig.web.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/components.json`
- Create: `apps/desktop/electron-builder.yml`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Consumes: `@ponter/ui-components`, `@ponter/api-client`, `@ponter/shared`, `@ponter/webrtc-core`.
- Produces: Runnable build and test scripts for `@ponter/desktop` (`pnpm --filter @ponter/desktop build`, `test`, `typecheck`).

- [ ] **Step 1: Create `apps/desktop/package.json`**

```json
{
  "name": "@ponter/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Ponter Desktop Application (Electron + Vue 3)",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "postinstall": "electron-builder install-app-deps",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json",
    "typecheck:web": "vue-tsc --noEmit -p tsconfig.web.json",
    "typecheck": "pnpm run typecheck:node && pnpm run typecheck:web",
    "test": "vitest run",
    "package:dir": "electron-builder --dir",
    "package": "electron-builder"
  },
  "dependencies": {
    "@lucide/vue": "^1.49.0",
    "@ponter/api-client": "workspace:*",
    "@ponter/shared": "workspace:*",
    "@ponter/ui-components": "workspace:*",
    "@ponter/webrtc-core": "workspace:*",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "electron-updater": "^6.3.9",
    "pinia": "4.0.3",
    "reka-ui": "^2.10.5",
    "shadcn-vue": "^2.8.2",
    "tailwind-merge": "^3.7.0",
    "tw-animate-css": "^1.4.0",
    "vue": "3.5.43"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/node": "24.19.0",
    "@vitejs/plugin-vue": "6.0.9",
    "@vue/test-utils": "2.5.1",
    "electron": "^35.0.0",
    "electron-builder": "^25.1.8",
    "electron-vite": "^4.0.0",
    "happy-dom": "20.14.5",
    "tailwindcss": "4.3.3",
    "typescript": "6.0.3",
    "vite": "8.3.1",
    "vitest": "5.0.3",
    "vue-tsc": "3.3.11"
  }
}
```

- [ ] **Step 2: Create `apps/desktop/electron.vite.config.ts`**

```typescript
import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@/lib/utils': resolve(__dirname, '../../packages/ui-components/src/lib/utils'),
        '@/components/ui': resolve(__dirname, '../../packages/ui-components/src/components/ui')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
});
```

- [ ] **Step 3: Create TypeScript configs (`tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`)**

`apps/desktop/tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`apps/desktop/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "electron.vite.config.ts",
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*"
  ]
}
```

`apps/desktop/tsconfig.web.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/renderer/*"],
      "@/lib/utils": ["../../packages/ui-components/src/lib/utils"],
      "@/components/ui/*": ["../../packages/ui-components/src/components/ui/*"]
    }
  },
  "include": [
    "src/renderer/**/*",
    "src/shared/**/*"
  ]
}
```

- [ ] **Step 4: Create `apps/desktop/index.html` and `apps/desktop/components.json`**

`apps/desktop/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss: http: https:;" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ponter Desktop</title>
  </head>
  <body class="bg-background text-foreground antialiased select-none overflow-hidden">
    <div id="app"></div>
    <script type="module" src="/src/renderer/main.ts"></script>
  </body>
</html>
```

`apps/desktop/components.json`:
```json
{
  "$schema": "https://shadcn-vue.com/schema.json",
  "style": "default",
  "typescript": true,
  "tailwind": {
    "config": "",
    "css": "src/renderer/style.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "framework": "vite",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

- [ ] **Step 5: Create `apps/desktop/electron-builder.yml`**

```yaml
appId: com.ponter.desktop
productName: Ponter Desktop
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - package.json
extraResources:
  - from: resources/ponter-agent
    to: ponter-agent
linux:
  target:
    - target: AppImage
    - target: deb
    - target: rpm
  category: Utility
  icon: icons/icon.png
win:
  target:
    - target: nsis
    - target: portable
  icon: icons/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
publish:
  provider: github
  owner: ngotuananh101
  repo: ponter
```

- [ ] **Step 6: Install dependencies & verify workspace graph**

Run: `pnpm install`
Expected: Successfully installs dependencies and links `@ponter/desktop` in pnpm workspace.

- [ ] **Step 7: Commit scaffolding**

```bash
git add apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/tsconfig*.json apps/desktop/index.html apps/desktop/components.json apps/desktop/electron-builder.yml pnpm-lock.yaml
git commit -m "feat(desktop): scaffold Electron monorepo and electron-vite configs"
```

---

### Task 2: IPC Contract & Preload contextBridge

**Files:**
- Create: `apps/desktop/src/shared/ipc-types.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Test: `apps/desktop/src/preload/__tests__/preload.test.ts`

**Interfaces:**
- Consumes: `@ponter/shared` types.
- Produces: `window.ponter` (`PonterDesktopApi`) available on the renderer window.

- [ ] **Step 1: Write failing preload & IPC test**

Create `apps/desktop/src/preload/__tests__/preload.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exposePonterApi } from '../index';

describe('Preload contextBridge API', () => {
  const ipcRendererMock = {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  };

  const contextBridgeMock = {
    exposeInMainWorld: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes window.ponter with all required contract methods', () => {
    exposePonterApi(contextBridgeMock as any, ipcRendererMock as any);
    expect(contextBridgeMock.exposeInMainWorld).toHaveBeenCalledWith(
      'ponter',
      expect.objectContaining({
        getConfig: expect.any(Function),
        saveConfig: expect.any(Function),
        probeServer: expect.any(Function),
        login: expect.any(Function),
        logout: expect.any(Function),
        probeCapture: expect.any(Function),
        setAutostart: expect.any(Function),
        isAutostartEnabled: expect.any(Function),
        listDevices: expect.any(Function),
        registerDevice: expect.any(Function),
        deleteDevice: expect.any(Function),
        getRuntimeStatus: expect.any(Function),
        onFleetChanged: expect.any(Function),
        onRuntimeStatus: expect.any(Function)
      })
    );
  });

  it('routes getConfig to ipcRenderer.invoke', async () => {
    ipcRendererMock.invoke.mockResolvedValueOnce({ serverUrl: 'http://localhost:8787' });
    const api = exposePonterApi(contextBridgeMock as any, ipcRendererMock as any);
    const result = await api.getConfig();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('desktop:get-config');
    expect(result).toEqual({ serverUrl: 'http://localhost:8787' });
  });

  it('subscribes and unregisters event listeners for onFleetChanged', () => {
    const api = exposePonterApi(contextBridgeMock as any, ipcRendererMock as any);
    const cb = vi.fn();
    const unsubscribe = api.onFleetChanged(cb);
    expect(ipcRendererMock.on).toHaveBeenCalledWith('desktop:fleet-changed', expect.any(Function));
    unsubscribe();
    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith('desktop:fleet-changed', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test src/preload/__tests__/preload.test.ts`
Expected: FAIL ("Cannot find module '../index'")

- [ ] **Step 3: Define `src/shared/ipc-types.ts`**

```typescript
export interface AppConfig {
  serverUrl: string | null;
  allowInput: boolean;
  theme: 'light' | 'dark' | null;
  hasServerUrl: boolean;
}

export interface SaveConfigPayload {
  serverUrl?: string | null;
  allowInput?: boolean;
  theme?: 'light' | 'dark' | null;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export interface UserProfile {
  id: string;
  username: string;
  email?: string | null;
  role: string;
}

export interface DesktopDevice {
  id: string;
  userId: string;
  hostname: string;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  publicKey: string;
  signingPublicKey: string | null;
  isOnline: boolean;
  lastHeartbeat: string | null;
  capabilities: string[];
  createdAt: string;
}

export interface RegisterDevicePayload {
  hostname?: string;
  capabilities?: string[];
}

export interface PonterDesktopApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(payload: SaveConfigPayload): Promise<void>;
  probeServer(url: string): Promise<ProbeResult>;
  login(username: string, password: string): Promise<UserProfile>;
  logout(): Promise<void>;
  probeCapture(): Promise<ProbeResult>;
  setAutostart(enabled: boolean): Promise<void>;
  isAutostartEnabled(): Promise<boolean>;
  listDevices(): Promise<DesktopDevice[]>;
  registerDevice(payload: RegisterDevicePayload): Promise<DesktopDevice>;
  deleteDevice(agentId: string): Promise<boolean>;
  getRuntimeStatus(): Promise<string>;
  onFleetChanged(callback: () => void): () => void;
  onRuntimeStatus(callback: (status: string) => void): () => void;
}

declare global {
  interface Window {
    ponter: PonterDesktopApi;
  }
}
```

- [ ] **Step 4: Implement `src/preload/index.ts`**

```typescript
import { contextBridge, ipcRenderer, IpcRenderer, ContextBridge } from 'electron';
import type { PonterDesktopApi, SaveConfigPayload, RegisterDevicePayload } from '../shared/ipc-types';

export function createPonterApi(ipc: typeof ipcRenderer): PonterDesktopApi {
  return {
    getConfig: () => ipc.invoke('desktop:get-config'),
    saveConfig: (payload: SaveConfigPayload) => ipc.invoke('desktop:save-config', payload),
    probeServer: (url: string) => ipc.invoke('desktop:probe-server', url),
    login: (username: string, password: string) => ipc.invoke('desktop:login', { username, password }),
    logout: () => ipc.invoke('desktop:logout'),
    probeCapture: () => ipc.invoke('desktop:probe-capture'),
    setAutostart: (enabled: boolean) => ipc.invoke('desktop:set-autostart', enabled),
    isAutostartEnabled: () => ipc.invoke('desktop:is-autostart-enabled'),
    listDevices: () => ipc.invoke('desktop:list-devices'),
    registerDevice: (payload: RegisterDevicePayload) => ipc.invoke('desktop:register-device', payload),
    deleteDevice: (agentId: string) => ipc.invoke('desktop:delete-device', agentId),
    getRuntimeStatus: () => ipc.invoke('desktop:get-runtime-status'),
    onFleetChanged: (callback: () => void) => {
      const listener = () => callback();
      ipc.on('desktop:fleet-changed', listener);
      return () => ipc.removeListener('desktop:fleet-changed', listener);
    },
    onRuntimeStatus: (callback: (status: string) => void) => {
      const listener = (_: any, status: string) => callback(status);
      ipc.on('desktop:runtime-status', listener);
      return () => ipc.removeListener('desktop:runtime-status', listener);
    }
  };
}

export function exposePonterApi(bridge: ContextBridge = contextBridge, ipc: IpcRenderer = ipcRenderer): PonterDesktopApi {
  const api = createPonterApi(ipc);
  bridge.exposeInMainWorld('ponter', api);
  return api;
}

// In Electron preload runtime:
if (typeof process !== 'undefined' && process.type === 'renderer') {
  exposePonterApi();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test src/preload/__tests__/preload.test.ts`
Expected: PASS (3 tests passing)

- [ ] **Step 6: Commit IPC contract and preload implementation**

```bash
git add apps/desktop/src/shared/ipc-types.ts apps/desktop/src/preload/
git commit -m "feat(desktop): implement typed IPC contract and preload contextBridge"
```

---

### Task 3: Main Process Core Services

**Files:**
- Create: `apps/desktop/src/main/config.ts`
- Create: `apps/desktop/src/main/keychain.ts`
- Create: `apps/desktop/src/main/session.ts`
- Create: `apps/desktop/src/main/devices.ts`
- Create: `apps/desktop/src/main/fleet.ts`
- Create: `apps/desktop/src/main/autostart.ts`
- Create: `apps/desktop/src/main/tray.ts`
- Create: `apps/desktop/src/main/window.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/__tests__/config.test.ts`
- Test: `apps/desktop/src/main/__tests__/session.test.ts`
- Test: `apps/desktop/src/main/__tests__/fleet.test.ts`
- Test: `apps/desktop/src/main/__tests__/keychain.test.ts`

**Interfaces:**
- Consumes: `@ponter/api-client` (`createApiClient`), `@ponter/webrtc-core` (`toWsUrl`, `stripTrailingSlashes`), Electron `safeStorage`, Electron `app`, `Tray`, `BrowserWindow`.
- Produces: Main process initialization and IPC handlers registered for all `desktop:*` channels.

- [ ] **Step 1: Write failing config service unit test**

Create `apps/desktop/src/main/__tests__/config.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigManager } from '../config';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn()
}));

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves runtime env URL before persisted or default URL (ADR-64)', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: 'http://runtime.example.com',
      buildDefaultUrl: 'http://build.example.com'
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ serverUrl: 'http://persisted.example.com' }));

    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('http://runtime.example.com');
    expect(cfg.hasServerUrl).toBe(true);
  });

  it('falls back to build default and then localhost when unset', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: ''
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('http://localhost:8787');
    expect(cfg.hasServerUrl).toBe(false);
  });

  it('trims trailing slashes from server URLs', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: 'https://server.example.com///'
    });
    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('https://server.example.com');
  });

  it('handles corrupt JSON gracefully by falling back to defaults', () => {
    const manager = new ConfigManager('/tmp/test-config.json');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json ');

    const cfg = manager.load();
    expect(cfg.allowInput).toBe(false);
    expect(cfg.serverUrl).toBe('http://localhost:8787');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test src/main/__tests__/config.test.ts`
Expected: FAIL ("Cannot find module '../config'")

- [ ] **Step 3: Implement `src/main/config.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AppConfig, SaveConfigPayload } from '../shared/ipc-types';

export interface ConfigOptions {
  runtimeEnvUrl?: string;
  buildDefaultUrl?: string;
}

export function getCanonicalConfigPath(): string {
  const userData = app?.getPath ? app.getPath('userData') : '';
  const home = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const baseDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'com.ponter.desktop')
    : path.join(home, 'com.ponter.desktop');
  return path.join(baseDir, 'config.json');
}

export class ConfigManager {
  private filePath: string;
  private runtimeEnvUrl: string;
  private buildDefaultUrl: string;

  constructor(filePath?: string, options?: ConfigOptions) {
    this.filePath = filePath || getCanonicalConfigPath();
    this.runtimeEnvUrl = options?.runtimeEnvUrl ?? process.env.PONTER_SERVER_URL ?? '';
    this.buildDefaultUrl = options?.buildDefaultUrl ?? process.env.PONTER_DEFAULT_SERVER_URL ?? '';
  }

  private cleanUrl(url?: string | null): string {
    if (!url) return '';
    const trimmed = url.trim();
    return trimmed.replace(/\/+$/, '');
  }

  load(): AppConfig {
    let persisted: Partial<AppConfig> = {};
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        persisted = JSON.parse(raw);
      } catch {
        persisted = {};
      }
    }

    const envUrl = this.cleanUrl(this.runtimeEnvUrl);
    const persistedUrl = this.cleanUrl(persisted.serverUrl);
    const buildUrl = this.cleanUrl(this.buildDefaultUrl);

    let effectiveUrl = 'http://localhost:8787';
    let hasServerUrl = false;

    if (envUrl) {
      effectiveUrl = envUrl;
      hasServerUrl = true;
    } else if (persistedUrl) {
      effectiveUrl = persistedUrl;
      hasServerUrl = true;
    } else if (buildUrl) {
      effectiveUrl = buildUrl;
      hasServerUrl = true;
    }

    return {
      serverUrl: effectiveUrl,
      allowInput: persisted.allowInput === true,
      theme: persisted.theme === 'dark' || persisted.theme === 'light' ? persisted.theme : null,
      hasServerUrl
    };
  }

  save(payload: SaveConfigPayload): void {
    const current = this.load();
    const updated = {
      serverUrl: payload.serverUrl !== undefined ? (payload.serverUrl ? this.cleanUrl(payload.serverUrl) : null) : current.serverUrl,
      allowInput: payload.allowInput !== undefined ? payload.allowInput : current.allowInput,
      theme: payload.theme !== undefined ? payload.theme : current.theme
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }
}
```

- [ ] **Step 4: Run config test to verify it passes**

Run: `pnpm --filter @ponter/desktop test src/main/__tests__/config.test.ts`
Expected: PASS (4 tests passing)

- [ ] **Step 5: Write failing session & auth classification test (Issue #107)**

Create `apps/desktop/src/main/__tests__/session.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session';

describe('SessionManager & Auth Classification (Issue #107)', () => {
  const apiClientMock = {
    post: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn()
  };

  const keychainMock = {
    getSecret: vi.fn(),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies 401 UNAUTHORIZED as auth-fatal and purges keychain', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.post.mockRejectedValue({ status: 401, data: { message: 'Session expired' } });

    const session = new SessionManager(apiClientMock as any, keychainMock as any);
    await expect(session.refreshSession()).rejects.toThrow('AUTH_FAILED: UNAUTHORIZED');
    expect(keychainMock.deleteSecret).toHaveBeenCalledWith('refresh_token');
  });

  it('treats 403 as non-fatal without wiping keychain (e.g. AGENT_LIMIT_REACHED)', async () => {
    keychainMock.getSecret.mockReturnValue('valid-refresh-token');
    apiClientMock.post.mockRejectedValue({ status: 403, data: { message: 'AGENT_LIMIT_REACHED' } });

    const session = new SessionManager(apiClientMock as any, keychainMock as any);
    await expect(session.refreshSession()).rejects.toThrow('AGENT_LIMIT_REACHED');
    expect(keychainMock.deleteSecret).not.toHaveBeenCalled();
  });

  it('retryOnceOn401 executes refresh and retries original request', async () => {
    let callCount = 0;
    const mockRequest = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      return { success: true };
    });

    keychainMock.getSecret.mockReturnValue('refresh-token');
    apiClientMock.post.mockResolvedValueOnce({
      accessToken: 'new-access-token',
      refreshToken: 'rotated-refresh-token',
      user: { id: 'u1', username: 'alice', role: 'admin' }
    });

    const session = new SessionManager(apiClientMock as any, keychainMock as any);
    const result = await session.retryOnceOn401(mockRequest);
    expect(result).toEqual({ success: true });
    expect(callCount).toBe(2);
    expect(keychainMock.storeSecret).toHaveBeenCalledWith('refresh_token', 'rotated-refresh-token');
  });
});
```

- [ ] **Step 6: Implement `src/main/keychain.ts` and `src/main/session.ts`**

`apps/desktop/src/main/keychain.ts`:
```typescript
import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getCanonicalConfigPath } from './config';

export class KeychainService {
  private storeFile: string;

  constructor(storeFile?: string) {
    const configPath = storeFile || getCanonicalConfigPath();
    this.storeFile = path.join(path.dirname(configPath), 'secrets.enc');
  }

  private readStore(): Record<string, string> {
    if (!fs.existsSync(this.storeFile)) return {};
    try {
      const raw = fs.readFileSync(this.storeFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeStore(store: Record<string, string>): void {
    const dir = path.dirname(this.storeFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify(store, null, 2), 'utf-8');
  }

  storeSecret(key: string, secret: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('KEYCHAIN_UNAVAILABLE: OS encryption service not ready');
    }
    const encrypted = safeStorage.encryptString(secret).toString('base64');
    const store = this.readStore();
    store[key] = encrypted;
    this.writeStore(store);
  }

  getSecret(key: string): string | null {
    const store = this.readStore();
    const encryptedBase64 = store[key];
    if (!encryptedBase64) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('KEYCHAIN_UNAVAILABLE: OS encryption service not ready');
    }
    try {
      const buffer = Buffer.from(encryptedBase64, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
  }

  deleteSecret(key: string): void {
    const store = this.readStore();
    if (store[key]) {
      delete store[key];
      this.writeStore(store);
    }
  }
}
```

`apps/desktop/src/main/session.ts`:
```typescript
import type { ApiClient } from '@ponter/api-client';
import type { KeychainService } from './keychain';
import type { UserProfile } from '../shared/ipc-types';

export class SessionManager {
  private client: ApiClient;
  private keychain: KeychainService;
  private currentUser: UserProfile | null = null;

  constructor(client: ApiClient, keychain: KeychainService) {
    this.client = client;
    this.keychain = keychain;
  }

  async login(username: string, password: string): Promise<UserProfile> {
    try {
      const resp: any = await this.client.post('/api/auth/login', { username, password });
      this.currentUser = resp.user;
      this.client.setToken(resp.accessToken);
      if (resp.refreshToken) {
        this.keychain.storeSecret('refresh_token', resp.refreshToken);
      }
      return resp.user;
    } catch (err: any) {
      throw new Error(err.data?.message || err.message || 'Login failed');
    }
  }

  async logout(): Promise<void> {
    try {
      await this.client.post('/api/auth/logout', {});
    } catch {
      // Swallowed on client logout
    } finally {
      this.currentUser = null;
      this.client.clearToken();
      this.keychain.deleteSecret('refresh_token');
    }
  }

  async refreshSession(): Promise<string> {
    const refreshToken = this.keychain.getSecret('refresh_token');
    if (!refreshToken) {
      this.currentUser = null;
      this.client.clearToken();
      throw new Error('AUTH_FAILED: UNAUTHORIZED (missing refresh token)');
    }

    try {
      const resp: any = await this.client.post('/api/auth/refresh', { refreshToken });
      this.client.setToken(resp.accessToken);
      if (resp.refreshToken) {
        this.keychain.storeSecret('refresh_token', resp.refreshToken);
      }
      if (resp.user) this.currentUser = resp.user;
      return resp.accessToken;
    } catch (err: any) {
      if (err.status === 401 || err.statusCode === 401) {
        this.currentUser = null;
        this.client.clearToken();
        this.keychain.deleteSecret('refresh_token');
        throw new Error('AUTH_FAILED: UNAUTHORIZED');
      }
      throw err;
    }
  }

  async retryOnceOn401<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err.status === 401 || err.statusCode === 401) {
        await this.refreshSession();
        return await fn();
      }
      throw err;
    }
  }
}
```

- [ ] **Step 7: Run session & auth classification tests**

Run: `pnpm --filter @ponter/desktop test src/main/__tests__/session.test.ts`
Expected: PASS (3 tests passing)

- [ ] **Step 8: Implement `devices.ts`, `fleet.ts`, `autostart.ts`, `tray.ts`, `window.ts`, `ipc.ts`, and `index.ts`**

`apps/desktop/src/main/devices.ts`:
- Wraps `GET /api/agents`, `POST /api/agents`, `DELETE /api/agents/:id` in `session.retryOnceOn401`.
- On `registerDevice`, extracts device credential `ag_...` from response and persists it to keychain via `keychain.storeSecret('device_credential_' + device.id, credential)`. Strips credential before returning device object to renderer.

`apps/desktop/src/main/fleet.ts`:
- Dual-layer fleet synchronization (ADR-82): primary WebSocket with ticket from `/api/ws/ticket`, fallback polling (~5s interval). Emits `desktop:fleet-changed` to renderer window on updates.

`apps/desktop/src/main/autostart.ts`:
- Uses `app.setLoginItemSettings({ openAtLogin: enabled })` on Windows, and standard `.desktop` entry under `$XDG_CONFIG_HOME/autostart/ponter-desktop.desktop` on Linux.

`apps/desktop/src/main/tray.ts`:
- Builds Electron `Tray` instance with context menu (Show Window, Status, Quit) and single-click window restore.

`apps/desktop/src/main/ipc.ts`:
- Registers `ipcMain.handle` listeners for all 12 channels defined in Task 2.

`apps/desktop/src/main/index.ts`:
- Acquires `app.requestSingleInstanceLock()`. Initializes window, tray, supervisor, and fleet.

- [ ] **Step 9: Commit main process core services**

```bash
git add apps/desktop/src/main/
git commit -m "feat(desktop): implement Electron main process core services and IPC handlers"
```

---

### Task 4: Agent Sidecar Supervisor

**Files:**
- Create: `apps/desktop/src/main/agent-supervisor.ts`
- Test: `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `KeychainService`, `toWsUrl` from `@ponter/webrtc-core`.
- Produces: Child process management for `ponter-agent` binary, health events, and bounded exponential backoff.

- [ ] **Step 1: Write failing agent supervisor unit test**

Create `apps/desktop/src/main/__tests__/agent-supervisor.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSupervisor } from '../agent-supervisor';

describe('AgentSupervisor (ADR-86 Sidecar Contract)', () => {
  const spawnMock = vi.fn();
  const keychainMock = {
    getSecret: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assembles exact environment variables per spec contract', () => {
    keychainMock.getSecret.mockReturnValue('ag_secret_credential_123');
    const supervisor = new AgentSupervisor(keychainMock as any, { spawn: spawnMock as any });

    const env = supervisor.buildEnvironment({
      agentId: 'dev_laptop_01',
      serverUrl: 'http://localhost:8787',
      allowInput: true,
      filesRoot: '/home/user/ponter-files',
      identityPath: '/home/user/.config/ponter/identity.pkcs8'
    });

    expect(env).toEqual(
      expect.objectContaining({
        AGENT_ID: 'dev_laptop_01',
        AGENT_SERVER: 'ws://localhost:8787/api/ws/agent',
        AGENT_CREDENTIAL: 'ag_secret_credential_123',
        STUN_SERVER: 'stun:stun.l.google.com:19302',
        AGENT_ALLOW_INPUT: 'true',
        AGENT_FILES_ROOT: '/home/user/ponter-files',
        AGENT_IDENTITY_PATH: '/home/user/.config/ponter/identity.pkcs8'
      })
    );
  });

  it('calculates bounded exponential backoff correctly (1s up to max 30s)', () => {
    const supervisor = new AgentSupervisor(keychainMock as any);
    expect(supervisor.getBackoffDelay(0)).toBe(1000);
    expect(supervisor.getBackoffDelay(1)).toBe(2000);
    expect(supervisor.getBackoffDelay(2)).toBe(4000);
    expect(supervisor.getBackoffDelay(3)).toBe(8000);
    expect(supervisor.getBackoffDelay(4)).toBe(16000);
    expect(supervisor.getBackoffDelay(5)).toBe(30000);
    expect(supervisor.getBackoffDelay(10)).toBe(30000);
  });

  it('unsets AGENT_FILES_ROOT when files gate is closed (ADR-32)', () => {
    keychainMock.getSecret.mockReturnValue('ag_token');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_01',
      serverUrl: 'http://localhost:8787',
      allowInput: false
    });
    expect(env.AGENT_FILES_ROOT).toBeUndefined();
    expect(env.AGENT_ALLOW_INPUT).toBe('false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/desktop test src/main/__tests__/agent-supervisor.test.ts`
Expected: FAIL ("Cannot find module '../agent-supervisor'")

- [ ] **Step 3: Implement `src/main/agent-supervisor.ts`**

```typescript
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { toWsUrl } from '@ponter/webrtc-core';
import type { KeychainService } from './keychain';

export interface AgentSupervisorOptions {
  spawn?: typeof spawn;
  binaryPath?: string;
  onStatusChange?: (status: string) => void;
}

export interface SupervisorConfig {
  agentId: string;
  serverUrl: string;
  allowInput: boolean;
  filesRoot?: string;
  identityPath?: string;
  stunServer?: string;
}

export class AgentSupervisor {
  private keychain: KeychainService;
  private spawnFn: typeof spawn;
  private binaryPath: string;
  private onStatusChange?: (status: string) => void;
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private restartTimeout: any = null;
  private isIntentionallyStopped = true;
  private currentConfig: SupervisorConfig | null = null;

  constructor(keychain: KeychainService, options?: AgentSupervisorOptions) {
    this.keychain = keychain;
    this.spawnFn = options?.spawn || spawn;
    this.onStatusChange = options?.onStatusChange;
    this.binaryPath = options?.binaryPath || this.resolveBinaryPath();
  }

  private resolveBinaryPath(): string {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'ponter-agent.exe' : 'ponter-agent';

    if (process.env.PONTER_AGENT_PATH && fs.existsSync(process.env.PONTER_AGENT_PATH)) {
      return process.env.PONTER_AGENT_PATH;
    }

    if (process.resourcesPath) {
      const prodPath = path.join(process.resourcesPath, binaryName);
      if (fs.existsSync(prodPath)) return prodPath;
    }

    const devReleasePath = path.resolve(__dirname, '../../../agent/target/release', binaryName);
    if (fs.existsSync(devReleasePath)) return devReleasePath;

    const devDebugPath = path.resolve(__dirname, '../../../agent/target/debug', binaryName);
    if (fs.existsSync(devDebugPath)) return devDebugPath;

    return binaryName;
  }

  buildEnvironment(config: SupervisorConfig): Record<string, string> {
    const credential = this.keychain.getSecret(`device_credential_${config.agentId}`);
    if (!credential) {
      throw new Error(`Missing credential in keychain for agent ${config.agentId}`);
    }

    const wsUrl = `${toWsUrl(config.serverUrl)}/api/ws/agent`;
    const env: Record<string, string> = {
      AGENT_ID: config.agentId,
      AGENT_SERVER: wsUrl,
      AGENT_CREDENTIAL: credential,
      STUN_SERVER: config.stunServer || 'stun:stun.l.google.com:19302',
      AGENT_ALLOW_INPUT: config.allowInput ? 'true' : 'false'
    };

    if (config.filesRoot) {
      env.AGENT_FILES_ROOT = config.filesRoot;
    }
    if (config.identityPath) {
      env.AGENT_IDENTITY_PATH = config.identityPath;
    }

    return env;
  }

  getBackoffDelay(attempt: number): number {
    const delay = Math.pow(2, attempt) * 1000;
    return Math.min(delay, 30000);
  }

  start(config: SupervisorConfig): void {
    this.currentConfig = config;
    this.isIntentionallyStopped = false;
    this.restartCount = 0;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    if (this.child || !this.currentConfig) return;

    try {
      const env = this.buildEnvironment(this.currentConfig);
      this.child = this.spawnFn(this.binaryPath, [], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.onStatusChange?.('connected');

      this.child.on('exit', (code) => {
        this.child = null;
        if (this.isIntentionallyStopped) {
          this.onStatusChange?.('stopped');
          return;
        }

        this.onStatusChange?.('error');
        const delay = this.getBackoffDelay(this.restartCount++);
        this.restartTimeout = setTimeout(() => {
          if (!this.isIntentionallyStopped) {
            this.spawnProcess();
          }
        }, delay);
      });
    } catch {
      this.onStatusChange?.('error');
    }
  }

  stop(): Promise<void> {
    this.isIntentionallyStopped = true;
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (!this.child) {
      this.onStatusChange?.('stopped');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const child = this.child;
      if (!child) return resolve();

      const killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(killTimeout);
        this.child = null;
        this.onStatusChange?.('stopped');
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        resolve();
      }
    });
  }

  getStatus(): string {
    if (this.child) return 'connected';
    if (this.isIntentionallyStopped) return 'stopped';
    return 'error';
  }
}
```

- [ ] **Step 4: Run supervisor tests to verify they pass**

Run: `pnpm --filter @ponter/desktop test src/main/__tests__/agent-supervisor.test.ts`
Expected: PASS (3 tests passing)

- [ ] **Step 5: Commit agent supervisor implementation**

```bash
git add apps/desktop/src/main/agent-supervisor.ts apps/desktop/src/main/__tests__/agent-supervisor.test.ts
git commit -m "feat(desktop): implement agent sidecar supervisor with bounded backoff and exact contract"
```

---

### Task 5: Renderer Porting

**Files:**
- Create: `apps/desktop/src/renderer/style.css`
- Create: `apps/desktop/src/renderer/main.ts`
- Create: `apps/desktop/src/renderer/App.vue`
- Create: `apps/desktop/src/renderer/composables/useTheme.ts`
- Create: `apps/desktop/src/renderer/stores/config.ts`
- Create: `apps/desktop/src/renderer/stores/auth.ts`
- Create: `apps/desktop/src/renderer/stores/devices.ts`
- Create: `apps/desktop/src/renderer/stores/wizard.ts`
- Create: `apps/desktop/src/renderer/views/ServerSetupView.vue`
- Create: `apps/desktop/src/renderer/views/LoginView.vue`
- Create: `apps/desktop/src/renderer/views/WizardView.vue`
- Create: `apps/desktop/src/renderer/views/DevicesView.vue`

**Interfaces:**
- Consumes: `@ponter/ui-components` (`tokens.css`, `useTheme`, `LoginForm`, `ThemeToggle`), `window.ponter`.
- Produces: Visual UI for Ponter Desktop Shell.

- [ ] **Step 1: Create `src/renderer/style.css`**

```css
@import 'tailwindcss';
@import 'tw-animate-css';
@import 'shadcn-vue/tailwind.css';
@import '@ponter/ui-components/styles/tokens.css';

@source "../../../packages/ui-components/src";
@source "../views";
@source "../components";
@source "../App.vue";
```

- [ ] **Step 2: Create `src/renderer/composables/useTheme.ts`**

Configure the shared `@ponter/ui-components` `useTheme` with an IPC storage adapter satisfying the R8 rule:
```typescript
import { useTheme as useSharedTheme, configureThemeStorage, Theme } from '@ponter/ui-components';

let cachedTheme: Theme | null = null;

export function initDesktopTheme(initialTheme?: Theme | null): void {
  cachedTheme = initialTheme || null;

  configureThemeStorage({
    get: () => cachedTheme,
    set: (theme: Theme) => {
      cachedTheme = theme;
      if (typeof window !== 'undefined' && window.ponter?.saveConfig) {
        window.ponter.saveConfig({ theme }).catch(() => {});
      }
    }
  });
}

export function useTheme() {
  return useSharedTheme();
}
```

- [ ] **Step 3: Port Pinia Stores (`stores/config.ts`, `stores/auth.ts`, `stores/devices.ts`, `stores/wizard.ts`)**

In `src/renderer/stores/config.ts`:
Replace Tauri `invoke('get_config')` and `invoke('save_config')` with `window.ponter.getConfig()` and `window.ponter.saveConfig()`.

In `src/renderer/stores/auth.ts`:
Replace Tauri `invoke('login')` and `invoke('logout')` with `window.ponter.login(username, password)` and `window.ponter.logout()`.

In `src/renderer/stores/devices.ts`:
Replace Tauri `invoke('list_devices')`, `invoke('register_device')`, `invoke('delete_device')` with `window.ponter.listDevices()`, `window.ponter.registerDevice()`, `window.ponter.deleteDevice()`. Listen to `window.ponter.onFleetChanged()`.

In `src/renderer/stores/wizard.ts`:
Replace Tauri `invoke('probe_capture')`, `invoke('set_autostart')`, `invoke('is_autostart_enabled')` with `window.ponter.probeCapture()`, `window.ponter.setAutostart()`, `window.ponter.isAutostartEnabled()`.

- [ ] **Step 4: Port Views (`ServerSetupView.vue`, `LoginView.vue`, `WizardView.vue`, `DevicesView.vue`) and `App.vue`**

`App.vue`:
Enforces the ADR-66 startup-flash gate (`config.configLoaded`) and route gate order:
```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';
import { useAuthStore } from '@/stores/auth';
import { useWizardStore } from '@/stores/wizard';
import { initDesktopTheme } from '@/composables/useTheme';
import ServerSetupView from '@/views/ServerSetupView.vue';
import LoginView from '@/views/LoginView.vue';
import WizardView from '@/views/WizardView.vue';
import DevicesView from '@/views/DevicesView.vue';

const config = useConfigStore();
const auth = useAuthStore();
const wizard = useWizardStore();

onMounted(async () => {
  await config.load();
  initDesktopTheme(config.theme);
});
</script>

<template>
  <div v-if="!config.configLoaded" class="flex h-screen w-screen items-center justify-center bg-background text-foreground">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
  </div>
  <main v-else class="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
    <ServerSetupView v-if="!config.hasServerUrl || config.editing" />
    <LoginView v-else-if="!auth.isAuthenticated" />
    <WizardView v-else-if="wizard.inProgress" />
    <DevicesView v-else />
  </main>
</template>
```

- [ ] **Step 5: Verify renderer type checking**

Run: `pnpm --filter @ponter/desktop typecheck:web`
Expected: PASS (0 TypeScript errors in renderer).

- [ ] **Step 6: Commit renderer porting**

```bash
git add apps/desktop/src/renderer/
git commit -m "feat(desktop): port Vue 3 renderer views, Pinia stores, and theme composables to Electron IPC"
```

---

### Task 6: Test Suite Porting & Parity Verification

**Files:**
- Create: `apps/desktop/src/renderer/__tests__/app.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/config.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/login.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/serverSetup.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/wizard.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/theme.test.ts`
- Create: `apps/desktop/src/renderer/__tests__/devices.test.ts`

**Interfaces:**
- Consumes: Vue Test Utils, Vitest, Happy-DOM, mock `window.ponter`.
- Produces: Full test suite execution demonstrating 100% behavioral parity with historical desktop suite.

- [ ] **Step 1: Write `src/renderer/__tests__/app.test.ts`**

Port historical `fc4754b^:apps/desktop/src/__tests__/app.test.ts` replacing Tauri invoke mocks with `window.ponter` mocks:
Tests startup-flash gate, route transitions (`ServerSetup` -> `Login` -> `Wizard` -> `Devices`), and edit mode toggle.

- [ ] **Step 2: Write `src/renderer/__tests__/config.test.ts`**

Port historical `config.test.ts`:
Tests `load()` fail-soft error swallowing, `setServerUrl()`, `setAllowInput()`, `setTheme()`.

- [ ] **Step 3: Write `src/renderer/__tests__/login.test.ts`**

Port historical `login.test.ts`:
Tests credential trimming, empty password rejection, login success profile mapping, error message surfacing, logout cleanup.

- [ ] **Step 4: Write `src/renderer/__tests__/serverSetup.test.ts`**

Port historical `serverSetup.test.ts`:
Tests URL validation, server health probe execution, save config on success, error alert on failed probe.

- [ ] **Step 5: Write `src/renderer/__tests__/wizard.test.ts`**

Port historical `wizard.test.ts`:
Tests 3-step state machine (capture -> inputGate -> autoStart), capture probe requirement, autostart toggle via `window.ponter.setAutostart`.

- [ ] **Step 6: Write `src/renderer/__tests__/theme.test.ts`**

Port historical `theme.test.ts`:
Tests toggle light/dark theme and IPC persistence dispatch via `window.ponter.saveConfig`.

- [ ] **Step 7: Write `src/renderer/__tests__/devices.test.ts`**

Port historical `devices.test.ts`:
Tests device listing, registration with capabilities, deletion, background refresh coalescing, runtime status display, and Issue #107 401 auth-death classification.

- [ ] **Step 8: Run all Vitest suites in `@ponter/desktop`**

Run: `pnpm --filter @ponter/desktop test`
Expected: PASS (All test files green, 0 failures).

- [ ] **Step 9: Commit ported Vitest suite**

```bash
git add apps/desktop/src/renderer/__tests__/
git commit -m "test(desktop): port all 7 desktop test suites to Vitest with window.ponter IPC mocks"
```

---

### Task 7: Electron-builder Packaging, CI Rewrite, and Cleanup

**Files:**
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `apps/desktop/README.md`
- Delete: `apps/desktop/Cargo.toml`
- Delete: `apps/desktop/Cargo.lock`
- Delete: `apps/desktop/src/*.rs`
- Delete: `apps/desktop/src/core/`
- Delete: `apps/desktop/src/theme/`
- Delete: `apps/desktop/src/tray/`
- Delete: `apps/desktop/src/ui/`
- Delete: `apps/desktop/installer.nsi`
- Delete: `apps/desktop/wix/`
- Delete: `apps/desktop/scripts/make-appimage.sh`
- Delete: `apps/desktop/ponter-desktop.desktop`

**Interfaces:**
- Consumes: Built `ponter-agent` binary, electron-builder.
- Produces: Clean CI pipeline on GitHub Actions producing `.deb`, `.rpm`, `.AppImage`, and Windows `.exe`/`.msi`.

- [ ] **Step 1: Rewrite `.github/workflows/build-desktop.yml`**

Update `.github/workflows/build-desktop.yml` to:
1. Matrix: `ubuntu-latest`, `windows-latest`.
2. Setup Node 24 + pnpm (`pnpm/action-setup`).
3. Setup Rust toolchain (`dtolnay/rust-toolchain`).
4. Build Rust agent binary:
   ```bash
   cargo build --release --locked --manifest-path apps/agent/Cargo.toml
   ```
5. Copy agent binary into `apps/desktop/resources/ponter-agent`:
   ```bash
   mkdir -p apps/desktop/resources
   cp apps/agent/target/release/ponter-agent apps/desktop/resources/ponter-agent
   # or on Windows: copy apps/agent/target/release/ponter-agent.exe apps/desktop/resources/ponter-agent.exe
   ```
6. Run tests:
   ```bash
   pnpm --filter @ponter/desktop test
   cargo test --locked --manifest-path apps/agent/Cargo.toml
   ```
7. Build & package with electron-vite & electron-builder:
   ```bash
   pnpm --filter @ponter/desktop build
   pnpm --filter @ponter/desktop package
   ```
8. Remove the old webview guard (`cargo tree | grep webkit`), `cargo deb`, `cargo generate-rpm`, `wix`, and minisign signing steps.

- [ ] **Step 2: Delete legacy `egui` Rust source code and artifacts**

Delete:
- `apps/desktop/Cargo.toml`
- `apps/desktop/Cargo.lock`
- `apps/desktop/src/main.rs`
- `apps/desktop/src/app.rs`
- `apps/desktop/src/autostart.rs`
- `apps/desktop/src/core/`
- `apps/desktop/src/theme/`
- `apps/desktop/src/tray/`
- `apps/desktop/src/ui/`
- `apps/desktop/installer.nsi`
- `apps/desktop/wix/`
- `apps/desktop/scripts/`
- `apps/desktop/ponter-desktop.desktop`

- [ ] **Step 3: Update `apps/desktop/README.md`**

Rewrite `apps/desktop/README.md` to document:
- Architecture: Electron main process supervising `ponter-agent` sidecar, Vue 3 renderer using `@ponter/ui-components`.
- Commands: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm package`.
- Supported platforms: Linux (x86_64) and Windows (x86_64).

- [ ] **Step 4: Run full workspace verification**

Run: `pnpm format:check`
Expected: PASS (all files formatted with Prettier).

Run: `pnpm typecheck`
Expected: PASS (0 TypeScript errors across the workspace).

Run: `pnpm test`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit packaging, CI rewrite, and egui cleanup**

```bash
git add .github/workflows/build-desktop.yml apps/desktop/
git commit -m "feat(desktop): complete Electron migration, rewrite CI workflow, and remove legacy egui shell"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-electron-subproject-b-desktop-shell.md`.
Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** (Recommended) — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, ensuring isolated context per task and rigorous quality gates.
- **Native** — Execute tasks inline within this session.
