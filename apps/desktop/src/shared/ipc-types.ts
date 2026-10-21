/**
 * The desktop stream profiles the agent accepts on `--desktop-profile` /
 * `AGENT_DESKTOP_PROFILE` (Phase 16, ADR-92).
 *
 * The order is presentation order in the settings UI, not a quality ranking.
 */
export const DESKTOP_PROFILES = [
  '1080p30',
  '720p30',
  '1080p60',
  '720p60',
] as const;
export type DesktopProfileName = (typeof DESKTOP_PROFILES)[number];
export const DEFAULT_DESKTOP_PROFILE: DesktopProfileName = '1080p30';

/** Any absent, unknown, or non-string value resolves to the safe default. */
export function normalizeDesktopProfile(raw: unknown): DesktopProfileName {
  return typeof raw === 'string' &&
    (DESKTOP_PROFILES as readonly string[]).includes(raw)
    ? (raw as DesktopProfileName)
    : DEFAULT_DESKTOP_PROFILE;
}

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
  /**
   * This machine's own Device Code, cached so "This Device" reads offline
   * (spec §3.3, §5.4; ADR-91).
   */
  deviceCode: string | null;
  /** Desktop stream profile forwarded to the sidecar as AGENT_DESKTOP_PROFILE. */
  desktopProfile: DesktopProfileName;
  /** Start the local agent automatically on the next launch (Ticket #154). */
  agentAutoStart: boolean;
  /** Whether login credentials / session should be remembered (Ticket #156). Defaults to true. */
  rememberMe: boolean;
  /** Last remembered username for login autofill (Ticket #156). */
  savedUsername: string | null;
}

export interface SaveConfigPayload {
  serverUrl?: string | null;
  allowInput?: boolean;
  theme?: 'light' | 'dark' | null;
  /** `undefined` = unchanged, `null` = forget this machine's device. */
  localAgentId?: string | null;
  /** `undefined` = unchanged, `null` = forget the cached code. */
  deviceCode?: string | null;
  /** `undefined` = unchanged. An invalid value is normalised to 1080p30. */
  desktopProfile?: DesktopProfileName;
  /** `undefined` = unchanged; persisted so the agent starts on next launch. */
  agentAutoStart?: boolean;
  /** `undefined` = unchanged; whether session should be remembered across restarts. */
  rememberMe?: boolean | null;
  /** `undefined` = unchanged, `null` = clear prefilled username. */
  savedUsername?: string | null;
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
  /** Human-facing 9-digit Device Code (ADR-91), or null before allocation. */
  deviceCode: string | null;
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

export interface OpenRemoteSessionPayload {
  agentId: string;
  mode?: 'desktop' | 'terminal' | 'files';
}

export interface OpenRemoteSessionResult {
  ok: boolean;
  url?: string;
  message?: string;
}

export interface PonterDesktopApi {
  getConfig(): Promise<AppConfig>;
  saveConfig(payload: SaveConfigPayload): Promise<void>;
  probeServer(url: string): Promise<ProbeResult>;
  login(
    username: string,
    password: string,
    rememberMe?: boolean,
  ): Promise<UserProfile>;
  logout(): Promise<void>;
  /** Restore remembered session if available (Ticket #156). */
  restoreSession(): Promise<UserProfile | null>;
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
  openRemoteSession(
    payload: OpenRemoteSessionPayload,
  ): Promise<OpenRemoteSessionResult>;
}

declare global {
  interface Window {
    ponter: PonterDesktopApi;
  }
}
