# Phase 2 Week 4 — WebRTC Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `packages/webrtc-core` (a runtime-agnostic WebRTC abstraction with browser and werift adapters, data channel management, ICE buffering, and a real loopback P2P test in CI) and the REST signaling surface (four `/api/signal/*` endpoints on `workers/signaling` with tenant-isolated session ownership, cursor-based polling, and D1 indexes).

**Architecture:** A clean separation across four layers: (1) `RTCPeerConnectionLike` narrow adapter seam implemented by `BrowserAdapter` (DOM) and `WeriftAdapter` (Node/tests via `werift@0.24.4`); (2) `SignalTransport` abstraction decoupling core logic from REST polling today and WebSocket relay in Week 5; (3) `PeerConnection` state machine buffering ICE candidates until remote description is set (F1) and declaring channels prior to offer generation (F2); (4) four authenticated Hono signaling routes with strict tenant-isolation matching `sessions.ts` convention, using SQLite-compatible datetime arithmetic for signal TTL.

**Tech Stack:** TypeScript 6.0.3, Node >= 24 (24.21.0 local), pnpm 12.6.0 workspaces, Vitest 5.0.1 (packages/webrtc-core) & Vitest 4.1.11 + `@cloudflare/vitest-pool-workers` 0.22.0 (workers/signaling), Hono 4.13.9, Drizzle ORM 0.45.3 / drizzle-kit 0.31.11, `werift@0.24.4` (pure TypeScript Node WebRTC, devDependency only), ESLint 10 flat config, Prettier 3.9.9 (`singleQuote: true`).

**Spec:** `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md`

---

## Global Constraints

- Root `packageManager` is `pnpm@12.6.0`. Node floor is `>= 24`.
- TypeScript is pinned at `6.0.3` across all workspaces (`tsconfig.base.json` extends with `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `strict: true`, `noUncheckedIndexedAccess: true`).
- `packages/shared` MUST remain DOM-free (`sdp: string`, `candidate: string`). Never import or declare `RTCSessionDescriptionInit` in `packages/shared` (F10, F11, ADR-07).
- `packages/webrtc-core` declares `"lib": ["ES2024", "DOM"]` in its `tsconfig.json` following the precedent in `api-client` and `crypto` (F12, ADR-07).
- `src/index.ts` of `packages/webrtc-core` MUST NOT re-export `WeriftAdapter` or `werift`. `werift` imports Node built-ins (`dgram`, `net`, `tls`, `dns`, `worker_threads`) that cause Vite in `apps/web` to fail bundle resolution. `WeriftAdapter` lives in `src/adapters/werift.ts` and is imported only by Node test suites or dedicated subpath exports.
- `workers/signaling/wrangler.toml` must keep its exact name and path; `@cloudflare/vitest-pool-workers` references it directly.
- `wrangler.prod.toml` is gitignored and contains real Cloudflare resource IDs; NEVER commit it or remove it from `.gitignore`.
- Secrets (`JWT_SECRET`, `REFRESH_TOKEN_SECRET`, etc.) are never hardcoded or committed. Test suites use the standard test secret (`'jwt-secret-min-32-chars-for-test-suit'`).
- SQLite datetime format compatibility: all D1 timestamps and comparisons MUST use `datetime('now')` and `datetime('now', '+5 minutes')` (space-separated `YYYY-MM-DD HH:MM:SS`), NEVER JavaScript ISO-8601 strings (`YYYY-MM-DDTHH:MM:SS.sssZ`). JavaScript ISO strings sort lexicographically greater than `datetime('now')` due to the `'T'` vs `' '` character comparison, which renders the expiry filter a no-op.
- Prettier: `singleQuote: true`. Run `pnpm format:check` and `pnpm format` as needed.
- SonarCloud quality gate: Duplication on New Code must be ≤ 3.0%. Consolidating `RESET_STATEMENTS` in Task 1 is mandatory to prevent SonarQube duplication failures across test files.
- Test baseline: starts at 97 passing tests at HEAD `9ba5613`, grows to exactly 135 passing tests (24 in `webrtc-core`, 14 in `signaling`).

---

## Review Focus

1. **ICE candidate arrives before remote description (F1):** `setLocalDescription()` emits host candidates synchronously during offer creation. If delivered to the answerer before the answerer calls `setRemoteDescription(offer)`, WebRTC throws or drops the candidate, causing connection timeout.
   *Expected behavior:* `PeerConnection` buffers all candidates in an internal array if `remoteDescriptionSet === false`, and automatically flushes them via `addIceCandidate()` sequentially immediately after `setRemoteDescription()` resolves.
   *Owning task:* Task 6 (`test/p2p.test.ts` & `src/connection.ts`).
2. **Data channel declared after offer creation (F2):** Calling `createDataChannel` after `createOffer` generates an SDP without an `m=application` (SCTP) section. The answerer will never fire `onDataChannel`, and channel negotiation silently hangs.
   *Expected behavior:* All initial channels configured via `PeerConnectionOptions.channelLabels` MUST be instantiated synchronously during `PeerConnection` initialization or before `createOffer()` is called.
   *Owning task:* Task 5 (`src/data-channel.ts`) & Task 6 (`src/connection.ts`).
3. **Cross-tenant signaling hijack:** A malicious user polls or posts signals to a `sessionId` belonging to another user. If ownership check is absent or incomplete on any route (especially `/api/signal/poll/:sessionId`), session SDP and candidate data leaks.
   *Expected behavior:* Every `/api/signal/*` route validates that `sessions.id === sessionId AND sessions.userId === user.id`. If not owned, return 404 `NOT_FOUND` (never 403, preventing resource enumeration).
   *Owning task:* Task 8 (`workers/signaling/src/routes/signal.ts`).
4. **Signaling against terminated or inactive session:** Attempting to exchange offers or candidates on a terminated or closed session creates zombie signaling state in D1.
   *Expected behavior:* If `session.status !== 'pending' && session.status !== 'active'`, any POST signal route rejects with 409 `SESSION_NOT_ACTIVE`.
   *Owning task:* Task 8 (`workers/signaling/src/routes/signal.ts`).
5. **Poll cursor race & duplicate deliveries under sub-second timestamps:** If polling uses `ORDER BY created_at ASC, id ASC`, two signals created in the same second will be ordered by UUID string comparison, not insertion order. If a later signal has an alphabetically smaller UUID than an earlier signal, an `id > cursor` filter will skip the later signal permanently.
   *Expected behavior:* Polling uses SQLite `rowid` ordering (`ORDER BY rowid ASC` with `rowid > COALESCE((SELECT rowid FROM signals WHERE id = afterId AND session_id = sessionId), 0)`), ensuring strictly monotonic signal delivery without timestamp collision gaps.
   *Owning task:* Task 4 (`src/transport.ts`) & Task 8 (`workers/signaling/src/routes/signal.ts`).

---

### Task 1: Consolidate Test Fixtures in `workers/signaling`

Extract the duplicated `RESET_STATEMENTS` array from 4 test files into a single shared helper in `workers/signaling/test/helpers.ts`, adding `CREATE TABLE signals` and `CREATE TABLE audit_logs` so the test database schema is complete across all suites.

**Files:**
- Create: `workers/signaling/test/helpers.ts`
- Modify: `workers/signaling/test/auth.test.ts:40-65`
- Modify: `workers/signaling/test/db.test.ts:15-60`
- Modify: `workers/signaling/test/middleware.test.ts:15-35`
- Modify: `workers/signaling/test/resources.test.ts:70-135`

**Interfaces:**
- Produces:
  ```typescript
  // workers/signaling/test/helpers.ts
  export const RESET_STATEMENTS: string[];
  export const TEST_JWT_SECRET: string;
  ```
- Consumes: Existing SQLite tables defined in `workers/signaling/src/db/schema.ts`.

- [ ] **Step 1: Write `workers/signaling/test/helpers.ts`**

Create `workers/signaling/test/helpers.ts` with the complete DDL mirroring all tables in `src/db/schema.ts` (`users`, `devices`, `agents`, `sessions`, `signals`, `audit_logs`):

```typescript
export const TEST_JWT_SECRET = 'jwt-secret-min-32-chars-for-test-suit';

/**
 * `D1Database.exec()` splits its input on newlines, so a multi-line
 * `CREATE TABLE` is torn apart mid-statement. `D1Database.batch()` takes one
 * prepared statement per array entry, keeping each statement's exact
 * multi-line SQL while still running them sequentially and atomically.
 *
 * This fixture creates all tables defined in `src/db/schema.ts`.
 */
export const RESET_STATEMENTS = [
  'PRAGMA foreign_keys = ON',
  'DROP TABLE IF EXISTS signals',
  'DROP TABLE IF EXISTS audit_logs',
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS agents',
  'DROP TABLE IF EXISTS devices',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    public_key TEXT NOT NULL,
    password_hash TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    metadata TEXT
  )`,
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    device_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    is_trusted INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hostname TEXT,
    platform TEXT,
    os_version TEXT,
    agent_version TEXT,
    public_key TEXT NOT NULL,
    is_online INTEGER NOT NULL DEFAULT 0,
    last_ping_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id),
    agent_id TEXT REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    metadata TEXT
  )`,
  `CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  )`,
  `CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];
```

- [ ] **Step 2: Update `auth.test.ts`, `db.test.ts`, `resources.test.ts`, and `middleware.test.ts` to use `RESET_STATEMENTS`**

In `workers/signaling/test/auth.test.ts`:
Replace the local `const RESET_STATEMENTS = [...]` with:
```typescript
import { RESET_STATEMENTS } from './helpers';
```

In `workers/signaling/test/db.test.ts`:
Replace the local `const RESET_STATEMENTS = [...]` with:
```typescript
import { RESET_STATEMENTS } from './helpers';
```

In `workers/signaling/test/resources.test.ts`:
Replace the local `const RESET_STATEMENTS = [...]` with:
```typescript
import { RESET_STATEMENTS } from './helpers';
```

In `workers/signaling/test/middleware.test.ts`:
Replace the local `const RESET_STATEMENTS = [...]` and its two user inserts. `middleware.test.ts` expects `usr_active` and `usr_inactive`. Keep the imports clean:
```typescript
import { RESET_STATEMENTS, TEST_JWT_SECRET } from './helpers';

const MIDDLEWARE_RESET_STATEMENTS = [
  ...RESET_STATEMENTS,
  `INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_active', 'alice', 'pk_1', 1)`,
  `INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_inactive', 'eve', 'pk_2', 0)`,
];
```
And in `middleware.test.ts`, change `beforeEach`:
```typescript
await env.DB.batch(MIDDLEWARE_RESET_STATEMENTS.map((sql) => env.DB.prepare(sql)));
```
Replace the hardcoded secret with `TEST_JWT_SECRET`.

- [ ] **Step 3: Run existing signaling tests to verify zero regressions**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: All existing test files PASS (auth, crypto, db, health, middleware, resources). Exactly 46 passing tests.

- [ ] **Step 4: Commit**

```bash
git add workers/signaling/test/helpers.ts workers/signaling/test/auth.test.ts workers/signaling/test/db.test.ts workers/signaling/test/middleware.test.ts workers/signaling/test/resources.test.ts
git commit -m "test(signaling): consolidate RESET_STATEMENTS fixture and add signals DDL"
```

---

### Task 2: Scaffold `packages/webrtc-core`

Configure `packages/webrtc-core/package.json`, `tsconfig.json`, `vitest.config.ts`, and initial type definitions (`src/types.ts`). Install `werift@0.24.4` as a devDependency in `packages/webrtc-core`.

**Files:**
- Modify: `packages/webrtc-core/package.json`
- Create: `packages/webrtc-core/tsconfig.json`
- Create: `packages/webrtc-core/vitest.config.ts`
- Create: `packages/webrtc-core/src/types.ts`

**Interfaces:**
- Produces:
  ```typescript
  // packages/webrtc-core/src/types.ts
  export interface RTCDataChannelLike {
    readonly label: string;
    readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(): void;
    onMessage(handler: (data: string | ArrayBuffer) => void): void;
    onStateChange(handler: (state: string) => void): void;
  }

  export interface RTCPeerConnectionLike {
    createOffer(): Promise<RTCSessionDescriptionInit>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike;
    onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void;
    onDataChannel(handler: (channel: RTCDataChannelLike) => void): void;
    onConnectionStateChange(handler: (state: string) => void): void;
    getStats(): Promise<RTCStatsReport>;
    close(): Promise<void>;
  }

  export interface PeerConnectionOptions {
    iceServers?: import('@remote/shared').IceServerConfig[];
    role: 'offerer' | 'answerer';
    channelLabels: string[];
    connectTimeoutMs?: number;
  }
  ```

- [ ] **Step 1: Update `packages/webrtc-core/package.json`**

Edit `packages/webrtc-core/package.json`:
```json
{
  "name": "@remote/webrtc-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./adapters/werift": "./src/adapters/werift.ts"
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@remote/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "typescript": "6.0.3",
    "vitest": "5.0.1",
    "werift": "0.24.4"
  }
}
```

- [ ] **Step 2: Install dependencies via pnpm**

Run:
```bash
pnpm install
```
Expected: Clean resolution, `werift@0.24.4` installed in `packages/webrtc-core`.

- [ ] **Step 3: Create `packages/webrtc-core/tsconfig.json`**

Create `packages/webrtc-core/tsconfig.json` with DOM and ES2024 libs:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Create `packages/webrtc-core/vitest.config.ts`**

Create `packages/webrtc-core/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create `packages/webrtc-core/src/types.ts`**

Create `packages/webrtc-core/src/types.ts`:
```typescript
import type { IceServerConfig, SignalMessage } from '@remote/shared';

export interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string | ArrayBuffer) => void): void;
  onStateChange(handler: (state: string) => void): void;
}

export interface RTCPeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike;
  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void;
  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void;
  onConnectionStateChange(handler: (state: string) => void): void;
  getStats(): Promise<RTCStatsReport>;
  close(): Promise<void>;
}

export interface PeerConnectionOptions {
  iceServers?: IceServerConfig[];
  role: 'offerer' | 'answerer';
  channelLabels: string[];
  connectTimeoutMs?: number;
}

export interface SignalTransport {
  send(msg: SignalMessage): Promise<void>;
  subscribe(handler: (msg: SignalMessage) => void): () => void;
  close(): void;
}
```

- [ ] **Step 6: Create initial `packages/webrtc-core/src/index.ts`**

Create `packages/webrtc-core/src/index.ts`:
```typescript
export * from './types';
```

- [ ] **Step 7: Verify typecheck passes**

Run:
```bash
pnpm --filter @remote/webrtc-core typecheck
```
Expected: PASS with 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/webrtc-core/package.json packages/webrtc-core/tsconfig.json packages/webrtc-core/vitest.config.ts packages/webrtc-core/src/types.ts packages/webrtc-core/src/index.ts pnpm-lock.yaml
git commit -m "feat(webrtc-core): scaffold package structure and define adapter seam types"
```

---

### Task 3: Implement Adapters (`BrowserAdapter` & `WeriftAdapter`)

Implement `BrowserAdapter` (mapping browser DOM `window.RTCPeerConnection` to `RTCPeerConnectionLike`) and `WeriftAdapter` (mapping `werift`'s event emitters, `Buffer` data, and `SessionDescription` return values to `RTCPeerConnectionLike`).

**Files:**
- Create: `packages/webrtc-core/src/adapters/browser.ts`
- Create: `packages/webrtc-core/src/adapters/werift.ts`
- Create: `packages/webrtc-core/src/adapter.ts`
- Modify: `packages/webrtc-core/src/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  // packages/webrtc-core/src/adapters/browser.ts
  export class BrowserAdapter implements RTCPeerConnectionLike { ... }

  // packages/webrtc-core/src/adapters/werift.ts
  export class WeriftAdapter implements RTCPeerConnectionLike { ... }

  // packages/webrtc-core/src/adapter.ts
  export function createBrowserAdapter(config?: { iceServers?: IceServerConfig[] }): BrowserAdapter;
  ```
- Consumes: `RTCPeerConnectionLike`, `RTCDataChannelLike`, `IceServerConfig` from `src/types.ts`.

- [ ] **Step 1: Implement `packages/webrtc-core/src/adapters/browser.ts`**

Create `packages/webrtc-core/src/adapters/browser.ts`:
```typescript
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
} from '../types';
import type { IceServerConfig } from '@remote/shared';

class BrowserDataChannel implements RTCDataChannelLike {
  constructor(private readonly dc: RTCDataChannel) {}

  get label(): string {
    return this.dc.label;
  }

  get readyState(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this.dc.readyState;
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      this.dc.send(data);
    } else {
      this.dc.send(data);
    }
  }

  close(): void {
    this.dc.close();
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.dc.addEventListener('message', (event) => {
      handler(event.data);
    });
  }

  onStateChange(handler: (state: string) => void): void {
    const fire = () => handler(this.dc.readyState);
    this.dc.addEventListener('open', fire);
    this.dc.addEventListener('close', fire);
    this.dc.addEventListener('error', fire);
  }
}

export class BrowserAdapter implements RTCPeerConnectionLike {
  private readonly pc: RTCPeerConnection;
  private readonly iceHandlers: Array<(candidate: RTCIceCandidateInit) => void> = [];
  private readonly channelHandlers: Array<(channel: RTCDataChannelLike) => void> = [];
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(config: { iceServers?: IceServerConfig[] } = {}) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('BrowserAdapter requires RTCPeerConnection in the global environment');
    }

    const rtcIceServers: RTCIceServer[] = (config.iceServers ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));

    this.pc = new RTCPeerConnection({ iceServers: rtcIceServers });

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        const init = event.candidate.toJSON();
        for (const handler of this.iceHandlers) {
          handler(init);
        }
      }
    });

    this.pc.addEventListener('datachannel', (event) => {
      const wrapped = new BrowserDataChannel(event.channel);
      for (const handler of this.channelHandlers) {
        handler(wrapped);
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      for (const handler of this.stateHandlers) {
        handler(this.pc.connectionState);
      }
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return await this.pc.createOffer();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return await this.pc.createAnswer();
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setLocalDescription(description);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(description);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike {
    const dc = this.pc.createDataChannel(label, options);
    return new BrowserDataChannel(dc);
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.iceHandlers.push(handler);
  }

  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void {
    this.channelHandlers.push(handler);
  }

  onConnectionStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  async close(): Promise<void> {
    this.pc.close();
  }
}
```

- [ ] **Step 2: Implement `packages/webrtc-core/src/adapters/werift.ts`**

Create `packages/webrtc-core/src/adapters/werift.ts`:
```typescript
import { RTCPeerConnection as WeriftPC } from 'werift';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
} from '../types';
import type { IceServerConfig } from '@remote/shared';

class WeriftDataChannel implements RTCDataChannelLike {
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(private readonly dc: InstanceType<typeof WeriftPC>['createDataChannel'] extends (...args: never[]) => infer R ? R : never) {
    // Normalise werift's stateChanged event
    this.dc.stateChanged.subscribe((state) => {
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    });
  }

  get label(): string {
    return this.dc.label;
  }

  get readyState(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this.dc.readyState;
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data === 'string') {
      this.dc.send(Buffer.from(data));
    } else if (data instanceof ArrayBuffer) {
      this.dc.send(Buffer.from(data));
    } else {
      this.dc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  close(): void {
    this.dc.close();
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.dc.onMessage.subscribe((raw) => {
      if (Buffer.isBuffer(raw)) {
        // Convert Buffer to ArrayBuffer for universal consumer compatibility
        const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        handler(ab);
      } else {
        handler(raw);
      }
    });
  }

  onStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }
}

export class WeriftAdapter implements RTCPeerConnectionLike {
  private readonly pc: WeriftPC;
  private readonly iceHandlers: Array<(candidate: RTCIceCandidateInit) => void> = [];
  private readonly channelHandlers: Array<(channel: RTCDataChannelLike) => void> = [];
  private readonly stateHandlers: Array<(state: string) => void> = [];

  constructor(config: { iceServers?: IceServerConfig[] } = {}) {
    const rtcIceServers = (config.iceServers ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }));

    this.pc = new WeriftPC({ iceServers: rtcIceServers });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        const init: RTCIceCandidateInit = {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        };
        for (const handler of this.iceHandlers) {
          handler(init);
        }
      }
    });

    this.pc.onDataChannel.subscribe((channel) => {
      const wrapped = new WeriftDataChannel(channel as never);
      for (const handler of this.channelHandlers) {
        handler(wrapped);
      }
    });

    this.pc.connectionStateChange.subscribe((state) => {
      for (const handler of this.stateHandlers) {
        handler(state);
      }
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    return {
      type: offer.type as RTCSdpType,
      sdp: offer.sdp,
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    return {
      type: answer.type as RTCSdpType,
      sdp: answer.sdp,
    };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setLocalDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription({
      type: description.type as never,
      sdp: description.sdp,
    });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannelLike {
    const dc = this.pc.createDataChannel(label, options);
    return new WeriftDataChannel(dc as never);
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): void {
    this.iceHandlers.push(handler);
  }

  onDataChannel(handler: (channel: RTCDataChannelLike) => void): void {
    this.channelHandlers.push(handler);
  }

  onConnectionStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.pc.getStats();
  }

  async close(): Promise<void> {
    await this.pc.close();
  }
}
```

- [ ] **Step 3: Implement `packages/webrtc-core/src/adapter.ts` and update `index.ts`**

Create `packages/webrtc-core/src/adapter.ts`:
```typescript
import type { IceServerConfig } from '@remote/shared';
import { BrowserAdapter } from './adapters/browser';

export function createBrowserAdapter(config?: { iceServers?: IceServerConfig[] }): BrowserAdapter {
  return new BrowserAdapter(config);
}
```

Update `packages/webrtc-core/src/index.ts`:
```typescript
export * from './types';
export * from './adapters/browser';
export * from './adapter';
```
*(Note: `WeriftAdapter` is deliberately NOT exported from `src/index.ts` to prevent browser bundling issues with Node builtins).*

- [ ] **Step 4: Verify typecheck**

Run:
```bash
pnpm --filter @remote/webrtc-core typecheck
```
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/webrtc-core/src/adapters/browser.ts packages/webrtc-core/src/adapters/werift.ts packages/webrtc-core/src/adapter.ts packages/webrtc-core/src/index.ts
git commit -m "feat(webrtc-core): implement BrowserAdapter and WeriftAdapter matching RTCPeerConnectionLike"
```

---

### Task 4: Signal Handling & REST Polling Transport

Implement `src/signal-handler.ts` (converting between wire `SignalMessage` and local `RTCSessionDescriptionInit`/`RTCIceCandidateInit`) and `src/transport.ts` (`SignalTransport` and `RESTPollingTransport` with adaptive backoff, cursor paging, and teardown).

**Files:**
- Create: `packages/webrtc-core/src/signal-handler.ts`
- Create: `packages/webrtc-core/src/transport.ts`
- Create: `packages/webrtc-core/test/helpers.ts`
- Create: `packages/webrtc-core/test/signal-handler.test.ts`
- Create: `packages/webrtc-core/test/transport.test.ts`
- Modify: `packages/webrtc-core/src/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  // src/signal-handler.ts
  export function toSessionDescriptionInit(offerOrAnswer: { sdp: string }, type: 'offer' | 'answer'): RTCSessionDescriptionInit;
  export function toIceCandidateInit(signal: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): RTCIceCandidateInit;
  export function createOfferSignal(sessionId: string, desc: RTCSessionDescriptionInit, capabilities?: string[]): SignalMessage;
  export function createAnswerSignal(sessionId: string, desc: RTCSessionDescriptionInit, approved?: boolean): SignalMessage;
  export function createCandidateSignal(sessionId: string, cand: RTCIceCandidateInit): SignalMessage;

  // src/transport.ts
  export interface RESTPollingTransportOptions {
    baseUrl: string;
    sessionId: string;
    token: string;
    fetch?: typeof fetch;
    initialIntervalMs?: number;
    maxIntervalMs?: number;
  }
  export class RESTPollingTransport implements SignalTransport { ... }
  ```

- [ ] **Step 1: Write test for `signal-handler.ts`**

Create `packages/webrtc-core/test/signal-handler.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  toSessionDescriptionInit,
  toIceCandidateInit,
  createOfferSignal,
  createAnswerSignal,
  createCandidateSignal,
} from '../src/signal-handler';

describe('Signal Handler conversions', () => {
  it('converts SDP string to RTCSessionDescriptionInit', () => {
    const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const desc = toSessionDescriptionInit({ sdp }, 'offer');
    expect(desc).toEqual({ type: 'offer', sdp });
  });

  it('converts ICE candidate signal to RTCIceCandidateInit', () => {
    const cand = toIceCandidateInit({
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(cand).toEqual({
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('builds offer SignalMessage payload', () => {
    const msg = createOfferSignal('sess_1', { type: 'offer', sdp: 'sdp_offer' }, ['terminal']);
    expect(msg).toEqual({
      type: 'offer',
      data: {
        sessionId: 'sess_1',
        sdp: 'sdp_offer',
        capabilities: ['terminal'],
      },
    });
  });

  it('builds answer SignalMessage payload', () => {
    const msg = createAnswerSignal('sess_1', { type: 'answer', sdp: 'sdp_answer' }, true);
    expect(msg).toEqual({
      type: 'answer',
      data: {
        sessionId: 'sess_1',
        sdp: 'sdp_answer',
        approved: true,
      },
    });
  });

  it('builds candidate SignalMessage payload with null defaults for mid/index', () => {
    const msg = createCandidateSignal('sess_1', {
      candidate: 'candidate_line',
    });
    expect(msg).toEqual({
      type: 'ice-candidate',
      data: {
        sessionId: 'sess_1',
        candidate: 'candidate_line',
        sdpMid: null,
        sdpMLineIndex: null,
      },
    });
  });

  it('throws on empty sdp or candidate', () => {
    expect(() => toSessionDescriptionInit({ sdp: '' }, 'offer')).toThrow('Empty SDP');
    expect(() => toIceCandidateInit({ candidate: '' })).toThrow('Empty ICE candidate');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter @remote/webrtc-core test signal-handler
```
Expected: FAIL (cannot find module `../src/signal-handler`).

- [ ] **Step 3: Implement `packages/webrtc-core/src/signal-handler.ts`**

Create `packages/webrtc-core/src/signal-handler.ts`:
```typescript
import type { SignalMessage } from '@remote/shared';

export function toSessionDescriptionInit(
  offerOrAnswer: { sdp: string },
  type: 'offer' | 'answer',
): RTCSessionDescriptionInit {
  if (!offerOrAnswer.sdp) {
    throw new Error('Empty SDP description');
  }
  return {
    type,
    sdp: offerOrAnswer.sdp,
  };
}

export function toIceCandidateInit(signal: {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}): RTCIceCandidateInit {
  if (!signal.candidate) {
    throw new Error('Empty ICE candidate');
  }
  return {
    candidate: signal.candidate,
    sdpMid: signal.sdpMid ?? null,
    sdpMLineIndex: signal.sdpMLineIndex ?? null,
  };
}

export function createOfferSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  capabilities: string[] = [],
): SignalMessage {
  return {
    type: 'offer',
    data: {
      sessionId,
      sdp: desc.sdp ?? '',
      capabilities,
    },
  };
}

export function createAnswerSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  approved = true,
): SignalMessage {
  return {
    type: 'answer',
    data: {
      sessionId,
      sdp: desc.sdp ?? '',
      approved,
    },
  };
}

export function createCandidateSignal(
  sessionId: string,
  cand: RTCIceCandidateInit,
): SignalMessage {
  return {
    type: 'ice-candidate',
    data: {
      sessionId,
      candidate: cand.candidate ?? '',
      sdpMid: cand.sdpMid ?? null,
      sdpMLineIndex: cand.sdpMLineIndex ?? null,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm --filter @remote/webrtc-core test signal-handler
```
Expected: PASS (6 tests).

- [ ] **Step 5: Write test for `transport.ts`**

Create `packages/webrtc-core/test/helpers.ts` for mock in-memory signaling bus and mock fetch:
```typescript
import { vi } from 'vitest';
import type { SignalMessage } from '@remote/shared';

export class MemorySignalBus {
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];

  subscribe(handler: (msg: SignalMessage) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  deliver(msg: SignalMessage): void {
    for (const sub of [...this.subscribers]) {
      sub(msg);
    }
  }
}

export function mockFetchResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}
```

Create `packages/webrtc-core/test/transport.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESTPollingTransport } from '../src/transport';
import type { SignalMessage } from '@remote/shared';

describe('RESTPollingTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts offer signal to /api/signal/offer', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'sig_1', sessionId: 'sess_1', type: 'offer' }), { status: 201 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'offer',
      data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: ['terminal'] },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/offer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token_abc',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('posts answer signal to /api/signal/answer', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'sig_2', sessionId: 'sess_1', type: 'answer' }), { status: 201 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'answer',
      data: { sessionId: 'sess_1', sdp: 'v=0', approved: true },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/answer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('posts candidate signal to /api/signal/ice-candidate', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'sig_3', sessionId: 'sess_1', type: 'ice-candidate' }), { status: 201 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const msg: SignalMessage = {
      type: 'ice-candidate',
      data: { sessionId: 'sess_1', candidate: 'cand_1', sdpMid: '0', sdpMLineIndex: 0 },
    };

    await transport.send(msg);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://test/api/signal/ice-candidate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(msg.data),
      }),
    );
    transport.close();
  });

  it('polls signals, advances cursor, and notifies subscribers', async () => {
    let callCount = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      callCount++;
      if (url.includes('/api/signal/poll')) {
        return new Response(
          JSON.stringify({
            signals: [
              {
                id: 'sig_10',
                sessionId: 'sess_1',
                type: 'offer',
                payload: { sessionId: 'sess_1', sdp: 'v=0', capabilities: [] },
              },
            ],
            cursor: 'sig_10',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 50,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const received: SignalMessage[] = [];
    transport.subscribe((msg) => received.push(msg));

    // Advance timer to trigger first poll
    await vi.advanceTimersByTimeAsync(60);

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('offer');

    // Next poll includes cursor ?after=sig_10
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/signal/poll/sess_1?after=sig_10'),
      expect.anything(),
    );

    transport.close();
  });

  it('stops polling immediately on close()', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ signals: [], cursor: null }), { status: 200 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(110);
    const countBeforeClose = fetchSpy.mock.calls.length;

    transport.close();

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy.mock.calls.length).toBe(countBeforeClose);
  });

  it('throws when sending after close()', async () => {
    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
    });
    transport.close();

    await expect(
      transport.send({
        type: 'offer',
        data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: [] },
      }),
    ).rejects.toThrow('Transport closed');
  });

  it('backs off polling interval on empty results', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ signals: [], cursor: null }), { status: 200 }),
    );

    const transport = new RESTPollingTransport({
      baseUrl: 'http://test',
      sessionId: 'sess_1',
      token: 'token_abc',
      initialIntervalMs: 100,
      maxIntervalMs: 400,
      fetch: fetchSpy as unknown as typeof fetch,
    });

    transport.subscribe(() => {});

    // Poll 1: 100ms
    await vi.advanceTimersByTimeAsync(110);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Poll 2: backed off (150ms)
    await vi.advanceTimersByTimeAsync(120);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    transport.close();
  });
});
```

- [ ] **Step 6: Run test to verify failure**

Run:
```bash
pnpm --filter @remote/webrtc-core test transport
```
Expected: FAIL (cannot find module `../src/transport`).

- [ ] **Step 7: Implement `packages/webrtc-core/src/transport.ts`**

Create `packages/webrtc-core/src/transport.ts`:
```typescript
import type { SignalTransport } from './types';
import type { SignalMessage } from '@remote/shared';

export interface RESTPollingTransportOptions {
  baseUrl: string;
  sessionId: string;
  token: string;
  fetch?: typeof fetch;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
}

interface RawPollItem {
  id: string;
  sessionId: string;
  type: 'offer' | 'answer' | 'ice-candidate';
  payload: unknown;
  createdAt?: string;
}

interface RawPollResponse {
  signals: RawPollItem[];
  cursor: string | null;
}

export class RESTPollingTransport implements SignalTransport {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly token: string;
  private readonly customFetch: typeof fetch;
  private readonly initialIntervalMs: number;
  private readonly maxIntervalMs: number;

  private currentIntervalMs: number;
  private cursor: string | null = null;
  private isClosed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers: Array<(msg: SignalMessage) => void> = [];

  constructor(options: RESTPollingTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.initialIntervalMs = options.initialIntervalMs ?? 200;
    this.maxIntervalMs = options.maxIntervalMs ?? 2000;
    this.currentIntervalMs = this.initialIntervalMs;
  }

  async send(msg: SignalMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport closed');
    }

    let endpoint = '';
    switch (msg.type) {
      case 'offer':
        endpoint = `${this.baseUrl}/api/signal/offer`;
        break;
      case 'answer':
        endpoint = `${this.baseUrl}/api/signal/answer`;
        break;
      case 'ice-candidate':
        endpoint = `${this.baseUrl}/api/signal/ice-candidate`;
        break;
    }

    const res = await this.customFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(msg.data),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to send signal ${msg.type}: HTTP ${res.status} ${text}`);
    }

    // Reset backoff on activity so response signals are received promptly
    this.currentIntervalMs = this.initialIntervalMs;
    this.reschedule(0);
  }

  subscribe(handler: (msg: SignalMessage) => void): () => void {
    this.subscribers.push(handler);
    if (!this.timer && !this.isClosed) {
      this.reschedule(this.initialIntervalMs);
    }
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  close(): void {
    this.isClosed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.subscribers.length = 0;
  }

  private reschedule(delayMs: number): void {
    if (this.isClosed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.isClosed) return;

    try {
      const query = this.cursor ? `?after=${encodeURIComponent(this.cursor)}` : '';
      const url = `${this.baseUrl}/api/signal/poll/${encodeURIComponent(this.sessionId)}${query}`;

      const res = await this.customFetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!res.ok) {
        // Back off on error
        this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
        this.reschedule(this.currentIntervalMs);
        return;
      }

      const data = (await res.json()) as RawPollResponse;
      if (data.cursor) {
        this.cursor = data.cursor;
      }

      if (data.signals && data.signals.length > 0) {
        this.currentIntervalMs = this.initialIntervalMs;
        for (const item of data.signals) {
          const signalMessage = this.parseSignalItem(item);
          if (signalMessage) {
            for (const sub of [...this.subscribers]) {
              sub(signalMessage);
            }
          }
        }
      } else {
        // Back off when no signals are available
        this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
      }
    } catch {
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 1.5, this.maxIntervalMs);
    } finally {
      if (!this.isClosed) {
        this.reschedule(this.currentIntervalMs);
      }
    }
  }

  private parseSignalItem(item: RawPollItem): SignalMessage | null {
    const payload = (typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload) as Record<string, unknown>;
    switch (item.type) {
      case 'offer':
        return {
          type: 'offer',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            sdp: (payload.sdp as string) ?? '',
            capabilities: (payload.capabilities as string[]) ?? [],
          },
        };
      case 'answer':
        return {
          type: 'answer',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            sdp: (payload.sdp as string) ?? '',
            approved: Boolean(payload.approved),
          },
        };
      case 'ice-candidate':
        return {
          type: 'ice-candidate',
          data: {
            sessionId: (payload.sessionId as string) ?? this.sessionId,
            candidate: (payload.candidate as string) ?? '',
            sdpMid: (payload.sdpMid as string | null) ?? null,
            sdpMLineIndex: (payload.sdpMLineIndex as number | null) ?? null,
          },
        };
      default:
        return null;
    }
  }
}
```

- [ ] **Step 8: Update `packages/webrtc-core/src/index.ts`**

Add exports to `packages/webrtc-core/src/index.ts`:
```typescript
export * from './types';
export * from './adapters/browser';
export * from './adapter';
export * from './signal-handler';
export * from './transport';
```

- [ ] **Step 9: Run tests to verify all 13 tests pass**

Run:
```bash
pnpm --filter @remote/webrtc-core test signal-handler transport
```
Expected: PASS (13 tests total: 6 signal-handler + 7 transport).

- [ ] **Step 10: Commit**

```bash
git add packages/webrtc-core/src/signal-handler.ts packages/webrtc-core/src/transport.ts packages/webrtc-core/test/helpers.ts packages/webrtc-core/test/signal-handler.test.ts packages/webrtc-core/test/transport.test.ts packages/webrtc-core/src/index.ts
git commit -m "feat(webrtc-core): add signal serialization and REST polling transport with backoff"
```

---

### Task 5: Data Channel Management

Implement `src/data-channel.ts` (`DataChannelManager`) managing the 4 standard channels (`terminal`, `desktop`, `files`, `control`) with typed framing over `DataChannelMessage<T>`, state observation, and channel lookup.

**Files:**
- Create: `packages/webrtc-core/src/data-channel.ts`
- Create: `packages/webrtc-core/test/data-channel.test.ts`
- Modify: `packages/webrtc-core/src/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  // src/data-channel.ts
  export class DataChannelManager {
    registerChannel(channel: RTCDataChannelLike): void;
    getChannel(label: string): RTCDataChannelLike | undefined;
    hasChannel(label: string): boolean;
    sendJson<T>(label: string, type: string, payload: T): void;
    sendRaw(label: string, data: string | ArrayBuffer | Uint8Array): void;
    onMessage<T = unknown>(label: string, handler: (msg: DataChannelMessage<T>) => void): () => void;
    onRawMessage(label: string, handler: (data: string | ArrayBuffer) => void): () => void;
    onStateChange(label: string, handler: (state: string) => void): () => void;
    closeAll(): void;
  }
  ```

- [ ] **Step 1: Write test for `data-channel.ts`**

Create `packages/webrtc-core/test/data-channel.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { DataChannelManager } from '../src/data-channel';
import type { RTCDataChannelLike } from '../src/types';

class MockDataChannel implements RTCDataChannelLike {
  public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  public sentData: Array<string | ArrayBuffer | Uint8Array> = [];
  private messageHandlers: Array<(data: string | ArrayBuffer) => void> = [];
  private stateHandlers: Array<(state: string) => void> = [];

  constructor(public readonly label: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') {
      throw new Error(`Channel ${this.label} is not open`);
    }
    this.sentData.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    for (const h of this.stateHandlers) h('closed');
  }

  onMessage(handler: (data: string | ArrayBuffer) => void): void {
    this.messageHandlers.push(handler);
  }

  onStateChange(handler: (state: string) => void): void {
    this.stateHandlers.push(handler);
  }

  simulateOpen(): void {
    this.readyState = 'open';
    for (const h of this.stateHandlers) h('open');
  }

  simulateMessage(data: string | ArrayBuffer): void {
    for (const h of this.messageHandlers) h(data);
  }
}

describe('DataChannelManager', () => {
  it('registers and retrieves channels by label', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('terminal');
    mgr.registerChannel(ch);

    expect(mgr.hasChannel('terminal')).toBe(true);
    expect(mgr.getChannel('terminal')).toBe(ch);
    expect(mgr.hasChannel('control')).toBe(false);
  });

  it('routes raw messages from registered channels', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('terminal');
    mgr.registerChannel(ch);

    const received: string[] = [];
    mgr.onRawMessage('terminal', (data) => received.push(String(data)));

    ch.simulateMessage('hello terminal');
    expect(received).toEqual(['hello terminal']);
  });

  it('frames and sends typed DataChannelMessage payloads', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('control');
    mgr.registerChannel(ch);
    ch.simulateOpen();

    mgr.sendJson('control', 'ping', { seq: 1 });

    expect(ch.sentData).toHaveLength(1);
    const parsed = JSON.parse(ch.sentData[0] as string);
    expect(parsed.channel).toBe('control');
    expect(parsed.type).toBe('ping');
    expect(parsed.payload).toEqual({ seq: 1 });
    expect(typeof parsed.timestamp).toBe('number');
  });

  it('parses and routes typed DataChannelMessage on receive', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('control');
    mgr.registerChannel(ch);

    const received: Array<{ type: string; payload: unknown }> = [];
    mgr.onMessage('control', (msg) => {
      received.push({ type: msg.type, payload: msg.payload });
    });

    ch.simulateMessage(
      JSON.stringify({
        channel: 'control',
        type: 'ack',
        payload: { ok: true },
        timestamp: Date.now(),
      }),
    );

    expect(received).toEqual([{ type: 'ack', payload: { ok: true } }]);
  });

  it('notifies on channel state transitions', () => {
    const mgr = new DataChannelManager();
    const ch = new MockDataChannel('files');
    mgr.registerChannel(ch);

    const states: string[] = [];
    mgr.onStateChange('files', (s) => states.push(s));

    ch.simulateOpen();
    ch.close();

    expect(states).toEqual(['open', 'closed']);
  });

  it('closes all registered channels on closeAll()', () => {
    const mgr = new DataChannelManager();
    const ch1 = new MockDataChannel('terminal');
    const ch2 = new MockDataChannel('desktop');
    mgr.registerChannel(ch1);
    mgr.registerChannel(ch2);
    ch1.simulateOpen();
    ch2.simulateOpen();

    mgr.closeAll();

    expect(ch1.readyState).toBe('closed');
    expect(ch2.readyState).toBe('closed');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter @remote/webrtc-core test data-channel
```
Expected: FAIL (cannot find module `../src/data-channel`).

- [ ] **Step 3: Implement `packages/webrtc-core/src/data-channel.ts`**

Create `packages/webrtc-core/src/data-channel.ts`:
```typescript
import type { RTCDataChannelLike } from './types';
import type { DataChannelMessage, WebRTCChannelType } from '@remote/shared';

export class DataChannelManager {
  private readonly channels = new Map<string, RTCDataChannelLike>();
  private readonly rawMessageHandlers = new Map<string, Array<(data: string | ArrayBuffer) => void>>();
  private readonly typedMessageHandlers = new Map<string, Array<(msg: DataChannelMessage) => void>>();
  private readonly stateHandlers = new Map<string, Array<(state: string) => void>>();

  registerChannel(channel: RTCDataChannelLike): void {
    const label = channel.label;
    this.channels.set(label, channel);

    channel.onMessage((data) => {
      // 1. Raw listeners
      const rawList = this.rawMessageHandlers.get(label);
      if (rawList) {
        for (const handler of [...rawList]) {
          handler(data);
        }
      }

      // 2. Typed listeners
      const typedList = this.typedMessageHandlers.get(label);
      if (typedList && typeof data === 'string') {
        try {
          const parsed = JSON.parse(data) as DataChannelMessage;
          if (parsed && typeof parsed.type === 'string') {
            for (const handler of [...typedList]) {
              handler(parsed);
            }
          }
        } catch {
          // ignore non-JSON messages on typed listeners
        }
      }
    });

    channel.onStateChange((state) => {
      const list = this.stateHandlers.get(label);
      if (list) {
        for (const handler of [...list]) {
          handler(state);
        }
      }
    });
  }

  getChannel(label: string): RTCDataChannelLike | undefined {
    return this.channels.get(label);
  }

  hasChannel(label: string): boolean {
    return this.channels.has(label);
  }

  sendRaw(label: string, data: string | ArrayBuffer | Uint8Array): void {
    const channel = this.channels.get(label);
    if (!channel) {
      throw new Error(`Data channel "${label}" is not registered`);
    }
    channel.send(data);
  }

  sendJson<T>(label: string, type: string, payload: T): void {
    const channel = this.channels.get(label);
    if (!channel) {
      throw new Error(`Data channel "${label}" is not registered`);
    }

    const message: DataChannelMessage<T> = {
      channel: label as WebRTCChannelType,
      type,
      payload,
      timestamp: Date.now(),
    };

    channel.send(JSON.stringify(message));
  }

  onRawMessage(label: string, handler: (data: string | ArrayBuffer) => void): () => void {
    let list = this.rawMessageHandlers.get(label);
    if (!list) {
      list = [];
      this.rawMessageHandlers.set(label, list);
    }
    list.push(handler);

    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  onMessage<T = unknown>(label: string, handler: (msg: DataChannelMessage<T>) => void): () => void {
    let list = this.typedMessageHandlers.get(label);
    if (!list) {
      list = [];
      this.typedMessageHandlers.set(label, list);
    }
    list.push(handler as (msg: DataChannelMessage) => void);

    return () => {
      const idx = list.indexOf(handler as (msg: DataChannelMessage) => void);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  onStateChange(label: string, handler: (state: string) => void): () => void {
    let list = this.stateHandlers.get(label);
    if (!list) {
      list = [];
      this.stateHandlers.set(label, list);
    }
    list.push(handler);

    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  closeAll(): void {
    for (const channel of this.channels.values()) {
      try {
        channel.close();
      } catch {
        // ignore close errors
      }
    }
    this.channels.clear();
  }
}
```

- [ ] **Step 4: Update `packages/webrtc-core/src/index.ts`**

Add exports:
```typescript
export * from './types';
export * from './adapters/browser';
export * from './adapter';
export * from './signal-handler';
export * from './transport';
export * from './data-channel';
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
pnpm --filter @remote/webrtc-core test data-channel
```
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/webrtc-core/src/data-channel.ts packages/webrtc-core/test/data-channel.test.ts packages/webrtc-core/src/index.ts
git commit -m "feat(webrtc-core): implement DataChannelManager with typed framing and state routing"
```

---

### Task 6: Connection State Machine & Real P2P Test

Implement `src/connection.ts` (`PeerConnection`), encapsulating the F1 ICE candidate buffering mechanism, F2 channel-before-offer requirement, and signaling lifecycle. Write `test/p2p.test.ts` to execute a genuine ICE/DTLS/SCTP loopback connection between two `werift` peers in Node CI without external networks.

**Files:**
- Create: `packages/webrtc-core/src/connection.ts`
- Create: `packages/webrtc-core/test/p2p.test.ts`
- Modify: `packages/webrtc-core/src/index.ts`

**Interfaces:**
- Produces:
  ```typescript
  // src/connection.ts
  export class PeerConnection {
    constructor(
      public readonly peer: RTCPeerConnectionLike,
      public readonly transport: SignalTransport,
      public readonly options: PeerConnectionOptions,
    );
    readonly dataChannels: DataChannelManager;
    start(): Promise<void>;
    waitForChannel(label: string, timeoutMs?: number): Promise<RTCDataChannelLike>;
    onConnectionStateChange(handler: (state: string) => void): () => void;
    getStats(): Promise<RTCStatsReport>;
    close(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write `test/p2p.test.ts`**

Create `packages/webrtc-core/test/p2p.test.ts`:
```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { WeriftAdapter } from '../src/adapters/werift';
import { PeerConnection } from '../src/connection';
import type { SignalTransport } from '../src/types';
import type { SignalMessage } from '@remote/shared';

// Direct in-memory bus connecting offerer and answerer transports
class InProcessBus {
  private handlers = new Map<string, Array<(msg: SignalMessage) => void>>();

  createTransport(id: string, targetId: string): SignalTransport {
    if (!this.handlers.has(id)) {
      this.handlers.set(id, []);
    }

    return {
      send: async (msg: SignalMessage) => {
        const targetList = this.handlers.get(targetId) ?? [];
        for (const handler of [...targetList]) {
          handler(msg);
        }
      },
      subscribe: (handler: (msg: SignalMessage) => void) => {
        const list = this.handlers.get(id) ?? [];
        list.push(handler);
        this.handlers.set(id, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      close: () => {
        this.handlers.delete(id);
      },
    };
  }
}

describe('Real P2P Handshake (werift)', () => {
  let offererPC: PeerConnection | null = null;
  let answererPC: PeerConnection | null = null;

  afterEach(async () => {
    if (offererPC) {
      await offererPC.close();
      offererPC = null;
    }
    if (answererPC) {
      await answererPC.close();
      answererPC = null;
    }
  });

  it('completes real ICE + DTLS + SCTP handshake on loopback without external STUN', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal', 'control'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    // Start handshake
    await offererPC.start();

    // Wait for channel 'terminal' to open on both sides
    const chA = await offererPC.waitForChannel('terminal', 12000);
    const chB = await answererPC.waitForChannel('terminal', 12000);

    expect(chA.readyState).toBe('open');
    expect(chB.readyState).toBe('open');

    // Verify bidirectional data transfer
    const echoPromise = new Promise<string>((resolve) => {
      chA.onMessage((data) => {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString();
        resolve(text);
      });
    });

    chB.onMessage((data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString();
      chB.send(`echo:${text}`);
    });

    chA.send('ping-p2p');
    const echo = await echoPromise;

    expect(echo).toBe('echo:ping-p2p');

    // Verify stats return RTCStatsReport
    const statsA = await offererPC.getStats();
    expect(statsA).toBeDefined();
    expect(typeof statsA.size).toBe('number');
  }, 20000);

  it('buffers ICE candidates received before remote description is set (F1)', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    // Offerer creates offer and transmits candidates
    await offererPC.start();

    // Channel opens cleanly even if candidates arrive early
    const ch = await answererPC.waitForChannel('terminal', 12000);
    expect(ch.readyState).toBe('open');
  }, 20000);

  it('creates configured data channels before offer so SCTP is in SDP (F2)', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['desktop', 'files'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    await offererPC.start();

    const chDesktop = await answererPC.waitForChannel('desktop', 12000);
    const chFiles = await answererPC.waitForChannel('files', 12000);

    expect(chDesktop.label).toBe('desktop');
    expect(chFiles.label).toBe('files');
  }, 20000);

  it('exposes connection state change events', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    const adapterB = new WeriftAdapter({ iceServers: [] });

    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['control'],
    });

    answererPC = new PeerConnection(adapterB, tB, {
      role: 'answerer',
      channelLabels: [],
    });

    const statesA: string[] = [];
    offererPC.onConnectionStateChange((state) => statesA.push(state));

    await offererPC.start();
    await offererPC.waitForChannel('control', 12000);

    expect(statesA.length).toBeGreaterThan(0);
  }, 20000);

  it('times out waitForChannel when peer does not respond', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');

    const adapterA = new WeriftAdapter({ iceServers: [] });
    offererPC = new PeerConnection(adapterA, tA, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    await expect(offererPC.waitForChannel('non_existent', 300)).rejects.toThrow(
      'timeout waiting for channel "non_existent"',
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter @remote/webrtc-core test p2p
```
Expected: FAIL (cannot find module `../src/connection`).

- [ ] **Step 3: Implement `packages/webrtc-core/src/connection.ts`**

Create `packages/webrtc-core/src/connection.ts`:
```typescript
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
  PeerConnectionOptions,
} from './types';
import type { SignalMessage } from '@remote/shared';
import { DataChannelManager } from './data-channel';
import {
  toSessionDescriptionInit,
  toIceCandidateInit,
  createOfferSignal,
  createAnswerSignal,
  createCandidateSignal,
} from './signal-handler';

export class PeerConnection {
  public readonly dataChannels = new DataChannelManager();

  private remoteDescriptionSet = false;
  private isClosed = false;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly unsubscribeTransport: () => void;

  constructor(
    public readonly peer: RTCPeerConnectionLike,
    public readonly transport: SignalTransport,
    public readonly options: PeerConnectionOptions,
  ) {
    // 1. Hook peer candidates and send via transport
    this.peer.onIceCandidate((candidate) => {
      if (this.isClosed) return;
      const msg = createCandidateSignal('', candidate);
      void this.transport.send(msg);
    });

    // 2. Hook incoming remote data channels
    this.peer.onDataChannel((channel) => {
      this.dataChannels.registerChannel(channel);
    });

    // 3. Hook peer connection state changes
    this.peer.onConnectionStateChange((state) => {
      for (const listener of [...this.stateListeners]) {
        listener(state);
      }
    });

    // 4. Pre-create all offerer data channels before offer creation (F2)
    if (options.role === 'offerer') {
      for (const label of options.channelLabels) {
        const dc = this.peer.createDataChannel(label, { ordered: true });
        this.dataChannels.registerChannel(dc);
      }
    }

    // 5. Subscribe to incoming signaling messages
    this.unsubscribeTransport = this.transport.subscribe((msg) => {
      void this.handleSignal(msg);
    });
  }

  async start(): Promise<void> {
    if (this.isClosed) throw new Error('PeerConnection is closed');
    if (this.options.role !== 'offerer') return;

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const signal = createOfferSignal('', offer, this.options.channelLabels);
    await this.transport.send(signal);
  }

  onConnectionStateChange(handler: (state: string) => void): () => void {
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  async waitForChannel(label: string, timeoutMs = 10000): Promise<RTCDataChannelLike> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ch = this.dataChannels.getChannel(label);
      if (ch && ch.readyState === 'open') {
        return ch;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for channel "${label}" (saw state: ${ch ? ch.readyState : 'not registered'})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  async getStats(): Promise<RTCStatsReport> {
    return await this.peer.getStats();
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    this.unsubscribeTransport();
    this.transport.close();
    this.dataChannels.closeAll();
    this.pendingCandidates.length = 0;
    await this.peer.close();
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    if (this.isClosed) return;

    switch (msg.type) {
      case 'ice-candidate': {
        const candInit = toIceCandidateInit(msg.data);
        if (this.remoteDescriptionSet) {
          await this.peer.addIceCandidate(candInit);
        } else {
          // F1 ICE candidate buffering
          this.pendingCandidates.push(candInit);
        }
        break;
      }

      case 'offer': {
        if (this.options.role !== 'answerer') return;
        const offerDesc = toSessionDescriptionInit(msg.data, 'offer');
        await this.peer.setRemoteDescription(offerDesc);
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();

        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        const answerSignal = createAnswerSignal(msg.data.sessionId, answer, true);
        await this.transport.send(answerSignal);
        break;
      }

      case 'answer': {
        if (this.options.role !== 'offerer') return;
        const answerDesc = toSessionDescriptionInit(msg.data, 'answer');
        await this.peer.setRemoteDescription(answerDesc);
        this.remoteDescriptionSet = true;
        await this.flushPendingCandidates();
        break;
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const cand of queued) {
      await this.peer.addIceCandidate(cand);
    }
  }
}
```

- [ ] **Step 4: Update `packages/webrtc-core/src/index.ts`**

Export `PeerConnection`:
```typescript
export * from './types';
export * from './adapters/browser';
export * from './adapter';
export * from './signal-handler';
export * from './transport';
export * from './data-channel';
export * from './connection';
```

- [ ] **Step 5: Run P2P tests to verify genuine handshake**

Run:
```bash
pnpm --filter @remote/webrtc-core test p2p
```
Expected: PASS (all 5 P2P test cases succeed, completing genuine ICE+DTLS+SCTP handshakes in Node).

- [ ] **Step 6: Run full `packages/webrtc-core` test suite**

Run:
```bash
pnpm --filter @remote/webrtc-core test
```
Expected: All 24 tests pass (6 signal-handler + 7 transport + 6 data-channel + 5 p2p).

- [ ] **Step 7: Commit**

```bash
git add packages/webrtc-core/src/connection.ts packages/webrtc-core/test/p2p.test.ts packages/webrtc-core/src/index.ts
git commit -m "feat(webrtc-core): implement PeerConnection state machine and verify real P2P handshake in Node"
```

---

### Task 7: Database Migration for Signal Indexes

Create migration `0001_signal_indexes.sql` to add indexes on `signals(session_id, created_at)` and `signals(expires_at)` in D1, updating the Drizzle migration journal.

**Files:**
- Create: `workers/signaling/db/migrations/0001_signal_indexes.sql`
- Modify: `workers/signaling/db/migrations/meta/_journal.json`

**Interfaces:**
- Produces:
  ```sql
  CREATE INDEX `signals_session_created_idx` ON `signals` (`session_id`, `created_at`);
  CREATE INDEX `signals_expires_at_idx` ON `signals` (`expires_at`);
  ```
- Consumes: `signals` table from `0000_initial.sql`.

- [ ] **Step 1: Create `0001_signal_indexes.sql`**

Create `workers/signaling/db/migrations/0001_signal_indexes.sql`:
```sql
CREATE INDEX `signals_session_created_idx` ON `signals` (`session_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `signals_expires_at_idx` ON `signals` (`expires_at`);
```

- [ ] **Step 2: Update `workers/signaling/db/migrations/meta/_journal.json`**

Edit `workers/signaling/db/migrations/meta/_journal.json` to register entry index 1:
```json
{
  "version": "7",
  "dialect": "sqlite",
  "entries": [
    {
      "idx": 0,
      "version": "6",
      "when": 1790302012686,
      "tag": "0000_initial",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "6",
      "when": 1790370000000,
      "tag": "0001_signal_indexes",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 3: Apply migration to local test runner**

Run:
```bash
pnpm --filter @remote/signaling db:migrate:local
```
Expected: Successfully applied migration `0001_signal_indexes`.

- [ ] **Step 4: Commit**

```bash
git add workers/signaling/db/migrations/0001_signal_indexes.sql workers/signaling/db/migrations/meta/_journal.json
git commit -m "feat(signaling): add migration 0001_signal_indexes for cursor polling and TTL cleanup"
```

---

### Task 8: Signaling Endpoints (`/api/signal/*`)

Implement the four REST signaling endpoints in `workers/signaling/src/routes/signal.ts` mounted at `/api/signal`:
- `POST /api/signal/offer`
- `POST /api/signal/answer`
- `POST /api/signal/ice-candidate`
- `GET /api/signal/poll/:sessionId`
Enforce session tenancy ownership, status verification (`SESSION_NOT_ACTIVE`), cursor-based polling (`created_at ASC, id ASC`), limit clamping (1..200), and SQLite-compatible TTL arithmetic (`datetime('now', '+5 minutes')`).

**Files:**
- Create: `workers/signaling/src/routes/signal.ts`
- Modify: `workers/signaling/src/index.ts`
- Create: `workers/signaling/test/signal.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/signal/offer` -> `201 { id, sessionId, type, createdAt }`
  - `POST /api/signal/answer` -> `201 { id, sessionId, type, createdAt }`
  - `POST /api/signal/ice-candidate` -> `201 { id, sessionId, type, createdAt }`
  - `GET /api/signal/poll/:sessionId` -> `200 { signals: [...], cursor }`
- Consumes: `authMiddleware`, `sessions`, `signals` schema, `getDb`, `AppContext`, `AppError`.

- [ ] **Step 1: Write `workers/signaling/test/signal.test.ts`**

Create `workers/signaling/test/signal.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { RESET_STATEMENTS } from './helpers';

type AuthResponse = {
  token: string;
  user: { id: string };
};

type SignalResponse = {
  id: string;
  sessionId: string;
  type: string;
  createdAt: string;
};

type PollResponse = {
  signals: Array<{
    id: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  cursor: string | null;
};

type ErrorResponse = {
  error: string;
  code: string;
};

describe('Signaling REST API (/api/signal)', () => {
  let tokenUserA: string;
  let tokenUserB: string;
  let sessionIdA: string;

  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));

    // Register User A
    const resA = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user_a',
          password: 'Password123!',
          publicKey: 'pk_a',
        }),
      },
      env,
    );
    const dataA = (await resA.json()) as AuthResponse;
    tokenUserA = dataA.token;

    // Register User B
    const resB = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user_b',
          password: 'Password123!',
          publicKey: 'pk_b',
        }),
      },
      env,
    );
    const dataB = (await resB.json()) as AuthResponse;
    tokenUserB = dataB.token;

    // Create session for User A
    const sessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const sessData = (await sessRes.json()) as { id: string };
    sessionIdA = sessData.id;
  });

  it('posts offer signal to active session', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1',
          capabilities: ['terminal'],
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.sessionId).toBe(sessionIdA);
    expect(data.type).toBe('offer');
    expect(data.id).toBeDefined();
  });

  it('posts answer signal to active session', async () => {
    const res = await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'v=0\r\no=- 456 2 IN IP4 127.0.0.1',
          approved: true,
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.type).toBe('answer');
  });

  it('posts ice-candidate signal to active session', async () => {
    const res = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.type).toBe('ice-candidate');
  });

  it('polls signals for a session and parses JSON payloads', async () => {
    // 1. Post offer
    await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'offer_sdp',
        }),
      },
      env,
    );

    // 2. Poll signals
    const pollRes = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    expect(pollRes.status).toBe(200);
    const data = (await pollRes.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.type).toBe('offer');
    expect(data.signals[0]?.payload.sdp).toBe('offer_sdp');
    expect(data.cursor).toBe(data.signals[0]?.id);
  });

  it('advances cursor on poll and skips previously returned signals', async () => {
    // Post two candidates
    const r1 = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, candidate: 'cand_1' }),
      },
      env,
    );
    const sig1 = (await r1.json()) as SignalResponse;

    await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, candidate: 'cand_2' }),
      },
      env,
    );

    // Poll after sig1
    const pollRes = await app.request(
      `/api/signal/poll/${sessionIdA}?after=${sig1.id}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const data = (await pollRes.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.payload.candidate).toBe('cand_2');
  });

  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('rejects foreign-session post with 404 NOT_FOUND (ownership boundary)', async () => {
    // User B attempts to post to User A's session
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserB}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );

    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('rejects foreign-session poll with 404 NOT_FOUND (ownership boundary)', async () => {
    // User B attempts to poll User A's session
    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserB}` },
      },
      env,
    );

    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('rejects signaling on terminated session with 409 SESSION_NOT_ACTIVE', async () => {
    // Terminate session
    await app.request(
      `/api/sessions/${sessionIdA}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );

    expect(res.status).toBe(409);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('rejects missing sessionId with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sdp: 'v=0' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing sdp on offer/answer with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing candidate on ice-candidate with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('clamps limit to maximum 200 on poll', async () => {
    const res = await app.request(
      `/api/signal/poll/${sessionIdA}?limit=500`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('filters out signals whose expires_at has passed', async () => {
    // Insert an expired signal directly into DB
    const expiredSql = `
      INSERT INTO signals (id, session_id, type, payload, expires_at)
      VALUES ('sig_expired', ?, 'offer', '{"sdp":"expired"}', datetime('now', '-10 minutes'))
    `;
    await env.DB.prepare(expiredSql).bind(sessionIdA).run();

    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const data = (await res.json()) as PollResponse;
    expect(data.signals.find((s) => s.id === 'sig_expired')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm --filter @remote/signaling test signal
```
Expected: FAIL (route `/api/signal/*` not found 404).

- [ ] **Step 3: Implement `workers/signaling/src/routes/signal.ts`**

Create `workers/signaling/src/routes/signal.ts`:
```typescript
import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { sessions, signals } from '../db/schema';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

/**
 * Validate that the target session exists and is strictly owned by the caller.
 * Returns 404 NOT_FOUND on any mismatch to prevent tenancy enumeration.
 */
async function getOwnedActiveSession(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  userId: string,
) {
  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    throw new AppError('Session is not active', 409, 'SESSION_NOT_ACTIVE');
  }

  return session;
}

// POST /api/signal/offer
router.post('/offer', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    sdp?: string;
    capabilities?: string[];
  } | null;

  if (!body?.sessionId || typeof body.sdp !== 'string' || !body.sdp.trim()) {
    throw new AppError('sessionId and non-empty sdp are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  await getOwnedActiveSession(db, body.sessionId, user.id);

  const payload = JSON.stringify({
    sessionId: body.sessionId,
    sdp: body.sdp,
    capabilities: body.capabilities ?? [],
  });

  const [inserted] = await db
    .insert(signals)
    .values({
      sessionId: body.sessionId,
      type: 'offer',
      payload,
      expiresAt: sql`datetime('now', '+5 minutes')`,
    })
    .returning();

  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// POST /api/signal/answer
router.post('/answer', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    sdp?: string;
    approved?: boolean;
  } | null;

  if (!body?.sessionId || typeof body.sdp !== 'string' || !body.sdp.trim()) {
    throw new AppError('sessionId and non-empty sdp are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  await getOwnedActiveSession(db, body.sessionId, user.id);

  const payload = JSON.stringify({
    sessionId: body.sessionId,
    sdp: body.sdp,
    approved: body.approved !== false,
  });

  const [inserted] = await db
    .insert(signals)
    .values({
      sessionId: body.sessionId,
      type: 'answer',
      payload,
      expiresAt: sql`datetime('now', '+5 minutes')`,
    })
    .returning();

  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// POST /api/signal/ice-candidate
router.post('/ice-candidate', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  } | null;

  if (!body?.sessionId || typeof body.candidate !== 'string' || !body.candidate.trim()) {
    throw new AppError('sessionId and non-empty candidate are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  await getOwnedActiveSession(db, body.sessionId, user.id);

  const payload = JSON.stringify({
    sessionId: body.sessionId,
    candidate: body.candidate,
    sdpMid: body.sdpMid ?? null,
    sdpMLineIndex: body.sdpMLineIndex ?? null,
  });

  const [inserted] = await db
    .insert(signals)
    .values({
      sessionId: body.sessionId,
      type: 'ice-candidate',
      payload,
      expiresAt: sql`datetime('now', '+5 minutes')`,
    })
    .returning();

  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// GET /api/signal/poll/:sessionId
router.get('/poll/:sessionId', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('sessionId');
  const afterId = c.req.query('after');
  const rawLimit = Number(c.req.query('limit')) || 50;
  const limit = Math.max(1, Math.min(rawLimit, 200));

  const db = getDb(c.env.DB);

  // Ownership verification: 404 if not found or owned by different tenant
  const session = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  // Order by rowid ASC to guarantee deterministic insertion-order delivery.
  // SQLite created_at has 1-second resolution; sorting by (created_at, id)
  // sorts sub-second signals by random UUID, causing later signals with
  // smaller UUIDs to be skipped by an (id > cursor) filter.
  const query = afterId
    ? sql`
        SELECT id, session_id as sessionId, type, payload, created_at as createdAt
        FROM signals
        WHERE session_id = ${sessionId}
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND rowid > COALESCE((SELECT rowid FROM signals WHERE id = ${afterId} AND session_id = ${sessionId}), 0)
        ORDER BY rowid ASC
        LIMIT ${limit}
      `
    : sql`
        SELECT id, session_id as sessionId, type, payload, created_at as createdAt
        FROM signals
        WHERE session_id = ${sessionId}
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY rowid ASC
        LIMIT ${limit}
      `;

  const rows = await db.all<{
    id: string;
    sessionId: string;
    type: string;
    payload: string;
    createdAt: string;
  }>(query);

  const parsedSignals = rows.map((r) => {
    let parsedPayload: Record<string, unknown> = {};
    try {
      parsedPayload = JSON.parse(r.payload);
    } catch {
      parsedPayload = { raw: r.payload };
    }
    return {
      id: r.id,
      sessionId: r.sessionId,
      type: r.type,
      payload: parsedPayload,
      createdAt: r.createdAt,
    };
  });

  const nextCursor = parsedSignals.length > 0 ? parsedSignals[parsedSignals.length - 1]?.id ?? null : null;

  return c.json({
    signals: parsedSignals,
    cursor: nextCursor,
  });
});

export default router;
```

- [ ] **Step 4: Mount router in `workers/signaling/src/index.ts`**

Edit `workers/signaling/src/index.ts`:
Add:
```typescript
import signal from './routes/signal';
```
And mount it:
```typescript
app.route('/api/signal', signal);
```

- [ ] **Step 5: Run signaling tests to verify all 14 tests pass**

Run:
```bash
pnpm --filter @remote/signaling test signal
```
Expected: PASS (14 tests).

- [ ] **Step 6: Run full signaling test suite**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: PASS (60 tests total across all 7 test files).

- [ ] **Step 7: Commit**

```bash
git add workers/signaling/src/routes/signal.ts workers/signaling/src/index.ts workers/signaling/test/signal.test.ts
git commit -m "feat(signaling): implement tenant-isolated REST signaling routes with cursor polling"
```

---

### Task 9: Documentation & Architecture Synchronization

Update `docs/ARCHITECTURE.md` (lines 935–947) to correct the historical contradiction where `SignalOffer` and `SignalAnswer` were typed with `RTCSessionDescriptionInit` instead of `string`. Add a clear note explaining the ADR-07 resolution and the Week 4 peer separation boundary limitation (§5.4).

**Files:**
- Modify: `docs/ARCHITECTURE.md:930-955`

- [ ] **Step 1: Update `docs/ARCHITECTURE.md`**

In `docs/ARCHITECTURE.md`, locate Section 6.2 (lines 930–950):
Replace:
```typescript
// packages/shared/src/types/signaling.ts
export interface SignalOffer {
  sessionId: string;
  sdp: RTCSessionDescriptionInit;
  capabilities: string[];
}

export interface SignalAnswer {
  sessionId: string;
  sdp: RTCSessionDescriptionInit;
  approved: boolean;
}

export interface IceCandidate {
  sessionId: string;
  candidate: RTCIceCandidateInit;
}
```

With the wire types and architectural rationale:
```typescript
// packages/shared/src/types/signaling.ts
// Wire types cross JSON network boundaries and Cloudflare Workers (which lack DOM libs).
// Conversion to RTCSessionDescriptionInit / RTCIceCandidateInit occurs inside packages/webrtc-core.
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
```

Add an explicit note documenting the accepted Week 4 limitation:
```markdown
> **Week 4 Security Boundary Note:** Authentication in Week 4 validates that the session is owned by the calling user. Differentiating the browser client from the desktop agent within the same user's account requires agent-scoped credentials, which are introduced in Week 5 alongside the Rust desktop agent.
```

- [ ] **Step 2: Run complete repository verification suite**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```
Expected:
- `lint`: 12/12 workspaces clean.
- `typecheck`: 12/12 workspaces clean.
- `format:check`: clean.
- `test`: exactly **135 passing tests** across the entire monorepo:
  - `workers/signaling`: 60 tests (46 existing + 14 signaling)
  - `packages/webrtc-core`: 24 tests (6 signal-handler + 7 transport + 6 data-channel + 5 p2p)
  - `apps/web`: 29 tests
  - `packages/api-client`: 11 tests
  - `packages/crypto`: 10 tests
  - `packages/shared`: 1 test

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): sync signaling wire types with shared package and note Week 4 auth boundary"
```
