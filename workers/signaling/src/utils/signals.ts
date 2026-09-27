import { sql, and, eq } from 'drizzle-orm';
import { signals, sessions } from '../db/schema';
import type { SignalSelect } from '../db/schema';
import type { Database } from '../db/client';
import type { SignalMessage } from '@remote/shared';

/** Matches the TTL the three REST routes wrote before this helper existed. */
export const SIGNAL_TTL_SQL = sql`datetime('now', '+5 minutes')`;

/**
 * Space-separated UTC, matching every other timestamp column in the schema.
 *
 * `datetime('now')` returns `YYYY-MM-DD HH:MM:SS`; `new Date().toISOString()`
 * returns `YYYY-MM-DDTHH:MM:SS.sssZ`. The `'T'` sorts after the `' '`, so a
 * single ISO value in one of these columns compares lexicographically greater
 * than every SQLite timestamp and makes any `> datetime('now', '-90 seconds')`
 * window silently true for it (W10).
 */
export const NOW_SQL = sql`(datetime('now'))`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Narrow an untrusted frame body to a `SignalMessage`.
 *
 * This is the only validator on the agent-socket path and it is deliberately
 * stricter than the REST routes' inline coercion (Week 5 D17): it filters
 * `capabilities` to strings and rejects an out-of-range `sdpMLineIndex`
 * instead of truncating it. `sdpMLineIndex` is `u16` on the Rust side
 * (Week 5 R7), so a negative or >65535 value would otherwise be silently
 * mangled by the peer.
 *
 * Returns `null` rather than throwing: the caller turns a `null` into a
 * `VALIDATION_ERROR` frame, and an inbound frame is attacker-influenced.
 */
export function parseSignalMessage(frame: unknown): SignalMessage | null {
  if (!isPlainObject(frame)) return null;
  if (!isPlainObject(frame.data)) return null;

  const sessionId = nonEmptyString(frame.data.sessionId);
  if (!sessionId) return null;

  if (frame.type === 'offer') {
    const sdp = nonEmptyString(frame.data.sdp);
    if (!sdp) return null;
    const raw = frame.data.capabilities;
    const capabilities = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : [];
    return { type: 'offer', data: { sessionId, sdp, capabilities } };
  }

  if (frame.type === 'answer') {
    const sdp = nonEmptyString(frame.data.sdp);
    if (!sdp) return null;
    return {
      type: 'answer',
      data: { sessionId, sdp, approved: frame.data.approved !== false },
    };
  }

  if (frame.type === 'ice-candidate') {
    const candidate = nonEmptyString(frame.data.candidate);
    if (!candidate) return null;
    const sdpMid = nonEmptyString(frame.data.sdpMid);
    const rawIndex = frame.data.sdpMLineIndex;
    const sdpMLineIndex =
      typeof rawIndex === 'number' &&
      Number.isInteger(rawIndex) &&
      rawIndex >= 0 &&
      rawIndex <= 65535
        ? rawIndex
        : null;
    return {
      type: 'ice-candidate',
      data: { sessionId, candidate, sdpMid, sdpMLineIndex },
    };
  }

  return null;
}

/**
 * The single write path for `signals`, shared by the REST routes and the agent
 * socket.
 *
 * `type` and `payload` are derived from the `SignalMessage`, so the two callers
 * cannot disagree about a row's shape. The `answer → active` session
 * transition lives here too (added in Task 5) for the same reason: two copies
 * of "insert the signal, then maybe transition the session" would drift.
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
  // signal, then maybe advance the session" (D16).
  //
  // The guard is `= 'pending'`, NOT `IN ('pending','active')`. §6.1's guard
  // paragraph states the blanket `IN` form for both transitions, but applied
  // here it also matches an already-`active` session and overwrites
  // `started_at` on every duplicate answer — the opposite of what §6.1
  // promises two paragraphs later ("when `type === 'answer'` and the session is
  // `pending`"). The `terminated` transition in `ws.ts` keeps the `IN` form,
  // where it is correct: there it is what stops a socket close from moving
  // `ended_at` after an explicit browser `DELETE`. See D-8.
  //
  // The transition keys on the signal *type*, not on which peer sent it: at the
  // database level the browser and the agent of one user are the same principal
  // for REST. In practice the browser is the offerer and never sends an
  // `answer`, so "an answer was persisted" and "the agent answered" coincide.
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
