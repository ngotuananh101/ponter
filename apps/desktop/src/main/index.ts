import { app, BrowserWindow } from 'electron';
import { ConfigManager } from './config';
import { KeychainService } from './keychain';
import { SessionManager } from './session';
import { DeviceManager } from './devices';
import { AutostartManager } from './autostart';
import { TrayManager } from './tray';
import { WindowManager } from './window';
import { FleetManager } from './fleet';
import { registerIpcHandlers } from './ipc';
import { createApiClient } from '@ponter/api-client';

/**
 * Main process entry point for the Ponter desktop shell (ADR-79).
 *
 * Initializes all core services: config, keychain, session, devices,
 * autostart, tray, window, fleet, and IPC handlers.
 */
let config: ConfigManager;
let keychain: KeychainService;
let session: SessionManager;
let devices: DeviceManager;
let autostart: AutostartManager;
let tray: TrayManager;
let window: WindowManager;
let fleet: FleetManager;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // Initialize config
    config = new ConfigManager();
    const cfg = config.load();

    // Initialize keychain (ADR-13: uses Electron safeStorage)
    keychain = new KeychainService();

    // Initialize session with API client
    const apiClient = createApiClient({
      baseUrl: cfg.serverUrl ?? 'http://localhost:8787',
      storage: {
        getAccessToken: async () => keychain.getSecret('access_token'),
        getRefreshToken: async () => keychain.getSecret('refresh_token'),
        setTokens: async (tokens) => {
          keychain.storeSecret('access_token', tokens.accessToken);
          keychain.storeSecret('refresh_token', tokens.refreshToken);
        },
        clearTokens: async () => {
          keychain.deleteSecret('access_token');
          keychain.deleteSecret('refresh_token');
        },
      },
    });

    session = new SessionManager(apiClient as any, keychain);

    // Initialize devices
    devices = new DeviceManager(session, keychain);

    // Initialize autostart
    autostart = new AutostartManager();

    // Initialize window manager
    window = new WindowManager();

    // Initialize tray (single-click to restore window)
    tray = new TrayManager({
      onShowWindow: () => window.restore(),
      onQuit: () => {
        fleet?.destroy();
        tray?.destroy();
        app.quit();
      },
    });
    tray.createTray();

    // Initialize fleet (dual-layer: WebSocket + polling fallback, ADR-82)
    fleet = new FleetManager(apiClient as any, session, {
      baseUrl: cfg.serverUrl ?? '',
    });
    fleet.start();

    // Create the main window
    window.createWindow();

    // Register all IPC handlers (12 desktop:* channels)
    registerIpcHandlers({ config, session, devices, autostart, fleet, window });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        window.createWindow();
      }
    });

    app.on('before-quit', () => {
      fleet?.destroy();
      tray?.destroy();
    });

    app.on('window-all-closed', () => {
      // On macOS, keep the app running unless explicitly quit
      if (process.platform !== 'darwin') {
        fleet?.destroy();
        tray?.destroy();
      }
    });
  });
}
