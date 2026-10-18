import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { ConfigManager } from './config';
import { KeychainService } from './keychain';
import { SessionManager, SessionTokenStorage } from './session';
import { DeviceManager } from './devices';
import { AutostartManager } from './autostart';
import { TrayManager } from './tray';
import { WindowManager } from './window';
import { FleetManager } from './fleet';
import { AgentSupervisor } from './agent-supervisor';
import { AgentControlService } from './agent-control';
import { UpdaterManager } from './updater';
import { registerIpcHandlers } from './ipc';
import { applyServerUrlChange } from './server-url';
import { createApiClient } from '@ponter/api-client';

/**
 * Main process entry point for the Ponter desktop shell (ADR-79).
 *
 * Initializes all core services: config, keychain, session, devices,
 * autostart, tray, window, fleet, supervisor, updater, and IPC handlers.
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
let supervisor: AgentSupervisor;
let agentControl: AgentControlService;
let updater: UpdaterManager;

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

    // Initialize agent sidecar supervisor (ADR-86)
    supervisor = new AgentSupervisor(config, keychain);

    // Initialize session token storage:
    // - Access tokens: in-memory only (never written to keychain/disk)
    // - Refresh tokens: via keychain.safeStorage
    // - Generation-aware (Issue #150): once the client is repointed at another
    //   server, stored credentials stop being served immediately, so neither a
    //   Bearer header nor a refresh POST can carry them to the new host.
    // - Optional chaining guard (BE review B3 TDZ): `getRefreshToken()` now
    //   calls this on its very first read to adopt the initial generation, so
    //   an early read before `apiClient` is assigned must not throw.
    let apiClient: ReturnType<typeof createApiClient> | undefined;
    const tokenStorage = new SessionTokenStorage(
      keychain,
      () => apiClient?.http.serverGeneration ?? 0,
    );

    // Initialize API client with secure storage adapter
    apiClient = createApiClient({
      baseUrl: cfg.serverUrl ?? 'http://localhost:8787',
      storage: tokenStorage,
    });

    session = new SessionManager(apiClient, keychain);

    // Initialize devices
    devices = new DeviceManager(apiClient, session, keychain, config);

    // Shared start/stop logic for the local agent (Ticket #154). Both the IPC
    // handlers and the tray call this, so the two entry points cannot drift and
    // start/stop stay serialized on one queue.
    agentControl = new AgentControlService({
      supervisor,
      config,
      devices,
      // PM ruling R3: a stable path under userData. The agent falls back to
      // CWD on Windows when unset, which regenerates the identity on every run
      // and breaks the WS2 trust binding.
      identityPath: path.join(app.getPath('userData'), 'agent-identity.pkcs8'),
    });

    // Initialize autostart
    autostart = new AutostartManager();

    // Initialize window manager
    window = new WindowManager();

    // Initialize tray (single-click to restore window)
    tray = new TrayManager({
      onShowWindow: () => window.restore(),
      onQuit: async () => {
        await agentControl?.stop();
        fleet?.destroy();
        tray?.destroy();
        app.quit();
      },
      // Ticket #154: the tray is the only control surface when the window is
      // hidden. Start/stop go through the same service as the IPC handlers.
      getAgentStatus: () => supervisor.getStatus(),
      onStartAgent: () => agentControl?.start(),
      onStopAgent: () => agentControl?.stop(),
    });
    try {
      tray.createTray();
    } catch (err) {
      console.warn('Failed to initialize tray:', err);
    }

    // Rebuild the tray menu whenever the agent lifecycle changes, so the
    // Start/Stop item always matches reality.
    supervisor.onStatusChange(() => tray?.updateAgentStatus());

    // Initialize fleet (dual-layer: WebSocket + polling fallback, ADR-82)
    fleet = new FleetManager(apiClient, session, {
      baseUrl: cfg.serverUrl ?? '',
    });
    fleet.start();

    // Create the main window
    window.createWindow();

    // Initialize auto-updater (ADR-87)
    updater = new UpdaterManager();

    // Check for updates in the background on startup when packaged
    if (app.isPackaged) {
      updater.checkForUpdates().catch(() => {
        // Suppress background check error
      });
    }

    // Register all IPC handlers (19 desktop:* channels)
    registerIpcHandlers({
      config,
      session,
      devices,
      autostart,
      fleet,
      window,
      supervisor,
      updater,
      agentControl,
      // Issue #150: the client and fleet are built once here, so a server URL
      // saved later must be pushed into the live services rather than waiting
      // for the next launch.
      applyServerUrlChange: (effectiveBaseUrl) =>
        applyServerUrlChange(
          {
            apiClient,
            session,
            fleet,
            agentControl,
            // Ticket #154 / ruling R1: the device credential is server-scoped,
            // so the switch forgets this machine's device and its sticky
            // auto-start. The keychain entry goes first — the config field is
            // only a pointer to it.
            onServerChanged: () => {
              const localAgentId = config.load().localAgentId;
              if (localAgentId) {
                keychain.deleteSecret(`device_credential_${localAgentId}`);
              }
              config.save({ localAgentId: null, agentAutoStart: false });
            },
          },
          effectiveBaseUrl,
        ),
    });

    // Ticket #154 / ruling R5: sticky auto-start. A user who pressed Start once
    // expects the agent to come back on the next launch; a Stop turns it off
    // for good. Best-effort — a failure here must never block startup.
    if (
      cfg.agentAutoStart === true &&
      cfg.hasServerUrl &&
      devices.getLocalAgentId() &&
      devices.getDeviceCredential(devices.getLocalAgentId()!)
    ) {
      void agentControl.start().catch(() => {
        // Surfaced in the UI via runtime status; boot continues regardless.
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        window.createWindow();
      }
    });

    app.on('before-quit', async () => {
      await agentControl?.stop();
      fleet?.destroy();
      tray?.destroy();
    });

    app.on('window-all-closed', async () => {
      // ADR-78: macOS not supported — quit on all remaining platforms
      await agentControl?.stop();
      fleet?.destroy();
      tray?.destroy();
      app.quit();
    });
  });
}
