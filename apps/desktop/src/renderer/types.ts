/**
 * Renderer-side types for the Ponter Desktop shell.
 *
 * These mirror the IPC payload types in `src/shared/ipc-types.ts` but are kept
 * separate so the renderer layer does not depend on the preload/shared module
 * graph.
 */

export type ThemeName = 'light' | 'dark';

/** Subset of the public user profile returned by the login command. */
export interface UserProfile {
  id: string;
  username: string;
  email?: string | null;
  role: string;
}

/** Result of a wizard probe (server health or screen capture). */
export interface ProbeResult {
  ok: boolean;
  message: string;
}

/** Wizard step identifiers — the state machine advances capture→inputGate→autoStart.
 * The server step moved to `ServerSetupView` before login (ADR-66). */
export type WizardStep = 'capture' | 'inputGate' | 'autoStart';

/**
 * A registered device, mirroring the shared `Agent` projection
 * (`packages/shared/src/types/user.ts`) returned by `GET /api/agents`.
 *
 * The `credential` field is intentionally absent: the one-time device
 * credential is written to the OS keychain inside the Rust `register_device`
 * command and never crosses to the frontend (ADR-54 / R3).
 */
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

/** Subset of a registered device for display — omits identity/security fields the
 * web dashboard's "agent dialogs" surface in their management list. */
export interface DeviceSummary {
  id: string;
  hostname: string;
  platform: string | null;
  isOnline: boolean;
  createdAt: string;
}

/** Persisted desktop config as returned by the `get_config` command. */
export interface AppConfig {
  serverUrl: string | null;
  allowInput: boolean;
  theme: 'light' | 'dark' | null;
  hasServerUrl: boolean;
  /** Registered agent belonging to this machine, or null (Ticket #154). */
  localAgentId: string | null;
  /** Whether the local agent should start on launch (Ticket #154). */
  agentAutoStart: boolean;
}
