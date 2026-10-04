import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { users } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import type { User } from '@ponter/shared';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET =
  'test-refresh-secret-at-least-32-characters-long';

describe('Admin REST Routes', () => {
  let db: Database;
  let adminToken: string;
  let adminUser: User;
  let regularToken: string;
  let regularUser: User;

  beforeEach(async () => {
    db = getDb(':memory:');
    const app = createApp();

    // 1. Admin registration (first user)
    const adminRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'superadmin',
        password: 'Password123!',
        publicKey: 'pk_admin',
      }),
    });
    const adminData = await adminRes.json();
    adminToken = adminData.token;
    adminUser = adminData.user;

    // 2. Regular user registration
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'user1',
        password: 'Password123!',
        publicKey: 'pk_user1',
      }),
    });
    regularUser = (await regRes.json()).user;

    // Manually approve user1 to get a token for testing regular user access
    await db
      .update(users)
      .set({ approvalStatus: 'approved' })
      .where(eq(users.id, regularUser.id));
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

  it('returns a numeric top-level total for GET /api/admin/users?status=all', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/users?status=all', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe('number');
    expect(body.total).toBe(2);
  });

  it('filters users by status=inactive (isActive = false)', async () => {
    const app = createApp();

    // Deactivate regularUser via admin patch.
    const deactivateRes = await app.request(
      `/api/admin/users/${regularUser.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: false }),
      },
    );
    expect(deactivateRes.status).toBe(200);

    const res = await app.request('/api/admin/users?status=inactive', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // The deactivated user should appear in the inactive filter results.
    expect(
      body.users.some((u: { id: string }) => u.id === regularUser.id),
    ).toBe(true);
    // The active admin should NOT appear.
    expect(body.users.some((u: { id: string }) => u.id === adminUser.id)).toBe(
      false,
    );
    expect(body.total).toBe(1);
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

  it('allows demoting a regular user back to user while 2 active admins, then blocks demoting the last active admin', async () => {
    const app = createApp();

    // Promote regularUser to admin (now 2 active admins).
    const promoteRes = await app.request(`/api/admin/users/${regularUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approvalStatus: 'approved', role: 'admin' }),
    });
    expect(promoteRes.status).toBe(200);
    const promoted = await promoteRes.json();
    expect(promoted.user.role).toBe('admin');

    // Demote regularUser back to user (2 active admins → allowed, RF4-03/04).
    const demoteRes = await app.request(`/api/admin/users/${regularUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(demoteRes.status).toBe(200);
    const demoted = await demoteRes.json();
    expect(demoted.user.role).toBe('user');

    // Demote adminUser (last remaining active admin → blocked, RF4-05).
    const lastDemoteRes = await app.request(
      `/api/admin/users/${adminUser.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user' }),
      },
    );
    expect(lastDemoteRes.status).toBe(400);
    const err = await lastDemoteRes.json();
    expect(err.code).toBe('LAST_ADMIN_PROTECTED');
  });

  it('rejects unauthenticated admin access with 401', async () => {
    const app = createApp();

    const statsRes = await app.request('/api/admin/stats');
    expect(statsRes.status).toBe(401);

    const usersRes = await app.request('/api/admin/users?status=all');
    expect(usersRes.status).toBe(401);
  });

  it('rejects requests from a deactivated user token with 401 UNAUTHORIZED', async () => {
    const app = createApp();

    // Deactivating another user is allowed (only self-deactivation is blocked).
    const deactivateRes = await app.request(
      `/api/admin/users/${regularUser.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: false }),
      },
    );
    expect(deactivateRes.status).toBe(200);

    // regularToken was issued in beforeEach while the user was active; the
    // auth middleware re-checks isActive on every request, so it is now rejected.
    const statsRes = await app.request('/api/admin/stats', {
      headers: { Authorization: `Bearer ${regularToken}` },
    });
    expect(statsRes.status).toBe(401);
    const err = await statsRes.json();
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects login for a rejected user with 403 USER_REJECTED', async () => {
    const app = createApp();

    // Admin rejects regularUser (correct password, so password check passes first).
    const rejectRes = await app.request(`/api/admin/users/${regularUser.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approvalStatus: 'rejected' }),
    });
    expect(rejectRes.status).toBe(200);

    // Login with correct credentials still fails for a rejected account.
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'Password123!' }),
    });
    expect(loginRes.status).toBe(403);
    const err = await loginRes.json();
    expect(err.code).toBe('USER_REJECTED');
  });

  it('returns 200 (not 500) for invalid page/limit params', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/users?page=abc&limit=xyz', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('rejects maxAgentsPerUser > 100 with 400', async () => {
    const app = createApp();
    const res = await app.request('/api/admin/settings', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxAgentsPerUser: 101 }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});
