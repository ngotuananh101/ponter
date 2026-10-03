import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
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

// happy-dom implements no Fullscreen API, so the view's fullscreen control would
// never render. Install the minimum the composable checks for, and remove it
// afterwards so the absence is not leaked to other suites.
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => null,
  });
});

afterEach(() => {
  delete (Element.prototype as unknown as Record<string, unknown>)
    .requestFullscreen;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

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
    kind: 'terminal',
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

  it('renders DesktopView (not XtermTerminal) for a desktop tab', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-d',
      agentId: 'ag-1',
      kind: 'desktop',
      terminalId: '',
      title: 'Host 1',
      status: 'active',
      desktopStream: { track: { kind: 'video' }, streams: [] } as never,
    });
    store.setActiveTab('tab-d');
    const wrapper = mount(WorkspaceView);
    await flushPromises();
    expect(wrapper.find('video').exists()).toBe(true);
  });

  it('shows the connection stepper for a terminal tab still connecting', async () => {
    const store = useTerminalStore();
    // The store pushes this tab before its session exists; the body must show
    // progress, not xterm mounted against an undefined session.
    store.tabs.push({
      id: 'tab-c',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: '',
      title: 'Host 1',
      status: 'connecting',
      initStep: 'negotiating',
    });
    store.setActiveTab('tab-c');

    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.text()).toContain('Connecting to');
    expect(wrapper.text()).toContain('Negotiating WebRTC channel');
    // xterm is stubbed in this suite; its absence is asserted via the stub
    // name not appearing as a rendered terminal.
    expect(wrapper.findComponent({ name: 'XtermTerminal' }).exists()).toBe(
      false,
    );
  });

  it('shows the error overlay, not the stepper, for a failed terminal tab', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-e',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: '',
      title: 'Host 1',
      status: 'error',
      error: 'no route',
    });
    store.setActiveTab('tab-e');

    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.text()).toContain('no route');
    expect(wrapper.text()).not.toContain('Connecting to');
  });

  it('offers a fullscreen control only when a session tab is active', async () => {
    const store = useTerminalStore();
    const wrapper = mountWorkspace();

    // No tab: nothing to take fullscreen.
    expect(wrapper.find('[data-test="fullscreen-toggle"]').exists()).toBe(
      false,
    );

    seedTab(store, 'tab-1', 'agent-1');
    store.setActiveTab('tab-1');
    await flushPromises();

    expect(wrapper.find('[data-test="fullscreen-toggle"]').exists()).toBe(true);
  });

  /** Seed one active desktop tab and mount the workspace on it. */
  async function mountWorkspaceWithDesktopTab(
    overrides: Partial<
      Parameters<TerminalStore['tabs']['push']>[0] & {
        desktopInputEnabled?: boolean;
      }
    > = {},
  ) {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-d2',
      agentId: 'ag-1',
      kind: 'desktop',
      terminalId: '',
      title: 'Host 1',
      status: 'active',
      desktopStream: { track: { kind: 'video' }, streams: [] } as never,
      desktopStats: {
        width: 1280,
        height: 720,
        fps: 30,
        targetBitrateBps: 4_000_000,
      },
      ...overrides,
    } as never);
    store.setActiveTab('tab-d2');

    const wrapper = mountWorkspace();
    await flushPromises();
    return wrapper;
  }

  it('shows the desktop stats-derived media line in the footer', async () => {
    const wrapper = await mountWorkspaceWithDesktopTab();

    // Scoped to the footer element so this pins the footer's own binding, not
    // the same resolution text rendered inside the desktop view body.
    const footerMedia = wrapper.find('[data-test="footer-media"]');
    expect(footerMedia.exists()).toBe(true);
    expect(footerMedia.text()).toContain('Media: H.264');
    expect(footerMedia.text()).toContain('1280×720');
  });

  it('advertises the input state once the agent reports the gate closed', async () => {
    const wrapper = await mountWorkspaceWithDesktopTab({
      desktopInputEnabled: false,
    });

    expect(wrapper.find('[data-test="footer-media"]').text()).toContain(
      'input off',
    );
  });

  it('advertises the input state once the agent reports the gate open', async () => {
    const wrapper = await mountWorkspaceWithDesktopTab({
      desktopInputEnabled: true,
    });

    expect(wrapper.find('[data-test="footer-media"]').text()).toContain(
      'input on',
    );
  });

  it('does not advertise input before the agent reports', async () => {
    // No `desktopInputEnabled` yet: the feature is not mentioned at all, which
    // is the production default while the gate ships closed (spec §7.4).
    const wrapper = await mountWorkspaceWithDesktopTab();

    const footer = wrapper.find('[data-test="footer-media"]').text();
    expect(footer).not.toContain('input');
  });
});
