# Admin Management & System Control Design

**Date:** 2026-10-04  
**Status:** Approved  
**Topic:** Admin role, user approval workflow, system statistics, and runtime system settings

---

## 1. Overview & Objectives

Ponter needs administrative controls before scaling multi-user deployments. This design introduces:
1. **Role-Based Access Control (RBAC):** Distinct `admin` vs `user` roles stored directly in the database. The initial registered user is automatically elevated to `admin` and `approved`.
2. **Approval-Based User Management:** New user registrations default to `pending` status unless auto-approval is toggled on. Admins can view, approve, reject, deactivate, or promote/demote users.
3. **Runtime System Settings:** A persistent dynamic configuration store for operational toggles:
   - `allow_registration` (boolean, default: true)
   - `auto_approve_users` (boolean, default: false)
   - `max_agents_per_user` (integer, default: 10)
4. **System Statistics:** A consolidated telemetry endpoint and dashboard view summarizing users, real-time agent connections (online status, OS platforms), and active WebRTC sessions.
5. **Modern Admin Cockpit:** A responsive 3-tab administration panel in `apps/web` (`/admin`), protected by client-side route guards and backend middleware.

---

## 2. Architecture & Data Model

### 2.1 Database Schema (`apps/server/src/db/schema.ts`)

#### Extensions to `users` table:
```typescript
export const users = sqliteTable('users', {
  // Existing fields...
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

  // New fields:
  role: text('role').notNull().default('user'), // 'admin' | 'user'
  approvalStatus: text('approval_status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
});
```

#### New `system_settings` table:
```typescript
export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

Default settings seeded on migration / initial run:
- `allow_registration`: `'true'`
- `auto_approve_users`: `'false'`
- `max_agents_per_user`: `'10'`

### 2.2 Shared Types (`packages/shared/src/types/user.ts`)

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

---

## 3. Backend Implementation (`apps/server`)

### 3.1 Authorization Middleware (`apps/server/src/middleware/admin.ts`)
```typescript
export const adminMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    throw new AppError('Forbidden: Admin privileges required', 403, 'FORBIDDEN');
  }
  await next();
};
```

### 3.2 Authentication Flow Adjustments (`apps/server/src/routes/auth.ts`)

1. **Registration (`POST /api/auth/register`):**
   - Query `system_settings` for `allow_registration`. If `'false'`, reject with `403 REGISTRATION_DISABLED`.
   - Count total users in database:
     - If count is `0` (first user bootstrap): set `role = 'admin'` and `approvalStatus = 'approved'`.
     - If count > `0`: set `role = 'user'`, and set `approvalStatus = autoApprove ? 'approved' : 'pending'`.
   - Return `{ user: toPublicUser(newUser), requiresApproval: newUser.approvalStatus === 'pending' }`.

2. **Login (`POST /api/auth/login`):**
   - Check user credentials as normal.
   - If `approvalStatus === 'pending'`: throw `AppError('Your account is pending administrator approval', 403, 'USER_PENDING_APPROVAL')`.
   - If `approvalStatus === 'rejected'`: throw `AppError('Your account registration was rejected', 403, 'USER_REJECTED')`.
   - If `isActive === false`: throw `AppError('Your account is deactivated', 403, 'USER_DEACTIVATED')`.

### 3.3 Admin REST Routes (`apps/server/src/routes/admin.ts`)

All routes mounted at `/api/admin/*`, guarded by `authMiddleware` + `adminMiddleware`:

- **`GET /api/admin/stats`**:
  - Aggregates counts from `users`, `agents`, and active `sessions`.
  - Distinguishes platform breakdowns and terminal vs desktop active sessions.

- **`GET /api/admin/users`**:
  - Query parameters: `status` (`all` | `pending` | `approved` | `rejected`), `search` (username or email partial match), `page`, `limit`.
  - Returns paginated list of public user objects.

- **`PATCH /api/admin/users/:id`**:
  - Accepts `{ approvalStatus?, isActive?, role? }`.
  - **Safety validations:**
    - An admin cannot demote themselves if they are the only active admin.
    - An admin cannot deactivate their own account.
  - Updates `updatedAt` and persists to SQLite.

- **`GET /api/admin/settings`**:
  - Returns current parsed key-value settings as `SystemSettings`.

- **`PUT /api/admin/settings`**:
  - Validates and saves updated settings:
    - `allowRegistration`: boolean
    - `autoApproveUsers`: boolean
    - `maxAgentsPerUser`: integer >= 1
  - Upserts into `system_settings` table.

---

## 4. Frontend Implementation (`apps/web`)

### 4.1 Route & Navigation Guard
- Add route in `apps/web/src/router/index.ts`:
  ```typescript
  {
    path: '/admin',
    name: 'admin',
    component: () => import('@/views/AdminView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  }
  ```
- In `router.beforeEach`:
  - If `to.meta.requiresAdmin` and `authStore.user?.role !== 'admin'`, redirect to `/dashboard`.
- In `apps/web/src/components/layout/AppHeader.vue`:
  - If `authStore.user?.role === 'admin'`, render navigation link `Admin` with `ShieldCheck` icon.

### 4.2 Admin Cockpit View (`apps/web/src/views/AdminView.vue`)

- **Tab 1: Overview (General Statistics)**
  - Stat cards:
    - Total Users (with highlight chip for Pending Approvals).
    - Agents Online / Total (with breakdown badges for Linux, Windows, macOS).
    - Active WebRTC Sessions (Terminal & Desktop).
  - Quick action banner: If `pending > 0`, display alert with button to switch to "Pending Users" tab.

- **Tab 2: User Management**
  - Search input & status filter pills (`All`, `Pending`, `Approved`, `Rejected`, `Deactivated`).
  - Data table:
    - Avatar, Username, Email, Created At, Last Login.
    - Role badge (`Admin` in violet/amber, `User` in slate/muted).
    - Approval status badge (`Pending` in yellow, `Approved` in emerald, `Rejected` in red).
    - Actions:
      - 1-click **Approve** (check icon) & **Reject** (X icon) for pending users.
      - Action menu: Toggle Active/Inactive, Promote to Admin / Demote to User.
      - Self-protection: Current admin's own actions are disabled.

- **Tab 3: Settings (System Settings)**
  - Form cards:
    - `Allow Registration`: Switch toggle with descriptive subtext.
    - `Auto-approve Users`: Switch toggle with descriptive subtext.
    - `Max Agents per User`: Number input (min 1, max 100).
    - Save button with toast notification on update.

### 4.3 Auth Views Polish
- `RegisterView.vue`: Upon registration, if `requiresApproval` is true, show success alert: *"Registration successful! Your account is pending administrator approval."*
- `LoginView.vue`: Catch `USER_PENDING_APPROVAL` error and present dedicated explanatory card instead of raw generic error.

---

## 5. Security & Verification

1. **RBAC Isolation:** Normal users attempting to call `/api/admin/*` receive 403 Forbidden with zero data exposure.
2. **First-User Bootstrap:** Strictly atomic `count(id) === 0` check within a transaction so race conditions cannot create multiple unapproved or duplicate admins.
3. **Admin Lockout Prevention:** Validation blocks demoting or deactivating the last active admin.
4. **Test Suite:**
   - Server unit/integration tests (`apps/server/test/admin.test.ts`):
     - First user bootstrap as admin.
     - Second user as pending user.
     - Pending user cannot login.
     - Non-admin blocked from `/api/admin/*`.
     - Admin approve user enables login.
     - Admin settings toggle disables registration.
     - Last admin protection.
   - Web unit tests (`apps/web/src/__tests__/AdminView.test.ts`):
     - Admin view tabs rendering.
     - User approval action triggering API call.
     - Settings save action.
     - Router guard blocking non-admin.
