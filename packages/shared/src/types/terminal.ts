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

export interface TerminalDataMessage {
  terminalId: string;
  data: string;
}

export interface TerminalResizeMessage {
  terminalId: string;
  cols: number;
  rows: number;
}
