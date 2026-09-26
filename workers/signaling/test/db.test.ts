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
});
