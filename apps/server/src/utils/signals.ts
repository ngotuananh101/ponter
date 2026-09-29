import { sql, and, eq } from 'drizzle-orm';
import { signals, sessions } from '../db/schema.js';
import type { SignalSelect } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { SignalMessage } from '@ponter/shared';

/** Matches the TTL the signal routes write before this helper existed. */
export const SIGNAL_TTL_SQL = sql`datetime('now', '+5 minutes')`;

/**
 * Space-separated UTC, matching every other timestamp column in the schema.
 *
 * `datetime('now')` returns `YYYY-MM-DD HH:MM:SS`; `new Date().toISOString()`
 * returns `YYYY-MM-DDTHH:MM:SS.sssZ`. The `'T'` sorts after the `' '`, so a
 * single ISO value in one of these columns compares lexicographically greater
 * than every SQLite timestamp.
 */
export const NOW_SQL = sql`(datetime('now'))`;

/**
 * The single write path for `signals`, shared by the REST routes and the agent
 * socket.
 *
 * `type` and `payload` are derived from the `SignalMessage`, so the two callers
 * cannot disagree about a row's shape. The `answer -> active` session
 * transition lives here too: two copies of "insert the signal, then maybe
 * transition the session" would drift.
 */
export async function recordSignal(
  db: Database,
  message: SignalMessage,
): Promise<SignalSelect | null> {
  const [inserted] = await db
    .insert(signals)
    .values({
      sessionId: message.data.sessionId,
      type: message.type,
      payload: JSON.stringify(message.data),
      expiresAt: SIGNAL_TTL_SQL,
    })
    .returning();

  // `pending -> active` lives here rather than in either caller, because the
  // REST routes and the agent socket must not grow two copies of "insert the
  // signal, then maybe advance the session".
  //
  // The guard is `= 'pending'`, NOT `IN ('pending','active')`. The transition's
  // guarantee is "when `type === 'answer'` and the session is `pending`".
  if (message.type === 'answer') {
    await db
      .update(sessions)
      .set({ status: 'active', startedAt: NOW_SQL, updatedAt: NOW_SQL })
      .where(
        and(
          eq(sessions.id, message.data.sessionId),
          eq(sessions.status, 'pending'),
        ),
      );
  }

  return inserted ?? null;
}
