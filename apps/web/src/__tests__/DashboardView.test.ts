import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DashboardView from '@/views/DashboardView.vue';
import type { Agent } from '@ponter/shared';

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from 'vue-sonner';

vi.mock('@/services/client', () => ({
  apiClient: {
    // The auth store assigns `onAuthError` onto the http client at setup time.
    http: { onAuthError: null },
    devices: { list: vi.fn().mockResolvedValue([]) },
    agents: {
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} }),
}));

// The registration dialog pulls in @ponter/crypto key generation; it is not
// under test here, so stub it and keep the manage dialogs real (the wiring
// between the dashboard and those dialogs is what this suite pins).

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    userId: 'u1',
    hostname: 'host-a',
    platform: 'linux',
    osVersion: '6.5',
    agentVersion: '0.1.0',
    publicKey: 'pk-a',
    signingPublicKey: null,
    isOnline: true,
    lastHeartbeat: null,
    capabilities: ['terminal', 'desktop'],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const STUBS = {
  Teleport: true,
  RegisterAgentDialog: { template: '<div />' },
};

async function mountDashboard(agents: Agent[]) {
  const { apiClient } = await import('@/services/client');
  vi.mocked(apiClient.agents.list).mockResolvedValue(agents);

  const wrapper = mount(DashboardView, { global: { stubs: STUBS } });
  await flushPromises();
  return wrapper;
}

describe('DashboardView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('exposes edit and delete controls on each agent card', async () => {
    const wrapper = await mountDashboard([
      makeAgent({ id: 'a1', hostname: 'host-a' }),
      makeAgent({ id: 'a2', hostname: 'host-b', isOnline: false }),
    ]);

    expect(wrapper.find('[data-test="edit-agent-a1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="delete-agent-a1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="edit-agent-a2"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="delete-agent-a2"]').exists()).toBe(true);
  });

  it('opens the edit dialog prefilled for the clicked agent', async () => {
    const wrapper = await mountDashboard([makeAgent({ hostname: 'host-a' })]);

    await wrapper.find('[data-test="edit-agent-a1"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('#edit-agent-hostname').exists()).toBe(true);
    expect(
      (wrapper.find('#edit-agent-hostname').element as HTMLInputElement).value,
    ).toBe('host-a');
  });

  it('reflects an edited agent in the list after a successful update', async () => {
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.agents.update).mockResolvedValueOnce(
      makeAgent({ hostname: 'renamed-host' }),
    );

    const wrapper = await mountDashboard([makeAgent({ hostname: 'host-a' })]);

    await wrapper.find('[data-test="edit-agent-a1"]').trigger('click');
    await flushPromises();
    await wrapper.find('#edit-agent-hostname').setValue('renamed-host');
    await wrapper.find('[data-test="edit-agent-submit"]').trigger('click');
    await flushPromises();

    expect(apiClient.agents.update).toHaveBeenCalledWith('a1', {
      hostname: 'renamed-host',
      platform: 'linux',
      osVersion: '6.5',
      agentVersion: '0.1.0',
      capabilities: ['terminal', 'desktop'],
    });
    expect(wrapper.text()).toContain('renamed-host');
    expect(toast.success).toHaveBeenCalledWith('Agent updated');
  });

  it('opens the delete dialog for the clicked agent', async () => {
    const wrapper = await mountDashboard([
      makeAgent({ id: 'a2', hostname: 'host-b' }),
    ]);

    await wrapper.find('[data-test="delete-agent-a2"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="delete-agent-confirm"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain('host-b');
  });

  it('removes the agent from the list after a successful delete', async () => {
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.agents.delete).mockResolvedValueOnce({
      success: true,
    });

    const wrapper = await mountDashboard([
      makeAgent({ id: 'a1', hostname: 'host-a' }),
      makeAgent({ id: 'a2', hostname: 'host-b' }),
    ]);

    await wrapper.find('[data-test="delete-agent-a2"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="delete-agent-confirm"]').trigger('click');
    await flushPromises();

    expect(apiClient.agents.delete).toHaveBeenCalledWith('a2');
    expect(wrapper.find('[data-test="delete-agent-a2"]').exists()).toBe(false);
    // The other agent is untouched.
    expect(wrapper.find('[data-test="delete-agent-a1"]').exists()).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Agent deleted');
  });

  it('renders an error Alert when device/agent load fails', async () => {
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.devices.list).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(apiClient.agents.list).mockRejectedValueOnce(new Error('boom'));

    const wrapper = await mountDashboard([]);
    await flushPromises();

    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('boom');
  });
});
