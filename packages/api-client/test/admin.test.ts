import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient } from '../src/client';
import { AdminResource } from '../src/resources/admin';
import type { SystemStats, SystemSettings } from '@ponter/shared';

describe('AdminResource', () => {
  let http: HttpClient;
  let admin: AdminResource;

  beforeEach(() => {
    http = new HttpClient({
      baseUrl: 'http://localhost:3000',
      storage: {
        getAccessToken: vi.fn().mockResolvedValue('admin-token'),
        getRefreshToken: vi.fn().mockResolvedValue(null),
        setTokens: vi.fn(),
        clearTokens: vi.fn(),
      },
    });
    admin = new AdminResource(http);
  });

  it('fetches system stats from /api/admin/stats', async () => {
    const mockStats: SystemStats = {
      users: { total: 10, approved: 8, pending: 2, rejected: 0, admins: 1 },
      agents: { total: 4, online: 3, byPlatform: { linux: 3, windows: 1 } },
      sessions: { active: 2, byKind: { terminal: 1, desktop: 1 } },
    };
    vi.spyOn(http, 'request').mockResolvedValue(mockStats);

    const res = await admin.getStats();
    expect(res).toEqual(mockStats);
    expect(http.request).toHaveBeenCalledWith('GET', '/api/admin/stats', {
      auth: true,
    });
  });

  it('updates a user status via PATCH /api/admin/users/:id', async () => {
    vi.spyOn(http, 'request').mockResolvedValue({
      user: { id: 'u1', approvalStatus: 'approved' },
    });

    const res = await admin.updateUser('u1', { approvalStatus: 'approved' });
    expect(res.user.approvalStatus).toBe('approved');
    expect(http.request).toHaveBeenCalledWith('PATCH', '/api/admin/users/u1', {
      body: { approvalStatus: 'approved' },
      auth: true,
    });
  });

  it('fetches and updates system settings', async () => {
    const mockSettings: SystemSettings = {
      allowRegistration: true,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    };
    vi.spyOn(http, 'request')
      .mockResolvedValueOnce(mockSettings)
      .mockResolvedValueOnce({
        settings: { ...mockSettings, autoApproveUsers: true },
      });

    const current = await admin.getSettings();
    expect(current.allowRegistration).toBe(true);

    const updated = await admin.updateSettings({ autoApproveUsers: true });
    expect(updated.settings.autoApproveUsers).toBe(true);
  });
});
