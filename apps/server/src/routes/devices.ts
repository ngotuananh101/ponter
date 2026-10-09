import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { devices, sessions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { pushFleetToUser } from './ws.js';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

/** Mirrors the `device_type` domain documented in `src/db/schema.ts`. */
const ALLOWED_DEVICE_TYPES = new Set(['desktop', 'mobile', 'web']);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = c.get('db');
  const list = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, user.id));
  return c.json(list);
});

router.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{
      fingerprint?: string;
      deviceName?: string;
      deviceType?: string;
    }>()
    .catch(() => null);

  if (!body?.fingerprint || !body?.deviceType) {
    throw new AppError(
      'fingerprint and deviceType are required',
      400,
      'VALIDATION_ERROR',
    );
  }

  if (!ALLOWED_DEVICE_TYPES.has(body.deviceType)) {
    throw new AppError(
      'Invalid deviceType, must be desktop, mobile, or web',
      400,
      'VALIDATION_ERROR',
    );
  }

  const db = c.get('db');

  // `devices.fingerprint` carries a UNIQUE constraint, so a repeat
  // registration must surface as a 409 rather than a raw constraint 500.
  const existing = await db
    .select()
    .from(devices)
    .where(eq(devices.fingerprint, body.fingerprint))
    .get();

  if (existing) {
    throw new AppError(
      'Device fingerprint already registered',
      409,
      'DEVICE_EXISTS',
    );
  }

  const [created] = await db
    .insert(devices)
    .values({
      userId: user.id,
      fingerprint: body.fingerprint,
      deviceName: body.deviceName ?? null,
      deviceType: body.deviceType,
      isTrusted: false,
    })
    .returning();

  pushFleetToUser(user.id);

  return c.json(created, 201);
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('id');
  const db = c.get('db');

  const existing = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    .get();

  if (!existing) {
    throw new AppError('Device not found', 404, 'NOT_FOUND');
  }

  // `sessions.deviceId` references `devices(id)` with `ON DELETE SET NULL` per
  // the schema, so SQLite already nulls out the foreign key. An explicit UPDATE
  // is still issued so the intent is visible and the behaviour is identical if
  // the constraint is ever loosened in a future schema migration.
  await db
    .update(sessions)
    .set({ deviceId: null })
    .where(eq(sessions.deviceId, deviceId));

  await db.delete(devices).where(eq(devices.id, deviceId));

  pushFleetToUser(user.id);

  return c.json({ success: true });
});

export default router;
