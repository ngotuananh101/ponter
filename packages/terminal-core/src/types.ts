export type SessionState = 'connecting' | 'active' | 'exited' | 'closed';

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  shell?: string;
}
