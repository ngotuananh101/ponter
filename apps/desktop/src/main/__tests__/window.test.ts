import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, Menu } from 'electron';
import { WindowManager } from '../window';

describe('WindowManager', () => {
  const mockWindow = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
    },
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    removeMenu: vi.fn(),
    on: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
});
