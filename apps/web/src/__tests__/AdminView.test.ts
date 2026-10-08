import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import AdminView from '@/views/AdminView.vue';
import { apiClient } from '@/services/client';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@ponter/api-client';
import type { SystemStats, SystemSettings, User } from '@ponter/shared';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

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

/** Mount AdminView with the default mocked admin API and settle initial loads. */
async function mountAdminView() {
  const wrapper = mount(AdminView, {
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

/** Mount AdminView and switch to the Users tab (default mocked data). */
async function mountOnUsersTab() {
  const wrapper = await mountAdminView();
  await wrapper.find('[data-test="tab-users"]').trigger('click');
  return wrapper;
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
    const wrapper = await mountAdminView();

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
    const wrapper = await mountOnUsersTab();

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
    const wrapper = await mountOnUsersTab();

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
    const wrapper = await mountAdminView();

    await wrapper.find('[data-test="tab-settings"]').trigger('click');
    await flushPromises();

    const regInput = wrapper.find('[data-test="settings-allow-registration"]');
    expect(regInput.attributes('aria-checked')).toBe('true');
    await regInput.trigger('click');
    await flushPromises();
    expect(regInput.attributes('aria-checked')).toBe('false');

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
    const wrapper = await mountAdminView();
    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-test="btn-demote-u1"]').trigger('click');
    await flushPromises();
    await nextTick();
    await new Promise((r) => setTimeout(r, 50));

    // Confirm the AlertDialog action (content is Teleported to document.body)
    const confirmBtn = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    expect(confirmBtn).not.toBeNull();
    await confirmBtn.click();
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith('Cannot demote the last admin');
  });

  it('retries on fetch failure', async () => {
    vi.spyOn(apiClient.admin, 'getStats').mockRejectedValue(
      new ApiError('boom', 500, 'INTERNAL_ERROR'),
    );
    const wrapper = await mountAdminView();

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

  it('self-protection: disables all six action buttons on the current admin own row', async () => {
    // The current admin is u1 (the user in the auth store).
    const authStore = useAuthStore();
    authStore.user = makeUser({
      id: 'u1',
      username: 'self_admin',
      role: 'admin',
    });
    authStore.status = 'authenticated';

    // u1 is pending + active admin => renders approve, reject, demote, deactivate.
    vi.spyOn(apiClient.admin, 'getUsers').mockResolvedValue({
      users: [
        makeUser({ id: 'u1', username: 'self_admin', role: 'admin' }),
        makeUser({ id: 'u2', username: 'other_user', role: 'user' }),
      ],
      total: 2,
    });

    const wrapper = await mountAdminView();
    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await flushPromises();

    // Self row (u1): every action button present must be disabled.
    for (const action of [
      'approve',
      'reject',
      'promote',
      'demote',
      'deactivate',
      'activate',
    ]) {
      const btn = wrapper.find(`[data-test="btn-${action}-u1"]`);
      if (btn.exists()) {
        expect(btn.attributes('disabled')).toBeDefined();
      }
    }
    // Other-user row (u2): buttons must NOT be disabled.
    const otherBtn = wrapper.find('[data-test="btn-approve-u2"]');
    expect(otherBtn.exists()).toBe(true);
    expect(otherBtn.attributes('disabled')).toBeUndefined();
  });

  it('quick action: pending banner button switches to users tab with pending filter', async () => {
    vi.spyOn(apiClient.admin, 'getStats').mockResolvedValue({
      ...STATS,
      users: { ...STATS.users, pending: 1 },
    });
    const getUsersSpy = vi
      .spyOn(apiClient.admin, 'getUsers')
      .mockResolvedValue({ users: [], total: 0 });

    const wrapper = await mountAdminView();

    // The pending quick-action button should be visible on the overview.
    const quickAction = wrapper.find('[data-test="pending-quick-action"]');
    expect(quickAction.exists()).toBe(true);

    await quickAction.trigger('click');
    await flushPromises();

    // Users tab is now active and getUsers was called with status=pending.
    expect(wrapper.find('[data-test="tab-users"]').classes()).toContain(
      'bg-card',
    );
    expect(getUsersSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('a11y: every input/select is associated with a label (Sonar a11y findings)', async () => {
    const wrapper = await mountAdminView();
    await wrapper.find('[data-test="tab-users"]').trigger('click');
    await wrapper.find('[data-test="tab-settings"]').trigger('click');
    await flushPromises();

    const controls = wrapper.findAll('input, select');
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      const el = control.element as HTMLInputElement;
      const id = el.getAttribute('id');
      const hasAria =
        el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
      // A control is labelled when it has aria-label(ledby), or there is a
      // <label for="<id>">, or it is wrapped inside a <label>.
      const hasLabelFor = !!id && wrapper.find(`label[for="${id}"]`).exists();
      const wrappedInLabel = el.closest('label') !== null;

      expect(
        hasAria || hasLabelFor || wrappedInLabel,
        `control (id="${id}", type="${el.getAttribute('type')}") must have an associated label`,
      ).toBe(true);
    }
  });
});
