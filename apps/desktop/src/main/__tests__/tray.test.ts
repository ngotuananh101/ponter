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

    expect(template).toHaveLength(4);

    const showItem = template.find((item) => item.label === 'Show Window');
    expect(showItem).toBeDefined();
    showItem?.click?.();
    expect(onShowWindow).toHaveBeenCalledTimes(1);

    const statusItem = template.find((item) => item.label === 'Status');
    expect(statusItem).toBeDefined();
    statusItem?.click?.(); // should not throw

    const separator = template.find((item) => item.type === 'separator');
    expect(separator).toBeDefined();

    const quitItem = template.find((item) => item.label === 'Quit');
    expect(quitItem).toBeDefined();
    quitItem?.click?.();
    expect(onQuit).toHaveBeenCalledTimes(1);
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
