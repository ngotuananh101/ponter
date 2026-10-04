import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { AppError } from '../middleware/error.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { toPublicUser } from '../utils/user.js';
import { getSystemSettings, updateSystemSettings } from '../utils/settings.js';
import { users, agents, sessions } from '../db/schema.js';
import type { SystemSettings } from '@ponter/shared';
import type { UserRole, ApprovalStatus } from '@ponter/shared';
import {
  eq,
  and,
  count,
  like,
  desc,
  ne,
  isNotNull,
  isNull,
  or,
} from 'drizzle-orm';

const admin = new Hono<AppContext>();

/**
 * Every admin route requires an authenticated session (populates
 * `c.get('user')`) followed by the admin-role guard. Both run before any
 * handler so a non-admin never reaches admin logic.
 */
admin.use('*', authMiddleware, adminMiddleware);

// Session statuses that count as "not active" for stats purposes.
const TERMINAL_STATUSES = ['terminated', 'expired'] as const;

admin.get('/stats', async (c) => {
  const db = c.get('db');

  // Aggregate every count we need. Using Promise.all for independent reads.
  const [
    totalUsersRow,
    pendingUsersRow,
    approvedUsersRow,
    rejectedUsersRow,
    activeAdminsRow,
    totalAgentsRow,
    onlineAgentsRow,
  ] = await Promise.all([
    db.select({ value: count() }).from(users).get(),
    db
      .select({ value: count() })
      .from(users)
      .where(eq(users.approvalStatus, 'pending'))
      .get(),
    db
      .select({ value: count() })
      .from(users)
      .where(eq(users.approvalStatus, 'approved'))
      .get(),
    db
      .select({ value: count() })
      .from(users)
      .where(eq(users.approvalStatus, 'rejected'))
      .get(),
    db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
      .get(),
    db.select({ value: count() }).from(agents).get(),
    db
      .select({ value: count() })
      .from(agents)
      .where(eq(agents.isOnline, true))
      .get(),
  ]);

  // Active sessions = those not terminated or expired.
  const activeStatuses = TERMINAL_STATUSES;
  const activeSessionsRow = await db
    .select({ value: count() })
    .from(sessions)
    .where(and(...activeStatuses.map((s) => ne(sessions.status, s))))
    .get();

  // Sessions bound to an agent are terminal sessions; the rest are desktop
  // sessions (browser-mediated or device-backed).
  const [terminalSessionsRow, desktopSessionsRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(sessions)
      .where(
        and(
          ...activeStatuses.map((s) => ne(sessions.status, s)),
          isNotNull(sessions.agentId),
        ),
      )
      .get(),
    db
      .select({ value: count() })
      .from(sessions)
      .where(
        and(
          ...activeStatuses.map((s) => ne(sessions.status, s)),
          isNull(sessions.agentId),
        ),
      )
      .get(),
  ]);

  // Aggregate agent counts by platform in a single grouped query.
  const byPlatformRows = await db
    .select({ platform: agents.platform, count: count() })
    .from(agents)
    .groupBy(agents.platform)
    .all();

  const stats = {
    users: {
      total: totalUsersRow?.value ?? 0,
      pending: pendingUsersRow?.value ?? 0,
      approved: approvedUsersRow?.value ?? 0,
      rejected: rejectedUsersRow?.value ?? 0,
      admins: activeAdminsRow?.value ?? 0,
    },
    agents: {
      total: totalAgentsRow?.value ?? 0,
      online: onlineAgentsRow?.value ?? 0,
      byPlatform: Object.fromEntries(
        byPlatformRows.map((r) => [r.platform ?? 'unknown', r.count]),
      ),
    },
    sessions: {
      active: activeSessionsRow?.value ?? 0,
      byKind: {
        terminal: terminalSessionsRow?.value ?? 0,
        desktop: desktopSessionsRow?.value ?? 0,
      },
    },
  };

  return c.json(stats);
});

type UserListStatus = 'all' | 'pending' | 'approved' | 'rejected' | 'inactive';

admin.get('/users', async (c) => {
  const db = c.get('db');
  const url = new URL(c.req.url);
  const status = (url.searchParams.get('status') ?? 'all') as UserListStatus;
  const search = url.searchParams.get('search')?.trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10)),
  );
  const offset = (page - 1) * limit;

  const conditions = [];
  if (status === 'inactive') {
    // Spec §4.2: "Deactivated" filter — active accounts only when isActive is false.
    conditions.push(eq(users.isActive, false));
  } else if (status !== 'all') {
    conditions.push(eq(users.approvalStatus, status));
  }
  if (search) {
    const pattern = `%${search}%`;
    // Partial match on either username or email. SQLite LIKE is case-insensitive
    // for ASCII by default, so 'BOB' matches 'bob@example.com'.
    conditions.push(
      or(like(users.username, pattern), like(users.email, pattern)),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(users)
    .where(whereClause)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ value: count() })
    .from(users)
    .where(whereClause)
    .get();

  return c.json({
    users: rows.map((row) => toPublicUser(row)),
    total: totalRows?.value ?? 0,
    pagination: {
      page,
      limit,
      total: totalRows?.value ?? 0,
    },
  });
});

interface UserPatchBody {
  approvalStatus?: ApprovalStatus;
  isActive?: boolean;
  role?: UserRole;
}

const PATCHABLE_USER_FIELDS: (keyof UserPatchBody)[] = [
  'approvalStatus',
  'isActive',
  'role',
];

admin.patch('/users/:id', async (c) => {
  const db = c.get('db');
  const currentUser = c.get('user');
  const targetId = c.req.param('id');

  const body = (await c.req.json().catch(() => null)) as UserPatchBody | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'A JSON object body is required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const updates: Record<string, unknown> = {};

  // Reject unknown fields explicitly rather than silently ignoring them.
  for (const key of Object.keys(body)) {
    if (!PATCHABLE_USER_FIELDS.includes(key as keyof UserPatchBody)) {
      throw new AppError(`Unknown field: ${key}`, 400, 'VALIDATION_ERROR');
    }
  }

  if (body.approvalStatus !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(body.approvalStatus)) {
      throw new AppError(
        'Invalid approvalStatus value',
        400,
        'VALIDATION_ERROR',
      );
    }
    updates.approvalStatus = body.approvalStatus;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw new AppError('isActive must be a boolean', 400, 'VALIDATION_ERROR');
    }
    updates.isActive = body.isActive;
  }

  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'user') {
      throw new AppError('Invalid role value', 400, 'VALIDATION_ERROR');
    }
    updates.role = body.role;
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError('No updatable fields provided', 400, 'VALIDATION_ERROR');
  }

  // Fetch the target user row to evaluate safety rules and apply updates.
  const target = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .get();

  if (!target) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }

  // Safety: cannot deactivate your own account.
  if (targetId === currentUser.id && updates.isActive === false) {
    throw new AppError(
      'Cannot deactivate your own admin account',
      400,
      'SELF_DEACTIVATION_BLOCKED',
    );
  }

  // Safety: cannot demote the last active admin.
  if (updates.role === 'user' && target.role === 'admin' && target.isActive) {
    const updated = db.transaction((tx) => {
      const activeAdminsRow = tx
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
        .get();

      const activeAdmins = activeAdminsRow?.value ?? 0;
      if (activeAdmins <= 1) {
        throw new AppError(
          'Cannot demote the only active admin',
          400,
          'LAST_ADMIN_PROTECTED',
        );
      }

      updates.updatedAt = new Date().toISOString();
      const [result] = tx
        .update(users)
        .set(updates)
        .where(eq(users.id, targetId))
        .returning()
        .all();

      return result;
    });

    if (!updated) {
      throw new AppError('User not found', 404, 'NOT_FOUND');
    }

    return c.json({ user: toPublicUser(updated) });
  }

  updates.updatedAt = new Date().toISOString();

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, targetId))
    .returning();

  if (!updated) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }

  return c.json({ user: toPublicUser(updated) });
});

admin.get('/settings', async (c) => {
  const db = c.get('db');
  const settings = await getSystemSettings(db);
  return c.json(settings);
});

admin.put('/settings', async (c) => {
  const db = c.get('db');
  const body = (await c.req
    .json()
    .catch(() => null)) as Partial<SystemSettings> | null;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'A JSON object body is required',
      400,
      'VALIDATION_ERROR',
    );
  }

  const updates: Partial<SystemSettings> = {};

  if (body.allowRegistration !== undefined) {
    if (typeof body.allowRegistration !== 'boolean') {
      throw new AppError(
        'allowRegistration must be a boolean',
        400,
        'VALIDATION_ERROR',
      );
    }
    updates.allowRegistration = body.allowRegistration;
  }

  if (body.autoApproveUsers !== undefined) {
    if (typeof body.autoApproveUsers !== 'boolean') {
      throw new AppError(
        'autoApproveUsers must be a boolean',
        400,
        'VALIDATION_ERROR',
      );
    }
    updates.autoApproveUsers = body.autoApproveUsers;
  }

  if (body.maxAgentsPerUser !== undefined) {
    if (!Number.isInteger(body.maxAgentsPerUser) || body.maxAgentsPerUser < 1) {
      throw new AppError(
        'maxAgentsPerUser must be an integer >= 1',
        400,
        'VALIDATION_ERROR',
      );
    }
    updates.maxAgentsPerUser = body.maxAgentsPerUser;
  }

  const unknownFields = Object.keys(body).filter(
    (key) =>
      !['allowRegistration', 'autoApproveUsers', 'maxAgentsPerUser'].includes(
        key,
      ),
  );
  if (unknownFields.length > 0) {
    throw new AppError(
      `Unknown field(s): ${unknownFields.join(', ')}`,
      400,
      'VALIDATION_ERROR',
    );
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError('No updatable fields provided', 400, 'VALIDATION_ERROR');
  }

  const saved = await updateSystemSettings(db, updates);
  return c.json(saved);
});

export default admin;
