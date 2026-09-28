import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { agents } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { sha256Hex } from '../utils/crypto.js';
import {
  generateAgentCredential,
  toPublicAgent,
  type PublicAgent,
} from '../utils/agent.js';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

/**
 * Live agent sockets, keyed by `agents.id`.
 *
 * Module scope within the single Node.js process: WebSocket connections and HTTP
 * requests share the same process, so this map is reliable here (unlike the
 * multi-isolate Workers deployment). WebSocket handling is wired up in a later
 * task; the map is declared now so `toPublicAgent` can accept a socket-present
 * flag without callers needing to know the source.
 */
export const agentConnections = new Map<string, unknown>();

router.get('/', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const list = await db.select().from(agents).where(eq(agents.userId, user.id));
  return c.json(
    list.map((agent) => toPublicAgent(agent, agentConnections.has(agent.id))),
  );
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

  const db = c.get('db');

  // `agents.id` is the caller-supplied primary key (no `$defaultFn`), so a
  // repeat registration must surface as a 409 rather than a raw UNIQUE violation 500.
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
  // A freshly registered agent has no socket yet, so this is always false — but
  // it goes through the same predicate so the projection has one definition.
  return c.json({ agent: toPublicAgent(created, false), credential }, 201);
});

router.get('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = c.get('db');

  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!agent) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  return c.json(toPublicAgent(agent, agentConnections.has(agent.id)));
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = c.get('db');

  // Tenancy guard: only the owning user may delete an agent. The query matches
  // on both `id` and `userId`, so a non-owner sees no row and gets a 404 — the
  // same status an entirely absent agent would receive, so existence is not
  // leaked across tenants.
  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!agent) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  // Evict any in-process socket entry so a re-register after deletion starts
  // with a clean connection state.
  agentConnections.delete(agentId);

  await db.delete(agents).where(eq(agents.id, agentId));

  return c.json({ success: true });
});

export type { PublicAgent };
export default router;
