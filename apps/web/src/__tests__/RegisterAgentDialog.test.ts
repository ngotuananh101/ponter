import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RegisterAgentDialog from '@/components/agent/RegisterAgentDialog.vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';

function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    userId: 'user-1',
    hostname: 'test-host',
    platform: 'linux',
    osVersion: '6.5',
    agentVersion: '0.1.0',
    publicKey: 'mock-public-key',
    signingPublicKey: null,
    capabilities: ['terminal', 'desktop'],
    isOnline: false,
    lastHeartbeat: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: {
      create: vi.fn(),
    },
  },
}));

describe('RegisterAgentDialog.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
  });

  it('1. Does not render modal content when open is false', () => {
    const wrapper = mount(RegisterAgentDialog, {
      props: { open: false },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.find('h3').exists()).toBe(false);
  });

  it('2. Renders registration form when open is true', () => {
    const wrapper = mount(RegisterAgentDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    });
    expect(wrapper.find('h3').text()).toContain('Register Remote Agent');
    expect(wrapper.find('#agent-id').exists()).toBe(true);
    expect(wrapper.find('#agent-hostname').exists()).toBe(true);
  });

  it('3. Shows error when attempting to register without an Agent ID', async () => {
    const wrapper = mount(RegisterAgentDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    });

    const submitBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Generate Agent'));
    // Button is disabled when input is empty, but calling handler directly or enabling test:
    await wrapper.find('#agent-id').setValue('   ');
    expect(submitBtn?.attributes('disabled')).toBeDefined();
  });

  it('4. Successfully registers an agent and displays the success step', async () => {
    vi.mocked(apiClient.agents.create).mockResolvedValueOnce({
      agent: createMockAgent({
        id: 'node-alpha-01',
        hostname: 'node-alpha.lan',
        platform: 'windows',
      }),
      credential: 'ag_credential_token_12345',
    });

    const wrapper = mount(RegisterAgentDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('#agent-id').setValue('node-alpha-01');
    await wrapper.find('#agent-hostname').setValue('node-alpha.lan');

    // Click Linux platform (already default, or select Windows)
    const winBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Windows'));
    await winBtn?.trigger('click');

    const submitBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Generate Agent'));
    await submitBtn?.trigger('click');
    await flushPromises();

    expect(apiClient.agents.create).toHaveBeenCalledWith({
      id: 'node-alpha-01',
      hostname: 'node-alpha.lan',
      platform: 'windows',
      capabilities: ['terminal', 'desktop', 'files'],
    });

    // Load-bearing guard: the dialog must never fabricate or send a publicKey.
    // A real Ed25519 key is registered by the agent at first WS connect.
    expect(apiClient.agents.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ publicKey: expect.anything() }),
    );

    // Check success step rendered
    expect(wrapper.text()).toContain('Agent Provisioned:');
    expect(wrapper.text()).toContain('node-alpha-01');
    expect(wrapper.text()).toContain('ag_credential_token_12345');
    expect(wrapper.text()).toContain('./ponter-agent --agent-id node-alpha-01');
  });

  it('5. Handles registration API errors cleanly', async () => {
    vi.mocked(apiClient.agents.create).mockRejectedValueOnce(
      new Error('Agent ID already exists'),
    );

    const wrapper = mount(RegisterAgentDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('#agent-id').setValue('existing-agent');
    const submitBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Generate Agent'));
    await submitBtn?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Agent ID already exists');
    expect(wrapper.find('#agent-id').exists()).toBe(true);
  });

  /** Mount the dialog, fill the agent id, and submit — shared by the success-flow tests. */
  async function mountAndRegister(agentId: string) {
    const wrapper = mount(RegisterAgentDialog, {
      props: { open: true },
      global: { stubs: { Teleport: true } },
    });

    await wrapper.find('#agent-id').setValue(agentId);
    const submitBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Generate Agent'));
    await submitBtn?.trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('6. Copies credential and command to clipboard', async () => {
    vi.mocked(apiClient.agents.create).mockResolvedValueOnce({
      agent: createMockAgent({
        id: 'node-beta-02',
        hostname: 'node-beta.lan',
      }),
      credential: 'ag_secret_copy_test',
    });

    const wrapper = await mountAndRegister('node-beta-02');

    // Copy credential
    const copyCredBtn = wrapper
      .findAll('button')
      .find((b) => b.text().trim() === 'Copy');
    await copyCredBtn?.trigger('click');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'ag_secret_copy_test',
    );

    // Copy command
    const copyCmdBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Copy Command'));
    await copyCmdBtn?.trigger('click');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        './ponter-agent --agent-id node-beta-02 --server',
      ),
    );
  });

  it('7. Emits registered and update:open when closing after success', async () => {
    vi.mocked(apiClient.agents.create).mockResolvedValueOnce({
      agent: createMockAgent({
        id: 'node-gamma-03',
        hostname: 'node-gamma.lan',
      }),
      credential: 'ag_secret_test',
    });

    const wrapper = await mountAndRegister('node-gamma-03');

    const doneBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Done & Return to Fleet'));
    await doneBtn?.trigger('click');

    expect(wrapper.emitted('registered')).toHaveLength(1);
    expect(wrapper.emitted('update:open')).toEqual([[false]]);
  });
});
