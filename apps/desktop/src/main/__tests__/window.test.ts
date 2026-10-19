import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, Menu } from 'electron';
import { WindowManager } from '../window';

describe('WindowManager', () => {
  let eventHandlers: Record<string, (event?: any) => void>;

  const mockWindow = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
    },
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    removeMenu: vi.fn(),
    on: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers = {};
    mockWindow.isMinimized.mockReturnValue(false);
    mockWindow.on.mockImplementation((event: string, handler: any) => {
      eventHandlers[event] = handler;
      return mockWindow;
    });
    vi.mocked(BrowserWindow).mockImplementation(function MockBrowserWindow() {
      return mockWindow as any;
    } as any);
  });

  it('creates a compact window with usable minimum dimensions', () => {
    new WindowManager().createWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 800,
        height: 600,
        minWidth: 480,
        minHeight: 500,
      }),
    );
  });

  it('suppresses the native application and window menus', () => {
    new WindowManager().createWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ autoHideMenuBar: true }),
    );
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(mockWindow.removeMenu).toHaveBeenCalledOnce();
  });

  it('manages quitting state with setQuitting and isQuittingApp', () => {
    const wm = new WindowManager();
    expect(wm.isQuittingApp()).toBe(false);

    wm.setQuitting(true);
    expect(wm.isQuittingApp()).toBe(true);

    wm.setQuitting(false);
    expect(wm.isQuittingApp()).toBe(false);
  });

  it('intercepts close event and hides window when isQuitting is false', () => {
    const wm = new WindowManager();
    wm.createWindow();

    expect(eventHandlers['close']).toBeDefined();

    const preventDefault = vi.fn();
    eventHandlers['close']({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mockWindow.hide).toHaveBeenCalledOnce();
  });

  it('allows close event to proceed without preventDefault when isQuitting is true', () => {
    const wm = new WindowManager();
    wm.createWindow();
    wm.setQuitting(true);

    expect(eventHandlers['close']).toBeDefined();

    const preventDefault = vi.fn();
    eventHandlers['close']({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mockWindow.hide).not.toHaveBeenCalled();
  });

  it('restores minimized window, shows, and focuses it', () => {
    const wm = new WindowManager();
    wm.createWindow();

    mockWindow.isMinimized.mockReturnValue(true);
    wm.restore();

    expect(mockWindow.isMinimized).toHaveBeenCalledOnce();
    expect(mockWindow.restore).toHaveBeenCalledOnce();
    expect(mockWindow.show).toHaveBeenCalledOnce();
    expect(mockWindow.focus).toHaveBeenCalledOnce();
  });

  it('shows and focuses window directly when not minimized', () => {
    const wm = new WindowManager();
    wm.createWindow();

    mockWindow.isMinimized.mockReturnValue(false);
    wm.restore();

    expect(mockWindow.isMinimized).toHaveBeenCalledOnce();
    expect(mockWindow.restore).not.toHaveBeenCalled();
    expect(mockWindow.show).toHaveBeenCalledOnce();
    expect(mockWindow.focus).toHaveBeenCalledOnce();
  });

  it('close() sets isQuitting to true and closes mainWindow', () => {
    const wm = new WindowManager();
    wm.createWindow();

    expect(wm.isQuittingApp()).toBe(false);
    wm.close();

    expect(wm.isQuittingApp()).toBe(true);
    expect(mockWindow.close).toHaveBeenCalledOnce();
    expect(wm.getWindow()).toBeNull();
  });
});
