import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { toWsUrl } from '@ponter/webrtc-core';
import type { KeychainService } from './keychain';
import type { ConfigManager } from './config';
import type { DesktopProfileName } from '../shared/ipc-types';
import { DEFAULT_DESKTOP_PROFILE } from '../shared/ipc-types';

export interface AgentSupervisorOptions {
  spawn?: typeof spawn;
  binaryPath?: string;
  onStatusChange?: (status: string) => void;
}

export interface SupervisorConfig {
  agentId: string;
  serverUrl: string;
  allowInput: boolean;
  filesRoot?: string;
  identityPath?: string;
  stunServer?: string;
  /** Desktop stream profile; the agent defaults to 1080p30 when absent. */
  desktopProfile?: DesktopProfileName;
}

export class AgentSupervisor {
  private config?: ConfigManager;
  private keychain: KeychainService;
  private spawnFn: typeof spawn;
  private binaryPath: string;
  private statusCallbacks: ((status: string) => void)[] = [];
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private restartTimeout: any = null;
  private isIntentionallyStopped = true;
  private currentConfig: SupervisorConfig | null = null;
  /** Last few stderr lines from the child (PM ruling C). */
  private stderrTail: string[] = [];
  private static readonly STDERR_TAIL_LINES = 20;

  constructor(
    configOrKeychain: ConfigManager | KeychainService,
    keychainOrOptions?: KeychainService | AgentSupervisorOptions,
    options?: AgentSupervisorOptions,
  ) {
    if (
      keychainOrOptions &&
      typeof (keychainOrOptions as any).getSecret === 'function'
    ) {
      this.config = configOrKeychain as ConfigManager;
      this.keychain = keychainOrOptions as KeychainService;
      this.spawnFn = options?.spawn || spawn;
      this.binaryPath = options?.binaryPath || this.resolveBinaryPath();
      if (options?.onStatusChange) {
        this.statusCallbacks.push(options.onStatusChange);
      }
    } else {
      this.keychain = configOrKeychain as KeychainService;
      const opts = keychainOrOptions as AgentSupervisorOptions | undefined;
      this.spawnFn = opts?.spawn || spawn;
      this.binaryPath = opts?.binaryPath || this.resolveBinaryPath();
      if (opts?.onStatusChange) {
        this.statusCallbacks.push(opts.onStatusChange);
      }
    }
  }

  onStatusChange(callback: (status: string) => void): void {
    this.statusCallbacks.push(callback);
  }

  /**
   * Broadcast a lifecycle change.
   *
   * `connected` means the PROCESS is alive — not that it authenticated over the
   * WebSocket. The agent can still be crash-looping (bad identity, wrong
   * credential, unreachable server), so the UI labels this state "Running"
   * rather than "Connected" (PM ruling B, Ticket #154).
   */
  private emitStatus(status: string): void {
    for (const cb of this.statusCallbacks) {
      try {
        cb(status);
      } catch {}
    }
  }

  private resolveBinaryPath(): string {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'ponter-agent.exe' : 'ponter-agent';

    if (
      process.env.PONTER_AGENT_PATH &&
      fs.existsSync(process.env.PONTER_AGENT_PATH)
    ) {
      return process.env.PONTER_AGENT_PATH;
    }

    if (process.resourcesPath) {
      const prodPath = path.join(process.resourcesPath, binaryName);
      if (fs.existsSync(prodPath)) return prodPath;
    }

    const devReleasePath = path.resolve(
      __dirname,
      '../../../agent/target/release',
      binaryName,
    );
    if (fs.existsSync(devReleasePath)) return devReleasePath;

    const devDebugPath = path.resolve(
      __dirname,
      '../../../agent/target/debug',
      binaryName,
    );
    if (fs.existsSync(devDebugPath)) return devDebugPath;

    return binaryName;
  }

  buildEnvironment(config: SupervisorConfig): Record<string, string> {
    const credential = `device_credential_${config.agentId}`;
    const resolved = this.keychain.getSecret(credential);
    if (!resolved) {
      throw new Error(
        `Missing credential in keychain for agent ${config.agentId}`,
      );
    }

    const wsUrl = `${toWsUrl(config.serverUrl)}/api/ws/agent`;
    const env: Record<string, string> = {
      AGENT_ID: config.agentId,
      AGENT_SERVER: wsUrl,
      AGENT_CREDENTIAL: resolved,
      STUN_SERVER: config.stunServer || 'stun:stun.l.google.com:19302',
      AGENT_ALLOW_INPUT: config.allowInput ? 'true' : 'false',
      // Phase 16: the agent's `--desktop-profile` / `AGENT_DESKTOP_PROFILE`.
      // Always set, so the sidecar's effective profile is the one the app
      // persisted rather than whatever an inherited environment carried.
      AGENT_DESKTOP_PROFILE: config.desktopProfile ?? DEFAULT_DESKTOP_PROFILE,
    };

    if (config.filesRoot) {
      env.AGENT_FILES_ROOT = config.filesRoot;
    }
    if (config.identityPath) {
      env.AGENT_IDENTITY_PATH = config.identityPath;
    }

    return env;
  }

  getBackoffDelay(attempt: number): number {
    const delay = Math.pow(2, attempt) * 1000;
    return Math.min(delay, 30000);
  }

  /**
   * Start the sidecar.
   *
   * Refuses when a child is already alive (PM ruling A): overwriting
   * `currentConfig` there would mean a later respawn reconnects to the NEW
   * server while the process still carries the OLD server's credential in its
   * environment. Callers must `await stop()` first — the shared start/stop
   * service does exactly that.
   */
  start(config: SupervisorConfig): void {
    if (this.child) {
      throw new Error('Agent already running');
    }
    this.currentConfig = config;
    this.isIntentionallyStopped = false;
    this.restartCount = 0;
    this.stderrTail = [];
    this.spawnProcess();
  }

  private spawnProcess(): void {
    if (this.child || !this.currentConfig) return;

    try {
      const env = this.buildEnvironment(this.currentConfig);
      this.child = this.spawnFn(this.binaryPath, [], {
        env: { ...process.env, ...env },
        // stdout is dropped on purpose (BE blocking-2): the agent logs to
        // stdout via tracing's default writer, and nobody reads that pipe — a
        // full buffer (~64KB) would block the agent inside write() forever
        // while the process stays alive and the UI reports "Running".
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      this.captureStderr(this.child);
      this.captureSpawnFailure(this.child);
      this.emitStatus('connected');

      this.child.on('exit', (code) => {
        this.child = null;
        if (this.isIntentionallyStopped) {
          this.emitStatus('stopped');
          return;
        }

        this.emitStatus('error');
        const delay = this.getBackoffDelay(this.restartCount++);
        this.restartTimeout = setTimeout(() => {
          if (!this.isIntentionallyStopped) {
            this.spawnProcess();
          }
        }, delay);
      });
    } catch {
      this.emitStatus('error');
    }
  }

  /**
   * Handle a failed spawn (BE blocking-1).
   *
   * `spawn()` does not throw when the binary is missing — it emits 'error'
   * asynchronously. Without a listener Node treats that as an uncaught
   * exception and the Electron main process dies, so clicking "Start Agent"
   * with a missing sidecar would kill the whole app.
   *
   * A spawn failure is permanent (ENOENT/EACCES), unlike a process that ran and
   * exited: retrying it on the backoff ladder would loop forever, so the
   * supervisor goes idle instead.
   */
  private captureSpawnFailure(child: ChildProcess): void {
    child.on('error', (err: Error) => {
      this.child = null;
      this.isIntentionallyStopped = true;
      this.stderrTail.push(`spawn error: ${err.message}`);
      if (this.stderrTail.length > AgentSupervisor.STDERR_TAIL_LINES) {
        this.stderrTail.shift();
      }
      this.emitStatus('error');
    });
  }

  /**
   * Keep the last few stderr lines (PM ruling C).
   *
   * A corrupt identity file makes the agent exit immediately — fail-closed by
   * design, since regenerating would break the WS2 trust binding. Without this
   * tail the UI could only say "error"; with it, the real cause is surfaced.
   */
  private captureStderr(child: ChildProcess): void {
    const stderr = (child as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (!stderr?.on) return;

    let buffered = '';
    stderr.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      // Keep the trailing partial line buffered until its newline arrives.
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > AgentSupervisor.STDERR_TAIL_LINES) {
          this.stderrTail.shift();
        }
      }
    });
  }

  /** The most recent stderr output from the child, or null (PM ruling C). */
  getLastError(): string | null {
    return this.stderrTail.length > 0 ? this.stderrTail.join('\n') : null;
  }

  /** The server the running (or last started) child points at. */
  getCurrentServerUrl(): string | null {
    return this.currentConfig?.serverUrl ?? null;
  }

  stop(): Promise<void> {
    this.isIntentionallyStopped = true;
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (!this.child) {
      this.emitStatus('stopped');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const child = this.child;
      if (!child) return resolve();

      const killTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(killTimeout);
        this.child = null;
        this.emitStatus('stopped');
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        resolve();
      }
    });
  }

  getStatus(): string {
    if (this.child) return 'connected';
    if (this.isIntentionallyStopped) return 'stopped';
    return 'error';
  }
}
