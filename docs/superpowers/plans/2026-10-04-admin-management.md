# Admin Management, User Approval & System Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement role-based access control (`admin` vs `user`), approval-based user registration workflow, runtime system settings (`allow_registration`, `auto_approve_users`, `max_agents_per_user`), system telemetry statistics, and a full-featured Admin Cockpit UI at `/admin`.

**Architecture:**
- Database schema stores `role` and `approvalStatus` directly on `users`, with first registered user bootstrapped as `admin` and `approved`.
- Persistent `system_settings` key-value table controls operational toggles.
- Hono REST API adds `adminMiddleware` to protect `/api/admin/*` routes (stats, user management with last-admin protection, settings).
- Vue 3 frontend adds `/admin` route with `requiresAdmin` router guard, AppHeader navigation, and 3-tab responsive management cockpit (Overview, Users, Settings).

**Tech Stack:** TypeScript, Node.js 24, SQLite (BetterSqlite3 + Drizzle ORM), Hono, Vue 3, Pinia, Tailwind CSS, Lucide icons, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-admin-management-design.md`

## Global Constraints

- Backend runs on Node.js 24 + SQLite with Hono REST API.
- All code, identifiers, commit messages, and PRs must remain in English.
- Normal users receive strict 403 Forbidden with zero data exposure on any `/api/admin/*` route.
- An admin cannot demote themselves to `user` if they are the only active admin.
- An admin cannot deactivate their own account.
- Non-approved users (`approvalStatus !== 'approved'`) cannot obtain access tokens or log in.

## Review Focus

1. **First User Bootstrap Atomicity:** When DB is empty (`count === 0`), registering user must atomically receive `role: 'admin'` and `approvalStatus: 'approved'`, while subsequent users receive `role: 'user'` and default `approvalStatus: 'pending'`.
2. **Pending Registration No-Token Guard:** When `approvalStatus === 'pending'`, `/api/auth/register` must NOT return access/refresh tokens.
3. **Login Credential Verification Precedence:** Password must be verified *before* checking approval status or active status to prevent username/status enumeration by unauthenticated attackers.
4. **Last Admin Demotion / Deactivation Safety:** Admin PATCH endpoint must refuse self-demotion or self-deactivation when no other active admin exists, returning 400 with `LAST_ADMIN_PROTECTED`.
5. **Registration Disabled Enforcement:** When `allow_registration` is `false`, any `/api/auth/register` attempt must immediately return 403 `REGISTRATION_DISABLED` without creating a user or hashing passwords.

---

### Task 1: Shared Types & API Client Admin Resource

**Files:**
- Modify: `packages/shared/src/types/user.ts`
- Modify: `packages/shared/src/types/auth.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/api-client/src/resources/admin.ts`
- Modify: `packages/api-client/src/resources/auth.ts`
- Modify: `packages/api-client/src/client.ts`
- Modify: `packages/api-client/src/index.ts`
- Test: `packages/api-client/test/admin.test.ts`

**Interfaces:**
- Consumes: `HttpClient` from `packages/api-client/src/client.ts`
- Produces:
  - `UserRole = 'admin' | 'user'`
  - `ApprovalStatus = 'pending' | 'approved' | 'rejected'`
  - `SystemStats`, `SystemSettings`
  - `RegisterResponse` with optional `requiresApproval`
  - `apiClient.admin` resource (`getStats`, `getUsers`, `updateUser`, `getSettings`, `updateSettings`)

- [ ] **Step 1: Write the failing test for `AdminResource`**

Create `packages/api-client/test/admin.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient } from '../src/client';
import { AdminResource } from '../src/resources/admin';
import type { SystemStats, SystemSettings } from '@ponter/shared';

describe('AdminResource', () => {
  let http: HttpClient;
  let admin: AdminResource;

  beforeEach(() => {
    http = new HttpClient({
      baseUrl: 'http://localhost:3000',
      storage: {
        getAccessToken: vi.fn().mockResolvedValue('admin-token'),
        getRefreshToken: vi.fn().mockResolvedValue(null),
        setTokens: vi.fn(),
        clearTokens: vi.fn(),
      },
    });
    admin = new AdminResource(http);
  });

  it('fetches system stats from /api/admin/stats', async () => {
    const mockStats: SystemStats = {
      users: { total: 10, approved: 8, pending: 2, rejected: 0, admins: 1 },
      agents: { total: 4, online: 3, byPlatform: { linux: 3, windows: 1 } },
      sessions: { active: 2, byKind: { terminal: 1, desktop: 1 } },
    };
    vi.spyOn(http, 'request').mockResolvedValue(mockStats);

    const res = await admin.getStats();
    expect(res).toEqual(mockStats);
    expect(http.request).toHaveBeenCalledWith('GET', '/api/admin/stats', { auth: true });
  });

  it('updates a user status via PATCH /api/admin/users/:id', async () => {
    vi.spyOn(http, 'request').mockResolvedValue({ user: { id: 'u1', approvalStatus: 'approved' } });

    const res = await admin.updateUser('u1', { approvalStatus: 'approved' });
    expect(res.user.approvalStatus).toBe('approved');
    expect(http.request).toHaveBeenCalledWith('PATCH', '/api/admin/users/u1', {
      body: { approvalStatus: 'approved' },
      auth: true,
    });
  });

  it('fetches and updates system settings', async () => {
    const mockSettings: SystemSettings = {
      allowRegistration: true,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    };
    vi.spyOn(http, 'request')
      .mockResolvedValueOnce(mockSettings)
      .mockResolvedValueOnce({ settings: { ...mockSettings, autoApproveUsers: true } });

    const current = await admin.getSettings();
    expect(current.allowRegistration).toBe(true);

    const updated = await admin.updateSettings({ autoApproveUsers: true });
    expect(updated.settings.autoApproveUsers).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/api-client test admin.test.ts`  
Expected: FAIL (Cannot find module `AdminResource`).

- [ ] **Step 3: Update `packages/shared` types and implement `AdminResource`**

Update `packages/shared/src/types/user.ts`:
```typescript
export type UserRole = 'admin' | 'user';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface User {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  role: UserRole;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface SystemStats {
  users: {
    total: number;
    approved: number;
    pending: number;
    rejected: number;
    admins: number;
  };
  agents: {
    total: number;
    online: number;
    byPlatform: Record<string, number>;
  };
  sessions: {
    active: number;
    byKind: { terminal: number; desktop: number };
  };
}

export interface SystemSettings {
  allowRegistration: boolean;
  autoApproveUsers: boolean;
  maxAgentsPerUser: number;
}
```

Update `packages/shared/src/types/auth.ts`:
```typescript
export interface RegisterResponse {
  user: User;
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  requiresApproval?: boolean;
  message?: string;
}
```
Export all in `packages/shared/src/index.ts`.

Create `packages/api-client/src/resources/admin.ts`:
```typescript
import type { HttpClient } from '../client';
import type {
  SystemStats,
  SystemSettings,
  User,
  UserRole,
  ApprovalStatus,
} from '@ponter/shared';

export interface GetUsersQuery {
  status?: ApprovalStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
}

export interface UpdateUserPayload {
  approvalStatus?: ApprovalStatus;
  isActive?: boolean;
  role?: UserRole;
}

export class AdminResource {
  constructor(private readonly http: HttpClient) {}

  async getStats(): Promise<SystemStats> {
    return this.http.request<SystemStats>('GET', '/api/admin/stats', { auth: true });
  }

  async getUsers(params: GetUsersQuery = {}): Promise<{ users: User[]; total: number }> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    const path = `/api/admin/users${qs ? `?${qs}` : ''}`;
    return this.http.request<{ users: User[]; total: number }>('GET', path, { auth: true });
  }

  async updateUser(id: string, payload: UpdateUserPayload): Promise<{ user: User }> {
    return this.http.request<{ user: User }>('PATCH', `/api/admin/users/${id}`, {
      body: payload,
      auth: true,
    });
  }

  async getSettings(): Promise<SystemSettings> {
    return this.http.request<SystemSettings>('GET', '/api/admin/settings', { auth: true });
  }

  async updateSettings(settings: Partial<SystemSettings>): Promise<{ settings: SystemSettings }> {
    return this.http.request<{ settings: SystemSettings }>('PUT', '/api/admin/settings', {
      body: settings,
      auth: true,
    });
  }
}
```

Update `packages/api-client/src/resources/auth.ts`:
```typescript
import type { HttpClient } from '../client';
import type { LoginResponse, RegisterResponse } from '@ponter/shared';

export class AuthResource {
  // ...
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const res = await this.http.request<RegisterResponse>(
      'POST',
      '/api/auth/register',
      {
        body: input,
        auth: false,
      },
    );
    if (res.token && res.refreshToken) {
      await this.http.storage.setTokens({
        accessToken: res.token,
        refreshToken: res.refreshToken,
      });
    }
    return res;
  }
}
```

Wire `admin: AdminResource` in `packages/api-client/src/client.ts` and export it in `packages/api-client/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/shared typecheck && pnpm --filter @ponter/api-client test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/api-client
git commit -m "feat(shared,api-client): add admin RBAC types, settings, and AdminResource"
```

---

### Task 2: Server Database Schema, Migrations & Settings Helpers

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/client.ts`
- Modify: `apps/server/src/utils/user.ts`
- Create: `apps/server/src/utils/settings.ts`
- Test: `apps/server/test/db-settings.test.ts`

**Interfaces:**
- Consumes: `users`, `systemSettings` tables in `apps/server/src/db/schema.ts`
- Produces:
  - `toPublicUser(user)` returning `role` and `approvalStatus`
  - `getSystemSettings(db): Promise<SystemSettings>`
  - `updateSystemSettings(db, updates): Promise<SystemSettings>`

- [ ] **Step 1: Write failing test for `systemSettings` and `toPublicUser`**

Create `apps/server/test/db-settings.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { users } from '../src/db/schema';
import { getSystemSettings, updateSystemSettings } from '../src/utils/settings';
import { toPublicUser } from '../src/utils/user';

describe('DB Schema & Settings Helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('initializes default system settings', async () => {
    const settings = await getSystemSettings(db);
    expect(settings).toEqual({
      allowRegistration: true,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    });
  });

  it('updates system settings correctly', async () => {
    await updateSystemSettings(db, { allowRegistration: false, maxAgentsPerUser: 5 });
    const updated = await getSystemSettings(db);
    expect(updated.allowRegistration).toBe(false);
    expect(updated.autoApproveUsers).toBe(false);
    expect(updated.maxAgentsPerUser).toBe(5);
  });

  it('includes role and approvalStatus in toPublicUser projection', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: 'admin_test',
        publicKey: 'pk_test',
        role: 'admin',
        approvalStatus: 'approved',
      })
      .returning();

    const publicUser = toPublicUser(user!);
    expect(publicUser.role).toBe('admin');
    expect(publicUser.approvalStatus).toBe('approved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test db-settings.test.ts`  
Expected: FAIL (Schema fields / functions missing).

- [ ] **Step 3: Implement schema changes, migration SQL, and settings helpers**

In `apps/server/src/db/schema.ts`:
```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  publicKey: text('public_key').notNull(),
  passwordHash: text('password_hash'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  role: text('role').notNull().default('user'),
  approvalStatus: text('approval_status').notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastLoginAt: text('last_login_at'),
  metadata: text('metadata'),
});

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
```

In `apps/server/src/db/client.ts`, add to `runMigrations(sqlite)`:
```sql
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
And add migration migration check for existing `users` table:
```typescript
try {
  sqlite.exec(`
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
  `);
} catch {}
try {
  sqlite.exec(`
    ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
  `);
} catch {}
```

In `apps/server/src/utils/user.ts`:
Update `PublicUser` type and `toPublicUser` to project `role: user.role as UserRole` and `approvalStatus: user.approvalStatus as ApprovalStatus`.

Create `apps/server/src/utils/settings.ts`:
```typescript
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import type { SystemSettings } from '@ponter/shared';

const DEFAULT_SETTINGS: SystemSettings = {
  allowRegistration: true,
  autoApproveUsers: false,
  maxAgentsPerUser: 10,
};

export async function getSystemSettings(db: Database): Promise<SystemSettings> {
  const rows = await db.select().from(systemSettings).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    allowRegistration: map.has('allow_registration')
      ? map.get('allow_registration') === 'true'
      : DEFAULT_SETTINGS.allowRegistration,
    autoApproveUsers: map.has('auto_approve_users')
      ? map.get('auto_approve_users') === 'true'
      : DEFAULT_SETTINGS.autoApproveUsers,
    maxAgentsPerUser: map.has('max_agents_per_user')
      ? Number(map.get('max_agents_per_user')) || DEFAULT_SETTINGS.maxAgentsPerUser
      : DEFAULT_SETTINGS.maxAgentsPerUser,
  };
}

export async function updateSystemSettings(
  db: Database,
  updates: Partial<SystemSettings>,
): Promise<SystemSettings> {
  const entries: [string, string][] = [];
  if (updates.allowRegistration !== undefined) {
    entries.push(['allow_registration', String(updates.allowRegistration)]);
  }
  if (updates.autoApproveUsers !== undefined) {
    entries.push(['auto_approve_users', String(updates.autoApproveUsers)]);
  }
  if (updates.maxAgentsPerUser !== undefined) {
    entries.push(['max_agents_per_user', String(updates.maxAgentsPerUser)]);
  }

  for (const [key, value] of entries) {
    await db
      .insert(systemSettings)
      .values({ key, value, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date().toISOString() },
      });
  }

  return getSystemSettings(db);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test db-settings.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db apps/server/src/utils apps/server/test/db-settings.test.ts
git commit -m "feat(server): add role, approval_status to users and systemSettings store"
```

---

### Task 3: Server Auth Flow Updates (Bootstrap & Approval Gate)

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/test/auth-approval.test.ts`

**Interfaces:**
- Consumes: `users`, `systemSettings`, `getSystemSettings`, `toPublicUser`
- Produces:
  - First registered user automatically becomes `role: 'admin'`, `approvalStatus: 'approved'`.
  - Next users become `role: 'user'`, `approvalStatus: 'pending'` (or `'approved'` if `autoApproveUsers: true`).
  - Pending user register returns `{ user, requiresApproval: true }` without access/refresh tokens.
  - Login checks password, then if `approvalStatus === 'pending'` throws 403 `USER_PENDING_APPROVAL`.
  - Login checks if `approvalStatus === 'rejected'` throws 403 `USER_REJECTED`.
  - If `allowRegistration === false`, register throws 403 `REGISTRATION_DISABLED`.

- [ ] **Step 1: Write failing tests for Auth Approval workflow**

Create `apps/server/test/auth-approval.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { updateSystemSettings } from '../src/utils/settings';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

describe('Auth Approval & Registration Gate', () => {
  let db: Database;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('bootstraps the first user as approved admin with tokens', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'first_admin',
        password: 'Password123!',
        publicKey: 'pk_admin',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('admin');
    expect(body.user.approvalStatus).toBe('approved');
    expect(body.token).toBeDefined();
    expect(body.requiresApproval).toBe(false);
  });

  it('registers second user as pending without tokens', async () => {
    const app = createApp();
    // 1. First user
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'first_admin',
        password: 'Password123!',
        publicKey: 'pk_admin',
      }),
    });

    // 2. Second user
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'second_user',
        password: 'Password123!',
        publicKey: 'pk_user2',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('user');
    expect(body.user.approvalStatus).toBe('pending');
    expect(body.token).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(body.requiresApproval).toBe(true);
  });

  it('blocks pending user from logging in with 403 USER_PENDING_APPROVAL', async () => {
    const app = createApp();
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'Password123!',
        publicKey: 'pk_admin',
      }),
    });

    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bob_pending',
        password: 'Password123!',
        publicKey: 'pk_bob',
      }),
    });

    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob_pending', password: 'Password123!' }),
    });

    expect(loginRes.status).toBe(403);
    const err = await loginRes.json();
    expect(err.code).toBe('USER_PENDING_APPROVAL');
  });

  it('blocks registration when allowRegistration setting is false', async () => {
    const app = createApp();
    await updateSystemSettings(db, { allowRegistration: false });

    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'blocked_user',
        password: 'Password123!',
        publicKey: 'pk_blocked',
      }),
    });

    expect(res.status).toBe(403);
    const err = await res.json();
    expect(err.code).toBe('REGISTRATION_DISABLED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test auth-approval.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Update `apps/server/src/routes/auth.ts`**

In `auth.post('/register')`:
1. Query `getSystemSettings(db)`. If `!settings.allowRegistration`, throw `new AppError('Registration is currently disabled', 403, 'REGISTRATION_DISABLED')`.
2. Count existing users: `const [userCount] = await db.select({ value: count() }).from(users);`.
3. If `userCount.value === 0`: `role = 'admin'`, `approvalStatus = 'approved'`.
4. If `userCount.value > 0`: `role = 'user'`, `approvalStatus = settings.autoApproveUsers ? 'approved' : 'pending'`.
5. Insert user.
6. If `approvalStatus === 'pending'`, return:
   ```typescript
   return c.json({
     user: toPublicUser(newUser),
     requiresApproval: true,
     message: 'Registration successful. Your account is pending administrator approval.',
   }, 201);
   ```
7. If `approvalStatus === 'approved'`, mint tokens and return:
   ```typescript
   return c.json({
     user: toPublicUser(newUser),
     requiresApproval: false,
     token,
     refreshToken,
     expiresIn: exp - Math.floor(Date.now() / 1000),
   }, 201);
   ```

In `auth.post('/login')`:
After `verifyPassword(body.password, user.passwordHash)` passes:
```typescript
if (user.approvalStatus === 'pending') {
  throw new AppError('Your account is pending administrator approval', 403, 'USER_PENDING_APPROVAL');
}
if (user.approvalStatus === 'rejected') {
  throw new AppError('Your account registration was rejected', 403, 'USER_REJECTED');
}
if (!user.isActive) {
  throw new AppError('User account is inactive', 401, 'ACCOUNT_INACTIVE');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test auth-approval.test.ts && pnpm --filter @ponter/server test auth.test.ts`  
Expected: PASS (All tests pass).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/test/auth-approval.test.ts
git commit -m "feat(server): enforce user approval gate and first-user admin bootstrap"
```

---

### Task 4: Server Admin Middleware & REST Routes

**Files:**
- Create: `apps/server/src/middleware/admin.ts`
- Create: `apps/server/src/routes/admin.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin.test.ts`

**Interfaces:**
- Consumes: `authMiddleware`, `adminMiddleware`, `getSystemSettings`, `updateSystemSettings`
- Produces:
  - `GET /api/admin/stats`
  - `GET /api/admin/users`
  - `PATCH /api/admin/users/:id`
  - `GET /api/admin/settings`
  - `PUT /api/admin/settings`

- [ ] **Step 1: Write failing tests for Admin routes & safety rules**

Create `apps/server/test/admin.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { users } from '../src/db/schema';
import { eq } from 'drizzle-orm';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

describe('Admin REST Routes', () => {
  let db: Database;
  let adminToken: string;
  let adminUser: any;
  let regularToken: string;
  let regularUser: any;

  beforeEach(async () => {
    db = getDb(':memory:');
    const app = createApp();

    // 1. Admin registration (first user)
    const adminRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'superadmin', password: 'Password123!', publicKey: 'pk_admin' }),
    });
    const adminData = await adminRes.json();
    adminToken = adminData.token;
    adminUser = adminData.user;

    // 2. Regular user registration
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'Password123!', publicKey: 'pk_user1' }),
    });
    regularUser = (await regRes.json()).user;

    // Manually approve user1 to get a token for testing regular user access
    await db.update(users).set({ approvalStatus: 'approved' }).where(eq(users.id, regularUser.id));
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'Password123!' }),
    });
    regularToken = (await loginRes.json()).token;
  });

  afterEach(() => {
    closeDb();
  });

  it('rejects non-admin access to /api/admin/stats with 403 FORBIDDEN', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/stats', {
      headers: { Authorization: `Bearer ${regularToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns system stats to admin', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/stats', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(stats.users.total).toBe(2);
    expect(stats.users.admins).toBe(1);
    expect(stats.agents.total).toBe(0);
  });

  it('lists users and filters by status', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/users?status=all', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBe(2);
  });

  it('approves a user and promotes to admin', async () => {
    const app = createApp();
    const patchRes = await app.request(`/api/admin/users/${regularUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.user.role).toBe('admin');
  });

  it('prevents demoting the last active admin with 400 LAST_ADMIN_PROTECTED', async () => {
    const app = createApp();
    const res = await app.request(`/api/admin/users/${adminUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe('LAST_ADMIN_PROTECTED');
  });

  it('prevents deactivating the current admin account with 400 SELF_DEACTIVATION_BLOCKED', async () => {
    const app = createApp();
    const res = await app.request(`/api/admin/users/${adminUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe('SELF_DEACTIVATION_BLOCKED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test admin.test.ts`  
Expected: FAIL (404 Not Found on `/api/admin/*`).

- [ ] **Step 3: Implement `adminMiddleware`, `admin.ts` routes, and mount in `app.ts`**

Create `apps/server/src/middleware/admin.ts`:
```typescript
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types.js';
import { AppError } from './error.js';

export const adminMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    throw new AppError('Forbidden: Admin privileges required', 403, 'FORBIDDEN');
  }
  await next();
};
```

Create `apps/server/src/routes/admin.ts`:
Implement `/api/admin/stats`, `/api/admin/users`, `/api/admin/users/:id`, `/api/admin/settings`.
Include safety checks:
- Demoting admin: check if target is admin, count total active admins in DB. If count <= 1, throw `new AppError('Cannot demote the only active admin', 400, 'LAST_ADMIN_PROTECTED')`.
- Deactivating: if `target.id === currentUser.id && updates.isActive === false`, throw `new AppError('Cannot deactivate your own admin account', 400, 'SELF_DEACTIVATION_BLOCKED')`.

Mount in `apps/server/src/app.ts`:
```typescript
import admin from './routes/admin.js';
// ...
app.route('/api/admin', admin);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/server test admin.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/middleware/admin.ts apps/server/src/routes/admin.ts apps/server/src/app.ts apps/server/test/admin.test.ts
git commit -m "feat(server): add admin middleware, stats, user management, and settings routes"
```

---

### Task 5: Web Router, Navigation Guard & AppHeader

**Files:**
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/layout/AppHeader.vue`
- Modify: `apps/web/src/stores/auth.ts`
- Test: `apps/web/src/__tests__/router-admin-guard.test.ts`

**Interfaces:**
- Consumes: `authStore.user?.role`
- Produces:
  - Route `/admin` guarded by `requiresAdmin`
  - Header displays `Admin` tab when user has `admin` role
  - Store register handles `requiresApproval` gracefully without failing

- [ ] **Step 1: Write failing test for router admin guard**

Create `apps/web/src/__tests__/router-admin-guard.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { router } from '@/router';
import { useAuthStore } from '@/stores/auth';

describe('Router Admin Guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('redirects non-admin user trying to access /admin to /dashboard', async () => {
    const authStore = useAuthStore();
    authStore.restored = true;
    authStore.user = {
      id: 'u1',
      username: 'normal_user',
      email: null,
      publicKey: 'pk',
      role: 'user',
      approvalStatus: 'approved',
      isActive: true,
      createdAt: '',
      updatedAt: '',
      lastLoginAt: null,
    };
    (authStore as any).status = 'authenticated';

    await router.push('/admin');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test router-admin-guard.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Update `router/index.ts`, `AppHeader.vue`, and `stores/auth.ts`**

In `apps/web/src/router/index.ts`:
```typescript
{
  path: '/admin',
  name: 'admin',
  component: () => import('@/views/AdminView.vue'),
  meta: { requiresAuth: true, requiresAdmin: true },
}
```
In `router.beforeEach`:
```typescript
if (to.meta.requiresAdmin && authStore.user?.role !== 'admin') {
  return { path: '/dashboard' };
}
```

In `apps/web/src/components/layout/AppHeader.vue`:
Add `ShieldCheck` icon from `@lucide/vue`, and if `authStore.user?.role === 'admin'`:
```html
<router-link
  v-if="authStore.user?.role === 'admin'"
  to="/admin"
  class="flex items-center gap-2 px-3 py-1.5 rounded-md font-medium transition-colors"
  :class="route.name === 'admin' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'"
>
  <ShieldCheck class="w-4 h-4 text-violet-500" />
  Admin
</router-link>
```

In `apps/web/src/stores/auth.ts`:
In `register()`:
```typescript
const res = await apiClient.auth.register({...});
if (res.requiresApproval) {
  status.value = 'idle';
  user.value = null;
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test router-admin-guard.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/router apps/web/src/components/layout/AppHeader.vue apps/web/src/stores/auth.ts apps/web/src/__tests__/router-admin-guard.test.ts
git commit -m "feat(web): add admin router guard, AppHeader navigation, and auth store handling"
```

---

### Task 6: Web Admin Cockpit Views & Auth Views Polish

**Files:**
- Create: `apps/web/src/views/AdminView.vue`
- Modify: `apps/web/src/views/RegisterView.vue`
- Modify: `apps/web/src/views/LoginView.vue`
- Test: `apps/web/src/__tests__/AdminView.test.ts`

**Interfaces:**
- Consumes: `apiClient.admin`
- Produces:
  - 3-tab responsive management dashboard (Overview, Users, Settings)
  - 1-click Approve/Reject, Promote/Demote, Deactivate/Activate actions
  - User feedback on registration and login for pending approvals

- [ ] **Step 1: Write failing test for `AdminView.vue`**

Create `apps/web/src/__tests__/AdminView.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AdminView from '@/views/AdminView.vue';
import { apiClient } from '@/services/client';

describe('AdminView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(apiClient.admin, 'getStats').mockResolvedValue({
      users: { total: 5, approved: 3, pending: 2, rejected: 0, admins: 1 },
      agents: { total: 2, online: 1, byPlatform: { linux: 1 } },
      sessions: { active: 1, byKind: { terminal: 1, desktop: 0 } },
    });
    vi.spyOn(apiClient.admin, 'getUsers').mockResolvedValue({
      users: [
        {
          id: 'u1',
          username: 'pending_user',
          email: 'pending@example.com',
          publicKey: 'pk',
          role: 'user',
          approvalStatus: 'pending',
          isActive: true,
          createdAt: '2026-10-04T00:00:00Z',
          updatedAt: '2026-10-04T00:00:00Z',
          lastLoginAt: null,
        },
      ],
      total: 1,
    });
    vi.spyOn(apiClient.admin, 'getSettings').mockResolvedValue({
      allowRegistration: true,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    });
  });

  it('renders stats overview and switches tabs', async () => {
    const wrapper = mount(AdminView);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('System Overview');
    expect(wrapper.text()).toContain('5'); // Total users

    // Switch to Users tab
    await wrapper.find('[data-test="tab-users"]').trigger('click');
    expect(wrapper.text()).toContain('pending_user');
    expect(wrapper.find('[data-test="btn-approve-u1"]').exists()).toBe(true);
  });

  it('triggers approve user action', async () => {
    const updateSpy = vi.spyOn(apiClient.admin, 'updateUser').mockResolvedValue({
      user: { id: 'u1', approvalStatus: 'approved' } as any,
    });
    const wrapper = mount(AdminView);
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await wrapper.find('[data-test="btn-approve-u1"]').trigger('click');

    expect(updateSpy).toHaveBeenCalledWith('u1', { approvalStatus: 'approved' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test AdminView.test.ts`  
Expected: FAIL (`AdminView.vue` does not exist).

- [ ] **Step 3: Implement `AdminView.vue`, `RegisterView.vue`, `LoginView.vue`**

Create `apps/web/src/views/AdminView.vue`:
- Structure:
  - Header: "Administration Cockpit", badges for system status.
  - Tab buttons: `Overview`, `Users`, `Settings`.
  - Tab 1 Overview:
    - User stats: Total, Approved, Pending (alert banner if `pending > 0`), Admins.
    - Agent stats: Total, Online (with OS breakdown badges).
    - Session stats: Active sessions (Terminal, Desktop).
  - Tab 2 Users:
    - Search input & Status filter tabs (`All`, `Pending`, `Approved`, `Rejected`, `Inactive`).
    - Responsive data table.
    - Actions: Approve button (`data-test="btn-approve-<id>"`), Reject button, Promote/Demote button, Lock/Unlock button.
  - Tab 3 Settings:
    - `Allow Registration` switch.
    - `Auto-approve Users` switch.
    - `Max Agents per User` input.
    - Save button calling `apiClient.admin.updateSettings()`.

Update `apps/web/src/views/RegisterView.vue`:
- Show confirmation message when registration requires approval:
  *"Registration successful! Your account is pending administrator approval before you can sign in."*

Update `apps/web/src/views/LoginView.vue`:
- Check for `err.code === 'USER_PENDING_APPROVAL'` and display an informative alert box guiding the user.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test AdminView.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/AdminView.vue apps/web/src/views/RegisterView.vue apps/web/src/views/LoginView.vue apps/web/src/__tests__/AdminView.test.ts
git commit -m "feat(web): add AdminView cockpit with overview, user approval, and settings tabs"
```

---

### Task 7: Full Integration Verification & Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Run workspace validation

- [ ] **Step 1: Run full test suite across workspace**

Run:
```bash
pnpm --filter @ponter/shared test
pnpm --filter @ponter/api-client test
pnpm --filter @ponter/server test
pnpm --filter @ponter/web test
pnpm typecheck
pnpm lint
npx prettier --check .
```
Expected: All tests pass, 0 errors, 0 warnings.

- [ ] **Step 2: Update `docs/ARCHITECTURE.md`**

Add Section describing Admin Management, RBAC, Approval workflow, and System Settings.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: document admin RBAC, user approval workflow, and runtime settings"
```
