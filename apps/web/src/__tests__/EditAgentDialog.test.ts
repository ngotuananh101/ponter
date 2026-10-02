import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EditAgentDialog from '@/components/agent/EditAgentDialog.vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    hostname: 'old-host',
    platform: 'linux',
    osVersion: '22.04',
    agentVersion: '0.1.0',
    publicKey: 'pk-1',
    isOnline: true,
    lastHeartbeat: null,
    capabilities: ['terminal'],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: {
      update: vi.fn(),
    },
  },
}));

describe('EditAgentDialog.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Does not render modal content when open is false', () => {
    const wrapper = mount(EditAgentDialog, {
      props: { open: false, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.find('#edit-agent-hostname').exists()).toBe(false);
  });

  it('2. Prefills the form from the agent prop when opened', async () => {
    const wrapper = mount(EditAgentDialog, {
      props: { open: false, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.setProps({ open: true });

    expect(
      (wrapper.find('#edit-agent-hostname').element as HTMLInputElement).value,
    ).toBe('old-host');
    expect(
      (wrapper.find('#edit-agent-os-version').element as HTMLInputElement)
        .value,
    ).toBe('22.04');
    expect(
      (wrapper.find('#edit-agent-version').element as HTMLInputElement).value,
    ).toBe('0.1.0');
    // 'terminal' capability is on, 'desktop' is off.
    expect(
      wrapper
        .find('[data-test="edit-cap-terminal"]')
        .attributes('aria-pressed'),
    ).toBe('true');
    expect(
      wrapper.find('[data-test="edit-cap-desktop"]').attributes('aria-pressed'),
    ).toBe('false');
  });

  it('3. Re-prefills when reopened for a different agent', async () => {
    const wrapper = mount(EditAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });
    expect(
      (wrapper.find('#edit-agent-hostname').element as HTMLInputElement).value,
    ).toBe('old-host');

    await wrapper.setProps({
      agent: createMockAgent({ id: 'agent-2', hostname: 'other-host' }),
    });
    expect(
      (wrapper.find('#edit-agent-hostname').element as HTMLInputElement).value,
    ).toBe('other-host');
  });

  it('4. Submits the edited fields via agents.update and emits updated', async () => {
    const updated = createMockAgent({
      hostname: 'new-host',
      capabilities: ['terminal', 'desktop'],
    });
    vi.mocked(apiClient.agents.update).mockResolvedValueOnce(updated);

    const wrapper = mount(EditAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('#edit-agent-hostname').setValue('new-host');
    await wrapper.find('[data-test="edit-cap-desktop"]').trigger('click');
    await wrapper.find('[data-test="edit-agent-submit"]').trigger('click');
    await flushPromises();

    expect(apiClient.agents.update).toHaveBeenCalledWith('agent-1', {
      hostname: 'new-host',
      platform: 'linux',
      osVersion: '22.04',
      agentVersion: '0.1.0',
      capabilities: ['terminal', 'desktop'],
    });
    expect(wrapper.emitted('updated')?.[0]).toEqual([updated]);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('5. Shows the API error and stays open on failure', async () => {
    vi.mocked(apiClient.agents.update).mockRejectedValueOnce(
      new Error('Agent not found'),
    );

    const wrapper = mount(EditAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('[data-test="edit-agent-submit"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Agent not found');
    expect(wrapper.emitted('updated')).toBeFalsy();
    expect(wrapper.emitted('update:open')?.at(-1)).not.toEqual([false]);
  });

  it('6. Cancel closes without calling the API', async () => {
    const wrapper = mount(EditAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('[data-test="edit-agent-cancel"]').trigger('click');

    expect(apiClient.agents.update).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });
});
