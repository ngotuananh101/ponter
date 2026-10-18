export interface AppConfig {
  serverUrl: string | null;
  allowInput: boolean;
  theme: 'light' | 'dark' | null;
  hasServerUrl: boolean;
  /**
   * The registered agent that belongs to this machine (Ticket #154), or null
   * when this install has not registered a device — or the credential is gone.
   */
  localAgentId: string | null;
  /** Start the local agent automatically on the next launch (Ticket #154). */
  agentAutoStart: boolean;
}

export interface SaveConfigPayload {
  serverUrl?: string | null;
  allowInput?: boolean;
  theme?: 'light' | 'dark' | null;
  /** `undefined` = unchanged, `null` = forget this machine's device. */
  localAgentId?: string | null;
  /** `undefined` = unchanged; persisted so the agent starts on next launch. */
  agentAutoStart?: boolean;
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

/** Result of an agent start/stop request (Ticket #154). */
export interface AgentControlResult {
  ok: boolean;
  message: string;
}

export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatusInfo {
  status: UpdateStatus;
  version?: string;
  error?: string;
  progress?: number;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  error?: string;
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
  /** The registered agent belonging to this machine, or null (Ticket #154). */
  getLocalAgentId(): Promise<string | null>;
  /** Start the local agent; `ok: false` explains why it could not (Ticket #154). */
  startAgent(): Promise<AgentControlResult>;
  /** Stop the local agent (Ticket #154). */
  stopAgent(): Promise<void>;
  onFleetChanged(callback: () => void): () => void;
  onRuntimeStatus(callback: (status: string) => void): () => void;
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<boolean>;
  quitAndInstall(): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatusInfo>;
  onUpdateStatus?(callback: (status: UpdateStatusInfo) => void): () => void;
}

declare global {
  interface Window {
    ponter: PonterDesktopApi;
  }
}
