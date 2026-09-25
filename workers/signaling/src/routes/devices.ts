import { Hono } from 'hono';
import type { AppContext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/client';
import { devices, sessions } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error';

const router = new Hono<AppContext>();
router.use('*', authMiddleware);

router.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
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

  const db = getDb(c.env.DB);

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

  return c.json(created, 201);
});

router.delete('/:id', async (c) => {
  const user = c.get('user');
  const deviceId = c.req.param('id');
  const db = getDb(c.env.DB);

  const existing = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
    .get();

  if (!existing) {
    throw new AppError('Device not found', 404, 'NOT_FOUND');
  }

  // `sessions.device_id` references `devices(id)` with no `ON DELETE` action,
  // so with foreign keys enforced a bare delete would fail on any session that
  // still points at this device. Detach those rows first.
  await db
    .update(sessions)
    .set({ deviceId: null })
    .where(eq(sessions.deviceId, deviceId));

  await db.delete(devices).where(eq(devices.id, deviceId));
  return c.json({ success: true });
});

export default router;
