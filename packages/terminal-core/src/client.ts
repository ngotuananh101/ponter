import type { DataChannelManager } from '@ponter/webrtc-core';
import type {
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  TerminalCloseMessage,
  TerminalExitMessage,
  TerminalErrorMessage,
  TerminalE2eeAck,
} from '@ponter/shared';
import { TerminalSession } from './session';
import type { TerminalSessionOptions } from './types';
import type { DataChannelMessage } from '@ponter/shared';
import { TerminalE2ee } from './e2ee';
export type { E2eeContext } from './e2ee';

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
  private sendChain: Promise<void> = Promise.resolve();
  private receiveChain: Promise<void> = Promise.resolve();
  /** Terminal IDs for which a hello has already been enqueued (idempotency). */
  private readonly negotiatedTerminals = new Set<string>();

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
    private readonly e2ee?: TerminalE2ee,
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

    // T5-C: TerminalClient drives negotiation itself inside createSession().
    // After terminal-create (plaintext, always), send the e2ee hello on the
    // same ordered sendChain so it is sequenced after any prior input.
    if (this.e2ee) {
      this.negotiate(terminalId);
    }

    return session;
  }

  /**
   * Drive WS1 E2EE negotiation for a session.
   *
   * Called automatically from `createSession()` when `this.e2ee` is present.
   * Idempotent-safe: calling it twice for the same `terminalId` enqueues only
   * one hello. Two layers of guard:
   * 1. `e2ee.isActive()` — skips when the session key is already installed
   *    (i.e. the ack has already been processed).
   * 2. `negotiatedTerminals` set — skips when a hello has already been
   *    enqueued but not yet acked, covering the in-flight window.
   *
   * T5-C: the hello is sent on the same `sendChain` as terminal-data, so
   * ordering is preserved relative to any prior input on that terminal.
   */
  negotiate(terminalId: string): void {
    const e2ee = this.e2ee;
    if (!e2ee) return;
    // Idempotency guard 1: once the session key is active, re-negotiating would
    // send a redundant hello and could race the ack. The ack handler installs
    // the key; if it is already active, skip.
    if (e2ee.isActive()) return;
    // Idempotency guard 2: track per-terminal whether we have already enqueued a
    // hello. This covers the window between createSession()'s auto-hello and the
    // ack arriving — e2ee.isActive() only turns true after the ack, so it alone
    // cannot prevent a duplicate hello in that window.
    if (this.negotiatedTerminals.has(terminalId)) return;
    this.negotiatedTerminals.add(terminalId);
    this.sendChain = this.sendChain
      .then(async () => {
        const hello = await e2ee.buildHello(terminalId);
        this.dataChannelManager.sendJson(
          'terminal',
          'terminal-e2ee-hello',
          hello,
        );
      })
      .catch((err: unknown) => {
        for (const listener of [...this.errorListeners]) {
          listener(
            `terminal-e2ee-hello send chain failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  sendInput(terminalId: string, data: Uint8Array | string): void {
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const e2ee = this.e2ee;
    if (!e2ee || !e2ee.isActive()) {
      // Unchanged plaintext path — byte-identical to today.
      const payload: TerminalDataMessage = {
        terminalId,
        data: uint8ArrayToBase64(bytes),
      };
      this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
      return;
    }
    this.sendChain = this.sendChain
      .then(async () => {
        const framed = await e2ee.encrypt(bytes);
        const payload: TerminalDataMessage = {
          terminalId,
          data: uint8ArrayToBase64(framed),
        };
        this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
      })
      .catch((err: unknown) => {
        for (const listener of [...this.errorListeners]) {
          listener(
            `terminal-data send chain failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
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
        const e2ee = this.e2ee;
        if (!e2ee || !e2ee.isActive()) {
          // Unchanged plaintext path — byte-identical to today.
          const bytes = base64ToUint8Array(payload.data);
          session.receiveOutput(bytes);
          return;
        }
        this.receiveChain = this.receiveChain
          .then(async () => {
            try {
              const encrypted = base64ToUint8Array(payload.data);
              const bytes = await e2ee.decrypt(encrypted);
              session.receiveOutput(bytes);
            } catch (err) {
              for (const listener of [...this.errorListeners]) {
                listener(
                  `terminal-data decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          })
          .catch((err: unknown) => {
            for (const listener of [...this.errorListeners]) {
              listener(
                `terminal-data receive chain failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
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
    } else if (TerminalE2ee.isNegotiationFrame(msg.type)) {
      // T5-C: negotiation frames are processed on the receiveChain so the ack
      // is installed before any subsequent terminal-data frame is decrypted.
      const e2ee = this.e2ee;
      if (!e2ee) return;
      this.receiveChain = this.receiveChain.then(async () => {
        if (msg.type === 'terminal-e2ee-ack') {
          try {
            await e2ee.handleAck(msg.payload as TerminalE2eeAck);
          } catch (err) {
            for (const listener of [...this.errorListeners]) {
              listener(
                `terminal-e2ee-ack failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        // terminal-e2ee-hello is answerer-side; the browser is always the
        // offerer here, so it is ignored on this path.
      });
    }
  }
}
