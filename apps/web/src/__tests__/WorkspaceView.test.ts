import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, enableAutoUnmount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkspaceView from '../views/WorkspaceView.vue';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: { list: vi.fn().mockResolvedValue([]) },
    sessions: { create: vi.fn() },
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

// The view registers a window keydown listener; a leaked listener from one test
// would fire on the next test's synthetic keypress.
enableAutoUnmount(afterEach);

type TerminalStore = ReturnType<typeof useTerminalStore>;

// TerminalTabBar stays real on purpose: the bug this file pins lived in the
// template binding between the tab bar's "+" and this view, so clicking the
// actual button is the only way to prove the wiring.
const STUBS = {
  WorkspaceSidebar: true,
  XtermTerminal: true,
  MobileAccessoryBar: true,
};

function mountWorkspace() {
  return mount(WorkspaceView, { global: { stubs: STUBS } });
}

function seedTab(store: TerminalStore, id: string, agentId: string): void {
  store.tabs.push({
    id,
    agentId,
    terminalId: `term-${id}`,
    title: `Tab ${id}`,
    status: 'active',
    session: {} as unknown as TerminalSession,
  });
}

function pressNewTabHotkey(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true }),
  );
}

describe('WorkspaceView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders workspace container and sidebar', () => {
    const wrapper = mountWorkspace();
    expect(wrapper.exists()).toBe(true);
  });

  describe('new terminal wiring', () => {
    it('opens a tab for the active agent when "+" is clicked', async () => {
      const store = useTerminalStore();
      seedTab(store, 'tab-1', 'agent-1');
      seedTab(store, 'tab-2', 'agent-2');
      store.setActiveTab('tab-1');
      const openTab = vi.spyOn(store, 'openTab').mockResolvedValue('tab-new');

      const wrapper = mountWorkspace();
      await wrapper.find('button[title="Open new tab"]').trigger('click');

      // "+" used to only re-reveal the sidebar, so no tab was ever created.
      expect(openTab).toHaveBeenCalledTimes(1);
      expect(openTab).toHaveBeenCalledWith('agent-1');
    });

    it('falls back to the first tab when no tab is active', async () => {
      const store = useTerminalStore();
      seedTab(store, 'tab-1', 'agent-1');
      const openTab = vi.spyOn(store, 'openTab').mockResolvedValue('tab-new');

      const wrapper = mountWorkspace();
      await wrapper.find('button[title="Open new tab"]').trigger('click');

      expect(openTab).toHaveBeenCalledWith('agent-1');
    });

    it('reveals the sidebar from "+" when no tab exists', async () => {
      const store = useTerminalStore();
      const openTab = vi.spyOn(store, 'openTab').mockResolvedValue('tab-new');
      const wrapper = mountWorkspace();

      await wrapper.find('button[title="Hide sidebar"]').trigger('click');
      expect(wrapper.find('button[title="Show sidebar"]').exists()).toBe(true);

      await wrapper.find('button[title="Open new tab"]').trigger('click');

      expect(wrapper.find('button[title="Show sidebar"]').exists()).toBe(false);
      expect(openTab).not.toHaveBeenCalled();
    });

    it('opens a tab for the active agent on Ctrl+Shift+T', () => {
      const store = useTerminalStore();
      seedTab(store, 'tab-1', 'agent-1');
      seedTab(store, 'tab-2', 'agent-2');
      store.setActiveTab('tab-2');
      const openTab = vi.spyOn(store, 'openTab').mockResolvedValue('tab-new');

      mountWorkspace();
      pressNewTabHotkey();

      // The hotkey used to always take tabs[0] — a different agent than the
      // one on screen.
      expect(openTab).toHaveBeenCalledWith('agent-2');
    });

    it('reveals the sidebar on Ctrl+Shift+T when no tab exists', async () => {
      const store = useTerminalStore();
      const openTab = vi.spyOn(store, 'openTab').mockResolvedValue('tab-new');
      const wrapper = mountWorkspace();

      await wrapper.find('button[title="Hide sidebar"]').trigger('click');

      pressNewTabHotkey();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('button[title="Show sidebar"]').exists()).toBe(false);
      expect(openTab).not.toHaveBeenCalled();
    });
  });
});
