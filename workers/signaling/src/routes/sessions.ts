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

  // Validate the optional references before they reach SQLite. `undefined` and
  // `null` mean "not supplied" (stored as NULL). Any other value must be a
  // non-empty string after trimming: an empty string or a non-string can never
  // name a real row, and handing it to D1 would surface the foreign-key
  // violation as a 500 instead of a clean 404.
  //
  // The lookup is scoped by `userId`, so a cross-tenant id is indistinguishable
  // from a missing one (404, no enumeration of other users' resources).
  let deviceId: string | null = null;
  if (body.deviceId !== undefined && body.deviceId !== null) {
    const candidate =
      typeof body.deviceId === 'string' ? body.deviceId.trim() : '';

    const device = candidate
      ? await db
          .select()
          .from(devices)
          .where(and(eq(devices.id, candidate), eq(devices.userId, user.id)))
          .get()
      : undefined;

    if (!device) {
      throw new AppError('Device not found', 404, 'NOT_FOUND');
    }

    deviceId = candidate;
  }

  let agentId: string | null = null;
  if (body.agentId !== undefined && body.agentId !== null) {
    const candidate =
      typeof body.agentId === 'string' ? body.agentId.trim() : '';

    const agent = candidate
      ? await db
          .select()
          .from(agents)
          .where(and(eq(agents.id, candidate), eq(agents.userId, user.id)))
          .get()
      : undefined;

    if (!agent) {
      throw new AppError('Agent not found', 404, 'NOT_FOUND');
    }

    agentId = candidate;
  }

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
