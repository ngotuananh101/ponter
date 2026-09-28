# Self-Hosted Docker Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare Workers backend with a self-hosted, stateful Dockerized Node.js backend (`apps/server`) with SQLite storage, in-memory WebSocket signaling, dynamic STUN/TURN credentials, and three Docker Compose configurations (Local, Cloudflare Tunnel, Production VPS).

**Architecture:** Node.js 24 LTS running Hono via `@hono/node-server` and `ws` WebSocketServer. SQLite via `better-sqlite3` and `drizzle-orm` for persistent storage at `/app/data/remote.db`. WebRTC signals are dispatched instantaneously across in-memory agent sockets (`Map<agentId, AgentConnection>`), completely eliminating isolate boundaries and subrequest limits.

**Tech Stack:** Node.js 24, TypeScript 5.8+, Hono 4+, `@hono/node-server`, `ws`, `better-sqlite3`, `drizzle-orm`, Docker, Docker Compose, Coturn, Caddy.

**Spec:** `docs/superpowers/specs/2026-09-28-self-hosted-docker-backend-design.md`

## Global Constraints
- Runtime: Node.js 24 LTS (native ES Modules).
- Monorepo: pnpm workspaces with Turborepo (`apps/server`).
- Database: SQLite local file mounted at `/app/data/remote.db` in Docker, with automatic WAL mode enabled (`PRAGMA journal_mode = WAL;`).
- Zero Cloudflare Workers runtime dependencies in `apps/server` (no `workerd`, no D1, no KV bindings).
- Backward compatibility: The REST API and WebSocket wire protocol must remain 100% compatible with existing `apps/web`, `packages/shared`, `packages/webrtc-core`, and `apps/agent`.

## Review Focus
1. Concurrency: SQLite WAL mode and busy timeout handling under concurrent REST requests and WebSocket heartbeat writes.
2. WebSocket Disconnect Cleanliness: Agent disconnection must mark the agent offline in DB and terminate active/pending sessions immediately without memory leaks in `agentConnections`.
3. Token Revocation: SQLite `revoked_tokens` table query performance and periodic cleanup of expired tokens.
4. ICE Servers Endpoint: Correct RFC 5766 HMAC-SHA1 credential calculation for Coturn TURN credentials.
5. Docker Multi-Stage Build: C++ build tools (`g++`, `make`, `python3`) must compile `better-sqlite3` native addon on Alpine/Debian, with devDependencies stripped from final production image.

---

### Task 1: Scaffold `apps/server` Package and Environment

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/vitest.config.ts`
- Create: `apps/server/src/types.ts`
- Create: `apps/server/src/index.ts`
- Test: `apps/server/test/health.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

**Interfaces:**
- Produces: `createApp()` function returning Hono app instance, `startServer()` starting `@hono/node-server` HTTP and WebSocket server.
- Consumes: `@remote/shared`.

- [ ] **Step 1: Update workspace configuration**
In `pnpm-workspace.yaml`, ensure `apps/*` and `packages/*` are included.
In root `package.json`, update scripts to add `"dev:server": "pnpm --filter @remote/server dev"`, `"test:server": "pnpm --filter @remote/server test"`.

- [ ] **Step 2: Create `apps/server/package.json`**
Define dependencies:
```json
{
  "name": "@remote/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.8",
    "@remote/shared": "workspace:*",
    "better-sqlite3": "^11.8.1",
    "drizzle-orm": "^0.45.3",
    "hono": "^4.13.9",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^24.13.6",
    "@types/ws": "^8.5.14",
    "drizzle-kit": "^0.31.11",
    "tsx": "^4.19.3",
    "typescript": "^5.8.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 3: Create `apps/server/tsconfig.json` and `vitest.config.ts`**
Configure TypeScript with `"module": "NodeNext"`, `"target": "ES2022"`, `"strict": true`.
Configure Vitest for standard Node.js test environment.

- [ ] **Step 4: Write failing health check test**
In `apps/server/test/health.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';

describe('GET /health', () => {
  it('returns status ok', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**
Run: `pnpm --filter @remote/server test`
Expected: FAIL (Cannot find module '../src/app')

- [ ] **Step 6: Implement minimal `app.ts` and `types.ts`**
Create `apps/server/src/types.ts`:
```typescript
import type { UserSelect } from './db/schema';
import type { Database } from './db/client';

export interface AppEnv {
  DATABASE_PATH: string;
  JWT_SECRET: string;
  REFRESH_TOKEN_SECRET: string;
  JWT_EXPIRES_IN?: string;
  REFRESH_TOKEN_EXPIRES_IN?: string;
  PORT?: number;
  CORS_ORIGIN?: string;
  TURN_SECRET?: string;
  TURN_URL?: string;
  STUN_URL?: string;
}

export type Variables = {
  user: UserSelect;
  tokenPayload: { sub: string; username?: string; jti: string; type: string };
  db: Database;
};

export type AppContext = {
  Variables: Variables;
};
```
Create `apps/server/src/app.ts`:
```typescript
import { Hono } from 'hono';
import type { AppContext } from './types';
import { cors } from 'hono/cors';

export function createApp() {
  const app = new Hono<AppContext>();
  app.use('*', cors());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}
```

- [ ] **Step 7: Run test to verify it passes**
Run: `pnpm --filter @remote/server test`
Expected: PASS

- [ ] **Step 8: Commit**
```bash
git add apps/server pnpm-workspace.yaml package.json
git commit -m "feat(server): scaffold @remote/server package with Hono on Node.js"
```

---

### Task 2: SQLite Database Layer & Migrations with `better-sqlite3`

**Files:**
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/migrate.ts`
- Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Produces: `getDb(path?: string): Database`, `schema` tables: `users`, `devices`, `agents`, `sessions`, `signals`, `revokedTokens`.
- Consumes: `better-sqlite3`, `drizzle-orm/better-sqlite3`.

- [ ] **Step 1: Write failing database unit test**
In `apps/server/test/db.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../src/db/client';
import { users, revokedTokens } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Database client', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('creates tables and inserts user', async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: 'testuser',
      publicKey: 'pub_key_test',
    });

    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    expect(user).toBeDefined();
    expect(user?.username).toBe('testuser');
  });

  it('manages revoked tokens', async () => {
    const jti = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await db.insert(revokedTokens).values({ jti, expiresAt });

    const row = await db.select().from(revokedTokens).where(eq(revokedTokens.jti, jti)).get();
    expect(row).toBeDefined();
    expect(row?.jti).toBe(jti);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @remote/server test test/db.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `apps/server/src/db/schema.ts`**
Port tables from `workers/src/db/schema.ts` and add `revokedTokens`:
```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
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
  deviceType: text('device_type').notNull(),
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
  credentialHash: text('credential_hash'),
  capabilities: text('capabilities'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  endedAt: text('ended_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const signals = sqliteTable('signals', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const revokedTokens = sqliteTable('revoked_tokens', {
  jti: text('jti').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_revoked_tokens_expires').on(table.expiresAt),
]);

export type UserSelect = typeof users.$inferSelect;
export type AgentSelect = typeof agents.$inferSelect;
export type SessionSelect = typeof sessions.$inferSelect;
```

- [ ] **Step 4: Implement `apps/server/src/db/client.ts` with auto-migration**
Create `client.ts`:
- Use `better-sqlite3` with `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;`.
- Set busy timeout to 5000ms.
- Run table creation DDL on startup if not existing.
- Export `getDb(dbPath?: string)` and `closeDb()`.

- [ ] **Step 5: Run test to verify it passes**
Run: `pnpm --filter @remote/server test test/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add apps/server/src/db apps/server/test/db.test.ts
git commit -m "feat(server): implement SQLite database client and schema"
```

---

### Task 3: Authentication, Crypto & Token Revocation

**Files:**
- Create: `apps/server/src/utils/crypto.ts`
- Create: `apps/server/src/utils/jwt.ts`
- Create: `apps/server/src/middleware/auth.ts`
- Create: `apps/server/src/routes/auth.ts`
- Create: `apps/server/src/routes/users.ts`
- Test: `apps/server/test/auth.test.ts`

**Interfaces:**
- Produces: `authMiddleware`, `/api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/users/me`.
- Consumes: `users`, `revokedTokens` from Task 2.

- [ ] **Step 1: Write failing auth integration test**
In `apps/server/test/auth.test.ts`:
- Test user registration -> 201 Created with tokens.
- Test login with valid credentials -> returns accessToken and refreshToken.
- Test accessing `/api/users/me` with Bearer token -> 200 OK.
- Test logout -> token revoked; subsequent `/api/users/me` -> 401 Unauthorized.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @remote/server test test/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: Port and adapt crypto, JWT, and middleware**
- Port `workers/src/utils/crypto.ts` (PBKDF2 password hashing & SHA-256 hex via standard Web Crypto).
- Port `workers/src/utils/jwt.ts` (Token signing & verification).
- Implement `apps/server/src/middleware/auth.ts`: checks Bearer header, verifies JWT, checks `revokedTokens` table, attaches `user` and `tokenPayload` to Hono context.
- Implement `apps/server/src/routes/auth.ts` and `apps/server/src/routes/users.ts`.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm --filter @remote/server test test/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/utils apps/server/src/middleware apps/server/src/routes/auth.ts apps/server/src/routes/users.ts apps/server/test/auth.test.ts
git commit -m "feat(server): implement authentication, JWT, and token revocation"
```

---

### Task 4: Agents, Devices & Sessions Management

**Files:**
- Create: `apps/server/src/routes/agents.ts`
- Create: `apps/server/src/routes/devices.ts`
- Create: `apps/server/src/routes/sessions.ts`
- Test: `apps/server/test/agents-sessions.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/agents` (register agent, issue credential `ag_...`)
  - `GET /api/agents` (list user's agents with online status)
  - `DELETE /api/agents/:id`
  - `POST /api/sessions` (start new session for an agent)
  - `GET /api/sessions/:id` (session status)
  - `DELETE /api/sessions/:id` (terminate session)
- Consumes: DB schema from Task 2, `authMiddleware` from Task 3.

- [ ] **Step 1: Write failing agent & session tests**
In `apps/server/test/agents-sessions.test.ts`:
- Register agent -> receives `id`, `credential`.
- Verify `agents` table stores SHA-256 hash of credential.
- Create session for agent -> returns `sessionId` with status `pending`.
- List sessions -> returns session with agent details.
- Terminate session -> marks `status = 'terminated'` and `ended_at = now()`.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @remote/server test test/agents-sessions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `agents.ts`, `devices.ts`, `sessions.ts`**
Port business logic from `workers/src/routes/agents.ts`, `devices.ts`, `sessions.ts`.
Ensure tenancy guards and UUID validations match spec.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm --filter @remote/server test test/agents-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/server/src/routes/agents.ts apps/server/src/routes/devices.ts apps/server/src/routes/sessions.ts apps/server/test/agents-sessions.test.ts
git commit -m "feat(server): implement agents, devices, and sessions management"
```

---

### Task 5: WebRTC Signaling, In-Memory WebSocket Dispatcher & ICE Servers

**Files:**
- Create: `apps/server/src/utils/signals.ts`
- Create: `apps/server/src/routes/ws.ts`
- Create: `apps/server/src/routes/signal.ts`
- Create: `apps/server/src/routes/webrtc.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/signaling.test.ts`

**Interfaces:**
- Produces:
  - WebSocket server at `/api/ws/agent` with in-memory `agentConnections: Map<string, AgentConnection>`
  - `pushToAgent(agentId: string, message: SignalMessage): boolean`
  - `POST /api/signal/offer`, `POST /api/signal/answer`, `POST /api/signal/ice-candidate`
  - `GET /api/signal/poll/:sessionId` (fallback polling transport)
  - `GET /api/webrtc/ice-servers` (dynamic STUN/TURN credentials)
- Consumes: `sessions`, `signals`, `agents` from Task 2.

- [ ] **Step 1: Write failing signaling and WebSocket test**
In `apps/server/test/signaling.test.ts`:
- Start HTTP + WebSocket server on ephemeral port (`listen(0)`).
- Agent connects via WebSocket with Bearer credential.
- Agent sends `{ type: "ping" }` -> server responds `{ type: "pong" }` and updates `agents.last_ping_at` in DB.
- Browser posts `POST /api/signal/offer` -> Agent WebSocket **instantly** receives `{ type: "signal", data: { type: "offer", ... } }`.
- Agent sends answer back on WebSocket -> Signal recorded in DB.
- Browser polls `GET /api/signal/poll/:sessionId` -> receives answer.
- Test `GET /api/webrtc/ice-servers` -> returns STUN server and TURN credentials if secret configured.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @remote/server test test/signaling.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `apps/server/src/routes/ws.ts`**
- Set up Node.js `ws` WebSocketServer.
- Authenticate agent using `Authorization: Bearer ag_...` header.
- Store connection in `agentConnections = new Map<string, AgentConnection>()`.
- Handle ping/pong heartbeats: update `isOnline = true` and `lastPingAt = NOW` in DB.
- On close: remove from `agentConnections`, update `isOnline = false`, terminate active sessions for agent.
- Export `pushToAgent(agentId, message)`.

- [ ] **Step 4: Implement `apps/server/src/routes/signal.ts` and `webrtc.ts`**
- `signal.ts`: Offer, Answer, ICE Candidate handlers that record signal in DB and immediately invoke `pushToAgent()`.
- `webrtc.ts`: Generate RFC 5766 HMAC-SHA1 credentials:
  ```typescript
  import { createHmac } from 'node:crypto';
  const username = `${Math.floor(Date.now() / 1000) + 86400}:${user.id}`;
  const hmac = createHmac('sha1', turnSecret);
  hmac.update(username);
  const credential = hmac.digest('base64');
  ```

- [ ] **Step 5: Attach WebSocketServer to HTTP server in `apps/server/src/index.ts`**
Handle `server.on('upgrade')`: If `url === '/api/ws/agent'`, route to WebSocketServer; otherwise destroy socket.

- [ ] **Step 6: Run test to verify it passes**
Run: `pnpm --filter @remote/server test test/signaling.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**
```bash
git add apps/server/src/routes/ws.ts apps/server/src/routes/signal.ts apps/server/src/routes/webrtc.ts apps/server/src/index.ts apps/server/test/signaling.test.ts
git commit -m "feat(server): implement in-memory WebSocket signaling and ICE servers endpoint"
```

---

### Task 6: Docker Packaging & Compose Setups

**Files:**
- Create: `docker/Dockerfile.server`
- Create: `docker/docker-compose.local.yml`
- Create: `docker/docker-compose.tunnel.yml`
- Create: `docker/docker-compose.prod.yml`
- Create: `docker/Caddyfile`
- Create: `docker/.env.example`
- Create: `docker/README.md`
- Test: Build and run test container using Docker CLI.

**Interfaces:**
- Produces: Runnable Docker container and 3 docker-compose deployment options.

- [ ] **Step 1: Write `docker/Dockerfile.server`**
Multi-stage build:
```dockerfile
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder
RUN apk add --no-cache python3 make g++ gcc
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @remote/server build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache python3 make g++ gcc
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/packages/ ./packages/

VOLUME /app/data
ENV DATABASE_PATH=/app/data/remote.db
ENV PORT=8787

EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
```

- [ ] **Step 2: Create `docker/docker-compose.local.yml`**
Configured with service `server` on port `8787:8787`, SQLite volume `./data:/app/data`.

- [ ] **Step 3: Create `docker/docker-compose.tunnel.yml`**
Configured with service `server` and service `cloudflared` (using `TUNNEL_TOKEN`).

- [ ] **Step 4: Create `docker/docker-compose.prod.yml` and `docker/Caddyfile`**
Configured with service `server`, service `coturn` (STUN/TURN with `TURN_SECRET`), and service `caddy` (Let's Encrypt reverse proxy).

- [ ] **Step 5: Verify Docker build locally**
Run: `docker build -f docker/Dockerfile.server -t remote-server:test .`
Expected: Successfully built image.

- [ ] **Step 6: Commit**
```bash
git add docker/
git commit -m "feat(docker): add multi-stage Dockerfile and 3 compose setups (local, tunnel, prod)"
```

---

### Task 7: Update Documentation & CI/CD Pipeline

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/guides/deployment.md`
- Modify: `docs/guides/development.md`
- Modify: `docs/guides/agent-setup.md`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Update `docs/ARCHITECTURE.md`**
Replace Cloudflare Serverless edge diagrams with Self-hosted Node.js + SQLite and Coturn TURN architecture.
Detail the in-memory WebSocket dispatch mechanism.

- [ ] **Step 2: Update `docs/guides/deployment.md`**
Document running with `docker-compose.local.yml`, `docker-compose.tunnel.yml`, and `docker-compose.prod.yml`.
Document deploying the frontend `apps/web` to Cloudflare Pages.

- [ ] **Step 3: Update `docs/guides/development.md` and `docs/guides/agent-setup.md`**
Replace `wrangler dev` commands with `pnpm --filter @remote/server dev`.
Update agent connection strings to `ws://localhost:8787/api/ws/agent`.

- [ ] **Step 4: Update root `README.md` and `docs/README.md`**
Update project summary, technology stack, and quickstart commands.

- [ ] **Step 5: Update GitHub Actions workflows**
- In `.github/workflows/ci.yml`: test `apps/server`, verify Docker build.
- In `.github/workflows/deploy.yml`: remove `deploy-backend` Cloudflare worker job, keep `deploy-frontend` for Cloudflare static assets.

- [ ] **Step 6: Commit**
```bash
git add docs/ README.md .github/workflows/
git commit -m "docs(all): update architecture, deployment guides, and CI/CD for self-hosted backend"
```

---

### Task 8: Full Monorepo Lint, Typecheck, and End-to-End Verification

**Files:**
- All touched files

- [ ] **Step 1: Run typecheck across the monorepo**
Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run linter across the monorepo**
Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 3: Run all unit and integration tests**
Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Final commit and summary**
```bash
git commit --allow-empty -m "chore: complete self-hosted docker backend migration"
```
