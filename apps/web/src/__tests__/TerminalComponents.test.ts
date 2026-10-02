import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import TerminalTabBar from '../components/terminal/TerminalTabBar.vue';
import MobileAccessoryBar from '../components/terminal/MobileAccessoryBar.vue';
import WorkspaceSidebar from '../components/terminal/WorkspaceSidebar.vue';

describe('TerminalTabBar.vue', () => {
  it('renders tab items and handles select / close events', async () => {
    const tabs = [
      {
        id: 't1',
        title: 'Shell 1',
        status: 'active',
        kind: 'terminal' as const,
      },
      {
        id: 't2',
        title: 'Shell 2',
        status: 'connecting',
        kind: 'terminal' as const,
      },
    ];
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs,
        activeTabId: 't1',
      },
    });

    expect(wrapper.text()).toContain('Shell 1');
    expect(wrapper.text()).toContain('Shell 2');

    await wrapper.find('[data-test="close-tab-t1"]').trigger('click');
    expect(wrapper.emitted('closeTab')?.[0]).toEqual(['t1']);
  });

  it('emits selectTab when clicking an inactive tab', async () => {
    const tabs = [
      {
        id: 't1',
        title: 'Shell 1',
        status: 'active',
        kind: 'terminal' as const,
      },
      {
        id: 't2',
        title: 'Shell 2',
        status: 'exited',
        kind: 'terminal' as const,
      },
    ];
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs,
        activeTabId: 't1',
      },
    });

    // The second tab is the inactive one; clicking its main element (not the close button)
    // should emit selectTab with its id.
    const tabElements = wrapper.findAll('div.cursor-pointer');
    expect(tabElements).toHaveLength(2);
    await tabElements[1]!.trigger('click');
    expect(wrapper.emitted('selectTab')?.[0]).toEqual(['t2']);
  });

  it('emits newTab when the new tab button is clicked', async () => {
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs: [],
        activeTabId: null,
      },
    });
    await wrapper.find('button[title="Open new tab"]').trigger('click');
    expect(wrapper.emitted('newTab')).toHaveLength(1);
  });
});

describe('MobileAccessoryBar.vue', () => {
  it('emits key event on key button pointerdown', async () => {
    const wrapper = mount(MobileAccessoryBar);
    const escBtn = wrapper.find('[data-key="Escape"]');
    expect(escBtn.exists()).toBe(true);

    await escBtn.trigger('pointerdown');
    expect(wrapper.emitted('sendKey')?.[0]).toEqual(['\x1b']);
  });

  it('renders all expected virtual keys', () => {
    const wrapper = mount(MobileAccessoryBar);
    const keys = [
      'Escape',
      'Tab',
      'CtrlC',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Pipe',
      'Slash',
      'Tilde',
      'Dash',
    ];
    keys.forEach((k) => {
      expect(wrapper.find(`[data-key="${k}"]`).exists()).toBe(true);
    });
  });
});

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: {
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

describe('WorkspaceSidebar.vue', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.clearAllMocks();

    // Agent A advertises desktop; agent B does not.
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.agents.list).mockResolvedValue([
      {
        id: 'a1',
        userId: 'u1',
        hostname: 'host-a',
        platform: 'linux',
        osVersion: '6.5',
        agentVersion: '0.1.0',
        publicKey: 'pk-a',
        isOnline: true,
        lastHeartbeat: null,
        capabilities: ['terminal', 'desktop'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'a2',
        userId: 'u1',
        hostname: 'host-b',
        platform: 'linux',
        osVersion: '6.5',
        agentVersion: '0.1.0',
        publicKey: 'pk-b',
        isOnline: true,
        lastHeartbeat: null,
        capabilities: ['terminal'],
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  it('shows the Monitor button only for agents advertising desktop', async () => {
    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: {
        stubs: {
          Teleport: true,
          ScrollArea: { template: '<div><slot /></div>' },
        },
      },
    });
    // Drive the agent list through the mocked api client used by this suite.
    await flushPromises();
    expect(wrapper.find('[data-test="connect-desktop-a1"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-test="connect-desktop-a2"]').exists()).toBe(
      false,
    );

    await wrapper.find('[data-test="connect-desktop-a1"]').trigger('click');
    expect(wrapper.emitted('connectDesktop')).toBeTruthy();
    expect(wrapper.emitted('connectAgent')).toBeFalsy();
  });

  it('opens the edit dialog prefilled for the clicked agent', async () => {
    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: {
        stubs: {
          Teleport: true,
          ScrollArea: { template: '<div><slot /></div>' },
        },
      },
    });
    await flushPromises();

    expect(wrapper.find('[data-test="edit-agent-a1"]').exists()).toBe(true);
    await wrapper.find('[data-test="edit-agent-a1"]').trigger('click');
    await flushPromises();

    // The edit dialog is open with a1's hostname prefilled.
    expect(wrapper.find('#edit-agent-hostname').exists()).toBe(true);
    expect(
      (wrapper.find('#edit-agent-hostname').element as HTMLInputElement).value,
    ).toBe('host-a');

    // Editing must not also fire a connect action (the row click is stopped).
    expect(wrapper.emitted('connectAgent')).toBeFalsy();
    expect(wrapper.emitted('connectDesktop')).toBeFalsy();
  });

  it('opens the delete dialog for the clicked agent', async () => {
    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: {
        stubs: {
          Teleport: true,
          ScrollArea: { template: '<div><slot /></div>' },
        },
      },
    });
    await flushPromises();

    await wrapper.find('[data-test="delete-agent-a2"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="delete-agent-confirm"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain('host-b');
    expect(wrapper.emitted('connectAgent')).toBeFalsy();
  });

  it('removes the agent from the list after a successful delete', async () => {
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.agents.delete).mockResolvedValueOnce({ success: true });

    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: {
        stubs: {
          Teleport: true,
          ScrollArea: { template: '<div><slot /></div>' },
        },
      },
    });
    await flushPromises();

    expect(wrapper.find('[data-test="delete-agent-a2"]').exists()).toBe(true);
    await wrapper.find('[data-test="delete-agent-a2"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="delete-agent-confirm"]').trigger('click');
    await flushPromises();

    expect(apiClient.agents.delete).toHaveBeenCalledWith('a2');
    expect(wrapper.find('[data-test="delete-agent-a2"]').exists()).toBe(false);
    // The other agent is untouched.
    expect(wrapper.find('[data-test="delete-agent-a1"]').exists()).toBe(true);
  });

  it('reflects an edited agent in the list after a successful update', async () => {
    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.agents.update).mockResolvedValueOnce({
      id: 'a1',
      userId: 'u1',
      hostname: 'renamed-host',
      platform: 'linux',
      osVersion: '6.5',
      agentVersion: '0.1.0',
      publicKey: 'pk-a',
      isOnline: true,
      lastHeartbeat: null,
      capabilities: ['terminal', 'desktop'],
      createdAt: new Date().toISOString(),
    });

    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: {
        stubs: {
          Teleport: true,
          ScrollArea: { template: '<div><slot /></div>' },
        },
      },
    });
    await flushPromises();

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
  });
});
