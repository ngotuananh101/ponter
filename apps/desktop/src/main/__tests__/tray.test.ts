import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { TrayManager } from '../tray';
import { Tray, Menu } from 'electron';

describe('TrayManager', () => {
  let onShowWindow: Mock<() => void>;
  let onQuit: Mock<() => void>;
  let manager: TrayManager;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    onShowWindow = vi.fn<() => void>();
    onQuit = vi.fn<() => void>();
    manager = new TrayManager({
      onShowWindow,
      onQuit,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('creates tray and initializes tooltip, context menu, and click handler', () => {
    expect(manager.getTray()).toBeNull();

    const tray = manager.createTray();
    expect(tray).not.toBeNull();

    expect(Tray).toHaveBeenCalledTimes(1);
    expect(manager.getTray()).toBe(tray);
    expect(tray?.setToolTip).toHaveBeenCalledWith('Ponter Desktop');
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(tray?.setContextMenu).toHaveBeenCalledTimes(1);
    expect(tray?.on).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('selects correct icon depending on platform', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    manager.createTray();
    const winConstructorCall = vi.mocked(Tray).mock.calls[0][0];
    expect(winConstructorCall).toContain('ponter-tray.ico');

    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    const linuxManager = new TrayManager({ onShowWindow, onQuit });
    linuxManager.createTray();
    const linuxConstructorCall = vi.mocked(Tray).mock.calls[0][0];
    expect(linuxConstructorCall).toContain('ponter-tray.png');
  });

  it('sets up context menu actions for show window and quit', () => {
    manager.createTray();

    const template = vi.mocked(Menu.buildFromTemplate).mock
      .calls[0][0] as Array<{
      label?: string;
      type?: string;
      click?: () => void;
    }>;

    // Ticket #154: without agent callbacks the menu keeps its original shape
    // (show / status / separator / quit); the agent variant is covered below.
    expect(template).toHaveLength(4);

    const showItem = template.find((item) => item.label === 'Show Window');
    expect(showItem).toBeDefined();
    showItem?.click?.();
    expect(onShowWindow).toHaveBeenCalledTimes(1);

    const separator = template.find((item) => item.type === 'separator');
    expect(separator).toBeDefined();

    const quitItem = template.find((item) => item.label === 'Quit');
    expect(quitItem).toBeDefined();
    quitItem?.click?.();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  /**
   * Ticket #154: the tray is the only control surface when the window is
   * hidden, so it must show the agent state and offer the matching action.
   */
  describe('agent controls', () => {
    let getAgentStatus: Mock<() => string>;
    let onStartAgent: Mock<() => void>;
    let onStopAgent: Mock<() => void>;
    let agentManager: TrayManager;

    function templateOf(): Array<{
      label?: string;
      enabled?: boolean;
      type?: string;
      click?: () => void;
    }> {
      return vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as Array<{
        label?: string;
        enabled?: boolean;
        type?: string;
        click?: () => void;
      }>;
    }

    beforeEach(() => {
      getAgentStatus = vi.fn(() => 'stopped');
      onStartAgent = vi.fn();
      onStopAgent = vi.fn();
      agentManager = new TrayManager({
        onShowWindow,
        onQuit,
        getAgentStatus,
        onStartAgent,
        onStopAgent,
      });
    });

    afterEach(() => {
      agentManager.destroy();
    });

    it('shows the agent status as a disabled item', () => {
      agentManager.createTray();

      const statusItem = templateOf().find((item) =>
        item.label?.startsWith('Agent:'),
      );
      expect(statusItem?.label).toBe('Agent: stopped');
      expect(statusItem?.enabled).toBe(false);
    });

    it('offers Start Agent when the agent is stopped', () => {
      agentManager.createTray();

      const startItem = templateOf().find(
        (item) => item.label === 'Start Agent',
      );
      expect(startItem).toBeDefined();
      expect(
        templateOf().find((item) => item.label === 'Stop Agent'),
      ).toBeUndefined();

      startItem?.click?.();
      expect(onStartAgent).toHaveBeenCalledTimes(1);
    });

    it('offers Stop Agent when the agent is running', () => {
      getAgentStatus.mockReturnValue('connected');
      agentManager.createTray();

      const stopItem = templateOf().find((item) => item.label === 'Stop Agent');
      expect(stopItem).toBeDefined();
      expect(
        templateOf().find((item) => item.label === 'Start Agent'),
      ).toBeUndefined();

      stopItem?.click?.();
      expect(onStopAgent).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the menu when the agent status changes', () => {
      agentManager.createTray();
      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);

      getAgentStatus.mockReturnValue('connected');
      agentManager.updateAgentStatus('connected');

      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
      const latest = vi.mocked(Menu.buildFromTemplate).mock
        .calls[1][0] as Array<{ label?: string }>;
      expect(
        latest.find((item) => item.label === 'Agent: connected'),
      ).toBeDefined();
      expect(latest.find((item) => item.label === 'Stop Agent')).toBeDefined();
    });

    it('keeps the original menu when no agent callbacks are supplied', () => {
      const plain = new TrayManager({ onShowWindow, onQuit });
      plain.createTray();

      const template = vi.mocked(Menu.buildFromTemplate).mock
        .calls[0][0] as Array<{ label?: string }>;
      expect(template).toHaveLength(4);
      expect(template.find((item) => item.label === 'Status')).toBeDefined();

      plain.destroy();
    });
  });

  it('triggers onShowWindow when tray icon is clicked', () => {
    const tray = manager.createTray();
    expect(tray).not.toBeNull();

    const clickCall = (
      vi.mocked(tray!.on).mock.calls as Array<
        [string, (...args: any[]) => void]
      >
    ).find(([event]) => event === 'click');
    expect(clickCall).toBeDefined();

    const clickHandler = clickCall?.[1] as () => void;
    clickHandler();

    expect(onShowWindow).toHaveBeenCalledTimes(1);
  });

  it('destroys tray and resets instance to null', () => {
    const tray = manager.createTray();
    expect(manager.getTray()).toBe(tray);
    expect(tray).not.toBeNull();

    manager.destroy();

    expect(tray!.destroy).toHaveBeenCalledTimes(1);
    expect(manager.getTray()).toBeNull();

    // Calling destroy again when already destroyed does not throw
    expect(() => manager.destroy()).not.toThrow();
  });
});
