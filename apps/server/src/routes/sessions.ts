import { Hono } from 'hono';
import { eq, and, sql, or } from 'drizzle-orm';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { sessions, devices, agents } from '../db/schema.js';
import { pushToBrowser } from './ws.js';
import { normalizeDeviceCode } from '../utils/device-code.js';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const list = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, user.id));
  return c.json(list);
});

/**
 * Resolve an optional owned-reference id from untrusted input.
 *
 * `undefined` and `null` mean "not supplied" and resolve to `null` so they
 * are stored as SQL NULL. Any other value must be a non-empty string after
 * trimming, and must exist in the caller's tenancy — otherwise 404 NOT_FOUND.
 *
 * The lookup receives both the raw candidate and its normalised form so a
 * device code entered with spaces or dashes resolves to the canonical agent.
 */
async function resolveOwnedId<T extends { id: string }>(
  raw: unknown,
  lookup: (
    candidate: string,
    normalized: string,
  ) => T | undefined | Promise<T | undefined>,
  notFoundMessage: string,
): Promise<string | null> {
  if (raw === undefined || raw === null) {
    return null;
  }
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  const normalized = normalizeDeviceCode(candidate);
  const found = await lookup(candidate, normalized);
  if (!found) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  return found.id;
}

router.post('/', async (c) => {
  const user = c.get('user');
  // `catch(() => null)` keeps a malformed body out of the 500 path, and the
  // explicit `| null` means a literal JSON `null` body is rejected as a
  // validation error rather than dereferenced below.
  const body = (await c.req.json().catch(() => null)) as {
    deviceId?: string;
    agentId?: string;
  } | null;

  if (!body) {
    throw new AppError('Invalid JSON payload', 400, 'VALIDATION_ERROR');
  }

  const db = c.get('db');

  const deviceId = await resolveOwnedId(
    body.deviceId,
    (candidate) =>
      db
        .select()
        .from(devices)
        .where(and(eq(devices.id, candidate), eq(devices.userId, user.id)))
        .get(),
    'Device not found',
  );

  const agentId = await resolveOwnedId(
    body.agentId,
    (candidate, normalized) =>
      db
        .select()
        .from(agents)
        .where(
          and(
            or(eq(agents.id, candidate), eq(agents.deviceCode, normalized)),
            eq(agents.userId, user.id),
          ),
        )
        .get(),
    'Agent not found',
  );

  const [created] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      deviceId,
      agentId,
      status: 'pending',
    })
    .returning();

  return c.json(created, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const db = c.get('db');

  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  return c.json(session);
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const db = c.get('db');

  const session = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
    .get();

  if (!session) {
    throw new AppError('Session not found', 404, 'NOT_FOUND');
  }

  await db
    .update(sessions)
    .set({
      status: 'terminated',
      // D-6: `datetime('now')`, not `new Date().toISOString()`. These columns
      // hold space-separated UTC everywhere else (`created_at` defaults to it),
      // and an ISO string sorts after every SQLite timestamp — the `'T'` is
      // greater than the `' '` — so mixing the two makes every `datetime()`
      // comparison over this column wrong for half the rows.
      endedAt: sql`(datetime('now'))`,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(sessions.id, sessionId));

  // Tell any browser waiting on this session's handshake that it is over.
  pushToBrowser(user.id, sessionId, {
    type: 'error',
    code: 'SESSION_TERMINATED',
  });

  return c.json({ success: true });
});

export default router;
