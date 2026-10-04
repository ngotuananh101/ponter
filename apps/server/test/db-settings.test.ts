import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb } from '../src/db/client';
import type { Database } from '../src/db/client';
import { users } from '../src/db/schema';
import { getSystemSettings, updateSystemSettings } from '../src/utils/settings';
import { toPublicUser } from '../src/utils/user';

describe('DB Schema & Settings Helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = getDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('initializes default system settings', async () => {
    const settings = await getSystemSettings(db);
    expect(settings).toEqual({
      allowRegistration: true,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    });
  });

  it('updates system settings correctly', async () => {
    await updateSystemSettings(db, {
      allowRegistration: false,
      maxAgentsPerUser: 5,
    });
    const updated = await getSystemSettings(db);
    expect(updated.allowRegistration).toBe(false);
    expect(updated.autoApproveUsers).toBe(false);
    expect(updated.maxAgentsPerUser).toBe(5);
  });

  it('includes role and approvalStatus in toPublicUser projection', async () => {
    const [user] = await db
      .insert(users)
      .values({
        username: 'admin_test',
        publicKey: 'pk_test',
        role: 'admin',
        approvalStatus: 'approved',
      })
      .returning();

    const publicUser = toPublicUser(user!);
    expect(publicUser.role).toBe('admin');
    expect(publicUser.approvalStatus).toBe('approved');
  });
});
