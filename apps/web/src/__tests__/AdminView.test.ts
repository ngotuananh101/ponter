import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AdminView from '@/views/AdminView.vue';
import { apiClient } from '@/services/client';
import { ApiError } from '@ponter/api-client';
import type { SystemStats, SystemSettings, User } from '@ponter/shared';

const STATS: SystemStats = {
  users: { total: 5, approved: 3, pending: 2, rejected: 0, admins: 1 },
  agents: { total: 2, online: 1, byPlatform: { linux: 1 } },
  sessions: { active: 1, byKind: { terminal: 1, desktop: 0 } },
};

const SETTINGS: SystemSettings = {
  allowRegistration: true,
  autoApproveUsers: false,
  maxAgentsPerUser: 10,
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'pending_user',
    email: 'pending@example.com',
    publicKey: 'pk',
    role: 'user',
    approvalStatus: 'pending',
    isActive: true,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    lastLoginAt: null,
    ...overrides,
  };
}

describe('AdminView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(apiClient.admin, 'getStats').mockResolvedValue(STATS);
    vi.spyOn(apiClient.admin, 'getUsers').mockResolvedValue({
      users: [makeUser()],
      total: 1,
    });
    vi.spyOn(apiClient.admin, 'getSettings').mockResolvedValue(SETTINGS);
  });

  it('renders stats overview and switches tabs', async () => {
    const wrapper = mount(AdminView);
    await flushPromises();

    expect(wrapper.text()).toContain('System Overview');
    expect(wrapper.text()).toContain('5'); // Total users

    // Switch to Users tab
    await wrapper.find('[data-test="tab-users"]').trigger('click');
    expect(wrapper.text()).toContain('pending_user');
    expect(wrapper.find('[data-test="btn-approve-u1"]').exists()).toBe(true);
  });

  it('triggers approve user action', async () => {
    const updateSpy = vi
      .spyOn(apiClient.admin, 'updateUser')
      .mockResolvedValue({
        user: makeUser({ id: 'u1', approvalStatus: 'approved' }),
      });
    const wrapper = mount(AdminView);
    await flushPromises();

    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await wrapper.find('[data-test="btn-approve-u1"]').trigger('click');

    expect(updateSpy).toHaveBeenCalledWith('u1', {
      approvalStatus: 'approved',
    });
  });

  it('triggers reject user action', async () => {
    const updateSpy = vi
      .spyOn(apiClient.admin, 'updateUser')
      .mockResolvedValue({
        user: makeUser({ id: 'u1', approvalStatus: 'rejected' }),
      });
    const wrapper = mount(AdminView);
    await flushPromises();

    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await wrapper.find('[data-test="btn-reject-u1"]').trigger('click');

    expect(updateSpy).toHaveBeenCalledWith('u1', {
      approvalStatus: 'rejected',
    });
  });

  it('saves settings with toggled value', async () => {
    const updateSpy = vi
      .spyOn(apiClient.admin, 'updateSettings')
      .mockResolvedValue({
        settings: { ...SETTINGS, allowRegistration: false },
      });
    const wrapper = mount(AdminView);
    await flushPromises();

    await wrapper.find('[data-test="tab-settings"]').trigger('click');
    await flushPromises();

    const regInput = wrapper.find('[data-test="settings-allow-registration"]');
    expect(regInput.element).toBeInstanceOf(HTMLInputElement);
    await regInput.setValue(false);

    await wrapper.find('[data-test="btn-save-settings"]').trigger('click');
    await flushPromises();

    expect(updateSpy).toHaveBeenCalledWith({
      allowRegistration: false,
      autoApproveUsers: false,
      maxAgentsPerUser: 10,
    });
  });

  it('surfaces last-admin protection error in the notice alert', async () => {
    const lastAdminErr = new ApiError(
      'Cannot demote the last admin',
      400,
      'LAST_ADMIN_PROTECTED',
    );
    vi.spyOn(apiClient.admin, 'updateUser').mockRejectedValue(lastAdminErr);
    vi.spyOn(apiClient.admin, 'getUsers').mockResolvedValue({
      users: [makeUser({ id: 'u1', role: 'admin' })],
      total: 1,
    });
    vi.stubGlobal('confirm', () => true);

    const wrapper = mount(AdminView);
    await flushPromises();

    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-test="btn-demote-u1"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Cannot demote the last admin');
  });

  it('retries on fetch failure', async () => {
    vi.spyOn(apiClient.admin, 'getStats').mockRejectedValue(
      new ApiError('boom', 500, 'INTERNAL_ERROR'),
    );
    const wrapper = mount(AdminView);
    await flushPromises();

    // Failure alert with Retry button should appear
    expect(wrapper.text()).toContain('boom');
    expect(wrapper.find('[data-test="btn-retry-overview"]').exists()).toBe(
      true,
    );

    // Restore stats and retry
    vi.spyOn(apiClient.admin, 'getStats').mockResolvedValue(STATS);
    await wrapper.find('[data-test="btn-retry-overview"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('boom');
  });
});
