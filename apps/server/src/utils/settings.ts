import type { Database } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import type { SystemSettings } from '@ponter/shared';

const DEFAULT_SETTINGS: SystemSettings = {
  allowRegistration: true,
  autoApproveUsers: false,
  maxAgentsPerUser: 10,
};

export async function getSystemSettings(db: Database): Promise<SystemSettings> {
  const rows = await db.select().from(systemSettings).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    allowRegistration: map.has('allow_registration')
      ? map.get('allow_registration') === 'true'
      : DEFAULT_SETTINGS.allowRegistration,
    autoApproveUsers: map.has('auto_approve_users')
      ? map.get('auto_approve_users') === 'true'
      : DEFAULT_SETTINGS.autoApproveUsers,
    maxAgentsPerUser: map.has('max_agents_per_user')
      ? Number(map.get('max_agents_per_user')) ||
        DEFAULT_SETTINGS.maxAgentsPerUser
      : DEFAULT_SETTINGS.maxAgentsPerUser,
  };
}

export async function updateSystemSettings(
  db: Database,
  updates: Partial<SystemSettings>,
): Promise<SystemSettings> {
  const entries: [string, string][] = [];
  if (updates.allowRegistration !== undefined) {
    entries.push(['allow_registration', String(updates.allowRegistration)]);
  }
  if (updates.autoApproveUsers !== undefined) {
    entries.push(['auto_approve_users', String(updates.autoApproveUsers)]);
  }
  if (updates.maxAgentsPerUser !== undefined) {
    entries.push(['max_agents_per_user', String(updates.maxAgentsPerUser)]);
  }

  const updatedAt = new Date().toISOString();
  await Promise.all(
    entries.map(([key, value]) =>
      db
        .insert(systemSettings)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value, updatedAt },
        }),
    ),
  );

  return getSystemSettings(db);
}
