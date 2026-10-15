import { ipcMain, BrowserWindow, net } from 'electron';
import type { SessionManager } from './session';
import type { ConfigManager } from './config';
import type { DeviceManager } from './devices';
import type { AutostartManager } from './autostart';
import type { FleetManager } from './fleet';
import type { WindowManager } from './window';
import type { AgentSupervisor } from './agent-supervisor';
import type {
  AppConfig,
  SaveConfigPayload,
  ProbeResult,
  UserProfile,
  DesktopDevice,
  RegisterDevicePayload,
} from '../shared/ipc-types';

export interface IpcDependencies {
  config: ConfigManager;
  session: SessionManager;
  devices: DeviceManager;
  autostart: AutostartManager;
  fleet: FleetManager;
  window: WindowManager;
  supervisor: AgentSupervisor;
}

/**
 * Registers all `desktop:*` IPC channel handlers on ipcMain.
 *
 * The 12 channels match those defined in src/shared/ipc-types.ts:
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
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  const { config, session, devices, autostart, fleet, window, supervisor } =
    deps;

  // Listen for agent sidecar runtime status changes and broadcast to renderer windows
  supervisor.onStatusChange(notifyRuntimeStatus);

  // 1. desktop:get-config
  ipcMain.handle('desktop:get-config', (): AppConfig => {
    return config.load();
  });

  // 2. desktop:save-config
  ipcMain.handle(
    'desktop:save-config',
    (_event, payload: SaveConfigPayload): void => {
      config.save(payload);
    },
  );

  // 3. desktop:probe-server
  ipcMain.handle(
    'desktop:probe-server',
    async (_event, url: string): Promise<ProbeResult> => {
      // ADR-85 / tssecurity:S5144: `url` arrives from the renderer, so it is
      // untrusted. Parse it and reject any non-http(s) scheme (file:, gopher:,
      // data:, ...) before building the request target from the parsed origin
      // rather than concatenating raw input.
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
      payload: { username: string; password: string },
    ): Promise<UserProfile> => {
      return await session.login(payload.username, payload.password);
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
}

/**
 * Build the `/api/health` probe target from an untrusted renderer-supplied URL.
 *
 * tssecurity:S5144 (SSRF): the renderer controls `rawUrl`, so we parse it and
 * only allow the http/https schemes. Any other scheme (`file:`, `gopher:`,
 * `data:`, ...) yields `null` and the caller refuses the probe. The target is
 * rebuilt from the parsed origin so no raw input is string-concatenated into
 * the request URL.
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
  return `${parsed.origin}/api/health`;
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
