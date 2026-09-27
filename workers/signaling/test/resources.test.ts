import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { RESET_STATEMENTS } from './helpers';
import app from '../src/index';
import { isAgentOnline } from '../src/utils/agent';

/** Produce the space-separated UTC form `datetime('now')` writes, for test fixtures. */
function formatSqlite(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Response shapes asserted by this suite. Kept as local types rather than
 * `any` so the tests stay type-checked and lint-clean (the repo enables
 * `@typescript-eslint/no-explicit-any` as an error).
 */
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

describe('Devices, Agents & Sessions REST API', () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));

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
      env,
    );
    const regData = (await regRes.json()) as AuthResponse;
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
        env,
      );
      expect(createRes.status).toBe(201);
      const dev = (await createRes.json()) as DeviceResponse;
      expect(dev.fingerprint).toBe('fp_macbook_pro');
      expect(dev.userId).toBe(userId);

      // 2. List devices
      const listRes = await app.request(
        '/api/devices',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as DeviceResponse[];
      expect(list).toHaveLength(1);

      // 3. Delete device
      const delRes = await app.request(
        `/api/devices/${dev.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(delRes.status).toBe(200);

      // Verify empty list
      const listAfter = await app.request(
        '/api/devices',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      const listAfterJson = (await listAfter.json()) as DeviceResponse[];
      expect(listAfterJson).toHaveLength(0);
    });

    it('rejects a duplicate fingerprint with 409 DEVICE_EXISTS', async () => {
      const first = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_duplicate',
            deviceType: 'desktop',
          }),
        },
        env,
      );
      expect(first.status).toBe(201);

      const second = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_duplicate',
            deviceName: 'Another machine',
            deviceType: 'mobile',
          }),
        },
        env,
      );

      expect(second.status).toBe(409);
      const err = (await second.json()) as ErrorResponse;
      expect(err.code).toBe('DEVICE_EXISTS');
    });

    it('rejects an invalid deviceType with 400 VALIDATION_ERROR', async () => {
      const res = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_bad_type',
            deviceType: 'laptop',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('deletes a device referenced by a session without a 500', async () => {
      const devRes = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_referenced',
            deviceType: 'desktop',
          }),
        },
        env,
      );
      expect(devRes.status).toBe(201);
      const device = (await devRes.json()) as DeviceResponse;

      const sessRes = await app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ deviceId: device.id }),
        },
        env,
      );
      expect(sessRes.status).toBe(201);
      const session = (await sessRes.json()) as SessionResponse;
      expect(session.deviceId).toBe(device.id);

      // Deleting the device must detach the referencing session rather than
      // tripping the `sessions.device_id` foreign key.
      const delRes = await app.request(
        `/api/devices/${device.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(delRes.status).toBe(200);

      const getRes = await app.request(
        `/api/sessions/${session.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(getRes.status).toBe(200);
      const detached = (await getRes.json()) as SessionResponse;
      expect(detached.deviceId).toBeNull();
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
        env,
      );
      expect(createRes.status).toBe(201);

      const listRes = await app.request(
        '/api/agents',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as AgentResponse[];
      expect(list).toHaveLength(1);
      // `noUncheckedIndexedAccess` makes `list[0]` possibly undefined; the
      // optional chain keeps the assertion honest and the file type-clean.
      expect(list[0]?.id).toBe('agent_host_1');
      expect(list[0]?.userId).toBe(userId);

      const singleRes = await app.request(
        '/api/agents/agent_host_1',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(singleRes.status).toBe(200);
      const single = (await singleRes.json()) as AgentResponse;
      expect(single.hostname).toBe('ubuntu-desktop');
    });

    it('rejects a duplicate agent id with 409 AGENT_EXISTS', async () => {
      const payload = JSON.stringify({
        id: 'agent_dup',
        hostname: 'first-host',
        publicKey: 'pk_dup',
      });

      const first = await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: payload,
        },
        env,
      );
      expect(first.status).toBe(201);

      const second = await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: 'agent_dup',
            hostname: 'second-host',
            publicKey: 'pk_dup_2',
          }),
        },
        env,
      );

      expect(second.status).toBe(409);
      const err = (await second.json()) as ErrorResponse;
      expect(err.code).toBe('AGENT_EXISTS');
    });

    it('issues a credential once and stores only its SHA-256 hash', async () => {
      // Week 5 W12/D19: the plaintext is returned exactly once and never stored.
      const createRes = await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: 'agent_cred',
            publicKey: 'pk_cred',
            capabilities: ['terminal', 'files'],
          }),
        },
        env,
      );

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

      // D1 holds the digest, not the secret.
      const stored = await env.DB.prepare(
        `SELECT credential_hash FROM agents WHERE id = 'agent_cred'`,
      ).first<{ credential_hash: string }>();
      expect(stored?.credential_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.credential_hash).not.toBe(created.credential);

      // The digest is of the full token, `ag_` prefix included (D7).
      const expected = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(created.credential),
      );
      const expectedHex = [...new Uint8Array(expected)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(stored?.credential_hash).toBe(expectedHex);

      // A repeat registration is still 409 and mints no second credential.
      // Resolve the same before/after from the database: a Response body is
      // single-use, so a second `dupRes.json()` would be a vacuous assertion.
      const before = await env.DB.prepare(
        'SELECT credential_hash FROM agents WHERE id = ?',
      )
        .bind('agent_cred')
        .first<{ credential_hash: string | null }>();

      const dupRes = await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ id: 'agent_cred', publicKey: 'pk_cred_2' }),
        },
        env,
      );
      expect(dupRes.status).toBe(409);
      const dupBody = (await dupRes.json()) as ErrorResponse;
      expect(dupBody.code).toBe('AGENT_EXISTS');

      const after = await env.DB.prepare(
        'SELECT credential_hash FROM agents WHERE id = ?',
      )
        .bind('agent_cred')
        .first<{ credential_hash: string | null }>();
      expect(after).toEqual(before);
    });

    it('projects agents without leaking the credential hash (list and get)', async () => {
      // Week 5 W12/D34: `credentialHash` must not reach any response body. A
      // single un-projected route leaks the hash of every agent the user owns.
      await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id: 'agent_proj',
            publicKey: 'pk_proj',
            capabilities: ['terminal'],
          }),
        },
        env,
      );

      const listRes = await app.request(
        '/api/agents',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as AgentResponse[];
      const listed = list.find((a) => a.id === 'agent_proj');
      expect(listed).toBeDefined();
      expect(listed?.capabilities).toEqual(['terminal']);
      expect(listed?.lastHeartbeat).toBeNull();
      expect(Object.keys(listed ?? {})).not.toContain('credentialHash');

      const getRes = await app.request(
        '/api/agents/agent_proj',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as AgentResponse;
      expect(fetched.capabilities).toEqual(['terminal']);
      expect(Object.keys(fetched)).not.toContain('credentialHash');
    });

    it('reports isOnline false when is_online is 1 but the ping is outside the 90s window', async () => {
      // §6.3/W9: `is_online` in D1 is a hint; the 90s window is the truth. A row
      // can read is_online = 1 while the agent has been dark for two minutes,
      // because nothing clears it. The list must not report that as online.
      await app.request(
        '/api/agents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ id: 'agent_stale', publicKey: 'pk_stale' }),
        },
        env,
      );

      // A stale hint: online flag set, ping two minutes old, no socket.
      await env.DB.prepare(
        `UPDATE agents SET is_online = 1, last_ping_at = datetime('now', '-2 minutes') WHERE id = 'agent_stale'`,
      ).run();

      const listRes = await app.request(
        '/api/agents',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      const list = (await listRes.json()) as AgentResponse[];
      const stale = list.find((a) => a.id === 'agent_stale');

      expect(stale?.isOnline).toBe(false);
      expect(stale?.lastHeartbeat).not.toBeNull();

      // A fresh ping with the same flag reads online only if a socket is present
      // in this isolate. With no socket, the window alone is not sufficient —
      // both conditions are required (§6.3 consequence 1).
      await env.DB.prepare(
        `UPDATE agents SET last_ping_at = datetime('now') WHERE id = 'agent_stale'`,
      ).run();

      const freshRes = await app.request(
        '/api/agents',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      const fresh = (await freshRes.json()) as AgentResponse[];
      expect(fresh.find((a) => a.id === 'agent_stale')?.isOnline).toBe(false);
    });
  });

  describe('isAgentOnline boundary (unit)', () => {
    // This test pins the 90s window using the `nowMs` injection point. The HTTP
    // route cannot inject `nowMs`, so a direct unit test is the only way to
    // control the boundary. The offsets are *fixed* at 89s and 91s so that
    // changing ONLINE_WINDOW_SECONDS to a materially different value flips the
    // "inside" assertion from true to false — that is the discriminating proof.
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
        env,
      );
      expect(createRes.status).toBe(201);
      const session = (await createRes.json()) as SessionResponse;
      expect(session.status).toBe('pending');
      expect(session.userId).toBe(userId);

      // Fetch single session
      const getRes = await app.request(
        `/api/sessions/${session.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(getRes.status).toBe(200);

      // Terminate session
      const delRes = await app.request(
        `/api/sessions/${session.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(delRes.status).toBe(200);

      // Verify status terminated
      const getAfter = await app.request(
        `/api/sessions/${session.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      const terminatedSession = (await getAfter.json()) as SessionResponse;
      expect(terminatedSession.status).toBe('terminated');
    });

    it('rejects a null JSON body with 400 VALIDATION_ERROR', async () => {
      const res = await app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: 'null',
        },
        env,
      );

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
      const res = await app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        },
        env,
      );

      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('NOT_FOUND');
    });

    it('rejects a cross-tenant deviceId with 404 NOT_FOUND', async () => {
      // Register a second user and give them a device the first user must not
      // be able to attach to their own session.
      const otherReg = await app.request(
        '/api/auth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'other',
            password: 'Password123!',
            publicKey: 'pk_other',
          }),
        },
        env,
      );
      const other = (await otherReg.json()) as AuthResponse;

      const otherDevRes = await app.request(
        '/api/devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${other.token}`,
          },
          body: JSON.stringify({
            fingerprint: 'fp_other_user',
            deviceType: 'desktop',
          }),
        },
        env,
      );
      expect(otherDevRes.status).toBe(201);
      const otherDevice = (await otherDevRes.json()) as DeviceResponse;

      const res = await app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ deviceId: otherDevice.id }),
        },
        env,
      );

      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrorResponse;
      expect(err.code).toBe('NOT_FOUND');
    });

    it('writes ended_at in the same space-separated UTC format as created_at', async () => {
      // D-6: the route wrote `new Date().toISOString()` here, contradicting
      // §6.4's stated convention. An ISO value compares lexicographically greater
      // than every SQLite timestamp, so any `ended_at > …` filter would match it
      // regardless of when it happened. No prior test asserted this field.
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
        env,
      );
      const created = (await createRes.json()) as { id: string };

      await app.request(
        `/api/sessions/${created.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        env,
      );

      const row = await env.DB.prepare(
        `SELECT created_at, ended_at, updated_at, status FROM sessions WHERE id = ?`,
      )
        .bind(created.id)
        .first<{
          created_at: string;
          ended_at: string;
          updated_at: string;
          status: string;
        }>();

      expect(row?.status).toBe('terminated');
      const sqliteShape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      expect(row?.ended_at).toMatch(sqliteShape);
      expect(row?.updated_at).toMatch(sqliteShape);
      expect(row?.ended_at).not.toContain('T');

      // The column is now comparable to the others with a plain SQL comparison.
      const ordered = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND ended_at >= created_at`,
      )
        .bind(created.id)
        .first<{ n: number }>();
      expect(ordered?.n).toBe(1);
    });
  });
});
