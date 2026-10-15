export interface AppConfig {
  serverUrl: string | null;
  allowInput: boolean;
  theme: 'light' | 'dark' | null;
  hasServerUrl: boolean;
}

export interface SaveConfigPayload {
  serverUrl?: string | null;
  allowInput?: boolean;
  theme?: 'light' | 'dark' | null;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export interface UserProfile {
  id: string;
  username: string;
  email?: string | null;
  role: string;
}

export interface DesktopDevice {
  id: string;
  userId: string;
  hostname: string;
  platform: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  publicKey: string;
  signingPublicKey: string | null;
  isOnline: boolean;
  lastHeartbeat: string | null;
  capabilities: string[];
  createdAt: string;
}

export interface RegisterDevicePayload {
  hostname?: string;
  capabilities?: string[];
}

export interface PonterDesktopApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(payload: SaveConfigPayload): Promise<void>;
  probeServer(url: string): Promise<ProbeResult>;
  login(username: string, password: string): Promise<UserProfile>;
  logout(): Promise<void>;
  probeCapture(): Promise<ProbeResult>;
  setAutostart(enabled: boolean): Promise<void>;
  isAutostartEnabled(): Promise<boolean>;
  listDevices(): Promise<DesktopDevice[]>;
  registerDevice(payload: RegisterDevicePayload): Promise<DesktopDevice>;
  deleteDevice(agentId: string): Promise<boolean>;
  getRuntimeStatus(): Promise<string>;
  onFleetChanged(callback: () => void): () => void;
  onRuntimeStatus(callback: (status: string) => void): () => void;
}

declare global {
  interface Window {
    ponter: PonterDesktopApi;
  }
}
