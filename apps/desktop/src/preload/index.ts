import { contextBridge, ipcRenderer } from 'electron';
import type {
  PonterDesktopApi,
  SaveConfigPayload,
  RegisterDevicePayload,
  UpdateStatusInfo,
} from '../shared/ipc-types';

export function createPonterApi(ipc: typeof ipcRenderer): PonterDesktopApi {
  return {
    getConfig: () => ipc.invoke('desktop:get-config'),
    saveConfig: (payload: SaveConfigPayload) =>
      ipc.invoke('desktop:save-config', payload),
    probeServer: (url: string) => ipc.invoke('desktop:probe-server', url),
    login: (username: string, password: string) =>
      ipc.invoke('desktop:login', { username, password }),
    logout: () => ipc.invoke('desktop:logout'),
    probeCapture: () => ipc.invoke('desktop:probe-capture'),
    setAutostart: (enabled: boolean) =>
      ipc.invoke('desktop:set-autostart', enabled),
    isAutostartEnabled: () => ipc.invoke('desktop:is-autostart-enabled'),
    listDevices: () => ipc.invoke('desktop:list-devices'),
    registerDevice: (payload: RegisterDevicePayload) =>
      ipc.invoke('desktop:register-device', payload),
    deleteDevice: (agentId: string) =>
      ipc.invoke('desktop:delete-device', agentId),
    getRuntimeStatus: () => ipc.invoke('desktop:get-runtime-status'),
    getLocalAgentId: () => ipc.invoke('desktop:get-local-agent-id'),
    startAgent: () => ipc.invoke('desktop:start-agent'),
    stopAgent: () => ipc.invoke('desktop:stop-agent'),
    onFleetChanged: (callback: () => void) => {
      const listener = () => callback();
      ipc.on('desktop:fleet-changed', listener);
      return () => ipc.removeListener('desktop:fleet-changed', listener);
    },
    onRuntimeStatus: (callback: (status: string) => void) => {
      const listener = (_: unknown, status: string) => callback(status);
      ipc.on('desktop:runtime-status', listener);
      return () => ipc.removeListener('desktop:runtime-status', listener);
    },
    checkForUpdates: () => ipc.invoke('desktop:check-for-updates'),
    downloadUpdate: () => ipc.invoke('desktop:download-update'),
    quitAndInstall: () => ipc.invoke('desktop:quit-and-install'),
    getUpdateStatus: () => ipc.invoke('desktop:get-update-status'),
    onUpdateStatus: (callback: (status: UpdateStatusInfo) => void) => {
      const listener = (_: unknown, status: UpdateStatusInfo) =>
        callback(status);
      ipc.on('desktop:update-status', listener);
      return () => ipc.removeListener('desktop:update-status', listener);
    },
  };
}

export function exposePonterApi(
  bridge: typeof contextBridge = contextBridge,
  ipc: typeof ipcRenderer = ipcRenderer,
): PonterDesktopApi {
  const api = createPonterApi(ipc);
  bridge.exposeInMainWorld('ponter', api);
  return api;
}

// In Electron preload runtime:
if (typeof process !== 'undefined' && process.type === 'renderer') {
  try {
    exposePonterApi();
  } catch {
    // In test or non-isolated environments where contextBridge cannot expose
  }
}
