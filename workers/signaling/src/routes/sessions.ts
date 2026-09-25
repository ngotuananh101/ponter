import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { sessions, devices, agents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
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
 */
async function resolveOwnedId(
  raw: unknown,
  lookup: (candidate: string) => Promise<unknown>,
  notFoundMessage: string,
): Promise<string | null> {
  if (raw === undefined || raw === null) {
    return null;
  }
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  const found = await lookup(candidate);
  if (!found) {
    throw new AppError(notFoundMessage, 404, 'NOT_FOUND');
  }
  return candidate;
}

router.post('/', async (c) => {
  const user = c.get('user');
  // `catch(() => null)` keeps a malformed body out of the 500 path, and the
  // explicit `| null` means a literal JSON `null` body is rejected as a
  // validation error rather than dereferenced below.
  const body = (await c.req.json().catch(() => null)) as {
    deviceId?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
  } | null;

  if (!body) {
    throw new AppError('Invalid JSON payload', 400, 'VALIDATION_ERROR');
  }

  const db = getDb(c.env.DB);

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
    (candidate) =>
      db
        .select()
        .from(agents)
        .where(and(eq(agents.id, candidate), eq(agents.userId, user.id)))
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
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
    })
    .returning();

  return c.json(created, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.param('id');
  const db = getDb(c.env.DB);

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
  const db = getDb(c.env.DB);

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
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.id, sessionId));

  return c.json({ success: true });
});

export default router;
