import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { sessions, users } from '../db/schema.js';
import { recordSignal } from '../utils/signals.js';
import { pushToAgent } from './ws.js';
import type { SignalMessage } from '@ponter/shared';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

// POST /api/signal/offer
router.post('/offer', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    sdp?: string;
    capabilities?: string[];
  } | null;

  if (!body?.sessionId || typeof body.sdp !== 'string' || !body.sdp.trim()) {
    throw new AppError(
      'sessionId and non-empty sdp are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');
  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    throw new AppError('Session is not active', 409, 'SESSION_NOT_ACTIVE');
  }

  const message: SignalMessage = {
    type: 'offer',
    data: {
      sessionId: body.sessionId,
      sdp: body.sdp,
      capabilities: body.capabilities ?? [],
    },
  };

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  // The stored signal row is left unchanged; only the pushed message is
  // enriched. The agent authenticates with its credential and cannot read
  // user rows, so the session owner's signing public key is delivered with
  // the offer. The value is always server-sourced — a client-supplied
  // userSigningPublicKey is spread first and then overwritten below.
  const owner = await db
    .select({ signingPublicKey: users.signingPublicKey })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  // Spread first, then set userSigningPublicKey last so the server-sourced
  // value always wins over anything the client may have sent.
  const pushed: SignalMessage = {
    type: 'offer',
    data: {
      ...message.data,
      userSigningPublicKey: owner?.signingPublicKey ?? null,
    },
  };

  // Fire-and-forget: push the signal to the agent's socket if connected.
  if (session.agentId) {
    pushToAgent(session.agentId, pushed);
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// POST /api/signal/answer
router.post('/answer', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    sdp?: string;
    approved?: boolean;
  } | null;

  if (!body?.sessionId || typeof body.sdp !== 'string' || !body.sdp.trim()) {
    throw new AppError(
      'sessionId and non-empty sdp are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');
  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    throw new AppError('Session is not active', 409, 'SESSION_NOT_ACTIVE');
  }

  const message: SignalMessage = {
    type: 'answer',
    data: {
      sessionId: body.sessionId,
      sdp: body.sdp,
      approved: body.approved !== false,
    },
  };

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  if (session.agentId) {
    pushToAgent(session.agentId, message);
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// POST /api/signal/ice-candidate
router.post('/ice-candidate', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  } | null;

  if (
    !body?.sessionId ||
    typeof body.candidate !== 'string' ||
    !body.candidate.trim()
  ) {
    throw new AppError(
      'sessionId and non-empty candidate are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');
  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, body.sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    throw new AppError('Session is not active', 409, 'SESSION_NOT_ACTIVE');
  }

  const message: SignalMessage = {
    type: 'ice-candidate',
    data: {
      sessionId: body.sessionId,
      candidate: body.candidate,
      sdpMid: body.sdpMid ?? null,
      sdpMLineIndex: body.sdpMLineIndex ?? null,
    },
  };

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    throw new AppError('Failed to record signal', 500, 'INTERNAL_SERVER_ERROR');
  }

  if (session.agentId) {
    pushToAgent(session.agentId, message);
  }

  return c.json(
    {
      id: inserted.id,
      sessionId: inserted.sessionId,
      type: inserted.type,
      createdAt: inserted.createdAt,
    },
    201,
  );
});

// GET /api/signal/poll/:sessionId
router.get('/poll/:sessionId', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('sessionId');
  const afterId = c.req.query('after');
  const rawLimit = Number(c.req.query('limit')) || 50;
  const limit = Math.max(1, Math.min(rawLimit, 200));

  const db = c.get('db');

  // Ownership verification: 404 if not found or owned by a different tenant.
  // No status check: spec allows polling a terminated session so a peer can
  // drain the final signal.
  const session = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  // Order by rowid ASC for deterministic insertion-order delivery. SQLite's
  // created_at has 1-second resolution, so a (created_at, id) cursor would
  // permanently skip signals written within the same second; rowid is strictly
  // monotonic and is the authoritative ordering.
  const query = afterId
    ? sql`
        SELECT id, session_id AS "sessionId", type, payload, created_at AS "createdAt"
        FROM signals
        WHERE session_id = ${sessionId}
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND rowid > COALESCE((SELECT rowid FROM signals WHERE id = ${afterId} AND session_id = ${sessionId}), 0)
        ORDER BY rowid ASC
        LIMIT ${limit}
      `
    : sql`
        SELECT id, session_id AS "sessionId", type, payload, created_at AS "createdAt"
        FROM signals
        WHERE session_id = ${sessionId}
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY rowid ASC
        LIMIT ${limit}
      `;

  const rows = await db.all<{
    id: string;
    sessionId: string;
    type: string;
    payload: string;
    createdAt: string;
  }>(query);

  const parsedSignals = rows.map((r) => {
    let parsedPayload: Record<string, unknown> = {};
    try {
      parsedPayload = JSON.parse(r.payload);
    } catch {
      parsedPayload = { raw: r.payload };
    }
    return {
      id: r.id,
      sessionId: r.sessionId,
      type: r.type,
      payload: parsedPayload,
      createdAt: r.createdAt,
    };
  });

  const nextCursor =
    parsedSignals.length > 0
      ? (parsedSignals[parsedSignals.length - 1]?.id ?? null)
      : null;

  return c.json({
    signals: parsedSignals,
    cursor: nextCursor,
  });
});

export default router;
