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
    closeDb();
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
      body: JSON.stringify({
        username: 'bob_pending',
        password: 'Password123!',
      }),
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

  it('registers second user as approved with tokens when autoApproveUsers is true', async () => {
    const app = createApp();
    // 1. First user (admin)
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'Password123!',
        publicKey: 'pk_admin',
      }),
    });
    // 2. Enable autoApproveUsers
    await updateSystemSettings(db, { autoApproveUsers: true });
    // 3. Second user
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'auto_approved',
        password: 'Password123!',
        publicKey: 'pk_auto',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.role).toBe('user');
    expect(body.user.approvalStatus).toBe('approved');
    expect(body.token).toBeDefined();
    expect(body.requiresApproval).toBe(false);
  });
});
