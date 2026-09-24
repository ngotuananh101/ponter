# Phase 1 Tuần 1: Monorepo Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khởi tạo monorepo pnpm + Turborepo cho Remote Access Platform, tạo cấu trúc toàn bộ thư mục và package placeholder, định nghĩa type contracts cốt lõi trong `@remote/shared`, cấu hình ESLint 10 + Prettier + TypeScript 6, và thiết lập GitHub Actions CI.

**Architecture:** Monorepo pnpm workspaces kết hợp Turborepo 2. Cấu trúc chia làm 3 nhóm workspace: `apps/*`, `packages/*`, `workers/*`. Tuần 1 chỉ `@remote/shared` có code thật và typecheck qua TypeScript; các package khác là placeholder với script no-op. Toolchain ở root dùng ESLint 10 flat config và Prettier quét code (loại trừ `docs/`).

**Tech Stack:** Node 24, pnpm 12.6.0, Turborepo 2.11.3, TypeScript 6.0.3, ESLint 10.11.0, typescript-eslint 8.70.1, Prettier 3.9.9, @types/node 24.13.6.

**Spec:** `docs/superpowers/specs/2026-09-24-phase1-week1-monorepo-design.md`

## Global Constraints

- Root `package.json` bắt buộc có `"type": "module"` để `eslint.config.js` không gây cảnh báo runtime.
- `packageManager` ở root bắt buộc là `pnpm@12.6.0` để Turborepo và pnpm đồng nhất.
- `engines` ở root bắt buộc là `node: ">=24"`, `pnpm: ">=12"`.
- TypeScript dùng bản `6.0.3` (không dùng 7.x vì typescript-eslint 8.70.1 chỉ nhận `<6.1.0`).
- Base tsconfig dùng `module: "esnext"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `noUncheckedIndexedAccess: true`.
- Prettier ignore toàn bộ `docs/` để không làm thay đổi `docs/ARCHITECTURE.md` và các file markdown tài liệu.
- `.gitignore` phải bỏ qua `.remember/` và `.claude/settings.local.json`.
- Mọi file TypeScript mới phải tuân thủ `strict`, không dùng `any`, import type dùng `export type` hoặc `import type`.
- Không tạo các file tính năng (Workers, D1, Vue, agent Rust, Vitest, deploy scripts) trong phạm vi tuần 1.

## Review Focus

1. **Thừa hoặc thiếu package trong workspace:** Nếu một thư mục trong `apps/`, `packages/`, `workers/` thiếu `package.json`, pnpm hoặc Turborepo có thể bỏ qua hoặc báo lỗi khi chạy glob. *Test ở Task 2 kiểm tra đủ 12 `package.json`.*
2. **ESLint không quét hoặc quét quá đà:** Nếu flat config định nghĩa sai glob `files`, lint có thể exit 0 giả (không quét file nào) hoặc quét nhầm file config không phải TS. *Test ở Task 4 kiểm tra ESLint thực sự bắt lỗi vi phạm quy tắc.*
3. **Import giữa các file type trong `@remote/shared` thiếu đuôi hoặc hỏng với bundler:** Khi các file type import lẫn nhau, cấu hình `verbatimModuleSyntax` bắt buộc phải dùng `import type`. *Test ở Task 3 dùng TypeScript compiler kiểm tra không lỗi cú pháp.*
4. **Prettier fail trên file markdown hoặc lockfile:** Nếu `.prettierignore` thiếu thư mục, `pnpm format:check` sẽ fail trên `pnpm-lock.yaml`, `.turbo/`, hoặc `docs/ARCHITECTURE.md`. *Test ở Task 4 kiểm tra Prettier pass trên toàn bộ repo.*
5. **CI trên GitHub Actions không khớp cấu hình local:** Nếu CI dùng version Node hoặc pnpm khác, `--frozen-lockfile` có thể thất bại. *Test ở Task 5 xác nhận CI workflow dùng Node 24 và pnpm 12.6.0.*

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
- Produces: Root pnpm workspace định nghĩa 3 glob `apps/*`, `packages/*`, `workers/*`.
- Produces: Base TypeScript configuration được kế thừa bởi mọi package.
- Produces: Base Turborepo tasks cho `lint` và `typecheck`.

- [ ] **Step 1: Tạo `.gitignore`**

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

- [ ] **Step 2: Tạo `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'workers/*'
```

- [ ] **Step 3: Tạo root `package.json`**

```json
{
  "name": "remote-access-platform",
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

- [ ] **Step 4: Tạo `turbo.json`**

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

- [ ] **Step 5: Tạo `tsconfig.base.json`**

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

- [ ] **Step 6: Tạo `.prettierrc.json` và `.prettierignore`**

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

- [ ] **Step 7: Cài đặt dependencies ở root**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` được tạo ra, exit 0, cài đủ 6 devDependencies.

- [ ] **Step 8: Kiểm tra `.gitignore` hoạt động với `.remember` và `.claude/settings.local.json`**

Run: `git status --short`
Expected: `.remember` và `.claude/settings.local.json` KHÔNG xuất hiện trong danh sách untracked files. Chỉ thấy các file cấu hình vừa tạo.

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
- Produces: 11 package placeholder khai báo đúng `name` namespace `@remote/*`, `private: true`, `version: 0.1.0`.
- Produces: Mọi package placeholder có scripts `"lint": "echo ok"` và `"typecheck": "echo ok"` để Turborepo chạy thông suốt.

- [ ] **Step 1: Tạo các thư mục không phải package kèm `.gitkeep`**

```bash
mkdir -p scripts tests/e2e tests/unit tests/integration docs/guides docs/architecture
touch scripts/.gitkeep tests/e2e/.gitkeep tests/unit/.gitkeep tests/integration/.gitkeep docs/guides/.gitkeep docs/architecture/.gitkeep
```

- [ ] **Step 2: Tạo placeholder `package.json` cho nhóm `apps/`**

`apps/web/package.json`:
```json
{
  "name": "@remote/web",
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
  "name": "@remote/desktop",
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
  "name": "@remote/mobile",
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
  "name": "@remote/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 3: Tạo placeholder `package.json` cho nhóm `packages/` (trừ shared)**

`packages/api-client/package.json`:
```json
{
  "name": "@remote/api-client",
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
  "name": "@remote/webrtc-core",
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
  "name": "@remote/terminal-core",
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
  "name": "@remote/ui-components",
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
  "name": "@remote/crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 4: Tạo placeholder `package.json` cho nhóm `workers/`**

`workers/signaling/package.json`:
```json
{
  "name": "@remote/signaling",
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
  "name": "@remote/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "echo ok",
    "typecheck": "echo ok"
  }
}
```

- [ ] **Step 5: Tái tạo lockfile để ghi importer cho 11 package mới**

Lưu ý: `pnpm install` thường in "Already up to date" và KHÔNG ghi importer entry cho
package không có dependency. Vì vậy phải tái tạo từ đầu:

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

Expected: `pnpm-lock.yaml` mới có 11 dòng importer dạng `apps/agent: {}`,
`packages/api-client: {}`, `workers/api: {}`... Kiểm tra bằng:

```bash
grep -cE "^  (apps|packages|workers)/" pnpm-lock.yaml
```

Kết quả mong đợi: `11`. Nếu là `0`, lockfile chưa được ghi đúng và
`pnpm install --frozen-lockfile` sẽ fail với `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`.

- [ ] **Step 6: Kiểm tra Turborepo nhận diện đủ 11 package**

Run: `npx turbo run lint --dry=json`
Expected: Output JSON chứa danh sách 11 package vừa tạo trong trường `packages`.

---

### Task 3: `@remote/shared` Core Types Package

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
- Produces: Package `@remote/shared` export đầy đủ các interfaces và types cốt lõi:
  - `User`, `Device`, `Agent`, `DeviceType`
  - `Session`, `SessionStatus`
  - `IceServerConfig`, `WebRTCChannelType`, `DataChannelMessage`
  - `TerminalSession`, `TerminalSize`, `TerminalDataMessage`, `TerminalResizeMessage`
  - `RemoteFile`, `FileTransfer`, `TransferDirection`, `FileTransferStatus`, `FileChunkMessage`
  - `LoginRequest`, `LoginResponse`, `RegisterRequest`, `AuthTokens`
  - `SignalOffer`, `SignalAnswer`, `IceCandidateSignal`, `SignalMessage`

- [ ] **Step 1: Tạo `packages/shared/package.json`**

```json
{
  "name": "@remote/shared",
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

- [ ] **Step 2: Tạo `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Tạo `packages/shared/src/types/user.ts`**

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

- [ ] **Step 4: Tạo `packages/shared/src/types/session.ts`**

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

- [ ] **Step 5: Tạo `packages/shared/src/types/webrtc.ts`**

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

- [ ] **Step 6: Tạo `packages/shared/src/types/terminal.ts`**

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

- [ ] **Step 7: Tạo `packages/shared/src/types/files.ts`**

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

- [ ] **Step 8: Tạo `packages/shared/src/types/auth.ts`**

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

- [ ] **Step 9: Tạo `packages/shared/src/types/signaling.ts`**

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

- [ ] **Step 10: Tạo `packages/shared/src/types/index.ts`**

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

- [ ] **Step 11: Tạo `packages/shared/src/index.ts`**

```typescript
export * from './types/index';
```

- [ ] **Step 12: Cập nhật workspace và chạy typecheck cho `@remote/shared`**

Run: `rm -rf node_modules pnpm-lock.yaml && pnpm install && npx tsc -p packages/shared --noEmit`
Expected: exit 0, không có lỗi typecheck nào. Lockfile mới có 12 dòng importer
(`grep -cE "^  (apps|packages|workers)/" pnpm-lock.yaml` → `12`).

---

### Task 4: Lint, Format, and Typecheck Verification

**Files:**
- Create: `eslint.config.js`
- Modify: `.prettierignore` (nếu cần điều chỉnh)

**Interfaces:**
- Produces: ESLint 10 flat config kiểm tra các file TypeScript trong `packages/**`, `apps/**`, `workers/**`.
- Produces: `pnpm lint`, `pnpm typecheck`, `pnpm format:check` đều chạy được từ root qua Turborepo và Prettier.

- [ ] **Step 1: Tạo `eslint.config.js` ở root**

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

- [ ] **Step 2: Viết một test kiểm chứng ESLint thực sự bắt lỗi**

Tạo tạm file vi phạm:
```bash
node -e "fs.writeFileSync('packages/shared/src/test-violation.ts', 'export const bad: any = 1;\n')"
```
Chạy: `npx eslint packages/shared/src/test-violation.ts`
Expected: FAIL với lỗi `@typescript-eslint/no-explicit-any`. Exit code != 0.

Xóa file tạm:
```bash
rm packages/shared/src/test-violation.ts
```

- [ ] **Step 3: Chạy Prettier format trên các file cấu hình và code đã tạo**

Run: `pnpm format`
Expected: Định dạng toàn bộ file `.ts`, `.json`, `.yaml`, `.js`. Không đụng vào `docs/ARCHITECTURE.md`.

- [ ] **Step 4: Kiểm tra `pnpm format:check`**

Run: `pnpm format:check`
Expected: "All matched files use Prettier code style!", exit 0.

- [ ] **Step 5: Kiểm tra `pnpm lint` qua Turborepo**

Run: `pnpm lint`
Expected: Turbo chạy task `lint` cho `@remote/shared` và các placeholder packages, exit 0, không có warning hoặc error.

- [ ] **Step 6: Kiểm tra `pnpm typecheck` qua Turborepo**

Run: `pnpm typecheck`
Expected: Turbo chạy task `typecheck` cho toàn bộ workspace, exit 0.

---

### Task 5: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI pipeline tự động chạy `lint`, `typecheck`, và `format:check` trên GitHub khi có push/PR vào `main` và `develop`.

- [ ] **Step 1: Tạo thư mục `.github/workflows` nếu chưa có**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Tạo `.github/workflows/ci.yml`**

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

- [ ] **Step 3: Chạy toàn bộ bộ kiểm tra local theo đúng thứ tự của CI**

Run:
```bash
pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck
```
Expected: Cả 4 lệnh hoàn thành với exit code 0.

- [ ] **Step 4: Kiểm tra trạng thái git trước khi bàn giao**

Run: `git status`
Expected:
- Không có file rác trong untracked (không có `.remember/`, không có `.claude/settings.local.json`, không có thư mục tạm).
- Chỉ có các file thuộc kế hoạch: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.prettierrc.json`, `.prettierignore`, `.github/workflows/ci.yml`, `docs/superpowers/**`, các package placeholder và `packages/shared/**`.
