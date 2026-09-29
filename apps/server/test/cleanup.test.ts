import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../src/db/client.js';
import { runCleanup } from '../src/utils/cleanup.js';
import { startCleanup } from '../src/index.js';
import { users, agents, sessions, signals } from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';

// Nothing ever deleted expired signals or abandoned `pending` sessions, so both
// tables grew without bound and a session the user walked away from mid-handshake
// stayed `pending` forever.
describe('cleanup', () => {
  let db: Database;

  beforeEach(async () => {
    db = getDb(':memory:');
    // `sessions.agent_id` and `sessions.user_id` are foreign keys, so the rows
    // the tests terminate have to hang off real parents.
    await db.insert(users).values({
      id: 'user-1',
      username: 'tester',
      publicKey: 'pk_tester',
    });
    await db.insert(agents).values({
      id: 'agent-1',
      userId: 'user-1',
      publicKey: 'pk_agent',
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('deletes signals whose TTL has passed', async () => {
    // `signals.session_id` is a foreign key, so the rows need a real session.
    await db.insert(sessions).values({
      id: 'sess-host',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'active',
    });
    await db.insert(signals).values({
      id: 'sig-expired',
      sessionId: 'sess-host',
      type: 'offer',
      payload: '{}',
      expiresAt: '2020-01-01 00:00:00',
    });
    await db.insert(signals).values({
      id: 'sig-fresh',
      sessionId: 'sess-host',
      type: 'answer',
      payload: '{}',
      expiresAt: '2099-01-01 00:00:00',
    });
    // A NULL expiry must survive: the column is nullable for backward
    // compatibility with rows written before the TTL existed.
    await db.insert(signals).values({
      id: 'sig-no-ttl',
      sessionId: 'sess-host',
      type: 'offer',
      payload: '{}',
      expiresAt: null,
    });

    const result = await runCleanup(db);

    expect(result.signalsDeleted).toBe(1);
    const remaining = await db.select().from(signals);
    expect(remaining.map((s) => s.id).sort()).toEqual([
      'sig-fresh',
      'sig-no-ttl',
    ]);
  });

  it('terminates a pending session older than the abandonment window', async () => {
    await db.insert(sessions).values({
      id: 'sess-stale',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'pending',
      createdAt: '2020-01-01 00:00:00',
      updatedAt: '2020-01-01 00:00:00',
    });

    const result = await runCleanup(db);

    expect(result.sessionsTerminated).toBe(1);
    const [stale] = await db.select().from(sessions);
    expect(stale?.status).toBe('terminated');
    expect(stale?.endedAt).toBeTruthy();
  });

  it('leaves a recent pending session alone', async () => {
    // A handshake still legitimately in flight must not be reaped out from under
    // the agent that is about to answer it.
    const now = new Date().toISOString();
    await db.insert(sessions).values({
      id: 'sess-recent',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const result = await runCleanup(db);

    expect(result.sessionsTerminated).toBe(0);
    const [row] = await db.select().from(sessions);
    expect(row?.status).toBe('pending');
  });

  it('leaves an old active session alone', async () => {
    // A long-running terminal is legitimately older than the window; only
    // `pending` means nobody ever finished the handshake.
    await db.insert(sessions).values({
      id: 'sess-long',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'active',
      createdAt: '2020-01-01 00:00:00',
      updatedAt: '2020-01-01 00:00:00',
    });

    const result = await runCleanup(db);

    expect(result.sessionsTerminated).toBe(0);
    const [row] = await db.select().from(sessions);
    expect(row?.status).toBe('active');
  });

  it('leaves an old terminated session alone', async () => {
    // Re-terminating would move `endedAt` and rewrite history for no reason.
    await db.insert(sessions).values({
      id: 'sess-done',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'terminated',
      createdAt: '2020-01-01 00:00:00',
      updatedAt: '2020-01-01 00:00:00',
    });

    const result = await runCleanup(db);

    expect(result.sessionsTerminated).toBe(0);
  });

  it('is idempotent', async () => {
    // The job runs on a timer with no state of its own, so a second pass must
    // find nothing rather than re-terminating or re-counting.
    await db.insert(sessions).values({
      id: 'sess-signal-host',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'active',
    });
    await db.insert(signals).values({
      id: 'sig-old',
      sessionId: 'sess-signal-host',
      type: 'offer',
      payload: '{}',
      expiresAt: '2020-01-01 00:00:00',
    });
    await db.insert(sessions).values({
      id: 'sess-stale',
      userId: 'user-1',
      agentId: 'agent-1',
      status: 'pending',
      createdAt: '2020-01-01 00:00:00',
      updatedAt: '2020-01-01 00:00:00',
    });

    const first = await runCleanup(db);
    const second = await runCleanup(db);

    expect(first.signalsDeleted).toBe(1);
    expect(first.sessionsTerminated).toBe(1);
    expect(second.signalsDeleted).toBe(0);
    expect(second.sessionsTerminated).toBe(0);
  });
});

describe('cleanup timer', () => {
  afterEach(() => {
    closeDb();
  });

  it('stops cleanly so a test or shutdown can release the interval', async () => {
    const db = getDb(':memory:');
    const handle = startCleanup(db, 10_000);
    expect(() => handle.stop()).not.toThrow();
  });

  it('does not throw when the database is unusable', () => {
    // A failing reap is housekeeping, not a reason to take the server down.
    const broken = {
      delete: () => {
        throw new Error('database is locked');
      },
      update: () => {
        throw new Error('database is locked');
      },
    } as unknown as Database;

    expect(() => startCleanup(broken, 10_000).stop()).not.toThrow();
  });
});
