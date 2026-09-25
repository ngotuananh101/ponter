# Phase 1 Week 2 — Backend Foundation Design Specification

**Status:** Approved  
**Date:** 2026-09-25  
**Author:** Ngo Tuan Anh & Claude  
**Target:** Phase 1 Week 2 of `docs/ARCHITECTURE.md` (Section 8: Backend Foundation)  

---

## 1. Executive Summary & Goals

This specification details the architecture, design, and implementation plan for **Phase 1, Week 2: Backend Foundation** of the remote access platform.

### Goals
1. Establish the backend worker runtime on **Cloudflare Workers** using **Hono** framework.
2. Setup **Cloudflare D1 SQLite Database** with **Drizzle ORM** for type-safe schema definitions and migration management.
3. Configure **Cloudflare KV Cache** for token revocation blacklist and ephemeral state caching.
4. Implement complete **Authentication & Session Management** (User registration, password hashing via Web Crypto PBKDF2, JWT access & refresh tokens, token revocation on logout).
5. Expose core **REST API Endpoints** for Authentication, Users, Devices, Agents, and Sessions.
6. Build a robust test suite using **Vitest** and **`@cloudflare/vitest-pool-workers`** running against simulated in-memory D1 and KV instances in the real `workerd` runtime.
7. Integrate test scripts into Turborepo and GitHub Actions CI.

---

## 2. Architectural Decision Records (ADRs)

### ADR-01: Consolidation into `workers/signaling`
- **Context:** `docs/ARCHITECTURE.md` describes both `workers/signaling` and `workers/api` in the folder tree, but binds D1, KV, `wrangler.toml`, and deploy scripts to `remote-signaling`.
- **Decision:** Consolidate all REST API routes (Auth, Users, Devices, Sessions, Agents) and Signaling into `workers/signaling` (`@remote/signaling`). Keep `workers/api` as a minimal placeholder package for future standalone microservices if needed.
- **Rationale:** Prevents duplicate D1/KV bindings, eliminates cross-worker latency and CORS synchronization issues, and leverages Hono sub-routers for clean modular code separation.

### ADR-02: Drizzle ORM for Cloudflare D1
- **Context:** The original architecture document presents raw SQL migration files and uses manual `c.env.DB.prepare(...).bind(...)` calls.
- **Decision:** Adopt **Drizzle ORM (`drizzle-orm/d1`)** and `drizzle-kit` for schema declaration, type inference, and automated SQL migration generation.
- **Rationale:** Drizzle provides 100% type safety, eliminates SQL typos, integrates natively with TypeScript types in `@remote/shared`, and generates standard D1 migration SQL files without runtime ORM overhead.

### ADR-03: Web Crypto API for Password Hashing & WebAuthn Stubs
- **Context:** Node.js native C++ modules (such as standard `bcrypt` or `argon2`) cannot run in Cloudflare Workers V8 isolates without Wasm overhead.
- **Decision:** 
  1. Use the native **Web Crypto API (`crypto.subtle`)** with **PBKDF2-HMAC-SHA256** (100,000 iterations, 16-byte cryptographically secure random salt, constant-time verification) for password hashing.
  2. Implement Username/Password + JWT auth fully in Week 2. Stub WebAuthn endpoints (`/api/auth/webauthn/*`) with HTTP 501 Not Implemented and prepared request/response structures for future phases.
- **Rationale:** Zero external dependencies, hardware-accelerated execution in V8/BoringSSL, and zero attack surface from native bindings.

### ADR-04: Cloudflare KV for Token Revocation Blacklist
- **Context:** JWT tokens are stateless, but user logout requires immediate invalidation before expiry.
- **Decision:** Store revoked token IDs (`jti`) in Cloudflare KV (`CACHE`) with key `token:revoked:<jti>` and TTL matching the token's remaining lifetime.
- **Rationale:** Low-latency edge lookup on protected endpoints; automatic key expiration prevents unbounded storage growth.

### ADR-05: Vitest with `@cloudflare/vitest-pool-workers`
- **Context:** Backend logic relies on Cloudflare-specific globals and bindings (`D1Database`, `KVNamespace`, `crypto`).
- **Decision:** Use **Vitest** with `@cloudflare/vitest-pool-workers` to execute tests directly inside Cloudflare's `workerd` runtime with local D1 and KV support.
- **Rationale:** Tests execute against real runtime semantics rather than fragile mocks, providing high-fidelity integration test coverage.

### ADR-06: Worker service name is `ponta-remote`
- **Context:** The original architecture bound the Worker service name to `remote-signaling`. The repository was later connected to Cloudflare Workers Builds (Git integration) while `wrangler.toml` still declared `name = "remote-signaling"`, producing a name mismatch between the two. Investigation of the resulting failing GitHub check run established the mechanism precisely:
  - A **Workers Builds project** (the Git-connected CI configuration) and a **Worker service** (a deployed script on the edge) are **two distinct objects**. Connecting a repository creates the former; the latter exists only after a successful `wrangler deploy`.
  - The build project's name comes from the **repository slug / dashboard project name**, not from the `wrangler.toml` `name` field. Evidence: the check run was already named `Workers Builds: ponta-remote` on commits `b15edad`, `11785bd`, and `46eaaf6` — hours before `d976b61` changed `wrangler.toml` to `ponta-remote` (verified via `git log -L 1,1:workers/signaling/wrangler.toml`).
  - The GitHub App (`cloudflare-workers-and-pages`) creates a check run on every push while the build project exists — **even when no Worker service of that name exists at all**. The check run's own output stated verbatim: `Preview creation failed: This Worker does not exist on your account.`
- **Decision:** The Worker service name is **`ponta-remote`** everywhere — `workers/signaling/wrangler.toml`, `workers/signaling/wrangler.prod.example.toml`, and the deployment guide. The npm package name (`@remote/signaling`) and the source directory (`workers/signaling`) are unchanged: they describe the code's role, not the deployed service identity.
- **Rationale:** Aligning `wrangler.toml` with the build project's name means the CLI deploy (`pnpm deploy:workers`) and the Git integration target the same service, so the first successful CLI deploy satisfies the build project's expectation instead of creating a second, divergent Worker.
- **Consequence:** Any future environment split (e.g. `[env.staging]`) must follow the same base name — `ponta-remote-staging`, not `remote-signaling-staging`.
- **Open item (not resolved by this ADR):** The Workers Builds project still fails on every push because it is configured with the repository root as its build root — where no Wrangler configuration exists — and because `workers/signaling/wrangler.toml` carries placeholder bindings (`local-db-binding`, `local-cache-binding`) unsuitable for a cloud build. Resolving it requires either disconnecting the Git integration (Dashboard → the Worker → Settings → Builds → Disconnect) or configuring the build root as `workers/signaling` with CI-appropriate bindings. The check is not a required status check on `main`, so it does not block merges.

---

## 3. Package Structure & Toolchain

### 3.1 Dependencies for `workers/signaling/package.json`

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

### 3.2 Directory Layout

```
workers/signaling/
├── wrangler.toml                 # Worker configuration & bindings
├── drizzle.config.ts             # Drizzle Kit configuration
├── vitest.config.ts              # Vitest & workerd pool configuration
├── tsconfig.json                 # TypeScript configuration
├── db/
│   └── migrations/               # Generated SQL migrations (e.g. 0000_initial.sql)
├── src/
│   ├── index.ts                  # App entry point, middleware setup, router mounting
│   ├── types.ts                  # Env bindings & Hono context variable types
│   ├── db/
│   │   ├── schema.ts             # Drizzle tables definition
│   │   └── client.ts             # Drizzle D1 client factory
│   ├── middleware/
│   │   ├── auth.ts               # JWT verification & active user validation
│   │   ├── cors.ts               # CORS configuration
│   │   └── error.ts              # Global error handler
│   ├── utils/
│   │   ├── crypto.ts             # PBKDF2 password hashing & verification
│   │   └── jwt.ts                # Token creation and verification helpers
│   └── routes/
│       ├── auth.ts               # /api/auth routes
│       ├── users.ts              # /api/users routes
│       ├── devices.ts            # /api/devices routes
│       ├── agents.ts             # /api/agents routes
│       └── sessions.ts           # /api/sessions routes
└── test/
    ├── crypto.test.ts            # Unit tests for password & token helpers
    ├── auth.test.ts              # Integration tests for auth flow & logout
    └── resources.test.ts         # Integration tests for devices, agents, sessions
```

### 3.3 Wrangler Configuration (`workers/signaling/wrangler.toml`)

```toml
name = "ponta-remote"
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

---

## 4. Database Schema (Drizzle ORM)

File: `workers/signaling/src/db/schema.ts`

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
  metadata: text('metadata'), // JSON
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
  status: text('status').notNull().default('pending'), // 'pending' | 'awaiting_approval' | 'active' | 'terminated' | 'expired'
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
```

---

## 5. Security & Authentication Architecture

### 5.1 Password Hashing Specification
- **Algorithm:** PBKDF2 with HMAC-SHA256
- **Parameters:**
  - Salt: 16 bytes generated via `crypto.getRandomValues(new Uint8Array(16))`
  - Iterations: 100,000
  - Key length: 256 bits (32 bytes)
- **Serialized Format:** `$pbkdf2$v=1$i=100000$<salt_hex>$<derived_hex>`
- **Verification:** Constant-time comparison between target hash and computed hash across all bytes.

### 5.2 Token Lifecycle & Revocation
- **Access Token:**
  - Duration: 15 minutes (`exp: Math.floor(Date.now() / 1000) + 15 * 60`)
  - Payload: `{ sub: string, username: string, type: 'access', jti: string, exp: number }`
  - Signed via Hono's `sign()` using `env.JWT_SECRET`.
- **Refresh Token:**
  - Duration: 7 days (`exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60`)
  - Payload: `{ sub: string, type: 'refresh', jti: string, exp: number }`
  - Signed via Hono's `sign()` using `env.REFRESH_TOKEN_SECRET`.
- **Revocation via KV Cache:**
  - On `/api/auth/logout`: Calculate remaining TTL (`exp - now`). If TTL > 0, store in KV:
    `CACHE.put("token:revoked:" + jti, "1", { expirationTtl: Math.max(60, ttl) })`
  - On protected routes: Check KV key. If key exists, reject with HTTP 401 Unauthorized.

---

## 6. REST API Endpoints Specification

### 6.1 Authentication Routes (`/api/auth`)

| Endpoint | Method | Auth | Request Body | Success Response | Error Codes |
|----------|--------|------|--------------|------------------|-------------|
| `/api/auth/register` | POST | None | `{ username, email, password, publicKey }` | `201 Created` `{ user, token, refreshToken, expiresIn }` | 400 (validation), 409 (username/email exists) |
| `/api/auth/login` | POST | None | `{ username, password }` | `200 OK` `{ user, token, refreshToken, expiresIn }` | 400 (missing fields), 401 (invalid credentials / inactive) |
| `/api/auth/refresh` | POST | None | `{ refreshToken }` | `200 OK` `{ token, refreshToken, expiresIn }` | 400 (missing token), 401 (invalid/revoked token) |
| `/api/auth/logout` | POST | Bearer | Optional `{ refreshToken }` | `200 OK` `{ success: true }` | 401 (missing/invalid token) |
| `/api/auth/webauthn/options` | POST | None | `{ username }` | `501 Not Implemented` `{ error: "WebAuthn will be supported in Phase 2" }` | 501 |
| `/api/auth/webauthn/verify` | POST | None | `{ credential }` | `501 Not Implemented` `{ error: "WebAuthn will be supported in Phase 2" }` | 501 |

### 6.2 User Profile (`/api/users`)

| Endpoint | Method | Auth | Request Body | Success Response | Error Codes |
|----------|--------|------|--------------|------------------|-------------|
| `/api/users/me` | GET | Bearer | None | `200 OK` `{ user }` | 401 (unauthorized) |

### 6.3 Devices (`/api/devices`)

| Endpoint | Method | Auth | Request Body | Success Response | Error Codes |
|----------|--------|------|--------------|------------------|-------------|
| `/api/devices` | GET | Bearer | None | `200 OK` `Device[]` | 401 |
| `/api/devices` | POST | Bearer | `{ fingerprint, deviceName, deviceType }` | `201 Created` `Device` | 400, 401 |
| `/api/devices/:id` | DELETE | Bearer | None | `200 OK` `{ success: true }` | 401, 404 |

### 6.4 Agents (`/api/agents`)

| Endpoint | Method | Auth | Request Body | Success Response | Error Codes |
|----------|--------|------|--------------|------------------|-------------|
| `/api/agents` | GET | Bearer | None | `200 OK` `Agent[]` | 401 |
| `/api/agents` | POST | Bearer | `{ id, hostname, platform, osVersion, agentVersion, publicKey }` | `201 Created` `Agent` | 400, 401, 409 |
| `/api/agents/:id` | GET | Bearer | None | `200 OK` `Agent` | 401, 404 |

### 6.5 Sessions (`/api/sessions`)

| Endpoint | Method | Auth | Request Body | Success Response | Error Codes |
|----------|--------|------|--------------|------------------|-------------|
| `/api/sessions` | GET | Bearer | None | `200 OK` `Session[]` | 401 |
| `/api/sessions` | POST | Bearer | `{ deviceId, agentId }` | `201 Created` `Session` | 400, 401, 404 (device/agent not found) |
| `/api/sessions/:id` | GET | Bearer | None | `200 OK` `Session` | 401, 404 |
| `/api/sessions/:id` | DELETE | Bearer | None | `200 OK` `{ success: true }` | 401, 404 |

### 6.6 Standard Error Format
All errors return consistent JSON:
```json
{
  "error": "Human-readable description of error",
  "code": "ERROR_CODE_STRING",
  "details": null
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests (`workers/signaling/test/crypto.test.ts`)
- Verify PBKDF2 hashing formats salt and derived key correctly.
- Verify identical password matches hash.
- Verify tampered password fails verification.
- Verify JWT signing and decoding with expiration checks.

### 7.2 Integration Tests (`workers/signaling/test/auth.test.ts`)
- `POST /api/auth/register` creates user and persists to D1.
- `POST /api/auth/register` with duplicate username fails with 409.
- `POST /api/auth/login` returns valid JWT tokens and user profile.
- `POST /api/auth/login` with wrong password fails with 401.
- `GET /api/users/me` with valid Bearer token returns 200 and user data.
- `GET /api/users/me` without Bearer token returns 401.
- `POST /api/auth/logout` revokes access token; subsequent calls return 401.
- `POST /api/auth/refresh` issues a fresh access token.

### 7.3 Resource Tests (`workers/signaling/test/resources.test.ts`)
- Device registration, list, and deletion.
- Agent registration, list, and single fetch.
- Session creation, status transitions, and termination.

---

## 8. CI Pipeline & Turborepo Verification

### 8.1 Turborepo Pipeline (`turbo.json`)
Include `test` task:
```json
{
  "tasks": {
    "lint": {},
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "test": {}
  }
}
```

### 8.2 GitHub Actions Workflow (`.github/workflows/ci.yml`)
Add test step:
```yaml
      - name: Run workspace tests
        run: pnpm test
```

---

## 9. Review Focus & Edge Cases

1. **Token Timing Attack Protection:** Password comparisons must use constant-time XOR comparison to prevent timing side-channels.
2. **Revoked Token Replay:** Ensure KV lookup occurs before any database operation in `authMiddleware`.
3. **Database Cascade Deletions:** When a user is deleted, all owned devices, agents, and sessions must cascade-delete properly.
4. **Inactive Users:** Inactive users (`isActive === false`) must be blocked at login and their tokens immediately rejected by `authMiddleware`.
5. **JSON Payload Validation:** Malformed or empty JSON bodies must return structured 400 responses without crashing the worker.
