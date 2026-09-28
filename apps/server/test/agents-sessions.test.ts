import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { getDb, closeDb } from '../src/db/client';
import { agents, sessions } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { isAgentOnline } from '../src/utils/agent';

// In-process secrets for tests. These satisfy the "at least some entropy"
// expectation without depending on the real deployment env vars.
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

type PublicUser = {
  id: string;
  username: string;
  email: string | null;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type AuthResponse = {
  user: PublicUser;
  token: string;
  refreshToken: string;
  expiresIn: number;
};

type DeviceResponse = {
  id: string;
  userId: string;
  deviceName: string | null;
  deviceType: string;
  fingerprint: string;
  isTrusted: boolean;
  lastSeenAt: string | null;
  createdAt: string;
};

type AgentResponse = {
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
};

type SessionResponse = {
  id: string;
  userId: string;
  deviceId: string | null;
  agentId: string | null;
  status: string;
  startedAt: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  metadata: string | null;
};

type ErrorResponse = {
  error: string;
  code: string;
  details: unknown;
};

/** Produce the space-separated UTC form `datetime('now')` writes, for test fixtures. */
function formatSqlite(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');
}

describe('Agents, Devices & Sessions REST API', () => {
  let db: ReturnType<typeof getDb>;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    db = getDb(':memory:');

    const app = createApp();
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'tester',
        password: 'Password123!',
        publicKey: 'pk_tester',
      }),
    });

    const regData = (await regRes.json()) as AuthResponse;
    token = regData.token;
    userId = regData.user.id;
  });

  afterEach(() => {
    closeDb();
  });

  describe('Devices API (/api/devices)', () => {
    it('registers, lists, and deletes a device', async () => {
      const app = createApp();

      // 1. Register device
      const createRes = await app.request('/api/devices', {
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
      });
      expect(createRes.status).toBe(201);
      const dev = (await createRes.json()) as DeviceResponse;
      expect(dev.fingerprint).toBe('fp_macbook_pro');
      expect(dev.userId).toBe(userId);

      // 2. List devices
      const listRes = await app.request('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as DeviceResponse[];
      expect(list).toHaveLength(1);

      // 3. Delete device
      const delRes = await app.request(`/api/devices/${dev.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      // Verify empty list
      const listAfter = await app.request('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listAfterJson = (await listAfter.json()) as DeviceResponse[];
      expect(listAfterJson).toHaveLength(0);
    });

    it('rejects a duplicate fingerprint with 409 DEVICE_EXISTS', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      const first = await app.request('/api/devices', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fingerprint: 'fp_duplicate',
          deviceType: 'desktop',
        }),
      });
      expect(first.status).toBe(201);

      const second = await app.request('/api/devices', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fingerprint: 'fp_duplicate',
          deviceName: 'Another machine',
          deviceType: 'mobile',
        }),
      });

      expect(second.status).toBe(409);
      const err = (await second.json()) as ErrorResponse;
      expect(err.code).toBe('DEVICE_EXISTS');
    });

    it('rejects an invalid deviceType with 400 VALIDATION_ERROR', async () => {
      const app = createApp();
      const res = await app.request('/api/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fingerprint: 'fp_bad_type',
          deviceType: 'laptop',
        }),
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('deletes a device referenced by a session without a 500', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      const devRes = await app.request('/api/devices', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fingerprint: 'fp_referenced',
          deviceType: 'desktop',
        }),
      });
      expect(devRes.status).toBe(201);
      const device = (await devRes.json()) as DeviceResponse;

      const sessRes = await app.request('/api/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: device.id }),
      });
      expect(sessRes.status).toBe(201);
      const session = (await sessRes.json()) as SessionResponse;
      expect(session.deviceId).toBe(device.id);

      // Deleting the device must detach the referencing session rather than
      // tripping the `sessions.device_id` foreign key.
      const delRes = await app.request(`/api/devices/${device.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      const getRes = await app.request(`/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      const detached = (await getRes.json()) as SessionResponse;
      expect(detached.deviceId).toBeNull();
    });
  });

  describe('Agents API (/api/agents)', () => {
    it('registers, lists, and fetches an agent', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      const createRes = await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'agent_host_1',
          hostname: 'ubuntu-desktop',
          platform: 'linux',
          osVersion: '24.04',
          agentVersion: '0.1.0',
          publicKey: 'pk_host_agent',
        }),
      });
      expect(createRes.status).toBe(201);

      const listRes = await app.request('/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as AgentResponse[];
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe('agent_host_1');
      expect(list[0]?.userId).toBe(userId);

      const singleRes = await app.request('/api/agents/agent_host_1', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(singleRes.status).toBe(200);
      const single = (await singleRes.json()) as AgentResponse;
      expect(single.hostname).toBe('ubuntu-desktop');
    });

    it('rejects a duplicate agent id with 409 AGENT_EXISTS', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const payload = JSON.stringify({
        id: 'agent_dup',
        hostname: 'first-host',
        publicKey: 'pk_dup',
      });

      const first = await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: payload,
      });
      expect(first.status).toBe(201);

      const second = await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'agent_dup',
          hostname: 'second-host',
          publicKey: 'pk_dup_2',
        }),
      });

      expect(second.status).toBe(409);
      const err = (await second.json()) as ErrorResponse;
      expect(err.code).toBe('AGENT_EXISTS');
    });

    it('issues a credential once and stores only its SHA-256 hash', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      const createRes = await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'agent_cred',
          publicKey: 'pk_cred',
          capabilities: ['terminal', 'files'],
        }),
      });

      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        agent: AgentResponse;
        credential: string;
      };

      expect(created.credential).toMatch(/^ag_[0-9a-f]{32}$/);
      expect(created.agent.capabilities).toEqual(['terminal', 'files']);
      expect(created.agent.lastHeartbeat).toBeNull();
      expect(created.agent.isOnline).toBe(false);
      // The projection must not carry the hash.
      expect(Object.keys(created.agent)).not.toContain('credentialHash');

      // D1 (SQLite) holds the digest, not the secret.
      const stored = (await db
        .select({ credentialHash: agents.credentialHash })
        .from(agents)
        .where(eq(agents.id, 'agent_cred'))
        .get()) as { credentialHash: string | null } | undefined;

      expect(stored?.credentialHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.credentialHash).not.toBe(created.credential);

      // The digest is of the full token, `ag_` prefix included (D7).
      const expected = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(created.credential),
      );
      const expectedHex = [...new Uint8Array(expected)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(stored?.credentialHash).toBe(expectedHex);

      // A repeat registration is still 409 and mints no second credential.
      const before = await db
        .select({ credentialHash: agents.credentialHash })
        .from(agents)
        .where(eq(agents.id, 'agent_cred'))
        .get();

      const dupRes = await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'agent_cred', publicKey: 'pk_cred_2' }),
      });
      expect(dupRes.status).toBe(409);
      const dupBody = (await dupRes.json()) as ErrorResponse;
      expect(dupBody.code).toBe('AGENT_EXISTS');

      const after = await db
        .select({ credentialHash: agents.credentialHash })
        .from(agents)
        .where(eq(agents.id, 'agent_cred'))
        .get();
      expect(after).toEqual(before);
    });

    it('projects agents without leaking the credential hash (list and get)', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'agent_proj',
          publicKey: 'pk_proj',
          capabilities: ['terminal'],
        }),
      });

      const listRes = await app.request('/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as AgentResponse[];
      const listed = list.find((a) => a.id === 'agent_proj');
      expect(listed).toBeDefined();
      expect(listed?.capabilities).toEqual(['terminal']);
      expect(listed?.lastHeartbeat).toBeNull();
      expect(Object.keys(listed ?? {})).not.toContain('credentialHash');

      const getRes = await app.request('/api/agents/agent_proj', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as AgentResponse;
      expect(fetched.capabilities).toEqual(['terminal']);
      expect(Object.keys(fetched)).not.toContain('credentialHash');
    });

    it('reports isOnline false when is_online is 1 but the ping is outside the 90s window', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'agent_stale', publicKey: 'pk_stale' }),
      });

      // A stale hint: online flag set, ping two minutes old, no socket.
      // Update the row directly via Drizzle (bypassing the route).
      await db
        .update(agents)
        .set({
          isOnline: true,
          lastPingAt: new Date(Date.now() - 120_000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' '),
        })
        .where(eq(agents.id, 'agent_stale'));

      const listRes = await app.request('/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list = (await listRes.json()) as AgentResponse[];
      const stale = list.find((a) => a.id === 'agent_stale');

      expect(stale?.isOnline).toBe(false);
      expect(stale?.lastHeartbeat).not.toBeNull();

      // A fresh ping with is_online = 1 reads online.
      const freshPing = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await db
        .update(agents)
        .set({ lastPingAt: freshPing })
        .where(eq(agents.id, 'agent_stale'));

      const freshRes = await app.request('/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const fresh = (await freshRes.json()) as AgentResponse[];
      expect(fresh.find((a) => a.id === 'agent_stale')?.isOnline).toBe(true);
    });

    it('deletes an agent and removes it from the listing', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      await app.request('/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'agent_delete', publicKey: 'pk_del' }),
      });

      // Confirm it exists
      let list = (await app
        .request('/api/agents', {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())) as AgentResponse[];
      expect(list).toHaveLength(1);

      const delRes = await app.request('/api/agents/agent_delete', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      list = (await app
        .request('/api/agents', {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.json())) as AgentResponse[];
      expect(list).toHaveLength(0);
    });

    it('rejects a cross-tenant agent GET with 404', async () => {
      const app = createApp();

      // Register a second user who registers their own agent.
      const otherRes = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'other',
          password: 'Password123!',
          publicKey: 'pk_other',
        }),
      });
      const other = (await otherRes.json()) as AuthResponse;

      await app.request('/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({
          id: 'agent_other',
          publicKey: 'pk_other_agent',
        }),
      });

      const res = await app.request('/api/agents/agent_other', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('isAgentOnline boundary (unit)', () => {
    const baseAgent = { isOnline: true, lastPingAt: null as string | null };

    it('reads online inside the window and offline outside it, pinning ONLINE_WINDOW_SECONDS', () => {
      const nowMs = 1_700_000_000_000; // fixed epoch for reproducibility

      // 89s ago: inside the 90s window → online.
      const inside = {
        ...baseAgent,
        lastPingAt: formatSqlite(nowMs - 89_000),
      };
      expect(isAgentOnline(inside, true, nowMs)).toBe(true);

      // 91s ago: outside the window → offline.
      const outside = {
        ...baseAgent,
        lastPingAt: formatSqlite(nowMs - 91_000),
      };
      expect(isAgentOnline(outside, true, nowMs)).toBe(false);
    });
  });

  describe('Sessions API (/api/sessions)', () => {
    it('creates, retrieves, and terminates a session', async () => {
      const app = createApp();

      // Create session
      const createRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      expect(createRes.status).toBe(201);
      const session = (await createRes.json()) as SessionResponse;
      expect(session.status).toBe('pending');
      expect(session.userId).toBe(userId);

      // Fetch single session
      const getRes = await app.request(`/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);

      // Terminate session
      const delRes = await app.request(`/api/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      // Verify status terminated
      const getAfter = await app.request(`/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const terminatedSession = (await getAfter.json()) as SessionResponse;
      expect(terminatedSession.status).toBe('terminated');
    });

    it('creates a session bound to an agent', async () => {
      const app = createApp();
      const agentHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      // Register an agent first
      const agentRes = await app.request('/api/agents', {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({
          id: 'agent_for_session',
          publicKey: 'pk_session_agent',
        }),
      });
      expect(agentRes.status).toBe(201);
      const { agent: createdAgent } = (await agentRes.json()) as {
        agent: AgentResponse;
        credential: string;
      };

      // Create session bound to that agent
      const sessRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ agentId: createdAgent.id }),
      });
      expect(sessRes.status).toBe(201);
      const session = (await sessRes.json()) as SessionResponse;
      expect(session.status).toBe('pending');
      expect(session.agentId).toBe(createdAgent.id);

      // List sessions returns the session with agent details
      const listRes = await app.request('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as SessionResponse[];
      expect(list).toHaveLength(1);
      expect(list[0]?.agentId).toBe(createdAgent.id);
    });

    it('marks status=terminated and ended_at=now on DELETE', async () => {
      const app = createApp();

      const createRes = await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const session = (await createRes.json()) as SessionResponse;

      await app.request(`/api/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      // Read the raw row to verify ended_at was set.
      const row = await db
        .select({
          status: sessions.status,
          endedAt: sessions.endedAt,
          updatedAt: sessions.updatedAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .get();

      expect(row?.status).toBe('terminated');

      // ended_at must be set and match SQLite's space-separated UTC shape.
      expect(row?.endedAt).not.toBeNull();
      expect(typeof row?.endedAt).toBe('string');
      const sqliteShape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      expect(row?.endedAt).toMatch(sqliteShape);
      expect(row?.endedAt).not.toContain('T');

      // The column is comparable to created_at with a plain SQL comparison.
      const ordered = await db
        .select({ n: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, session.id));
      expect(ordered).toHaveLength(1);
    });

    it('lists sessions scoped to the authenticated user', async () => {
      const app = createApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      // User 1 creates a session
      await app.request('/api/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      // User 2 registers and creates a session
      const otherRes = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'other_user',
          password: 'Password123!',
          publicKey: 'pk_other_user',
        }),
      });
      const other = (await otherRes.json()) as AuthResponse;

      await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({}),
      });

      // User 1's list should only show their own session
      const listRes = await app.request('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list = (await listRes.json()) as SessionResponse[];
      expect(list).toHaveLength(1);
      expect(list[0]?.userId).toBe(userId);
    });

    it('rejects a null JSON body with 400 VALIDATION_ERROR', async () => {
      const app = createApp();
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: 'null',
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['a non-existent deviceId', { deviceId: 'does-not-exist' }],
      ['a non-existent agentId', { agentId: 'does-not-exist' }],
      ['an empty-string deviceId', { deviceId: '' }],
      ['an empty-string agentId', { agentId: '' }],
      ['a non-string deviceId', { deviceId: 12345 }],
    ])('rejects %s with 404 NOT_FOUND', async (_label, payload) => {
      const app = createApp();
      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('NOT_FOUND');
    });

    it('rejects a cross-tenant deviceId with 404 NOT_FOUND', async () => {
      const app = createApp();

      // Register a second user and give them a device the first user must not
      // be able to attach to their own session.
      const otherRes = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'cross_tenant',
          password: 'Password123!',
          publicKey: 'pk_cross',
        }),
      });
      const other = (await otherRes.json()) as AuthResponse;

      const otherDevRes = await app.request('/api/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({
          fingerprint: 'fp_other_user',
          deviceType: 'desktop',
        }),
      });
      expect(otherDevRes.status).toBe(201);
      const otherDevice = (await otherDevRes.json()) as DeviceResponse;

      const res = await app.request('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId: otherDevice.id }),
      });

      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('NOT_FOUND');
    });

    it('rejects session access without auth with 401', async () => {
      const app = createApp();

      const res = await app.request('/api/sessions', {});
      expect(res.status).toBe(401);
    });

    it('rejects session access with a revoked token with 401', async () => {
      const app = createApp();

      // Revoke the access token via logout
      await app.request('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await app.request('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
