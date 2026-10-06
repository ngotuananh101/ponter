export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  sessionId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  createdAt: string;
}

export interface TerminalCreateMessage {
  terminalId: string;
  cols: number;
  rows: number;
  shell?: string;
}

export interface TerminalDataMessage {
  terminalId: string;
  data: string;
}

export interface TerminalResizeMessage {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseMessage {
  terminalId: string;
}

export interface TerminalExitMessage {
  terminalId: string;
  exitCode?: number;
}

/**
 * A terminal the agent could not produce.
 *
 * Codes are the agent's `PtyErrorCode`: `pty-spawn-failed`,
 * `session-limit-reached`.
 */
export interface TerminalErrorMessage {
  terminalId: string;
  code: string;
  message: string;
}

/** WS1 E2EE negotiation: the offerer proposes a session key binding. */
export interface TerminalE2eeHello {
  terminalId: string;
  /** SPKI base64 ECDH P-256 public key. */
  ecdhPublicKey: string;
  /** Ed25519 signature over `canonicalKeyBinding(ecdhPublicKey)`. */
  signature: string;
}

/** WS1 E2EE negotiation: the answerer returns its own key binding. */
export interface TerminalE2eeAck {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}
