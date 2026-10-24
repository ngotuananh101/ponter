import type { AgentConfig } from '../config.js';
import type { Logger } from '../logging/index.js';
import type { AgentIdentity } from '../identity/store.js';
import { buildAgentIdentityFrame } from '../identity/frame.js';
import { rewriteWsScheme } from '@ponter/webrtc-core';
import { isAuthFatal } from './auth.js';
import { IDLE_TIMEOUT_MS, PING_INTERVAL_MS } from './constants.js';
import { BACKOFF_INITIAL_MS, nextBackoff } from './backoff.js';
import { classifyClose, type RunEnd } from './close.js';
import { dispatchInbound } from './inbound.js';
import { buildUpgradeHeaders } from './upgrade.js';

export interface SignallingSocket {
  send(data: string): void;
  close(code?: number): void;
  on(
    event: 'open' | 'message' | 'close' | 'error',
    cb: (...args: unknown[]) => void,
  ): void;
}

export interface SignallingDeps {
  connect(url: string, headers: Record<string, string>): SignallingSocket;
  logger: Logger;
  now(): number;
  /** Schedules `fn` every `ms`; returns a cancel handle. */
  every(ms: number, fn: () => void): () => void;
  /** Sleeps; injectable so tests drive it with fake timers. */
  sleep?(ms: number): Promise<void>;
}

export interface SignallingHandlers {
  onOffer(message: unknown): void;
  onAnswer(message: unknown): void;
  onCandidate(message: unknown): void;
  onIceServers(servers: unknown): void;
}

export class SignallingClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private lastRunOpened = false;

  constructor(
    private readonly deps: SignallingDeps,
    private readonly config: AgentConfig,
    private readonly identity: AgentIdentity,
    private readonly handlers: SignallingHandlers,
  ) {
    this.url = rewriteWsScheme(config.server);
    this.headers = buildUpgradeHeaders(config.credential);
  }

  /** One connection, from connect to close. */
  runOnce(): Promise<RunEnd> {
    return new Promise<RunEnd>((resolve) => {
      const socket = this.deps.connect(this.url, this.headers);
      let settled = false;
      let lastActivityAt = this.deps.now();
      let cancelPing: (() => void) | null = null;

      const finish = (end: RunEnd): void => {
        if (settled) return;
        settled = true;
        cancelPing?.();
        socket.close();
        resolve(end);
      };

      socket.on('open', () => {
        this.lastRunOpened = true;
        this.deps.logger.info({ url: this.url }, 'signalling connected');
        lastActivityAt = this.deps.now();
        cancelPing = this.deps.every(PING_INTERVAL_MS, () => {
          if (this.deps.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
            this.deps.logger.warn(
              { idleMs: IDLE_TIMEOUT_MS },
              'signalling idle timeout',
            );
            finish({ kind: 'transient' });
            return;
          }
          socket.send(JSON.stringify({ type: 'ping' }));
        });
      });

      socket.on('message', (raw: unknown) => {
        lastActivityAt = this.deps.now();
        if (typeof raw !== 'string') return;
        try {
          const event = dispatchInbound(raw, this.deps.logger);
          if (event.kind === 'challenge') {
            socket.send(buildAgentIdentityFrame(event.nonce, this.identity));
            return;
          }
          if (event.kind === 'ice') {
            this.handlers.onIceServers(event.servers);
            return;
          }
          if (event.kind !== 'signal') return;
          const message = event.message as { type?: string; data?: unknown };
          if (message.type === 'offer') this.handlers.onOffer(message);
          else if (message.type === 'answer') this.handlers.onAnswer(message);
          else if (message.type === 'ice-candidate')
            this.handlers.onCandidate(message);
        } catch (error) {
          // Fail-soft: a hostile or corrupt frame costs one frame, never the
          // session. The Rust dropped these the same way.
          this.deps.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'dropping an unparseable inbound frame',
          );
        }
      });

      socket.on('error', (error: unknown) => {
        this.deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'signalling socket error',
        );
      });

      socket.on('close', (code: unknown) => {
        finish(classifyClose(typeof code === 'number' ? code : null));
      });

      // The error frame is consumed by `dispatchInbound`, which logs it. Auth
      // fatality must still end the run rather than fall through to a retry, so
      // it is classified here from the raw bytes — the only place that still
      // has them.
      const checkAuth = (raw: unknown): void => {
        if (typeof raw !== 'string' || !raw.includes('UNAUTHORIZED')) return;
        try {
          const parsed = JSON.parse(raw) as { type?: string; code?: string };
          if (parsed.type === 'error' && isAuthFatal({ code: parsed.code })) {
            this.deps.logger.error(
              { code: parsed.code },
              'the server rejected this credential',
            );
            finish({ kind: 'terminal', code: 4401 });
          }
        } catch {
          /* already logged by the message handler */
        }
      };
      socket.on('message', checkAuth);
    });
  }

  /**
   * Reconnect until something terminal happens.
   *
   * The ladder resets **only after a successful connection**, not after every
   * attempt: a server that accepts the socket and immediately drops it is still
   * a server in trouble, and resetting on connect-attempt would hammer it at
   * 200 ms forever.
   */
  async run(): Promise<void> {
    let wait = BACKOFF_INITIAL_MS;
    for (;;) {
      this.lastRunOpened = false;
      const end = await this.runOnce();
      if (end.kind === 'terminal') {
        this.deps.logger.info(
          { code: end.code },
          'signalling ended terminally; not reconnecting',
        );
        return;
      }
      // Reset on a successful CONNECT, not on a successful run: a server that
      // accepts the socket and immediately drops it is still a server in
      // trouble, and resetting on every attempt would hammer it at 200 ms.
      if (this.lastRunOpened) wait = BACKOFF_INITIAL_MS;
      this.deps.logger.info(
        { waitMs: wait },
        'signalling dropped; reconnecting',
      );
      await sleep(this.deps, wait);
      wait = nextBackoff(wait);
    }
  }
}

function sleep(deps: SignallingDeps, ms: number): Promise<void> {
  if (deps.sleep) return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
