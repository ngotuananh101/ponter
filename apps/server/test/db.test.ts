import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    expect(user).toBeDefined();
    expect(user?.username).toBe('testuser');
  });

  it('manages revoked tokens', async () => {
    const jti = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await db.insert(revokedTokens).values({ jti, expiresAt });

    const row = await db.select().from(revokedTokens).where(eq(revokedTokens.jti, jti)).get();
    expect(row).toBeDefined();
    expect(row?.jti).toBe(jti);
  });
});
