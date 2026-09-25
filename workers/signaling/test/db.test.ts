import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db/client';
import { users, devices, agents } from '../src/db/schema';
import { eq } from 'drizzle-orm';

/**
 * `D1Database.exec()` splits its input on newlines — the documented contract is
 * "one or multiple queries separated by `\n`" — so a multi-line `CREATE TABLE`
 * is torn apart mid-statement and fails with `incomplete input: SQLITE_ERROR`.
 *
 * `D1Database.batch()` instead takes one prepared statement per array entry, so
 * each statement below keeps its exact multi-line SQL while the statements still
 * run sequentially and atomically.
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

describe('D1 Database & Schema', () => {
  beforeEach(async () => {
    // Drop and create tables for clean isolation in in-memory D1
    await env.DB.batch(RESET_STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it('inserts and queries a user with Drizzle', async () => {
    const db = getDb(env.DB);
    await db.insert(users).values({
      id: 'usr_1',
      username: 'alice',
      email: 'alice@example.com',
      publicKey: 'pubkey_alice',
      passwordHash: 'hash_123',
    });

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, 'usr_1'))
      .get();
    expect(user).toBeDefined();
    expect(user?.username).toBe('alice');
    expect(user?.isActive).toBe(true);
  });

  it('cascades delete from users to devices and agents', async () => {
    const db = getDb(env.DB);
    await db.insert(users).values({
      id: 'usr_2',
      username: 'bob',
      publicKey: 'pubkey_bob',
    });

    await db.insert(devices).values({
      id: 'dev_1',
      userId: 'usr_2',
      deviceType: 'desktop',
      fingerprint: 'fp_bob_1',
    });

    await db.insert(agents).values({
      id: 'agent_1',
      userId: 'usr_2',
      publicKey: 'pubkey_agent_1',
    });

    // Delete user
    await db.delete(users).where(eq(users.id, 'usr_2'));

    // Check device and agent deleted via CASCADE
    const dev = await db
      .select()
      .from(devices)
      .where(eq(devices.id, 'dev_1'))
      .get();
    const ag = await db
      .select()
      .from(agents)
      .where(eq(agents.id, 'agent_1'))
      .get();
    expect(dev).toBeUndefined();
    expect(ag).toBeUndefined();
  });
});
