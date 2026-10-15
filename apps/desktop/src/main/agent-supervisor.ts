import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { toWsUrl } from '@ponter/webrtc-core';
import type { KeychainService } from './keychain';
import type { ConfigManager } from './config';

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

  start(config: SupervisorConfig): void {
    this.currentConfig = config;
    this.isIntentionallyStopped = false;
    this.restartCount = 0;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    if (this.child || !this.currentConfig) return;

    try {
      const env = this.buildEnvironment(this.currentConfig);
      this.child = this.spawnFn(this.binaryPath, [], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

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
