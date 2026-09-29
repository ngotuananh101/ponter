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
