# Phase 5 Week 12 — Auth Hardening (WS4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the WS4 auth-hardening findings from the Phase 5 audit — login rate limiting and lockout (H9), refresh-token rotation with reuse detection (H10, 5.2), fail-fast secret validation (M9), a safe `CORS_ORIGIN` allowlist (H8, M12), revocation enforcement on WebSocket upgrade and on live sockets (M10, M11) — and remove the four false E2EE/Zero-Trust labels from the UI (§4.1).

**Architecture:** WS4 is Layer 1 of the three-layer Phase 5 design: it has no prerequisites and every later workstream builds on it. All work is server-side (`apps/server`) plus four one-line copy changes in `apps/web`. No crypto is introduced; the data path is untouched. Each defect is closed with a failing test first, then the smallest change that makes it pass, so a reviewer can reject one task without disturbing its neighbours.

**Tech Stack:** TypeScript, Hono 4.x, Drizzle ORM, better-sqlite3, `ws`, Vitest, Vue 3 (copy only).

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§3.1, §4.1, §5, §7)

## Global Constraints

- **Layer order is a gate.** WS4 is Layer 1 and MUST NOT depend on WS2/WS3/WS1. Do not start peer-identity or E2EE work in this plan.
- **Schedule:** Week 12 of Weeks 12–16. Security takes priority over feature schedule (owner decision 2026-10-05).
- **Do not regress the 19 verified-good controls** (spec §2.1): PBKDF2 with constant-time comparison, JWT HS256 with type/scope separation, SQLite revocation, single-use 15-second WebSocket tickets, CSPRNG usage, per-user tenancy scoping, the `4409` stale-guard (`apps/server/src/routes/ws.ts:736`), and the `1001` graceful-shutdown close. Every task below must leave them working.
- **UI copy must be true today** (spec §4.1, exit gate G2). The four labels in Task 6 currently assert protections that do not exist and must not be replaced with other unearned claims.
- **No new runtime dependency.** Rate limiting, rotation, and validation are implemented with the standard library and the existing `better-sqlite3` store. Do not add a rate-limit or JWT package.
- **Secrets never enter logs.** A rejected WebSocket upgrade already logs only the path (never the ticket); keep that property.
- **Commit discipline:** path-limited commits only (`git commit -m "..." -- <paths>`). Never `git add .`.
- **Language:** code, commit messages, and technical docs in English.

## Review Focus

The failure modes the spec implies but no single task's happy-path test exercises. Each line's test is added in the owning task.

1. **Lockout keyed only by username (victim lockout / shared IP).** An attacker failing logins on a victim's username from their own address must not stop the victim logging in from a different address; the key must combine client IP and username. → Task 3.
2. **Multi-tab concurrent refresh revokes the family.** Two tabs presenting the same refresh token at once must not trigger reuse detection; a short grace window returns the already-issued replacement instead of revoking. → Task 4.
3. **Production wildcard CORS boots silently.** `CORS_ORIGIN` unset or `*` under `NODE_ENV=production` must abort startup, not fall back to "allow everything". → Task 2.
4. **A live socket outlives revocation.** Deactivating, rejecting, or logging out a user must close that user's open browser sockets, not merely prevent new ones. → Task 5.
5. **A missing or short secret fails at first request, not at boot.** The process must refuse to start when a secret is absent or too short, rather than reporting healthy and 500-ing on the first login. → Task 1.

---

### Task 1: Fail-fast startup validation of secrets (M9)

**Files:**
- Create: `apps/server/src/utils/validate-env.ts`
- Modify: `apps/server/src/index.ts:220` (`startServer`)
- Modify: `apps/server/src/middleware/auth.ts:31`
- Test: `apps/server/test/validate-env.test.ts`

**Interfaces:**
- Produces: `validateEnv(env?: EnvLike): void` and `MIN_SECRET_LENGTH: number`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/validate-env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateEnv, MIN_SECRET_LENGTH } from '../src/utils/validate-env';

const JWT = 'a'.repeat(40);
const REFRESH = 'b'.repeat(40);

describe('validateEnv', () => {
  it('accepts two distinct secrets at or above the minimum length', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() =>
      validateEnv({ REFRESH_TOKEN_SECRET: REFRESH }),
    ).toThrow(/JWT_SECRET/);
  });

  it('throws when a secret is shorter than the minimum', () => {
    expect(() =>
      validateEnv({
        JWT_SECRET: 'short',
        REFRESH_TOKEN_SECRET: REFRESH,
      }),
    ).toThrow(/at least/);
  });

  it('throws when the two secrets are identical', () => {
    expect(() =>
      validateEnv({ JWT_SECRET: JWT, REFRESH_TOKEN_SECRET: JWT }),
    ).toThrow(/must differ/);
  });

  it('exposes a minimum length of 32', () => {
    expect(MIN_SECRET_LENGTH).toBe(32);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test -- validate-env`
Expected: FAIL — `Cannot find module '../src/utils/validate-env'`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/utils/validate-env.ts`:

```ts
/**
 * Fail-fast validation of the secrets the server cannot run without.
 *
 * `getJwtSecret()` already throws when `JWT_SECRET` is unset, but "first use"
 * is the first login request — in production, minutes after boot, with the
 * process reporting healthy. A misconfigured deploy must fail where an
 * operator is watching, so `startServer` calls this before it listens.
 *
 * Plain `Error`, not `AppError`: this runs at startup, where the only correct
 * outcome is a non-zero exit, not a JSON response.
 */

/** Minimum HMAC secret length. 32 chars ≈ 256 bits of ASCII entropy. */
export const MIN_SECRET_LENGTH = 32;

export interface EnvLike {
  NODE_ENV?: string;
  JWT_SECRET?: string;
  REFRESH_TOKEN_SECRET?: string;
  CORS_ORIGIN?: string;
}

export function validateEnv(env: EnvLike = process.env): void {
  requireSecret('JWT_SECRET', env.JWT_SECRET);
  requireSecret('REFRESH_TOKEN_SECRET', env.REFRESH_TOKEN_SECRET);

  // A shared secret would let an access token be replayed as a refresh token
  // and vice versa, silently defeating the type separation `verifyTokenForUser`
  // enforces. Two names, one value, is always a misconfiguration.
  if (env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
    throw new Error(
      'JWT_SECRET and REFRESH_TOKEN_SECRET must differ; the same value for ' +
        'both defeats access/refresh token separation',
    );
  }
}

function requireSecret(name: string, value: string | undefined): void {
  if (!value) {
    throw new Error(
      `${name} is not set. Generate one with \`openssl rand -base64 48\`.`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length}).`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test -- validate-env`
Expected: PASS (5 tests).

- [ ] **Step 5: Call `validateEnv` from `startServer`**

In `apps/server/src/index.ts`, add the import near the other `utils` imports (after line 17):

```ts
import { validateEnv } from './utils/validate-env.js';
```

Then make `startServer` (line 220) validate before it touches the network:

```ts
export function startServer(port?: number) {
  // Before anything binds a port: a missing or weak secret must stop the
  // process here, not surface as a 500 on the first login.
  validateEnv();

  const portNum = port ?? (Number(process.env.PORT) || 8080);
  const { server } = createSignalingServer();
  // ... unchanged from here ...
```

- [ ] **Step 6: Remove the non-null assertion in the auth middleware**

In `apps/server/src/middleware/auth.ts`, add the import beside the existing `verifyTokenForUser` import (line 4):

```ts
import { getJwtSecret } from '../utils/env.js';
```

Replace the `process.env.JWT_SECRET!` argument at line 31 with the getter, so a missing secret raises the shared `AppError(500)` instead of being asserted non-null:

```ts
  const { payload, user } = await verifyTokenForUser(
    c,
    token,
    getJwtSecret(),
    'access',
    {
```

- [ ] **Step 7: Run the server suite**

Run: `pnpm --filter @ponter/server test`
Expected: FAIL in `startup-db.test.ts` — it calls `startServer(0)` with no secrets, and `validateEnv()` now refuses to boot. Fix it in the next step.

- [ ] **Step 8: Give the startup test a valid environment**

`apps/server/test/startup-db.test.ts` runs in its own isolated Vitest environment, so the module-level `process.env.JWT_SECRET` set in `auth.test.ts` does not reach it. Add the two secrets at the top of the file, after the imports (line 9):

```ts
// `startServer` now validates its environment before listening, so the test
// must supply the secrets a real deployment would.
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';
```

- [ ] **Step 9: Run the server suite again**

Run: `pnpm --filter @ponter/server test`
Expected: PASS — the new file passes, `startup-db.test.ts` boots, and no other auth test regresses.

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(server): validate secrets at startup (M9)" -- \
  apps/server/src/utils/validate-env.ts \
  apps/server/test/validate-env.test.ts \
  apps/server/src/index.ts \
  apps/server/src/middleware/auth.ts \
  apps/server/test/startup-db.test.ts
```

---

### Task 2: `CORS_ORIGIN` allowlist with no wildcard in production (H8, M12)

**Files:**
- Modify: `apps/server/src/utils/cors.ts` (whole file)
- Modify: `apps/server/src/utils/validate-env.ts` (add the production CORS check)
- Modify: `docker/.env.example:41`
- Modify: `docker/docker-compose.local.yml:36`
- Modify: `docker/docker-compose.nginx.yml:29`
- Test: `apps/server/test/cors.test.ts`

**Interfaces:**
- Consumes: `validateEnv` from Task 1.
- Produces: `getAllowedOrigins(env?): string[] | '*'` (unchanged signature, new default policy) and the production guard inside `validateEnv`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/cors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getAllowedOrigins } from '../src/utils/cors';
import { validateEnv } from '../src/utils/validate-env';

const JWT = 'a'.repeat(40);
const REFRESH = 'b'.repeat(40);

describe('getAllowedOrigins', () => {
  it('parses a comma-separated allowlist', () => {
    expect(
      getAllowedOrigins({ CORS_ORIGIN: 'https://a.test, https://b.test' }),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('returns * only when the variable is unset or explicitly *', () => {
    expect(getAllowedOrigins({})).toBe('*');
    expect(getAllowedOrigins({ CORS_ORIGIN: '*' })).toBe('*');
  });
});

describe('validateEnv — CORS in production', () => {
  it('throws when CORS_ORIGIN is unset in production', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', JWT_SECRET: JWT, REFRESH_TOKEN_SECRET: REFRESH }),
    ).toThrow(/CORS_ORIGIN/);
  });

  it('throws on a wildcard CORS_ORIGIN in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        CORS_ORIGIN: '*',
      }),
    ).toThrow(/CORS_ORIGIN/);
  });

  it('allows an unset CORS_ORIGIN outside production (dev convenience)', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'development', JWT_SECRET: JWT, REFRESH_TOKEN_SECRET: REFRESH }),
    ).not.toThrow();
  });

  it('allows an explicit allowlist in production', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: JWT,
        REFRESH_TOKEN_SECRET: REFRESH,
        CORS_ORIGIN: 'https://app.example.com',
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test -- cors`
Expected: FAIL — the production CORS cases do not throw yet.

- [ ] **Step 3: Extend `validateEnv` with the production CORS guard**

In `apps/server/src/utils/validate-env.ts`, add this block at the end of `validateEnv`, after the shared-secret check:

```ts
  // The Origin header is the CSWSH defence for the browser WebSocket upgrade
  // (`routes/ws.ts`). A wildcard turns that defence off, and an unset variable
  // used to mean the same thing silently. In production both are refused here,
  // at boot, so a deploy cannot ship with cross-site sockets open.
  if (env.NODE_ENV === 'production') {
    const cors = env.CORS_ORIGIN?.trim();
    if (!cors || cors === '*') {
      throw new Error(
        'CORS_ORIGIN must be an explicit allowlist in production; a wildcard ' +
          'or an unset value is refused',
      );
    }
  }
```

- [ ] **Step 4: Document the new `getAllowedOrigins` policy**

Replace the body and doc-comment of `apps/server/src/utils/cors.ts` with:

```ts
/**
 * The allowed browser origins, from `CORS_ORIGIN`.
 *
 * Extracted from the CORS middleware in `app.ts` so the WebSocket upgrade
 * handler applies the same policy: the browser socket is authenticated by a
 * query-string ticket, which CORS does not protect, so Origin is the CSWSH
 * defence and must agree with what the REST API accepts.
 *
 * `'*'` means "no allowlist". It is returned only when the variable is unset
 * or explicitly `'*'`; `validateEnv` refuses both under `NODE_ENV=production`,
 * so a wildcard can only ever take effect in a development environment where
 * the operator asked for it. Outside production an unset value stays `'*'` so
 * `pnpm dev` needs no configuration.
 */
export function getAllowedOrigins(
  env: { CORS_ORIGIN?: string } = process.env,
): string[] | '*' {
  const corsOrigin = env.CORS_ORIGIN?.trim();
  if (!corsOrigin || corsOrigin === '*') return '*';
  return corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
```

- [ ] **Step 5: Run the CORS tests and the WebSocket origin tests**

Run: `pnpm --filter @ponter/server test -- cors ws-browser`
Expected: PASS. The existing `accepts any Origin when CORS_ORIGIN is *` test still passes because Vitest sets no `NODE_ENV=production`.

- [ ] **Step 6: Stop shipping a wildcard in the deployment files**

In `docker/.env.example`, replace line 40-42:

```
# Local dev: accept from anywhere.
CORS_ORIGIN=*
# Tunnel / Prod: restrict to your web app origin, e.g. https://app.example.com
```

with:

```
# The browser origins allowed to call the API and open the WebSocket.
# Comma-separated. REQUIRED in production — a wildcard or an unset value makes
# the server refuse to start (the Origin header is the CSWSH defence).
# Local dev may leave this unset, or set it to your web dev origin:
CORS_ORIGIN=http://localhost:5173
# Tunnel / Prod: e.g. https://app.example.com
```

In `docker/docker-compose.local.yml`, change line 36 from `CORS_ORIGIN=*` to the Vite dev origin (the local image runs `NODE_ENV=production`, so a wildcard would now abort startup):

```yaml
      - CORS_ORIGIN=http://localhost:5173
```

In `docker/docker-compose.nginx.yml`, change line 29 from `CORS_ORIGIN=${CORS_ORIGIN:-*}` to require the operator to supply it:

```yaml
      - CORS_ORIGIN=${CORS_ORIGIN:?CORS_ORIGIN must be set to an explicit allowlist}
```

- [ ] **Step 7: Run the full server suite**

Run: `pnpm --filter @ponter/server test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(server): require an explicit CORS allowlist in production (H8, M12)" -- \
  apps/server/src/utils/cors.ts \
  apps/server/src/utils/validate-env.ts \
  apps/server/test/cors.test.ts \
  docker/.env.example \
  docker/docker-compose.local.yml \
  docker/docker-compose.nginx.yml
```

---

### Task 3: Login rate limiting and lockout (H9)

**Files:**
- Create: `apps/server/src/middleware/login-rate-limit.ts`
- Modify: `apps/server/src/app.ts` (register on `/api/auth/login`)
- Test: `apps/server/test/login-rate-limit.test.ts`

**Interfaces:**
- Produces: `createLoginRateLimiter(options?: LoginRateLimitOptions): MiddlewareHandler<AppContext>`.
- Consumes: the `AppContext` type (`apps/server/src/types.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/login-rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

const REG = { password: 'Password123!', publicKey: 'pk' };

async function login(
  app: ReturnType<typeof createApp>,
  username: string,
  password: string,
  ip = '10.0.0.1',
) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...REG, username }),
  });
}

beforeEach(() => {
  closeDb();
  getDb(':memory:');
});

describe('login rate limiting', () => {
  it('returns 429 after five failed attempts from one IP', async () => {
    const app = createApp();
    await register(app, 'alice');
    for (let i = 0; i < 5; i++) {
      const res = await login(app, 'alice', 'wrong', '10.0.0.9');
      expect(res.status).toBe(401);
    }
    const blocked = await login(app, 'alice', 'wrong', '10.0.0.9');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not lock out a different IP for the same username', async () => {
    const app = createApp();
    await register(app, 'bob');
    for (let i = 0; i < 6; i++) await login(app, 'bob', 'wrong', '10.0.0.9');
    const victim = await login(app, 'bob', 'Password123!', '10.0.0.7');
    expect(victim.status).toBe(200);
  });

  it('resets the counter after a successful login', async () => {
    const app = createApp();
    await register(app, 'carol');
    for (let i = 0; i < 4; i++) await login(app, 'carol', 'wrong', '10.0.0.3');
    expect((await login(app, 'carol', 'Password123!', '10.0.0.3')).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(app, 'carol', 'wrong', '10.0.0.3');
    expect((await login(app, 'carol', 'wrong', '10.0.0.3')).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test -- login-rate-limit`
Expected: FAIL — the 429 assertion receives 401.

- [ ] **Step 3: Write the limiter**

Create `apps/server/src/middleware/login-rate-limit.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types.js';

export interface LoginRateLimitOptions {
  /** Failed attempts allowed per key before the key is blocked. */
  maxFailures?: number;
  /** How long a failure is remembered, and how long a block lasts. */
  windowMs?: number;
  /** Injectable clock, so a test can advance time without waiting. */
  now?: () => number;
}

interface Entry {
  failures: number;
  resetAt: number;
}

/**
 * Per-(IP, username) lockout for the login endpoint.
 *
 * Only 401 responses count as failures and a 200 clears the key, so a
 * legitimate user never accumulates budget: the counter measures *wrong
 * passwords*, not logins. A pending-approval 403 is not counted, because the
 * caller proved the password and the block is an account state, not a guess.
 *
 * The key includes the client IP as well as the username. Keying on the
 * username alone would let anyone lock a victim out of their own account by
 * failing logins on the victim's name; keying on IP alone would let one
 * attacker behind NAT exhaust the budget for everyone behind it.
 *
 * State is a `Map` created per call, so each `createApp()` gets an independent
 * limiter — a test cannot inherit another test's lockouts.
 */
export function createLoginRateLimiter(
  options: LoginRateLimitOptions = {},
): MiddlewareHandler<AppContext> {
  const maxFailures = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  return async (c, next) => {
    const key = `${clientIp(c)}|${await peekUsername(c)}`;
    const t = now();
    const entry = entries.get(key);

    if (entry && entry.failures >= maxFailures && t < entry.resetAt) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      return c.json(
        {
          error: 'Too many login attempts. Try again later.',
          code: 'TOO_MANY_REQUESTS',
          details: { retryAfter },
        },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    if (entry && t >= entry.resetAt) entries.delete(key);

    await next();

    if (c.res.status === 401) {
      const current = entries.get(key);
      const base =
        current && t < current.resetAt
          ? current
          : { failures: 0, resetAt: t + windowMs };
      base.failures += 1;
      entries.set(key, base);
    } else if (c.res.status === 200) {
      entries.delete(key);
    }
  };
}

/** The client address, honouring the proxy header a deployment terminates on. */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // `X-Forwarded-For` is trusted here because the only deployment that sets it
  // is the bundled reverse proxy, which overwrites it. A deployment exposed
  // directly to the internet would let a client forge the header and dodge the
  // limiter; that deployment must set the header at its own edge or remove
  // this branch.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Read the username without consuming the request body.
 *
 * The login handler reads the body itself, and a Hono request body can be read
 * once, so this clones the underlying `Request` before parsing. A body that is
 * absent or not JSON yields `''`, which still participates in the key.
 */
async function peekUsername(c: {
  req: { raw: Request };
}): Promise<string> {
  try {
    const body = (await c.req.raw.clone().json()) as { username?: unknown };
    return typeof body?.username === 'string'
      ? body.username.trim().toLowerCase()
      : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test -- login-rate-limit`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the limiter**

In `apps/server/src/app.ts`, add the import beside the other middleware imports (after line 4):

```ts
import { createLoginRateLimiter } from './middleware/login-rate-limit.js';
```

Register it on the login route only, after the database middleware (line 38) and before the route mounts:

```ts
  // Scoped to the login path: every other route is authenticated and does not
  // need a guess-budget. Created per app so tests get independent state.
  app.use('/api/auth/login', createLoginRateLimiter());
```

- [ ] **Step 6: Run the full server suite**

Run: `pnpm --filter @ponter/server test`
Expected: PASS — `auth.test.ts` performs few enough failed logins per username/IP to stay under the limit.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(server): rate-limit and lock out repeated failed logins (H9)" -- \
  apps/server/src/middleware/login-rate-limit.ts \
  apps/server/test/login-rate-limit.test.ts \
  apps/server/src/app.ts
```

---

### Task 4: Refresh-token rotation with reuse detection (H10, 5.2)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (add `refreshTokens`)
- Modify: `apps/server/src/db/client.ts` (DDL)
- Modify: `apps/server/src/utils/jwt.ts` (`signRefreshToken` family id; `TokenPayload.fam`)
- Create: `apps/server/src/utils/refresh-tokens.ts`
- Modify: `apps/server/src/routes/auth.ts` (register, login, refresh, logout)
- Test: `apps/server/test/refresh-rotation.test.ts`

**Interfaces:**
- Produces: `signRefreshToken(userId, secret, expiresInSeconds?, familyId?): Promise<{ token, jti, exp, familyId }>`; helpers `storeRefreshToken`, `findRefreshToken`, `markRefreshTokenUsed`, `revokeFamily`, `getReuseGraceMs`.
- Consumes: `signRefreshToken` call sites in `routes/auth.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/refresh-rotation.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

async function register(app: ReturnType<typeof createApp>, username: string) {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Password123!', publicKey: 'pk' }),
  });
  return (await res.json()) as { token: string; refreshToken: string };
}

async function refresh(app: ReturnType<typeof createApp>, refreshToken: string) {
  const res = await app.request('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

beforeEach(() => {
  closeDb();
  getDb(':memory:');
  vi.unstubAllEnvs();
});

describe('refresh token rotation', () => {
  it('issues a different refresh token on each use', async () => {
    const app = createApp();
    const { refreshToken } = await register(app, 'alice');
    const first = await refresh(app, refreshToken);
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(refreshToken);
    const second = await refresh(app, first.body.refreshToken!);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
  });

  it('returns the same replacement inside the grace window (multi-tab)', async () => {
    const app = createApp();
    const { refreshToken } = await register(app, 'bob');
    const first = await refresh(app, refreshToken);
    const retry = await refresh(app, refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.refreshToken).toBe(first.body.refreshToken);
  });

  it('revokes the family when a rotated token is reused after the grace window', async () => {
    vi.stubEnv('REFRESH_REUSE_GRACE_MS', '0');
    const app = createApp();
    const { refreshToken } = await register(app, 'carol');
    const first = await refresh(app, refreshToken);
    const reuse = await refresh(app, refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    // The family is dead: the replacement is now rejected too.
    const after = await refresh(app, first.body.refreshToken!);
    expect(after.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test -- refresh-rotation`
Expected: FAIL — `refreshToken` is returned unchanged and reuse is not detected.

- [ ] **Step 3: Add the `refresh_tokens` table**

In `apps/server/src/db/schema.ts`, add after the `revokedTokens` table (line 122):

```ts
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    jti: text('jti').primaryKey(),
    familyId: text('family_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    /** Unix **milliseconds** at which this token was rotated; null while current. */
    usedAt: integer('used_at'),
    /** The token this one was rotated into, replayed inside the grace window. */
    replacedByToken: text('replaced_by_token'),
    replacedByExpiresAt: integer('replaced_by_expires_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_refresh_tokens_family').on(table.familyId)],
);
```

In `apps/server/src/db/client.ts`, add the DDL inside the `createTables` template (after the `revoked_tokens` block, line 88):

```sql
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      jti TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      replaced_by_token TEXT,
      replaced_by_expires_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
```

- [ ] **Step 4: Give refresh tokens a family id**

In `apps/server/src/utils/jwt.ts`, add `fam` to `TokenPayload` (after the `scope` field, line 52):

```ts
  /** Refresh-token family id. Present on `type: 'refresh'` tokens only. */
  fam?: string;
```

Replace `signRefreshToken` (line 177) with:

```ts
export async function signRefreshToken(
  userId: string,
  secret: string,
  expiresInSeconds = 604800, // 7 days
  familyId: string = crypto.randomUUID(),
): Promise<{ token: string; jti: string; exp: number; familyId: string }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    type: 'refresh',
    jti,
    exp,
    fam: familyId,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp, familyId };
}
```

- [ ] **Step 5: Write the store helpers**

Create `apps/server/src/utils/refresh-tokens.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';

/**
 * How long a rotated token may be replayed and still return its replacement.
 *
 * Two tabs share one `localStorage` and can refresh at the same instant; the
 * second request presents a token the first has just rotated. Without this
 * window that race would look exactly like theft and revoke the family,
 * logging the user out. Ten seconds is far longer than a round trip and far
 * shorter than any realistic replay window.
 *
 * Read through a function, not a module-level constant, so an operator (or a
 * test) can change `REFRESH_REUSE_GRACE_MS` without re-importing the module.
 */
export function getReuseGraceMs(): number {
  const raw = Number(process.env.REFRESH_REUSE_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}

export interface StoredRefreshToken {
  jti: string;
  familyId: string;
  userId: string;
  expiresAt: number;
}

export async function storeRefreshToken(
  db: Database,
  token: StoredRefreshToken,
): Promise<void> {
  await db.insert(refreshTokens).values({
    jti: token.jti,
    familyId: token.familyId,
    userId: token.userId,
    expiresAt: token.expiresAt,
  });
}

export async function findRefreshToken(db: Database, jti: string) {
  return db.select().from(refreshTokens).where(eq(refreshTokens.jti, jti)).get();
}

export async function markRefreshTokenUsed(
  db: Database,
  jti: string,
  replacement: { token: string; expiresAt: number },
  usedAt: number,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({
      usedAt,
      replacedByToken: replacement.token,
      replacedByExpiresAt: replacement.expiresAt,
    })
    .where(eq(refreshTokens.jti, jti));
}

/**
 * Delete every token in a family.
 *
 * Deleting (rather than flagging) is what makes reuse detection final: after a
 * family is revoked, no token in it resolves to a row, so `findRefreshToken`
 * returns nothing and every one of them is rejected as invalid.
 */
export async function revokeFamily(db: Database, familyId: string): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.familyId, familyId));
}
```

- [ ] **Step 6: Wire rotation into register and login**

In `apps/server/src/routes/auth.ts`, add the import (after line 18):

```ts
import {
  storeRefreshToken,
  findRefreshToken,
  markRefreshTokenUsed,
  revokeFamily,
  getReuseGraceMs,
} from '../utils/refresh-tokens.js';
```

In `/register`, replace the refresh-token mint block (lines 185–189):

```ts
  const { token: refreshToken } = await signRefreshToken(
    newUser.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
```

with a stored, family-tagged one:

```ts
  const refresh = await signRefreshToken(
    newUser.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
  await storeRefreshToken(c.get('db'), {
    jti: refresh.jti,
    familyId: refresh.familyId,
    userId: newUser.id,
    expiresAt: refresh.exp,
  });
```

Then change the register response (line 196) from `refreshToken,` to `refreshToken: refresh.token,`.

In `/login`, replace the identical mint block (lines 273–277):

```ts
  const { token: refreshToken } = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
```

with:

```ts
  const refresh = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
  );
  await storeRefreshToken(c.get('db'), {
    jti: refresh.jti,
    familyId: refresh.familyId,
    userId: user.id,
    expiresAt: refresh.exp,
  });
```

Then change the login response (line 282) from `refreshToken,` to `refreshToken: refresh.token,`.

- [ ] **Step 7: Rewrite the `/refresh` handler**

Replace the body of `auth.post('/refresh', ...)` (lines 287–334) with:

```ts
auth.post('/refresh', async (c) => {
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (!body?.refreshToken) {
    throw new AppError('refreshToken is required', 400, 'VALIDATION_ERROR');
  }

  const { user, payload } = await verifyTokenForUser(
    c,
    body.refreshToken,
    getRefreshSecret(),
    'refresh',
    {
      invalid: {
        message: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      },
      wrongType: {
        message: 'Invalid token type',
        code: 'INVALID_TOKEN_TYPE',
      },
      revoked: {
        message: 'Refresh token has been revoked',
        code: 'TOKEN_REVOKED',
      },
      inactive: {
        message: 'User is inactive or not found',
        code: 'ACCOUNT_INACTIVE',
      },
    },
  );

  const db = c.get('db');
  const row = await findRefreshToken(db, payload.jti);
  if (!row) {
    // Unknown jti: minted before this migration, or a family already revoked.
    throw new AppError(
      'Invalid or expired refresh token',
      401,
      'INVALID_REFRESH_TOKEN',
    );
  }

  const nowMs = Date.now();
  if (row.usedAt) {
    // `usedAt` is stored in milliseconds so a `REFRESH_REUSE_GRACE_MS=0` test
    // is deterministic: a second use in the same millisecond is still reuse.
    const withinGrace =
      row.replacedByToken &&
      row.replacedByExpiresAt &&
      nowMs - row.usedAt < getReuseGraceMs();
    if (withinGrace) {
      // A concurrent refresh from another tab: hand back the same replacement
      // rather than treating a race as theft.
      const { token, exp } = await signAccessToken(
        user.id,
        user.username,
        getJwtSecret(),
        getAccessTokenTtl(),
      );
      return c.json({
        token,
        refreshToken: row.replacedByToken,
        expiresIn: exp - Math.floor(nowMs / 1000),
      });
    }
    // A rotated token replayed later is theft: burn the whole family.
    await revokeFamily(db, row.familyId);
    throw new AppError(
      'Refresh token reuse detected',
      401,
      'REFRESH_TOKEN_REUSED',
    );
  }

  const replacement = await signRefreshToken(
    user.id,
    getRefreshSecret(),
    getRefreshTokenTtl(),
    row.familyId,
  );
  await markRefreshTokenUsed(
    db,
    payload.jti,
    { token: replacement.token, expiresAt: replacement.exp },
    nowMs,
  );
  await storeRefreshToken(db, {
    jti: replacement.jti,
    familyId: replacement.familyId,
    userId: user.id,
    expiresAt: replacement.exp,
  });

  const { token, exp } = await signAccessToken(
    user.id,
    user.username,
    getJwtSecret(),
    getAccessTokenTtl(),
  );
  return c.json({
    token,
    refreshToken: replacement.token,
    expiresIn: exp - Math.floor(nowMs / 1000),
  });
});
```

- [ ] **Step 8: Revoke the family on logout**

In `/logout` (lines 354–373), replace the refresh-token revocation block with a family revocation, so a stolen refresh token cannot outlive a logout:

```ts
  // A logout kills the whole refresh family, not just the presented token:
  // any sibling token from the same login is now unusable.
  const body = await c.req.json<{ refreshToken?: string }>().catch(() => null);
  if (body?.refreshToken) {
    try {
      const refreshPayload: TokenPayload = await verifyToken(
        body.refreshToken,
        getRefreshSecret(),
      );
      if (refreshPayload.fam) {
        await revokeFamily(db, refreshPayload.fam);
      }
    } catch {
      // Ignore invalid refresh token during logout
    }
  }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test -- refresh-rotation auth`
Expected: PASS — rotation, grace replay, and family revocation all hold; the existing auth tests still pass.

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(server): rotate refresh tokens and detect reuse (H10)" -- \
  apps/server/src/db/schema.ts \
  apps/server/src/db/client.ts \
  apps/server/src/utils/jwt.ts \
  apps/server/src/utils/refresh-tokens.ts \
  apps/server/src/routes/auth.ts \
  apps/server/test/refresh-rotation.test.ts
```

---

### Task 5: Revocation on WebSocket upgrade and on live sockets (M10, M11)

**Files:**
- Modify: `apps/server/src/routes/ws.ts` (`closeUserSockets`; user check in `handleBrowserUpgrade`)
- Modify: `apps/server/src/routes/auth.ts` (logout closes sockets)
- Modify: `apps/server/src/routes/admin.ts` (deactivate/reject closes sockets)
- Test: `apps/server/test/ws-revocation.test.ts`

**Interfaces:**
- Produces: `closeUserSockets(userId: string, code?: number, reason?: string): void` exported from `routes/ws.ts`.
- Consumes: `browserConnections` (already exported from `routes/ws.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/ws-revocation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer, closeAllSignalingSockets } from '../src/index';
import { getDb, closeDb } from '../src/db/client';
import { closeUserSockets, browserConnections } from '../src/routes/ws';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

let server: Server | undefined;

/** Register a user through the real endpoint and mint a one-time WS ticket. */
async function registerAndTicket(
  app: ReturnType<typeof createSignalingServer>['app'],
  username: string,
): Promise<{ userId: string; ticket: string }> {
  const reg = await app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Password123!', publicKey: 'pk' }),
    }),
  );
  const { token, user } = (await reg.json()) as {
    token: string;
    user: { id: string };
  };
  const ticketRes = await app.fetch(
    new Request('http://localhost/api/ws/ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  return { userId: user.id, ticket };
}

function connect(port: number, ticket: string): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
  );
}

beforeEach(() => {
  browserConnections.clear();
  closeDb();
  getDb(':memory:');
});

afterEach(async () => {
  closeAllSignalingSockets();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('revocation closes live sockets', () => {
  it('closeUserSockets closes a user socket with 4401', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    const { userId, ticket } = await registerAndTicket(app, 'alice');
    const ws = connect(port, ticket);
    await new Promise<void>((r) => ws.once('open', () => r()));
    expect(browserConnections.get(userId)?.size).toBe(1);

    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    closeUserSockets(userId, 4401, 'revoked');
    expect(await closed).toBe(4401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test -- ws-revocation`
Expected: FAIL — `closeUserSockets` is not exported.

- [ ] **Step 3: Add `closeUserSockets` and the upgrade-time user check**

In `apps/server/src/routes/ws.ts`, extend the schema import (line 10) to include `users`:

```ts
import { agents, sessions, users } from '../db/schema.js';
```

Add this export immediately after the `browserConnections` declaration (line 81):

```ts
/**
 * Close every live browser socket belonging to a user.
 *
 * Called when the user's right to be connected ends — a logout, or an admin
 * deactivating or rejecting the account. Without it a revocation only stopped
 * *new* connections: an already-open socket kept streaming until the tab
 * closed.
 */
export function closeUserSockets(
  userId: string,
  code = 4401,
  reason = 'Session revoked',
): void {
  const connections = browserConnections.get(userId);
  if (!connections) return;
  for (const connection of connections) {
    try {
      connection.socket.close(code, reason);
    } catch {
      // A socket already closing is an ordinary outcome.
    }
  }
}
```

In `handleBrowserUpgrade`, after the one-time ticket check (line 560) and before the Origin check (line 564), reject a ticket whose user is no longer allowed to connect:

```ts
  // A ticket is minted with a 15s TTL, so a user can be deactivated between
  // mint and upgrade. Re-check the account here: the ticket proves the token
  // was valid at mint time, not that the account still is.
  const db = getDb(process.env.DATABASE_PATH);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();
  if (!user?.isActive || user.approvalStatus !== 'approved') {
    return reject(401, 'Unauthorized');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test -- ws-revocation`
Expected: PASS.

- [ ] **Step 5: Close sockets on logout**

In `apps/server/src/routes/auth.ts`, extend the ws import block. Add near the other route imports (after line 18):

```ts
import { closeUserSockets } from './ws.js';
```

In `/logout`, before `return c.json({ success: true })` (line 375), add:

```ts
  // A revoked access token must not leave a live socket behind.
  closeUserSockets(tokenPayload.sub, 4401, 'Logged out');
```

- [ ] **Step 6: Close sockets on admin deactivation or rejection**

In `apps/server/src/routes/admin.ts`, add the import beside the other route imports (after line 8):

```ts
import { closeUserSockets } from './ws.js';
```

In the `admin.patch('/users/:id', ...)` handler, in the normal update path — after `updates.updatedAt = new Date().toISOString();` and the `db.update(...)` call, immediately before `return c.json({ user: toPublicUser(updated) })` — add:

```ts
  // Deactivation or rejection must reach live sockets, not just the next
  // login. The demotion branch above returns early and leaves the account
  // active, so it needs no close here.
  if (updates.isActive === false || updates.approvalStatus === 'rejected') {
    closeUserSockets(targetId, 4401, 'Account disabled');
  }
```

- [ ] **Step 7: Run the full server suite**

Run: `pnpm --filter @ponter/server test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(server): enforce revocation on WS upgrade and live sockets (M10, M11)" -- \
  apps/server/src/routes/ws.ts \
  apps/server/src/routes/auth.ts \
  apps/server/src/routes/admin.ts \
  apps/server/test/ws-revocation.test.ts
```

---

### Task 6: Remove the false E2EE/Zero-Trust UI labels (§4.1, gate G2)

**Files:**
- Modify: `apps/web/src/components/layout/AppHeader.vue:132`
- Modify: `apps/web/src/components/auth/RegisterForm.vue:87`
- Modify: `apps/web/src/components/auth/LoginForm.vue:55`
- Modify: `apps/web/src/views/DashboardView.vue:269`
- Test: `apps/web/src/__tests__/e2ee-claims.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (copy only).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/e2ee-claims.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Exit gate G2: no UI text may assert E2EE or Zero-Trust that the code does
// not implement. These four labels did, before Phase 5 lands the feature.
const FILES = [
  'components/layout/AppHeader.vue',
  'components/auth/RegisterForm.vue',
  'components/auth/LoginForm.vue',
  'views/DashboardView.vue',
];

describe('no false E2EE claims in the UI', () => {
  for (const file of FILES) {
    it(`${file} does not claim E2EE or Zero-Trust`, () => {
      const source = read(file);
      expect(source).not.toMatch(/E2EE/);
      expect(source).not.toMatch(/Zero-Trust/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test -- e2ee-claims`
Expected: FAIL on all four files.

- [ ] **Step 3: Replace the four labels**

In `apps/web/src/components/layout/AppHeader.vue` line 132, replace `<span>E2EE Ready</span>` with:

```html
          <span>DTLS Secured</span>
```

In `apps/web/src/components/auth/RegisterForm.vue` line 87, replace `<span>E2EE Keygen</span>` with:

```html
          <span>Password-Derived Keys</span>
```

In `apps/web/src/components/auth/LoginForm.vue` line 55, replace `<span>Zero-Trust Auth</span>` with:

```html
          <span>Token Auth</span>
```

In `apps/web/src/views/DashboardView.vue` line 269, replace `<span>Zero-Trust E2EE</span>` with:

```html
              <span>DTLS-Secured Transport</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test -- e2ee-claims`
Expected: PASS.

- [ ] **Step 5: Run the web suite and lint**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web lint`
Expected: PASS — no component test asserted the old strings.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(web): replace false E2EE/Zero-Trust UI labels with true wording" -- \
  apps/web/src/components/layout/AppHeader.vue \
  apps/web/src/components/auth/RegisterForm.vue \
  apps/web/src/components/auth/LoginForm.vue \
  apps/web/src/views/DashboardView.vue \
  apps/web/src/__tests__/e2ee-claims.test.ts
```

---

## Verification

After all six tasks, run the whole repo gate from the repository root:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green. Then confirm the exit-gate items this plan owns:

- **G2 (partial):** `grep -rn "E2EE\|Zero-Trust" apps/web/src` returns nothing.
- **M9:** starting the server without `JWT_SECRET` exits non-zero with a message naming the variable.
- **H8/M12:** starting with `NODE_ENV=production CORS_ORIGIN=*` exits non-zero.
- **H9:** six wrong-password logins from one IP return `429` on the sixth.
- **H10/5.2:** a rotated refresh token replayed after the grace window returns `401 REFRESH_TOKEN_REUSED` and the family is dead.
- **M10/M11:** deactivating a user closes that user's open browser sockets.

Weeks 13–16 (WS2, WS3, WS1) are separate plans, written and executed in dependency order — WS2 next, because WS1's encryption is meaningless until peer identity holds.
