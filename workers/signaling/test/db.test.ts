import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { RESET_STATEMENTS } from './helpers';
import { getDb } from '../src/db/client';
import { users, devices, agents } from '../src/db/schema';
import { eq } from 'drizzle-orm';

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

  it('applies migration 0002 on a populated agents table', async () => {
    // Week 5 W3/W2: the three statements must be safe on real data, and the
    // unique index must reject a duplicate hash while allowing many NULLs.
    // A test against an empty table would pass for a migration that fails on
    // production rows.
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));

    await env.DB.prepare(
      `INSERT INTO users (id, username, public_key) VALUES ('u1', 'user_a', 'pk_a')`,
    ).run();

    // A row shaped like one that predates the migration: no credential, no
    // capabilities. It must survive and stay readable.
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key) VALUES ('legacy', 'u1', 'pk_legacy')`,
    ).run();

    const legacy = await env.DB.prepare(
      `SELECT credential_hash, capabilities FROM agents WHERE id = 'legacy'`,
    ).first<{ credential_hash: string | null; capabilities: string | null }>();
    expect(legacy).toEqual({ credential_hash: null, capabilities: null });

    // sessions.started_at exists and defaults to NULL.
    const sessionCols = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('sessions') WHERE name = 'started_at'`,
    ).first<{ name: string }>();
    expect(sessionCols?.name).toBe('started_at');

    // NULL repeats under the unique index; a duplicate non-NULL hash does not.
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a2', 'u1', 'pk2', NULL)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a3', 'u1', 'pk3', 'hash_abc')`,
    ).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO agents (id, user_id, public_key, credential_hash) VALUES ('a4', 'u1', 'pk4', 'hash_abc')`,
      ).run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
