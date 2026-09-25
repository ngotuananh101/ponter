import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';

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
  lastPingAt: string | null;
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

/**
 * `D1Database.exec()` splits its input on newlines, so a multi-line
 * `CREATE TABLE` is torn apart mid-statement. `D1Database.batch()` takes one
 * prepared statement per array entry, keeping each statement's exact
 * multi-line SQL while still running them sequentially and atomically.
 *
 * The DDL mirrors the Drizzle schema in `src/db/schema.ts` — including
 * `last_login_at` and `metadata`, which the auth routes write to.
 */
const RESET_STATEMENTS = [
  'PRAGMA foreign_keys = ON',
  'DROP TABLE IF EXISTS signals',
  'DROP TABLE IF EXISTS audit_logs',
  'DROP TABLE IF EXISTS sessions',
  'DROP TABLE IF EXISTS agents',
  'DROP TABLE IF EXISTS devices',
  'DROP TABLE IF EXISTS users',
  `CREATE TABLE users (
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
  )`,
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    device_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    is_trusted INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE agents (
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
  )`,
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id),
    agent_id TEXT REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    metadata TEXT
  )`,
];

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
      expect(list.length).toBe(1);

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
      expect(((await listAfter.json()) as DeviceResponse[]).length).toBe(0);
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
      expect(list.length).toBe(1);
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
  });
});
