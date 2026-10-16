/**
 * Test setup for Electron main process tests.
 *
 * Mocks the `electron` module so main-process modules can be imported in a
 * pure Node environment (where there is no running Electron process).
 */
import { vi } from 'vitest';

// Minimal stub of the Electron main-process surface that main modules touch.
vi.mock('electron', () => {
  const app = {
    getPath: vi.fn((_key: string) => '/tmp/test-user-data'),
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    getVersion: vi.fn(() => '0.1.0'),
    getName: vi.fn(() => 'Ponter Desktop'),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    on: vi.fn(),
    isPackaged: false,
  };
  const Tray = vi.fn(function () {
    return {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
  });
  const BrowserWindow = vi.fn();
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((buf: Buffer) => buf.toString()),
  };
  const ipcMain = {
    handle: vi.fn(),
    on: vi.fn(),
  };
  const screen = {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  };
  const Menu = {
    buildFromTemplate: vi.fn((items) => items),
    buildTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  };

  return {
    app,
    Tray,
    BrowserWindow,
    safeStorage,
    ipcMain,
    screen,
    Menu,
  };
});
