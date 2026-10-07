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

/** Wizard step identifiers — the state machine advances server→capture→inputGate→autoStart. */
export type WizardStep = 'server' | 'capture' | 'inputGate' | 'autoStart';
