import type { DataChannelManager } from '@remote/webrtc-core';
import type {
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  TerminalCloseMessage,
  TerminalExitMessage,
  TerminalErrorMessage,
} from '@remote/shared';
import { TerminalSession } from './session';
import type { TerminalSessionOptions } from './types';
import type { DataChannelMessage } from '@remote/shared';

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)!;
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export class TerminalClient {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly unsubscribeMessage: () => void;
  private resizeDebounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly errorListeners: Array<(message: string) => void> = [];

  /**
   * Subscribe to terminal failures the agent reports over the data channel.
   *
   * Returns an unsubscribe function, matching `TerminalSession.onStateChange`.
   */
  onError(handler: (message: string) => void): () => void {
    this.errorListeners.push(handler);
    return () => {
      const idx = this.errorListeners.indexOf(handler);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  constructor(
    public readonly agentId: string,
    private readonly dataChannelManager: DataChannelManager,
  ) {
    this.unsubscribeMessage = this.dataChannelManager.onMessage(
      'terminal',
      (msg) => this.handleMessage(msg),
    );
  }

  createSession(options?: TerminalSessionOptions): TerminalSession {
    const terminalId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;

    const session = new TerminalSession(
      terminalId,
      cols,
      rows,
      (data) => this.sendInput(terminalId, data),
      (c, r) => this.debouncedResize(terminalId, c, r),
      () => this.closeSession(terminalId),
    );

    this.sessions.set(terminalId, session);

    const createPayload: TerminalCreateMessage = {
      terminalId,
      cols,
      rows,
      shell: options?.shell,
    };

    this.dataChannelManager.sendJson(
      'terminal',
      'terminal-create',
      createPayload,
    );
    return session;
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  sendInput(terminalId: string, data: Uint8Array | string): void {
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const payload: TerminalDataMessage = {
      terminalId,
      data: uint8ArrayToBase64(bytes),
    };
    this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
  }

  private debouncedResize(
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    if (cols < 1 || rows < 1) return;

    const existing = this.resizeDebounceTimers.get(terminalId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.resizeDebounceTimers.delete(terminalId);
      const payload: TerminalResizeMessage = {
        terminalId,
        cols,
        rows,
      };
      try {
        this.dataChannelManager.sendJson(
          'terminal',
          'terminal-resize',
          payload,
        );
      } catch (err) {
        console.error('[TerminalClient] resize failed', err);
      }
    }, 100);

    this.resizeDebounceTimers.set(terminalId, timer);
  }

  closeSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);

    const timer = this.resizeDebounceTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.resizeDebounceTimers.delete(terminalId);

    try {
      session.close();
    } catch {
      // ignore if session already closed
    }

    const payload: TerminalCloseMessage = { terminalId };
    try {
      this.dataChannelManager.sendJson('terminal', 'terminal-close', payload);
    } catch {
      // ignore if channel already closed
    }
  }

  dispose(): void {
    this.unsubscribeMessage();
    for (const [, timer] of this.resizeDebounceTimers) {
      clearTimeout(timer);
    }
    this.resizeDebounceTimers.clear();

    for (const [, session] of this.sessions) {
      try {
        session.close();
      } catch {
        // ignore if session already closed
      }
    }
    this.sessions.clear();
  }

  private handleMessage(msg: DataChannelMessage): void {
    if (msg.type === 'terminal-data') {
      const payload = msg.payload as TerminalDataMessage;
      const session = this.sessions.get(payload.terminalId);
      if (session) {
        const bytes = base64ToUint8Array(payload.data);
        session.receiveOutput(bytes);
      }
    } else if (msg.type === 'terminal-exit') {
      const payload = msg.payload as TerminalExitMessage;
      const session = this.sessions.get(payload.terminalId);
      if (session) {
        session.markExited(payload.exitCode);
      }
    } else if (msg.type === 'terminal-error') {
      // Without this the agent's refusal to spawn a shell was invisible here:
      // the terminal opened and stayed blank with no way to tell a missing
      // shell from a slow one.
      const payload = msg.payload as TerminalErrorMessage;
      if (this.sessions.has(payload.terminalId)) {
        for (const listener of [...this.errorListeners]) {
          listener(payload.message);
        }
      }
    }
  }
}
