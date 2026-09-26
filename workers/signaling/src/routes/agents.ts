import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { agents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';
import { generateAgentCredential, toPublicAgent } from '../utils/agent';
import { sha256Hex } from '../utils/crypto';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(list.map(toPublicAgent));
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{
      id?: string;
      hostname?: string;
      platform?: string;
      osVersion?: string;
      agentVersion?: string | null;
      publicKey?: string;
      capabilities?: string[] | null;
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
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, body.id))
    .get();

  if (existing) {
    throw new AppError('Agent already exists', 409, 'AGENT_EXISTS');
  }

  // Minted only after the 409 pre-check: issuing a credential for an agent that
  // is never created would leave a live secret with no owner (Week 5 D18).
  const credential = generateAgentCredential();

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
      credentialHash: await sha256Hex(credential),
      capabilities: body.capabilities
        ? JSON.stringify(body.capabilities)
        : null,
    })
    .returning();

  if (!created) {
    throw new AppError(
      'Failed to register agent',
      500,
      'INTERNAL_SERVER_ERROR',
    );
  }

  // The credential is present exactly once, on this response. It is never
  // recoverable: only its hash is stored and there is no rotation endpoint.
  return c.json({ agent: toPublicAgent(created), credential }, 201);
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

  return c.json(toPublicAgent(agent));
});

export default router;
