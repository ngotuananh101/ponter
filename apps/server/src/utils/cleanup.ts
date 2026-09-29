import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { sessions, signals } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * How long a `pending` session may sit before it is treated as abandoned.
 *
 * The agent enforces a 1 h cap on a *running* session, but a session that never
 * got that far — the browser closed the tab, or the handshake died before an
 * answer — has no timer anywhere. An hour matches the agent's own cap, so this
 * never races a session that is still legitimately handshaking.
 */
const ABANDONED_SESSION_MINUTES = 60;

export interface CleanupResult {
  signalsDeleted: number;
  sessionsTerminated: number;
}

/**
 * Reap expired signals and abandoned sessions.
 *
 * The `signals.expires_at` column was written from the start and honoured by
 * the poll query, but nothing ever deleted the rows, so the table grew without
 * bound. Same for `pending` sessions: they were inserted and, on any failure
 * short of an answer, never transitioned or removed.
 *
 * Both operations are idempotent — a second run finds nothing to do — so this
 * is safe to call on a timer without tracking what the previous run did.
 *
 * Only `pending` sessions are terminated. A long-running terminal is
 * legitimately older than the window, and a `terminated` row that is rewritten
 * would move its `endedAt` for no reason.
 */
export async function runCleanup(db: Database): Promise<CleanupResult> {
  const now = sql`(datetime('now'))`;
  // SQLite's `datetime('now', ?)` takes the modifier as a bound string; a
  // template-interpolated one (`'-60 minutes'`) binds each character
  // separately and the whole query is rejected.
  const abandonedModifier = `-${ABANDONED_SESSION_MINUTES} minutes`;
  const abandonedBefore = sql`(datetime('now', ${abandonedModifier}))`;

  const deletedSignals = await db
    .delete(signals)
    .where(and(isNotNull(signals.expiresAt), lt(signals.expiresAt, now)))
    .returning({ id: signals.id });

  const terminatedSessions = await db
    .update(sessions)
    .set({ status: 'terminated', endedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessions.status, 'pending'),
        lt(sessions.updatedAt, abandonedBefore),
      ),
    )
    .returning({ id: sessions.id });

  return {
    signalsDeleted: deletedSignals.length,
    sessionsTerminated: terminatedSessions.length,
  };
}
