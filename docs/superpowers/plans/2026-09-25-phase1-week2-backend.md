# Phase 1 Week 2 — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation on Cloudflare Workers (`workers/signaling`) using Hono, D1 database with Drizzle ORM, KV cache, Web Crypto PBKDF2 password hashing, JWT authentication with token revocation, REST API endpoints (Auth, Users, Devices, Agents, Sessions), and a Vitest automated test suite running in `workerd`.

**Architecture:** A unified Cloudflare Worker (`@remote/signaling`) built with Hono router exposing modular sub-routers (`/api/auth`, `/api/users`, `/api/devices`, `/api/agents`, `/api/sessions`). Data persistence via Cloudflare D1 with Drizzle ORM for schema and migration management. Cloudflare KV cache for instant token revocation blacklist and ephemeral caching. Password hashing using Web Crypto API PBKDF2 with constant-time verification. Testing via Vitest and `@cloudflare/vitest-pool-workers`.

**Tech Stack:** Cloudflare Workers, Hono 4.13.9, Drizzle ORM 0.45.3, Drizzle Kit 0.31.11, Vitest 4.1.11, `@cloudflare/vitest-pool-workers` 0.22.0, `@cloudflare/workers-types`, TypeScript 6.0.3, pnpm 12.6.0, Turborepo 2.11.3.

**Spec:** `docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md`

## Global Constraints

- Root `packageManager` is `pnpm@12.6.0`.
- TypeScript is pinned at `6.0.3` across all packages (`tsconfig.base.json` extends with `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `strict: true`).
- Prettier ignore covers `docs/`, `.remember/`, `.superpowers/`.
- ESLint 10 flat config with `@typescript-eslint` 8.70.1.
- All code in `workers/signaling` must be compatible with Cloudflare Workers runtime (no native Node C++ bindings, use Web Crypto API).
- D1 SQLite compatibility: Foreign keys enabled, UUIDs generated via `crypto.randomUUID()`.

## Review Focus

- **Timing attack on password verification:** Password hashes must be compared with constant-time byte-by-byte XOR comparison (`crypto.subtle.timingSafeEqual` or equivalent constant-time buffer compare) rather than standard string equality (`===`).
- **Token revocation replay:** Revoked access tokens must be blocked immediately by checking KV (`CACHE`) before any database queries execute in `authMiddleware`.
- **Inactive user rejection:** Users with `isActive === false` must be rejected at login and rejected on all authenticated endpoints even if holding a cryptographically valid token.
- **Malformed JSON safety:** Invalid or empty request bodies on POST/PUT endpoints must be caught by global error handling and return structured HTTP 400 responses without unhandled 500 exceptions.
- **Foreign key cascade integrity:** Deleting a user must cascade-delete all related devices, agents, sessions, and signals in D1 SQLite.

---

### Task 1: Dependencies, Workspace Configuration & Worker Scaffolding

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `workers/signaling/package.json`
- Create: `workers/signaling/wrangler.toml`
- Create: `workers/signaling/tsconfig.json`
- Create: `workers/signaling/drizzle.config.ts`
- Create: `workers/signaling/vitest.config.ts`
- Create: `workers/signaling/src/index.ts`
- Create: `workers/signaling/test/health.test.ts`
- Modify: `turbo.json`
- Modify: `package.json`

**Interfaces:**
- Produces: Working `@remote/signaling` package capable of running `pnpm --filter @remote/signaling dev`, `pnpm --filter @remote/signaling test`, and `pnpm --filter @remote/signaling typecheck`.
- Produces: Root `pnpm test` orchestrated through Turborepo.

- [ ] **Step 1: Cập nhật `pnpm-workspace.yaml` để cho phép build scripts cho `esbuild` và `workerd`**

Cập nhật `pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'workers/*'

allowBuilds:
  esbuild: true
  workerd: true
```

- [ ] **Step 2: Cập nhật `workers/signaling/package.json`**

Ghi nội dung vào `workers/signaling/package.json`:
```json
{
  "name": "@remote/signaling",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply remote-access --local",
    "db:migrate:remote": "wrangler d1 migrations apply remote-access --remote",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@remote/shared": "workspace:*",
    "drizzle-orm": "^0.45.3",
    "hono": "^4.13.9"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.22.0",
    "@cloudflare/workers-types": "^4.20250214.0",
    "drizzle-kit": "^0.31.11",
    "typescript": "^6.0.3",
    "vitest": "^4.1.0",
    "wrangler": "^4.139.0"
  }
}
```

- [ ] **Step 3: Tạo `workers/signaling/wrangler.toml`**

Ghi file `workers/signaling/wrangler.toml`:
```toml
name = "remote-signaling"
main = "src/index.ts"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "development"
JWT_SECRET = "dev-secret-change-in-production-min-32-chars"
JWT_EXPIRES_IN = "15m"
REFRESH_TOKEN_SECRET = "dev-refresh-secret-min-32-chars"
REFRESH_TOKEN_EXPIRES_IN = "7d"

[[d1_databases]]
binding = "DB"
database_name = "remote-access"
database_id = "local-db-binding"
migrations_dir = "db/migrations"

[[kv_namespaces]]
binding = "CACHE"
id = "local-cache-binding"

[observability]
enabled = true
```

- [ ] **Step 4: Tạo `workers/signaling/tsconfig.json`**

Ghi file `workers/signaling/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "*.ts"]
}
```

- [ ] **Step 5: Tạo `workers/signaling/drizzle.config.ts`**

Ghi file `workers/signaling/drizzle.config.ts`:
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
});
```

- [ ] **Step 6: Tạo `workers/signaling/vitest.config.ts`**

Ghi file `workers/signaling/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
});
```

- [ ] **Step 7: Cập nhật `turbo.json` và root `package.json`**

Thêm task `test` vào `turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "lint": {},
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "test": {}
  }
}
```

Thêm script `"test": "turbo run test"` vào root `package.json`:
```json
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format:check": "prettier --check .",
    "format": "prettier --write ."
```

- [ ] **Step 8: Cài đặt dependencies và tái tạo lockfile**

Run:
```bash
rm -rf node_modules pnpm-lock.yaml && pnpm install
```
Expected: Cài đặt thành công toàn bộ dependencies cho `@remote/signaling`, `esbuild` và `workerd` build scripts được approved qua `allowBuilds`.

- [ ] **Step 9: Viết test failing đầu tiên cho Health Check (RED)**

Tạo file `workers/signaling/test/health.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('Worker Scaffolding & Health', () => {
  it('returns 200 OK and status ok on /health', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('can read and write to KV CACHE binding', async () => {
    await env.CACHE.put('test:ping', 'pong');
    const val = await env.CACHE.get('test:ping');
    expect(val).toBe('pong');
  });
});
```

- [ ] **Step 10: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì `src/index.ts` chưa tồn tại hoặc chưa có route `/health`.

- [ ] **Step 11: Tạo `workers/signaling/src/index.ts` tối thiểu (GREEN)**

Ghi file `workers/signaling/src/index.ts`:
```typescript
import { Hono } from 'hono';

export type Bindings = {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  REFRESH_TOKEN_SECRET: string;
  REFRESH_TOKEN_EXPIRES_IN: string;
  DB: D1Database;
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
```

- [ ] **Step 12: Chạy test để xác nhận GREEN**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: `Test Files: 1 passed (1), Tests: 2 passed (2)`, exit code 0.

- [ ] **Step 13: Chạy format, lint và typecheck**

Run:
```bash
pnpm format && pnpm lint && pnpm typecheck
```
Expected: Exit code 0, không có lỗi linter/type.

- [ ] **Step 14: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml turbo.json package.json workers/signaling/
git commit -m "feat(signaling): scaffold worker package with hono, vitest and cloudflare pool"
```

---

### Task 2: D1 Database Schema & Migrations with Drizzle ORM

**Files:**
- Create: `workers/signaling/src/db/schema.ts`
- Create: `workers/signaling/src/db/client.ts`
- Create: `workers/signaling/test/db.test.ts`
- Generate: `workers/signaling/db/migrations/0000_initial.sql`

**Interfaces:**
- Produces: Exported Drizzle tables `users`, `devices`, `agents`, `sessions`, `signals`, `auditLogs` từ `workers/signaling/src/db/schema.ts`.
- Produces: `getDb(d1: D1Database)` client factory từ `workers/signaling/src/db/client.ts`.
- Produces: SQL migration file trong `workers/signaling/db/migrations/`.

- [ ] **Step 1: Viết test failing cho Database Schema & Operations (RED)**

Tạo file `workers/signaling/test/db.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db/client';
import { users, devices, agents, sessions } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('D1 Database & Schema', () => {
  beforeEach(async () => {
    // Drop and create tables for clean isolation in in-memory D1
    await env.DB.exec(`
      PRAGMA foreign_keys = ON;
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS devices;
      DROP TABLE IF EXISTS users;

      CREATE TABLE users (
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
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT,
        device_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        is_trusted INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agents (
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
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id),
        agent_id TEXT REFERENCES agents(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        metadata TEXT
      );
    `);
  });

  it('inserts and queries a user with Drizzle', async () => {
    const db = getDb(env.DB);
    await db.insert(users).values({
      id: 'usr_1',
      username: 'alice',
      email: 'alice@example.com',
      publicKey: 'pubkey_alice',
      passwordHash: 'hash_123',
    });

    const user = await db.select().from(users).where(eq(users.id, 'usr_1')).get();
    expect(user).toBeDefined();
    expect(user?.username).toBe('alice');
    expect(user?.isActive).toBe(true);
  });

  it('cascades delete from users to devices and agents', async () => {
    const db = getDb(env.DB);
    await db.insert(users).values({
      id: 'usr_2',
      username: 'bob',
      publicKey: 'pubkey_bob',
    });

    await db.insert(devices).values({
      id: 'dev_1',
      userId: 'usr_2',
      deviceType: 'desktop',
      fingerprint: 'fp_bob_1',
    });

    await db.insert(agents).values({
      id: 'agent_1',
      userId: 'usr_2',
      publicKey: 'pubkey_agent_1',
    });

    // Delete user
    await db.delete(users).where(eq(users.id, 'usr_2'));

    // Check device and agent deleted via CASCADE
    const dev = await db.select().from(devices).where(eq(devices.id, 'dev_1')).get();
    const ag = await db.select().from(agents).where(eq(agents.id, 'agent_1')).get();
    expect(dev).toBeUndefined();
    expect(ag).toBeUndefined();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì `src/db/schema.ts` và `src/db/client.ts` chưa tồn tại.

- [ ] **Step 3: Tạo `workers/signaling/src/db/schema.ts`**

Ghi file `workers/signaling/src/db/schema.ts`:
```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  publicKey: text('public_key').notNull(),
  passwordHash: text('password_hash'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastLoginAt: text('last_login_at'),
  metadata: text('metadata'),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceName: text('device_name'),
  deviceType: text('device_type').notNull(), // 'desktop' | 'mobile' | 'web'
  fingerprint: text('fingerprint').notNull().unique(),
  isTrusted: integer('is_trusted', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hostname: text('hostname'),
  platform: text('platform'),
  osVersion: text('os_version'),
  agentVersion: text('agent_version'),
  publicKey: text('public_key').notNull(),
  isOnline: integer('is_online', { mode: 'boolean' }).notNull().default(false),
  lastPingAt: text('last_ping_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').references(() => devices.id),
  agentId: text('agent_id').references(() => agents.id),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
  metadata: text('metadata'),
});

export const signals = sqliteTable('signals', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'offer' | 'answer' | 'ice-candidate'
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  expiresAt: text('expires_at'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  details: text('details'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export type UserSelect = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type DeviceSelect = typeof devices.$inferSelect;
export type AgentSelect = typeof agents.$inferSelect;
export type SessionSelect = typeof sessions.$inferSelect;
```

- [ ] **Step 4: Tạo `workers/signaling/src/db/client.ts`**

Ghi file `workers/signaling/src/db/client.ts`:
```typescript
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof getDb>;
```

- [ ] **Step 5: Chạy test để xác nhận GREEN**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: Cả 2 test suites `health.test.ts` và `db.test.ts` pass 100%.

- [ ] **Step 6: Sinh file migration ban đầu qua `drizzle-kit`**

Run:
```bash
pnpm --filter @remote/signaling db:generate
```
Expected: File `db/migrations/0000_*.sql` được tạo ra trong `workers/signaling/db/migrations/`.

- [ ] **Step 7: Commit**

```bash
git add workers/signaling/src/db/ workers/signaling/db/migrations/ workers/signaling/test/db.test.ts
git commit -m "feat(signaling): add drizzle d1 schema, client and initial migration"
```

---

### Task 3: Web Crypto PBKDF2 Password Hashing & JWT Utilities

**Files:**
- Create: `workers/signaling/src/utils/crypto.ts`
- Create: `workers/signaling/src/utils/jwt.ts`
- Create: `workers/signaling/test/crypto.test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`
- Produces: `verifyPassword(password: string, serializedHash: string): Promise<boolean>`
- Produces: `signAccessToken(userId: string, username: string, secret: string, expiresIn?: number): Promise<{ token: string; jti: string; exp: number }>`
- Produces: `signRefreshToken(userId: string, secret: string, expiresIn?: number): Promise<{ token: string; jti: string; exp: number }>`
- Produces: `verifyToken(token: string, secret: string): Promise<TokenPayload>`

- [ ] **Step 1: Viết test failing cho Crypto & JWT (RED)**

Tạo file `workers/signaling/test/crypto.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/utils/crypto';
import { signAccessToken, signRefreshToken, verifyToken } from '../src/utils/jwt';

describe('Crypto & JWT Utilities', () => {
  describe('Password Hashing', () => {
    it('hashes and verifies password correctly', async () => {
      const password = 'SuperSecretPassword123!';
      const hash = await hashPassword(password);
      expect(hash).toMatch(/^\$pbkdf2\$v=1\$i=100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('WrongPassword', hash);
      expect(isInvalid).toBe(false);
    });

    it('rejects tampered hash string format gracefully', async () => {
      const isValid = await verifyPassword('password', 'invalid-hash-string');
      expect(isValid).toBe(false);
    });
  });

  describe('JWT Tokens', () => {
    const accessSecret = 'access-test-secret-at-least-32-chars-long';
    const refreshSecret = 'refresh-test-secret-at-least-32-chars-long';

    it('signs and verifies access token', async () => {
      const { token, jti, exp } = await signAccessToken('usr_1', 'alice', accessSecret, 900);
      expect(token).toBeDefined();
      expect(jti).toBeDefined();
      expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      const payload = await verifyToken(token, accessSecret);
      expect(payload.sub).toBe('usr_1');
      expect(payload.username).toBe('alice');
      expect(payload.type).toBe('access');
      expect(payload.jti).toBe(jti);
    });

    it('signs and verifies refresh token', async () => {
      const { token, jti } = await signRefreshToken('usr_1', refreshSecret, 604800);
      const payload = await verifyToken(token, refreshSecret);
      expect(payload.sub).toBe('usr_1');
      expect(payload.type).toBe('refresh');
      expect(payload.jti).toBe(jti);
    });

    it('fails verification on tampered token or wrong secret', async () => {
      const { token } = await signAccessToken('usr_1', 'alice', accessSecret);
      await expect(verifyToken(token, 'wrong-secret-32-characters-minimum')).rejects.toThrow();
      await expect(verifyToken(token + 'tampered', accessSecret)).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì `src/utils/crypto.ts` và `src/utils/jwt.ts` chưa tồn tại.

- [ ] **Step 3: Tạo `workers/signaling/src/utils/crypto.ts`**

Ghi file `workers/signaling/src/utils/crypto.ts`:
```typescript
const ITERATIONS = 100000;
const KEY_LEN_BYTES = 32;

function buf2hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hex2buf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedKey = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN_BYTES * 8
  );

  const saltHex = buf2hex(salt.buffer);
  const hashHex = buf2hex(derivedKey);

  return `$pbkdf2$v=1$i=${ITERATIONS}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password: string, serializedHash: string): Promise<boolean> {
  const parts = serializedHash.split('$');
  if (parts.length !== 6 || parts[1] !== 'pbkdf2' || parts[2] !== 'v=1') {
    return false;
  }

  const iterations = parseInt(parts[3]?.replace('i=', '') ?? '', 10);
  const saltHex = parts[4];
  const targetHashHex = parts[5];

  if (!iterations || !saltHex || !targetHashHex) {
    return false;
  }

  const salt = hex2buf(saltHex);
  const targetBytes = hex2buf(targetHashHex);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const computedKey = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LEN_BYTES * 8
  );

  const computedBytes = new Uint8Array(computedKey);

  if (computedBytes.length !== targetBytes.length) {
    return false;
  }

  // Constant-time XOR comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < computedBytes.length; i++) {
    diff |= (computedBytes[i] ?? 0) ^ (targetBytes[i] ?? 0);
  }

  return diff === 0;
}
```

- [ ] **Step 4: Tạo `workers/signaling/src/utils/jwt.ts`**

Ghi file `workers/signaling/src/utils/jwt.ts`:
```typescript
import { sign, verify } from 'hono/jwt';

export interface TokenPayload {
  sub: string;
  username?: string;
  type: 'access' | 'refresh';
  jti: string;
  exp: number;
  [key: string]: unknown;
}

export async function signAccessToken(
  userId: string,
  username: string,
  secret: string,
  expiresInSeconds = 900 // 15 mins
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    username,
    type: 'access',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

export async function signRefreshToken(
  userId: string,
  secret: string,
  expiresInSeconds = 604800 // 7 days
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    type: 'refresh',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as unknown as TokenPayload;
  return payload;
}
```

- [ ] **Step 5: Chạy test để xác nhận GREEN**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: Tất cả các test trong `crypto.test.ts` pass, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add workers/signaling/src/utils/ workers/signaling/test/crypto.test.ts
git commit -m "feat(signaling): add pbkdf2 password hashing and jwt token utilities"
```

---

### Task 4: Middleware, Token Revocation (KV) & Global Error Handling

**Files:**
- Create: `workers/signaling/src/types.ts`
- Create: `workers/signaling/src/middleware/error.ts`
- Create: `workers/signaling/src/middleware/cors.ts`
- Create: `workers/signaling/src/middleware/auth.ts`
- Create: `workers/signaling/test/middleware.test.ts`

**Interfaces:**
- Produces: `authMiddleware` bảo vệ các route yêu cầu xác thực, inject `user` và `payload` vào Hono Context.
- Produces: `errorHandler` định dạng phản hồi lỗi chuẩn.
- Produces: `corsMiddleware` xử lý CORS preflight và headers.

- [ ] **Step 1: Tạo `workers/signaling/src/types.ts`**

Ghi file `workers/signaling/src/types.ts`:
```typescript
import type { UserSelect } from './db/schema';
import type { TokenPayload } from './utils/jwt';

export type Bindings = {
  ENVIRONMENT: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  REFRESH_TOKEN_SECRET: string;
  REFRESH_TOKEN_EXPIRES_IN: string;
  DB: D1Database;
  CACHE: KVNamespace;
};

export type Variables = {
  user: UserSelect;
  tokenPayload: TokenPayload;
};

export type AppContext = {
  Bindings: Bindings;
  Variables: Variables;
};
```

- [ ] **Step 2: Viết test failing cho Middleware & Token Revocation (RED)**

Tạo file `workers/signaling/test/middleware.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/error';
import { signAccessToken } from '../src/utils/jwt';
import type { AppContext } from '../src/types';

describe('Auth Middleware & Token Revocation', () => {
  const secret = 'jwt-secret-min-32-chars-for-test-suit';
  let app: Hono<AppContext>;

  beforeEach(async () => {
    await env.DB.exec(`
      DROP TABLE IF EXISTS users;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        public_key TEXT NOT NULL,
        password_hash TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_active', 'alice', 'pk_1', 1);
      INSERT INTO users (id, username, public_key, is_active) VALUES ('usr_inactive', 'eve', 'pk_2', 0);
    `);

    app = new Hono<AppContext>();
    app.onError(errorHandler);
    app.use('/protected/*', authMiddleware);
    app.get('/protected/profile', (c) => c.json({ user: c.get('user') }));
  });

  it('rejects requests without Authorization header with 401', async () => {
    const res = await app.request('/protected/profile', {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing or invalid Authorization header');
  });

  it('allows active user with valid token', async () => {
    const { token } = await signAccessToken('usr_active', 'alice', secret);
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: secret }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe('alice');
  });

  it('rejects revoked token recorded in KV CACHE with 401', async () => {
    const { token, jti } = await signAccessToken('usr_active', 'alice', secret);
    // Put token in revocation blacklist in KV
    await env.CACHE.put(`token:revoked:${jti}`, '1');

    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: secret }
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Token has been revoked');
  });

  it('rejects inactive user with 401 even if token is valid', async () => {
    const { token } = await signAccessToken('usr_inactive', 'eve', secret);
    const res = await app.request(
      '/protected/profile',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { ...env, JWT_SECRET: secret }
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('User is inactive or not found');
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì `auth.ts`, `error.ts` chưa được tạo.

- [ ] **Step 4: Tạo `workers/signaling/src/middleware/error.ts`**

Ghi file `workers/signaling/src/middleware/error.ts`:
```typescript
import type { ErrorHandler } from 'hono';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'BAD_REQUEST',
    public details: unknown = null
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        details: err.details,
      },
      err.statusCode as any
    );
  }

  // Handle JSON parse errors or malformed payloads
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    return c.json(
      {
        error: 'Malformed JSON payload',
        code: 'MALFORMED_JSON',
        details: null,
      },
      400
    );
  }

  console.error('[Unhandled Error]', err);
  return c.json(
    {
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
      details: null,
    },
    500
  );
};
```

- [ ] **Step 5: Tạo `workers/signaling/src/middleware/cors.ts`**

Ghi file `workers/signaling/src/middleware/cors.ts`:
```typescript
import { cors } from 'hono/cors';

export const corsMiddleware = cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
});
```

- [ ] **Step 6: Tạo `workers/signaling/src/middleware/auth.ts`**

Ghi file `workers/signaling/src/middleware/auth.ts`:
```typescript
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { verifyToken } from '../utils/jwt';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AppError } from './error';

export const authMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Missing or invalid Authorization header', 401, 'UNAUTHORIZED');
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new AppError('Missing or invalid Authorization header', 401, 'UNAUTHORIZED');
  }

  let payload;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch {
    throw new AppError('Invalid or expired token', 401, 'UNAUTHORIZED');
  }

  if (payload.type !== 'access') {
    throw new AppError('Invalid token type', 401, 'UNAUTHORIZED');
  }

  // Fast check KV revocation blacklist
  const isRevoked = await c.env.CACHE.get(`token:revoked:${payload.jti}`);
  if (isRevoked) {
    throw new AppError('Token has been revoked', 401, 'UNAUTHORIZED');
  }

  // Check user active status in D1
  const db = getDb(c.env.DB);
  const user = await db.select().from(users).where(eq(users.id, payload.sub)).get();

  if (!user || !user.isActive) {
    throw new AppError('User is inactive or not found', 401, 'UNAUTHORIZED');
  }

  c.set('user', user);
  c.set('tokenPayload', payload);

  await next();
};
```

- [ ] **Step 7: Chạy test để xác nhận GREEN**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: Tất cả 4 test files (`health`, `db`, `crypto`, `middleware`) pass 100%.

- [ ] **Step 8: Commit**

```bash
git add workers/signaling/src/types.ts workers/signaling/src/middleware/ workers/signaling/test/middleware.test.ts
git commit -m "feat(signaling): add auth middleware, token revocation check and error handler"
```

---

### Task 5: Authentication Routes (`/api/auth/*`) & User Profile (`/api/users/me`)

**Files:**
- Create: `workers/signaling/src/routes/auth.ts`
- Create: `workers/signaling/src/routes/users.ts`
- Modify: `workers/signaling/src/index.ts`
- Create: `workers/signaling/test/auth.test.ts`

**Interfaces:**
- Produces: `/api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/webauthn/*`
- Produces: `/api/users/me`

- [ ] **Step 1: Viết test failing cho Authentication Flow (RED)**

Tạo file `workers/signaling/test/auth.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';

describe('Auth & Users REST API', () => {
  beforeEach(async () => {
    await env.DB.exec(`
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS devices;
      DROP TABLE IF EXISTS users;

      CREATE TABLE users (
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
      );
    `);
  });

  it('registers a new user and returns 201 with tokens', async () => {
    const res = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'alice',
          email: 'alice@example.com',
          password: 'Password123!',
          publicKey: 'pk_alice_ed25519',
        }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.user.username).toBe('alice');
    expect(body.token).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.expiresIn).toBe(900);
  });

  it('rejects registration with duplicate username with 409', async () => {
    await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'bob',
          email: 'bob@example.com',
          password: 'Password123!',
          publicKey: 'pk_bob',
        }),
      },
      env
    );

    const dupRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'bob',
          email: 'bob2@example.com',
          password: 'Password123!',
          publicKey: 'pk_bob_2',
        }),
      },
      env
    );

    expect(dupRes.status).toBe(409);
    const err = (await dupRes.json()) as any;
    expect(err.code).toBe('USERNAME_EXISTS');
  });

  it('logs in successfully and fetches /api/users/me', async () => {
    // 1. Register
    await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'charlie',
          password: 'SecretPassword!',
          publicKey: 'pk_charlie',
        }),
      },
      env
    );

    // 2. Login
    const loginRes = await app.request(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'charlie',
          password: 'SecretPassword!',
        }),
      },
      env
    );

    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as any;
    const token = loginData.token;

    // 3. Fetch profile
    const profileRes = await app.request(
      '/api/users/me',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );

    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as any;
    expect(profile.user.username).toBe('charlie');
  });

  it('refreshes token via /api/auth/refresh', async () => {
    const regRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'david',
          password: 'Password123!',
          publicKey: 'pk_david',
        }),
      },
      env
    );
    const { refreshToken } = (await regRes.json()) as any;

    const refreshRes = await app.request(
      '/api/auth/refresh',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      env
    );

    expect(refreshRes.status).toBe(200);
    const refreshData = (await refreshRes.json()) as any;
    expect(refreshData.token).toBeDefined();
  });

  it('revokes token on logout so subsequent requests fail with 401', async () => {
    const regRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'emma',
          password: 'Password123!',
          publicKey: 'pk_emma',
        }),
      },
      env
    );
    const { token } = (await regRes.json()) as any;

    // Logout
    const logoutRes = await app.request(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(logoutRes.status).toBe(200);

    // Profile request with old token must now be 401
    const profileRes = await app.request(
      '/api/users/me',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(profileRes.status).toBe(401);
  });

  it('returns 501 Not Implemented on WebAuthn stubs', async () => {
    const optRes = await app.request(
      '/api/auth/webauthn/options',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test' }) },
      env
    );
    expect(optRes.status).toBe(501);

    const verRes = await app.request(
      '/api/auth/webauthn/verify',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: {} }) },
      env
    );
    expect(verRes.status).toBe(501);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì các route `/api/auth/*` và `/api/users/*` chưa được cài đặt.

- [ ] **Step 3: Tạo `workers/signaling/src/routes/auth.ts`**

Ghi file `workers/signaling/src/routes/auth.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt';
import { AppError } from '../middleware/error';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono<AppContext>();

auth.post('/register', async (c) => {
  const body = await c.req.json<{
    username?: string;
    email?: string;
    password?: string;
    publicKey?: string;
  }>().catch(() => null);

  if (!body?.username || !body?.password || !body?.publicKey) {
    throw new AppError('username, password, and publicKey are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);

  // Check username or email uniqueness
  const conditions = [eq(users.username, body.username)];
  if (body.email) {
    conditions.push(eq(users.email, body.email));
  }
  const existing = await db.select().from(users).where(or(...conditions)).get();

  if (existing) {
    if (existing.username === body.username) {
      throw new AppError('Username already taken', 409, 'USERNAME_EXISTS');
    }
    throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await hashPassword(body.password);
  const userId = crypto.randomUUID();

  const [newUser] = await db
    .insert(users)
    .values({
      id: userId,
      username: body.username,
      email: body.email ?? null,
      publicKey: body.publicKey,
      passwordHash,
      isActive: true,
    })
    .returning();

  if (!newUser) {
    throw new AppError('Failed to create user', 500, 'DATABASE_ERROR');
  }

  const { token, exp } = await signAccessToken(newUser.id, newUser.username, c.env.JWT_SECRET);
  const { token: refreshToken } = await signRefreshToken(newUser.id, c.env.REFRESH_TOKEN_SECRET);

  const safeUser = {
    id: newUser.id,
    username: newUser.username,
    email: newUser.email,
    publicKey: newUser.publicKey,
    isActive: newUser.isActive,
    createdAt: newUser.createdAt,
    updatedAt: newUser.updatedAt,
    lastLoginAt: newUser.lastLoginAt,
  };

  return c.json(
    {
      user: safeUser,
      token,
      refreshToken,
      expiresIn: exp - Math.floor(Date.now() / 1000),
    },
    201
  );
});

auth.post('/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);

  if (!body?.username || !body?.password) {
    throw new AppError('Username and password are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  const user = await db.select().from(users).where(eq(users.username, body.username)).get();

  if (!user || !user.passwordHash) {
    throw new AppError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new AppError('User account is inactive', 401, 'ACCOUNT_INACTIVE');
  }

  const isValid = await verifyPassword(body.password, user.passwordHash);
  if (!isValid) {
    throw new AppError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  await db
    .update(users)
    .set({ lastLoginAt: new Date().toISOString() })
    .where(eq(users.id, user.id));

  const { token, exp } = await signAccessToken(user.id, user.username, c.env.JWT_SECRET);
  const { token: refreshToken } = await signRefreshToken(user.id, c.env.REFRESH_TOKEN_SECRET);

  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    publicKey: user.publicKey,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };

  return c.json({
    user: safeUser,
    token,
    refreshToken,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  });
});

auth.post('/refresh', async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (!body?.refreshToken) {
    throw new AppError('refreshToken is required', 400, 'VALIDATION_ERROR');
  }

  let payload;
  try {
    payload = await verifyToken(body.refreshToken, c.env.REFRESH_TOKEN_SECRET);
  } catch {
    throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }

  if (payload.type !== 'refresh') {
    throw new AppError('Invalid token type', 401, 'INVALID_TOKEN_TYPE');
  }

  const isRevoked = await c.env.CACHE.get(`token:revoked:${payload.jti}`);
  if (isRevoked) {
    throw new AppError('Refresh token has been revoked', 401, 'TOKEN_REVOKED');
  }

  const db = getDb(c.env.DB);
  const user = await db.select().from(users).where(eq(users.id, payload.sub)).get();

  if (!user || !user.isActive) {
    throw new AppError('User is inactive or not found', 401, 'ACCOUNT_INACTIVE');
  }

  const { token, exp } = await signAccessToken(user.id, user.username, c.env.JWT_SECRET);

  return c.json({
    token,
    refreshToken: body.refreshToken,
    expiresIn: exp - Math.floor(Date.now() / 1000),
  });
});

auth.post('/logout', authMiddleware, async (c) => {
  const tokenPayload = c.get('tokenPayload');
  const now = Math.floor(Date.now() / 1000);
  const ttl = tokenPayload.exp - now;

  if (ttl > 0) {
    await c.env.CACHE.put(`token:revoked:${tokenPayload.jti}`, '1', {
      expirationTtl: Math.max(60, ttl),
    });
  }

  // Also revoke refresh token if passed in body
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (body?.refreshToken) {
    try {
      const refreshPayload = await verifyToken(body.refreshToken, c.env.REFRESH_TOKEN_SECRET);
      const refreshTtl = refreshPayload.exp - now;
      if (refreshTtl > 0) {
        await c.env.CACHE.put(`token:revoked:${refreshPayload.jti}`, '1', {
          expirationTtl: Math.max(60, refreshTtl),
        });
      }
    } catch {
      // Ignore invalid refresh token during logout
    }
  }

  return c.json({ success: true });
});

auth.post('/webauthn/options', (c) => {
  return c.json({ error: 'WebAuthn will be supported in Phase 2' }, 501);
});

auth.post('/webauthn/verify', (c) => {
  return c.json({ error: 'WebAuthn will be supported in Phase 2' }, 501);
});

export default auth;
```

- [ ] **Step 4: Tạo `workers/signaling/src/routes/users.ts`**

Ghi file `workers/signaling/src/routes/users.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';

const users = new Hono<AppContext>();

users.use('*', authMiddleware);

users.get('/me', (c) => {
  const user = c.get('user');
  const safeUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    publicKey: user.publicKey,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
  return c.json({ user: safeUser });
});

export default users;
```

- [ ] **Step 5: Cập nhật `workers/signaling/src/index.ts` để mount sub-routers và global error handler**

Ghi file `workers/signaling/src/index.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from './types';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error';
import auth from './routes/auth';
import users from './routes/users';

const app = new Hono<AppContext>();

app.use('*', corsMiddleware);
app.onError(errorHandler);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api/auth', auth);
app.route('/api/users', users);

export default app;
```

- [ ] **Step 6: Chạy test để xác nhận GREEN**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: Tất cả 5 test files (`health`, `db`, `crypto`, `middleware`, `auth`) pass 100%.

- [ ] **Step 7: Commit**

```bash
git add workers/signaling/src/routes/ workers/signaling/src/index.ts workers/signaling/test/auth.test.ts
git commit -m "feat(signaling): implement auth routes, profile endpoint and webauthn stubs"
```

---

### Task 6: Resource Endpoints (Devices, Agents, Sessions) & CI Workflow Integration

**Files:**
- Create: `workers/signaling/src/routes/devices.ts`
- Create: `workers/signaling/src/routes/agents.ts`
- Create: `workers/signaling/src/routes/sessions.ts`
- Modify: `workers/signaling/src/index.ts`
- Create: `workers/signaling/test/resources.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CRUD endpoints cho `/api/devices`, `/api/agents`, `/api/sessions`.
- Produces: GitHub Actions CI executing `pnpm test` across all workspace projects.

- [ ] **Step 1: Viết test failing cho Resources CRUD (RED)**

Tạo file `workers/signaling/test/resources.test.ts`:
```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';

describe('Devices, Agents & Sessions REST API', () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await env.DB.exec(`
      PRAGMA foreign_keys = ON;
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS agents;
      DROP TABLE IF EXISTS devices;
      DROP TABLE IF EXISTS users;

      CREATE TABLE users (
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
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT,
        device_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        is_trusted INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE agents (
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
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT REFERENCES devices(id),
        agent_id TEXT REFERENCES agents(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        metadata TEXT
      );
    `);

    // Register user
    const regRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'tester',
          password: 'Password123!',
          publicKey: 'pk_tester',
        }),
      },
      env
    );
    const regData = (await regRes.json()) as any;
    token = regData.token;
    userId = regData.user.id;
  });

  describe('Devices API (/api/devices)', () => {
    it('registers, lists, and deletes a device', async () => {
      // 1. Register device
      const createRes = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_macbook_pro',
            deviceName: 'MacBook Pro 16',
            deviceType: 'desktop',
          }),
        },
        env
      );
      expect(createRes.status).toBe(201);
      const dev = (await createRes.json()) as any;
      expect(dev.fingerprint).toBe('fp_macbook_pro');

      // 2. List devices
      const listRes = await app.request(
        '/api/devices',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as any[];
      expect(list.length).toBe(1);

      // 3. Delete device
      const delRes = await app.request(
        `/api/devices/${dev.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(delRes.status).toBe(200);

      // Verify empty list
      const listAfter = await app.request(
        '/api/devices',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(((await listAfter.json()) as any[]).length).toBe(0);
    });
  });

  describe('Agents API (/api/agents)', () => {
    it('registers, lists, and fetches an agent', async () => {
      const createRes = await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: 'agent_host_1',
            hostname: 'ubuntu-desktop',
            platform: 'linux',
            osVersion: '24.04',
            agentVersion: '0.1.0',
            publicKey: 'pk_host_agent',
          }),
        },
        env
      );
      expect(createRes.status).toBe(201);

      const listRes = await app.request(
        '/api/agents',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as any[];
      expect(list.length).toBe(1);
      expect(list[0].id).toBe('agent_host_1');

      const singleRes = await app.request(
        '/api/agents/agent_host_1',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(singleRes.status).toBe(200);
      const single = (await singleRes.json()) as any;
      expect(single.hostname).toBe('ubuntu-desktop');
    });
  });

  describe('Sessions API (/api/sessions)', () => {
    it('creates, retrieves, and terminates a session', async () => {
      // Create session
      const createRes = await app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
        env
      );
      expect(createRes.status).toBe(201);
      const session = (await createRes.json()) as any;
      expect(session.status).toBe('pending');

      // Fetch single session
      const getRes = await app.request(
        `/api/sessions/${session.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(getRes.status).toBe(200);

      // Terminate session
      const delRes = await app.request(
        `/api/sessions/${session.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(delRes.status).toBe(200);

      // Verify status terminated
      const getAfter = await app.request(
        `/api/sessions/${session.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      const terminatedSession = (await getAfter.json()) as any;
      expect(terminatedSession.status).toBe('terminated');
    });
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận RED**

Run:
```bash
pnpm --filter @remote/signaling test
```
Expected: FAIL vì các route `/api/devices`, `/api/agents`, `/api/sessions` chưa tồn tại.

- [ ] **Step 3: Tạo `workers/signaling/src/routes/devices.ts`**

Ghi file `workers/signaling/src/routes/devices.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { devices } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(devices).where(eq(devices.userId, user.id));
  return c.json(list);
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    fingerprint?: string;
    deviceName?: string;
    deviceType?: string;
  }>().catch(() => null);

  if (!body?.fingerprint || !body?.deviceType) {
    throw new AppError('fingerprint and deviceType are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  const [created] = await db
    .insert(devices)
    .values({
      userId: user.id,
      fingerprint: body.fingerprint,
      deviceName: body.deviceName ?? null,
      deviceType: body.deviceType,
      isTrusted: false,
    })
    .returning();

  return c.json(created, 201);
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('id');
  const db = getDb(c.env.DB);

  const existing = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    .get();

  if (!existing) {
    throw new AppError('Device not found', 404, 'NOT_FOUND');
  }

  await db.delete(devices).where(eq(devices.id, deviceId));
  return c.json({ success: true });
});

export default router;
```

- [ ] **Step 4: Tạo `workers/signaling/src/routes/agents.ts`**

Ghi file `workers/signaling/src/routes/agents.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { agents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(list);
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    id?: string;
    hostname?: string;
    platform?: string;
    osVersion?: string;
    agentVersion?: string;
    publicKey?: string;
  }>().catch(() => null);

  if (!body?.id || !body?.publicKey) {
    throw new AppError('id and publicKey are required', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);
  const [created] = await db
    .insert(agents)
    .values({
      id: body.id,
      userId: user.id,
      hostname: body.hostname ?? null,
      platform: body.platform ?? null,
      osVersion: body.osVersion ?? null,
      agentVersion: body.agentVersion ?? null,
      publicKey: body.publicKey,
      isOnline: false,
    })
    .returning();

  return c.json(created, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = getDb(c.env.DB);

  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!agent) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  return c.json(agent);
});

export default router;
```

- [ ] **Step 5: Tạo `workers/signaling/src/routes/sessions.ts`**

Ghi file `workers/signaling/src/routes/sessions.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { sessions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(sessions).where(eq(sessions.userId, user.id));
  return c.json(list);
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    deviceId?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
  };

  const db = getDb(c.env.DB);
  const [created] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      deviceId: body.deviceId ?? null,
      agentId: body.agentId ?? null,
      status: 'pending',
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
    })
    .returning();

  return c.json(created, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const db = getDb(c.env.DB);

  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  return c.json(session);
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const db = getDb(c.env.DB);

  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  await db
    .update(sessions)
    .set({
      status: 'terminated',
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.id, sessionId));

  return c.json({ success: true });
});

export default router;
```

- [ ] **Step 6: Cập nhật `workers/signaling/src/index.ts` để mount đầy đủ sub-routers**

Ghi file `workers/signaling/src/index.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from './types';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error';
import auth from './routes/auth';
import users from './routes/users';
import devices from './routes/devices';
import agents from './routes/agents';
import sessions from './routes/sessions';

const app = new Hono<AppContext>();

app.use('*', corsMiddleware);
app.onError(errorHandler);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api/auth', auth);
app.route('/api/users', users);
app.route('/api/devices', devices);
app.route('/api/agents', agents);
app.route('/api/sessions', sessions);

export default app;
```

- [ ] **Step 7: Cập nhật `.github/workflows/ci.yml` để chạy test suite**

Sửa `.github/workflows/ci.yml` thêm bước chạy `pnpm test`:
```yaml
      - name: Lint workspace
        run: pnpm lint

      - name: Typecheck workspace
        run: pnpm typecheck

      - name: Check code formatting
        run: pnpm format:check

      - name: Run test suite
        run: pnpm test
```

- [ ] **Step 8: Chạy toàn bộ chuỗi kiểm tra local**

Run:
```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```
Expected: Cả 4 lệnh đều pass 100% với exit code 0.

- [ ] **Step 9: Commit**

```bash
git add workers/signaling/src/routes/ workers/signaling/src/index.ts workers/signaling/test/resources.test.ts .github/workflows/ci.yml
git commit -m "feat(signaling): implement devices, agents, sessions routes and add ci test step"
```
