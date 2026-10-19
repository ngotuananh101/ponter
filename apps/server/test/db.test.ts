import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { getDb, closeDb } from '../src/db/client';
import { users, revokedTokens } from '../src/db/schema';
import { eq } from 'drizzle-orm';

describe('Database client', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('creates tables and inserts user', async () => {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: 'testuser',
      publicKey: 'pub_key_test',
    });

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();
    expect(user).toBeDefined();
    expect(user?.username).toBe('testuser');
  });

  it('manages revoked tokens', async () => {
    const jti = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await db.insert(revokedTokens).values({ jti, expiresAt });

    const row = await db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, jti))
      .get();
    expect(row).toBeDefined();
    expect(row?.jti).toBe(jti);
  });

  it('adds the device_code column and its unique index to agents', () => {
    const sqlite = (db as unknown as { $client: BetterSqlite3.Database })
      .$client;
    const columns = sqlite.prepare('PRAGMA table_info(agents)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain('device_code');
    const indexes = sqlite
      .prepare("PRAGMA index_list('agents')")
      .all() as Array<{ name: string; unique: number }>;
    expect(
      indexes.some(
        (i) => i.name === 'idx_agents_device_code' && i.unique === 1,
      ),
    ).toBe(true);
  });
});
