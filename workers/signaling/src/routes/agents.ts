import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { agents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(list);
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{
      id?: string;
      hostname?: string;
      platform?: string;
      osVersion?: string;
      agentVersion?: string;
      publicKey?: string;
    }>()
    .catch(() => null);

  if (!body?.id || !body?.publicKey) {
    throw new AppError(
      'id and publicKey are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = getDb(c.env.DB);

  // `agents.id` is the caller-supplied primary key (no `$defaultFn`), so a
  // repeat registration must be a 409 rather than a raw UNIQUE violation 500.
  const existing = await db
    .select()
    .from(agents)
    .where(eq(agents.id, body.id))
    .get();

  if (existing) {
    throw new AppError('Agent already exists', 409, 'AGENT_EXISTS');
  }

  const [created] = await db
    .insert(agents)
    .values({
      id: body.id,
      userId: user.id,
      hostname: body.hostname ?? null,
      platform: body.platform ?? null,
      osVersion: body.osVersion ?? null,
      agentVersion: body.agentVersion ?? null,
      publicKey: body.publicKey,
      isOnline: false,
    })
    .returning();

  return c.json(created, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = getDb(c.env.DB);

  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!agent) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  return c.json(agent);
});

export default router;
