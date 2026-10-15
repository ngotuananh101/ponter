import { app, BrowserWindow } from 'electron';
import { ConfigManager } from './config';
import { KeychainService } from './keychain';
import { SessionManager, SessionTokenStorage } from './session';
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
 *
 * ADR-78: macOS is not supported (native GUI Windows + Linux only).
 */

// Module-level state for this process instance.
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
    // Initialize config (ADR-64: server URL resolution precedence)
    config = new ConfigManager();
    const cfg = config.load();

    // Initialize keychain (ADR-13/ADR-52/R8: uses Electron safeStorage)
    keychain = new KeychainService();

    // Initialize session token storage:
    // - Access tokens: in-memory only (never written to keychain/disk)
    // - Refresh tokens: via keychain.safeStorage
    const tokenStorage = new SessionTokenStorage(keychain);

    // Initialize API client with secure storage adapter
    const apiClient = createApiClient({
      baseUrl: cfg.serverUrl ?? 'http://localhost:8787',
      storage: tokenStorage,
    });

    session = new SessionManager(apiClient, keychain);

    // Initialize devices
    devices = new DeviceManager(apiClient, session, keychain);

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
    fleet = new FleetManager(apiClient, session, {
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
      // ADR-78: macOS not supported — quit on all remaining platforms
      fleet?.destroy();
      tray?.destroy();
      app.quit();
    });
  });
}
