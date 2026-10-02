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
// The one live-socket map, owned by the WebSocket layer. Importing it here —
// rather than keeping a second, never-populated map — is what makes the
// `socketPresent` flag reflect reality. `ws.ts` does not import this module, so
// there is no cycle.
import { agentConnections } from './ws.js';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

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

/**
 * The mutable subset of an agent's metadata.
 *
 * Identity and lifecycle columns (`id`, `user_id`, `public_key`, `is_online`,
 * `last_ping_at`, `created_at`, `credential_hash`) are not updatable through
 * this route: the first three identify the agent and its key material, and the
 * last four are owned by the server. Rejecting them explicitly — rather than
 * ignoring them — stops a caller from believing a `publicKey` rotation took
 * effect when it did not.
 */
const UPDATABLE_FIELDS = [
  'hostname',
  'platform',
  'osVersion',
  'agentVersion',
  'capabilities',
] as const;

type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

type PatchBody = Partial<Record<UpdatableField, unknown>>;

/** Fields a caller may never set; their presence is a 400, not a silent no-op. */
const IMMUTABLE_FIELDS = [
  'id',
  'userId',
  'publicKey',
  'isOnline',
  'lastHeartbeat',
  'createdAt',
] as const;

/**
 * A nullable string field: `null` clears it, a string sets it, anything else is
 * invalid. Absent keys are handled by the caller (they mean "leave unchanged").
 */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

router.patch('/:id', async (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const db = c.get('db');

  const body = await c.req.json<PatchBody | null>().catch(() => null);

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'A JSON object body is required',
      400,
      'VALIDATION_ERROR',
    );
  }

  for (const field of IMMUTABLE_FIELDS) {
    if (field in body) {
      throw new AppError(
        `${field} cannot be modified`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }

  const unknownFields = Object.keys(body).filter(
    (key) => !(UPDATABLE_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    throw new AppError(
      `Unknown field(s): ${unknownFields.join(', ')}`,
      400,
      'VALIDATION_ERROR',
    );
  }

  const changes: Partial<Record<UpdatableField, string | null>> = {};

  for (const field of UPDATABLE_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];

    if (field === 'capabilities') {
      if (value === null) {
        changes.capabilities = null;
      } else if (isStringArray(value)) {
        changes.capabilities = JSON.stringify(value);
      } else {
        throw new AppError(
          'capabilities must be an array of strings or null',
          400,
          'VALIDATION_ERROR',
        );
      }
      continue;
    }

    if (!isNullableString(value)) {
      throw new AppError(
        `${field} must be a string or null`,
        400,
        'VALIDATION_ERROR',
      );
    }
    changes[field] = value;
  }

  if (Object.keys(changes).length === 0) {
    throw new AppError('No updatable fields provided', 400, 'VALIDATION_ERROR');
  }

  // Tenancy guard runs before the write: matching on both `id` and `userId`
  // means a non-owner updates no row and gets the same 404 as an absent agent,
  // so cross-tenant existence is not leaked.
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .get();

  if (!existing) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  const updated = await db
    .update(agents)
    .set(changes)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
    .returning()
    .get();

  if (!updated) {
    throw new AppError('Agent not found', 404, 'NOT_FOUND');
  }

  return c.json(toPublicAgent(updated, agentConnections.has(agentId)));
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
