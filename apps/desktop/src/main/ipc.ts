import { ipcMain, BrowserWindow, net } from 'electron';
import type { SessionManager } from './session';
import type { ConfigManager } from './config';
import type { DeviceManager } from './devices';
import type { AutostartManager } from './autostart';
import type { FleetManager } from './fleet';
import type { WindowManager } from './window';
import type { AgentSupervisor } from './agent-supervisor';
import type { AgentControlService } from './agent-control';
import type { UpdaterManager } from './updater';
import type {
  AppConfig,
  SaveConfigPayload,
  ProbeResult,
  UserProfile,
  DesktopDevice,
  RegisterDevicePayload,
  AgentControlResult,
  UpdateStatusInfo,
  UpdateCheckResult,
} from '../shared/ipc-types';

export interface IpcDependencies {
  config: ConfigManager;
  session: SessionManager;
  devices: DeviceManager;
  autostart: AutostartManager;
  fleet: FleetManager;
  window: WindowManager;
  supervisor: AgentSupervisor;
  updater: UpdaterManager;
  /**
   * Shared start/stop logic for the local agent (Ticket #154). The tray uses
   * the same instance, so both entry points behave identically.
   */
  agentControl?: Pick<AgentControlService, 'start' | 'stop'>;
  /**
   * Apply a changed server URL to the running services (Issue #150).
   *
   * Wired by `index.ts` to `applyServerUrlChange`; optional so tests and any
   * embedder that does not own a live runtime can register the handlers alone.
   */
  applyServerUrlChange?: (effectiveBaseUrl: string) => Promise<boolean>;
}

/**
 * Registers all `desktop:*` IPC channel handlers on ipcMain.
 *
 * The 20 channels match those defined in src/shared/ipc-types.ts:
 *  1. desktop:get-config
 *  2. desktop:save-config
 *  3. desktop:probe-server
 *  4. desktop:login
 *  5. desktop:logout
 *  6. desktop:probe-capture
 *  7. desktop:set-autostart
 *  8. desktop:is-autostart-enabled
 *  9. desktop:list-devices
 * 10. desktop:register-device
 * 11. desktop:delete-device
 * 12. desktop:get-runtime-status
 * 13. desktop:check-for-updates
 * 14. desktop:download-update
 * 15. desktop:quit-and-install
 * 16. desktop:get-update-status
 * 17. desktop:get-local-agent-id
 * 18. desktop:start-agent
 * 19. desktop:stop-agent
 * 20. desktop:restore-session
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  const {
    config,
    session,
    devices,
    autostart,
    fleet,
    window,
    supervisor,
    updater,
    agentControl,
    applyServerUrlChange,
  } = deps;

  // Listen for agent sidecar runtime status changes and broadcast to renderer windows
  supervisor.onStatusChange(notifyRuntimeStatus);

  // Listen for updater status changes and broadcast to renderer windows
  updater.onStatusChange(notifyUpdateStatus);

  // 1. desktop:get-config
  ipcMain.handle('desktop:get-config', (): AppConfig => {
    return config.load();
  });

  // 2. desktop:save-config
  ipcMain.handle(
    'desktop:save-config',
    async (_event, payload: SaveConfigPayload): Promise<void> => {
      config.save(payload);
      // Issue #150: a new server URL must take effect now, not at next launch.
      // The ApiClient and FleetManager are built once in `app.whenReady()`, so
      // they only learn about the change through this hook. Only an explicit
      // `serverUrl` key triggers it — a theme/allowInput save must not log the
      // user out. The URL applied is the *effective* one (`config.load()`),
      // which honours the ADR-64 precedence order, not the raw payload.
      if (payload.serverUrl !== undefined && applyServerUrlChange) {
        const effectiveUrl = config.load().serverUrl;
        if (effectiveUrl) {
          await applyServerUrlChange(effectiveUrl);
        }
      }
    },
  );

  // 3. desktop:probe-server
  ipcMain.handle(
    'desktop:probe-server',
    async (_event, url: string): Promise<ProbeResult> => {
      // ADR-85 / tssecurity:S5144: `url` arrives from the renderer, so it is
      // untrusted. Parse it and reject any non-http(s) scheme (file:, gopher:,
      // data:, ...) before building the request target from the parsed URL
      // (path prefix preserved) rather than concatenating raw input.
      const healthUrl = buildHealthUrl(url);
      if (!healthUrl) {
        return {
          ok: false,
          message: 'Only http:// and https:// URLs are allowed',
        };
      }

      try {
        const response = await net.fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return { ok: true, message: 'Server reachable' };
        }
        return { ok: false, message: `HTTP ${response.status}` };
      } catch (err: any) {
        return { ok: false, message: err.message || 'Connection failed' };
      }
    },
  );

  // 4. desktop:login
  ipcMain.handle(
    'desktop:login',
    async (
      _event,
      payload: { username: string; password: string; rememberMe?: boolean },
    ): Promise<UserProfile> => {
      return await session.login(
        payload.username,
        payload.password,
        payload.rememberMe,
      );
    },
  );

  // 5. desktop:logout
  ipcMain.handle('desktop:logout', async (): Promise<void> => {
    await session.logout();
  });

  // 6. desktop:probe-capture
  ipcMain.handle('desktop:probe-capture', async (): Promise<ProbeResult> => {
    try {
      // Check if screen capture resources are available
      const { screen } = await import('electron');
      const displays = screen.getAllDisplays();
      if (displays.length > 0) {
        return { ok: true, message: `${displays.length} display(s) available` };
      }
      return { ok: false, message: 'No displays found' };
    } catch (err: any) {
      return {
        ok: false,
        message: err.message || 'Screen capture unavailable',
      };
    }
  });

  // 7. desktop:set-autostart
  ipcMain.handle('desktop:set-autostart', (_event, enabled: boolean): void => {
    autostart.setEnabled(enabled);
  });

  // 8. desktop:is-autostart-enabled
  ipcMain.handle('desktop:is-autostart-enabled', (): boolean => {
    return autostart.isEnabled();
  });

  // 9. desktop:list-devices
  ipcMain.handle('desktop:list-devices', async (): Promise<DesktopDevice[]> => {
    return await devices.listDevices();
  });

  // 10. desktop:register-device
  ipcMain.handle(
    'desktop:register-device',
    async (_event, payload: RegisterDevicePayload): Promise<DesktopDevice> => {
      return await devices.registerDevice(payload);
    },
  );

  // 11. desktop:delete-device
  ipcMain.handle(
    'desktop:delete-device',
    async (_event, agentId: string): Promise<boolean> => {
      return await devices.deleteDevice(agentId);
    },
  );

  // 12. desktop:get-runtime-status
  ipcMain.handle('desktop:get-runtime-status', (): string => {
    return supervisor.getStatus();
  });

  // 13. desktop:check-for-updates
  ipcMain.handle(
    'desktop:check-for-updates',
    async (): Promise<UpdateCheckResult> => {
      return await updater.checkForUpdates();
    },
  );

  // 14. desktop:download-update
  ipcMain.handle('desktop:download-update', async (): Promise<boolean> => {
    return await updater.downloadUpdate();
  });

  // 15. desktop:quit-and-install
  ipcMain.handle('desktop:quit-and-install', (): void => {
    updater.quitAndInstall();
  });

  // 16. desktop:get-update-status
  ipcMain.handle('desktop:get-update-status', (): UpdateStatusInfo => {
    return updater.getStatus();
  });

  // 17. desktop:get-local-agent-id
  ipcMain.handle('desktop:get-local-agent-id', (): string | null => {
    return devices.getLocalAgentId();
  });

  // 18. desktop:start-agent
  ipcMain.handle(
    'desktop:start-agent',
    async (): Promise<AgentControlResult> => {
      if (!agentControl) {
        return { ok: false, message: 'Agent control is unavailable' };
      }
      return await agentControl.start();
    },
  );

  // 19. desktop:stop-agent
  ipcMain.handle('desktop:stop-agent', async (): Promise<void> => {
    await agentControl?.stop();
  });

  // 20. desktop:restore-session
  ipcMain.handle(
    'desktop:restore-session',
    async (): Promise<UserProfile | null> => {
      return await session.restoreSession();
    },
  );
}

/**
 * Build the `/health` probe target from an untrusted renderer-supplied URL.
 *
 * The server exposes its liveness route at `/health` (see
 * `apps/server/src/app.ts`), not `/api/health`.
 *
 * tssecurity:S5144 (SSRF): the renderer controls `rawUrl`, so we parse it and
 * only allow the http/https schemes. Any other scheme (`file:`, `gopher:`,
 * `data:`, ...) yields `null` and the caller refuses the probe. The target is
 * rebuilt from the parsed URL — mutating `pathname` and serialising with
 * `toString()` — so no raw input is string-concatenated into the request URL.
 *
 * Any path prefix is preserved: a server mounted under a sub-path (e.g.
 * `https://host/ponter`) probes `https://host/ponter/health`. The path is
 * trailing-slash-trimmed first, matching `config.cleanUrl`'s convention, and
 * the query/fragment are dropped so the target is exactly the health endpoint.
 */
function buildHealthUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}/health`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Notify all renderer windows of a fleet change.
 */
export function notifyFleetChanged(): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('desktop:fleet-changed');
  }
}

/**
 * Notify all renderer windows of a runtime status change.
 */
export function notifyRuntimeStatus(status: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('desktop:runtime-status', status);
  }
}

/**
 * Notify all renderer windows of an updater status change.
 */
export function notifyUpdateStatus(status: UpdateStatusInfo): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('desktop:update-status', status);
  }
}
