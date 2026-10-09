# Phase 1 Week 1: Monorepo Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize pnpm + Turborepo monorepo for the Remote Access Platform, create complete directory structure and package placeholders, define core type contracts in `@ponter/shared`, configure ESLint 10 + Prettier + TypeScript 6, and establish GitHub Actions CI.

**Architecture:** pnpm workspaces monorepo paired with Turborepo 2. Workspace structure divided into 3 groups: `apps/*`, `packages/*`, `workers/*`. In Week 1, only `@ponter/shared` has functional code and passes TypeScript typecheck; other packages are placeholders with no-op scripts. Root toolchain uses ESLint 10 flat config and Prettier code formatting (ignoring `docs/`).

**Tech Stack:** Node 24, pnpm 12.6.0, Turborepo 2.11.3, TypeScript 6.0.3, ESLint 10.11.0, typescript-eslint 8.70.1, Prettier 3.9.9, @types/node 24.13.6.

**Spec:** `docs/superpowers/specs/2026-09-24-phase1-week1-monorepo-design.md`

## Global Constraints

- Root `package.json` must specify `"type": "module"` so `eslint.config.js` does not trigger runtime warnings.
- `packageManager` at root must be `pnpm@12.6.0` to align Turborepo and pnpm.
- `engines` at root must be `node: ">=24"`, `pnpm: ">=12"`.
- TypeScript version `6.0.3` (not 7.x because typescript-eslint 8.70.1 only supports `<6.1.0`).
- Base tsconfig uses `module: "esnext"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`.
- Prettier ignores all of `docs/` to avoid modifying `docs/ARCHITECTURE.md` and documentation markdown files.
- `.gitignore` must ignore `.remember/` and `.claude/settings.local.json`.
- All new TypeScript files must adhere to `strict`, avoid `any`, and import/export types using `export type` or `import type`.
- Do not create feature files (Workers, D1, Vue, Rust agent, Vitest, deploy scripts) within Week 1 scope.

## Review Focus

1. **Extraneous or missing packages in workspace:** If a directory in `apps/`, `packages/`, `workers/` lacks `package.json`, pnpm or Turborepo may omit it or error on globs. *Test in Task 2 verifies all 12 `package.json` files exist.*
2. **ESLint misses or over-scans files:** If flat config specifies incorrect glob `files`, linting could falsely exit 0 (scanning nothing) or mistakenly scan non-TS configs. *Test in Task 4 verifies ESLint actively catches rule violations.*
3. **Type imports in `@ponter/shared` lack extensions or break bundlers:** When type files import one another, `verbatimModuleSyntax` requires `import type`. *Test in Task 3 uses TypeScript compiler to verify zero syntax errors.*
4. **Prettier fails on markdown or lockfile:** If `.prettierignore` omits folders, `pnpm format:check` will fail on `pnpm-lock.yaml`, `.turbo/`, or `docs/ARCHITECTURE.md`. *Test in Task 4 verifies Prettier passes across the entire repository.*
5. **GitHub Actions CI mismatches local configuration:** If CI uses a different Node or pnpm version, `--frozen-lockfile` may fail. *Test in Task 5 confirms CI workflow uses Node 24 and pnpm 12.6.0.*

---

### Task 1: Root Workspace & Toolchain Config

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

**Interfaces:**
- Produces: Root pnpm workspace defining 3 globs `apps/*`, `packages/*`, `workers/*`.
- Produces: Base TypeScript configuration inherited by all packages.
- Produces: Base Turborepo tasks for `lint` and `typecheck`.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
dist/
build/
target/
.turbo/

# Environment files
.env
.env.local
.env.*.local
*.env

# Logs
logs/
*.log
npm-debug.log*
pnpm-debug.log*
yarn-debug.log*

# OS files
.DS_Store
Thumbs.db

# Editor & local tooling
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
.idea/
*.swp
*.swo

# Local agent & memory artifacts
.remember/
.claude/settings.local.json
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'workers/*'
```

- [ ] **Step 3: Create root `package.json`**

```json
{
  "name": "ponter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.6.0",
  "engines": {
    "node": ">=24",
    "pnpm": ">=12"
  },
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "format:check": "prettier --check .",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "eslint": "10.11.0",
    "prettier": "3.9.9",
    "turbo": "2.11.3",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.1"
  }
}
```

- [ ] **Step 4: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "lint": {},
    "typecheck": {
      "dependsOn": ["^typecheck"]
    }
  }
}
```

- [ ] **Step 5: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- [ ] **Step 6: Create `.prettierrc.json` and `.prettierignore`**

`.prettierrc.json`:
```json
{
  "singleQuote": true
}
```

`.prettierignore`:
```ignore
node_modules
dist
build
target
.turbo
pnpm-lock.yaml
docs
.remember
.claude
```

- [ ] **Step 7: Install dependencies at root**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` generated, exit 0, all 6 devDependencies installed.

- [ ] **Step 8: Verify `.gitignore` rules for `.remember` and `.claude/settings.local.json`**

Run: `git status --short`
Expected: `.remember` and `.claude/settings.local.json` DO NOT appear in untracked files list. Only newly created configuration files appear.

---

### Task 2: Project Folders & Workspace Placeholders

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/desktop/package.json`
- Create: `apps/mobile/package.json`
- Create: `apps/agent/package.json`
- Create: `packages/api-client/package.json`
- Create: `packages/webrtc-core/package.json`
- Create: `packages/terminal-core/package.json`
- Create: `packages/ui-components/package.json`
- Create: `packages/crypto/package.json`
- Create: `workers/signaling/package.json`
- Create: `workers/api/package.json`
- Create: `scripts/.gitkeep`
- Create: `tests/e2e/.gitkeep`
- Create: `tests/unit/.gitkeep`
- Create: `tests/integration/.gitkeep`
- Create: `docs/guides/.gitkeep`
- Create: `docs/architecture/.gitkeep`

**Interfaces:**
- Produces: 11 placeholder packages declaring exact `name` namespace `@ponter/*`, `private: true`, `version: 0.1.0`.
- Produces: Every placeholder package includes scripts `"lint": "echo ok"` and `"typecheck": "echo ok"` for smooth Turborepo execution.

- [ ] **Step 1: Create non-package directories with `.gitkeep`**

```bash
mkdir -p scripts tests/e2e tests/unit tests/integration docs/guides docs/architecture
touch scripts/.gitkeep tests/e2e/.gitkeep tests/unit/.gitkeep tests/integration/.gitkeep docs/guides/.gitkeep docs/architecture/.gitkeep
```

- [ ] **Step 2: Create placeholder `package.json` for `apps/` group**

`apps/web/package.json`:
```json
{
  "name": "@ponter/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`apps/desktop/package.json`:
```json
{
  "name": "@ponter/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`apps/mobile/package.json`:
```json
{
  "name": "@ponter/mobile",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`apps/agent/package.json`:
```json
{
  "name": "@ponter/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 3: Create placeholder `package.json` for `packages/` group (excluding shared)**

`packages/api-client/package.json`:
```json
{
  "name": "@ponter/api-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`packages/webrtc-core/package.json`:
```json
{
  "name": "@ponter/webrtc-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`packages/terminal-core/package.json`:
```json
{
  "name": "@ponter/terminal-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`packages/ui-components/package.json`:
```json
{
  "name": "@ponter/ui-components",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`packages/crypto/package.json`:
```json
{
  "name": "@ponter/crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 4: Create placeholder `package.json` for `workers/` group**

`workers/signaling/package.json`:
```json
{
  "name": "@ponter/signaling",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

`workers/api/package.json`:
```json
{
  "name": "@ponter/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 5: Regenerate lockfile to record importers for 11 new packages**

Note: `pnpm install` often prints "Already up to date" and DOES NOT record importer entries for
packages without dependencies. Therefore, regenerate from scratch:

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

Expected: New `pnpm-lock.yaml` contains 11 importer entries like `apps/agent: {}`,
`packages/api-client: {}`, `workers/api: {}`... Verify via:

```bash
grep -cE "^  (apps|packages|workers)/" pnpm-lock.yaml
```

Expected result: `11`. If `0`, lockfile was not written correctly and
`pnpm install --frozen-lockfile` will fail with `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`.

- [ ] **Step 6: Verify Turborepo detects all 11 packages**

Run: `npx turbo run lint --dry=json`
Expected: Output JSON contains list of 11 newly created packages in `packages` field.

---

### Task 3: `@ponter/shared` Core Types Package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types/user.ts`
- Create: `packages/shared/src/types/session.ts`
- Create: `packages/shared/src/types/webrtc.ts`
- Create: `packages/shared/src/types/terminal.ts`
- Create: `packages/shared/src/types/files.ts`
- Create: `packages/shared/src/types/auth.ts`
- Create: `packages/shared/src/types/signaling.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: Package `@ponter/shared` exports full core interfaces and types:
  - `User`, `Device`, `Agent`, `DeviceType`
  - `Session`, `SessionStatus`
  - `IceServerConfig`, `WebRTCChannelType`, `DataChannelMessage`
  - `TerminalSession`, `TerminalSize`, `TerminalDataMessage`, `TerminalResizeMessage`
  - `RemoteFile`, `FileTransfer`, `TransferDirection`, `FileTransferStatus`, `FileChunkMessage`
  - `LoginRequest`, `LoginResponse`, `RegisterRequest`, `AuthTokens`
  - `SignalOffer`, `SignalAnswer`, `IceCandidateSignal`, `SignalMessage`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@ponter/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/shared/src/types/user.ts`**

```typescript
export type DeviceType = 'desktop' | 'mobile' | 'web';

export interface User {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface Device {
  id: string;
  userId: string;
  deviceName: string | null;
  deviceType: DeviceType;
  fingerprint: string;
  platform: string | null;
  browser: string | null;
  ipAddress: string | null;
  approvedAt: string | null;
  lastSeenAt: string | null;
  isTrusted: boolean;
  createdAt: string;
}

export interface Agent {
  id: string;
  userId: string;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  publicKey: string;
  isOnline: boolean;
  lastHeartbeat: string | null;
  capabilities: string[];
  createdAt: string;
}
```

- [ ] **Step 4: Create `packages/shared/src/types/session.ts`**

```typescript
export type SessionStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'active'
  | 'terminated'
  | 'expired';

export interface Session {
  id: string;
  userId: string;
  deviceId: string | null;
  agentId: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 5: Create `packages/shared/src/types/webrtc.ts`**

```typescript
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type WebRTCChannelType = 'terminal' | 'desktop' | 'files' | 'control';

export interface DataChannelMessage<T = unknown> {
  type: string;
  channel: WebRTCChannelType;
  payload: T;
  timestamp: number;
}
```

- [ ] **Step 6: Create `packages/shared/src/types/terminal.ts`**

```typescript
export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  sessionId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  createdAt: string;
}

export interface TerminalDataMessage {
  terminalId: string;
  data: string;
}

export interface TerminalResizeMessage {
  terminalId: string;
  cols: number;
  rows: number;
}
```

- [ ] **Step 7: Create `packages/shared/src/types/files.ts`**

```typescript
export type TransferDirection = 'upload' | 'download';

export type FileTransferStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
  mode?: number;
}

export interface FileTransfer {
  id: string;
  sessionId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  fileHash: string | null;
  direction: TransferDirection;
  status: FileTransferStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface FileChunkMessage {
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // base64 encoded
}
```

- [ ] **Step 8: Create `packages/shared/src/types/auth.ts`**

```typescript
import type { User } from './user';

export interface LoginRequest {
  username: string;
  password?: string;
}

export interface AuthTokens {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  user: User;
  expiresIn: number;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  publicKey: string;
}
```

- [ ] **Step 9: Create `packages/shared/src/types/signaling.ts`**

```typescript
export interface SignalOffer {
  sessionId: string;
  sdp: string;
  capabilities: string[];
}

export interface SignalAnswer {
  sessionId: string;
  sdp: string;
  approved: boolean;
}

export interface IceCandidateSignal {
  sessionId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalMessage =
  | { type: 'offer'; data: SignalOffer }
  | { type: 'answer'; data: SignalAnswer }
  | { type: 'ice-candidate'; data: IceCandidateSignal };
```

- [ ] **Step 10: Create `packages/shared/src/types/index.ts`**

```typescript
export type {
  DeviceType,
  User,
  Device,
  Agent,
} from './user';

export type {
  SessionStatus,
  Session,
} from './session';

export type {
  IceServerConfig,
  WebRTCChannelType,
  DataChannelMessage,
} from './webrtc';

export type {
  TerminalSize,
  TerminalSession,
  TerminalDataMessage,
  TerminalResizeMessage,
} from './terminal';

export type {
  TransferDirection,
  FileTransferStatus,
  RemoteFile,
  FileTransfer,
  FileChunkMessage,
} from './files';

export type {
  LoginRequest,
  AuthTokens,
  LoginResponse,
  RegisterRequest,
} from './auth';

export type {
  SignalOffer,
  SignalAnswer,
  IceCandidateSignal,
  SignalMessage,
} from './signaling';
```

- [ ] **Step 11: Create `packages/shared/src/index.ts`**

```typescript
export * from './types/index';
```

- [ ] **Step 12: Update workspace and run typecheck for `@ponter/shared`**

Run: `rm -rf node_modules pnpm-lock.yaml && pnpm install && npx tsc -p packages/shared --noEmit`
Expected: exit 0, zero typecheck errors. New lockfile contains 12 importer entries
(`grep -cE "^  (apps|packages|workers)/" pnpm-lock.yaml` → `12`).

---

### Task 4: Lint, Format, and Typecheck Verification

**Files:**
- Create: `eslint.config.js`
- Modify: `.prettierignore` (if adjustments needed)

**Interfaces:**
- Produces: ESLint 10 flat config validating TypeScript files across `packages/**`, `apps/**`, `workers/**`.
- Produces: `pnpm lint`, `pnpm typecheck`, `pnpm format:check` all executable from root via Turborepo and Prettier.

- [ ] **Step 1: Create `eslint.config.js` at root**

```javascript
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/target/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'workers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  }
);
```

- [ ] **Step 2: Write a verification test proving ESLint catches violations**

Create temporary violation file:
```bash
node -e "fs.writeFileSync('packages/shared/src/test-violation.ts', 'export const bad: any = 1;\n')"
```
Run: `npx eslint packages/shared/src/test-violation.ts`
Expected: FAIL with `@typescript-eslint/no-explicit-any` error. Exit code != 0.

Remove temporary file:
```bash
rm packages/shared/src/test-violation.ts
```

- [ ] **Step 3: Run Prettier formatting on created configuration and code files**

Run: `pnpm format`
Expected: Format all `.ts`, `.json`, `.yaml`, `.js` files. Does not touch `docs/ARCHITECTURE.md`.

- [ ] **Step 4: Verify `pnpm format:check`**

Run: `pnpm format:check`
Expected: "All matched files use Prettier code style!", exit 0.

- [ ] **Step 5: Verify `pnpm lint` via Turborepo**

Run: `pnpm lint`
Expected: Turbo runs `lint` task for `@ponter/shared` and placeholder packages, exit 0, zero warnings or errors.

- [ ] **Step 6: Verify `pnpm typecheck` via Turborepo**

Run: `pnpm typecheck`
Expected: Turbo runs `typecheck` task across entire workspace, exit 0.

---

### Task 5: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI pipeline automatically running `lint`, `typecheck`, and `format:check` on GitHub upon push/PR to `main` and `develop`.

- [ ] **Step 1: Create `.github/workflows` directory if missing**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  verify:
    name: Lint, Typecheck & Format
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 12.6.0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Check code formatting
        run: pnpm format:check

      - name: Lint workspace
        run: pnpm lint

      - name: Typecheck workspace
        run: pnpm typecheck
```

- [ ] **Step 3: Run full local test suite in exact CI order**

Run:
```bash
pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck
```
Expected: All 4 commands complete with exit code 0.

- [ ] **Step 4: Inspect git status before handover**

Run: `git status`
Expected:
- No unwanted files in untracked (no `.remember/`, no `.claude/settings.local.json`, no temporary folders).
- Only planned files present: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.prettierrc.json`, `.prettierignore`, `.github/workflows/ci.yml`, `docs/superpowers/**`, placeholder packages, and `packages/shared/**`.
