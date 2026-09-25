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

  // A referenced device must exist *and* belong to the requesting user, so a
  // cross-tenant id is indistinguishable from a missing one (404, no
  // enumeration of other users' resources).
  if (body.deviceId) {
    const device = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, body.deviceId), eq(devices.userId, user.id)))
      .get();

    if (!device) {
      throw new AppError('Device not found', 404, 'NOT_FOUND');
    }
  }

  if (body.agentId) {
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.userId, user.id)))
      .get();

    if (!agent) {
      throw new AppError('Agent not found', 404, 'NOT_FOUND');
    }
  }

  const [created] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      deviceId: body.deviceId ?? null,
      agentId: body.agentId ?? null,
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
