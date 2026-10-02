import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DeleteAgentDialog from '@/components/agent/DeleteAgentDialog.vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    hostname: 'host-a',
    platform: 'linux',
    osVersion: '22.04',
    agentVersion: '0.1.0',
    publicKey: 'pk-1',
    isOnline: false,
    lastHeartbeat: null,
    capabilities: ['terminal'],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: {
      delete: vi.fn(),
    },
  },
}));

describe('DeleteAgentDialog.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Does not render modal content when open is false', () => {
    const wrapper = mount(DeleteAgentDialog, {
      props: { open: false, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.find('[data-test="delete-agent-confirm"]').exists()).toBe(
      false,
    );
  });

  it('2. Names the agent being deleted when open', () => {
    const wrapper = mount(DeleteAgentDialog, {
      props: { open: true, agent: createMockAgent({ hostname: 'host-a' }) },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.text()).toContain('host-a');
    expect(wrapper.find('[data-test="delete-agent-confirm"]').exists()).toBe(
      true,
    );
  });

  it('3. Deletes the agent on confirm and emits deleted with the id', async () => {
    vi.mocked(apiClient.agents.delete).mockResolvedValueOnce({ success: true });

    const wrapper = mount(DeleteAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('[data-test="delete-agent-confirm"]').trigger('click');
    await flushPromises();

    expect(apiClient.agents.delete).toHaveBeenCalledWith('agent-1');
    expect(wrapper.emitted('deleted')?.[0]).toEqual(['agent-1']);
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('4. Shows the API error and does not emit deleted on failure', async () => {
    vi.mocked(apiClient.agents.delete).mockRejectedValueOnce(
      new Error('Agent not found'),
    );

    const wrapper = mount(DeleteAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('[data-test="delete-agent-confirm"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Agent not found');
    expect(wrapper.emitted('deleted')).toBeFalsy();
    expect(wrapper.emitted('update:open')?.at(-1)).not.toEqual([false]);
  });

  it('5. Cancel closes without calling the API', async () => {
    const wrapper = mount(DeleteAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('[data-test="delete-agent-cancel"]').trigger('click');

    expect(apiClient.agents.delete).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('6. Makes the click-outside backdrop a keyboard-activatable button', () => {
    const wrapper = mount(DeleteAgentDialog, {
      props: { open: true, agent: createMockAgent() },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.find('[aria-label="Close dialog"]').element.tagName).toBe(
      'BUTTON',
    );
  });
});
