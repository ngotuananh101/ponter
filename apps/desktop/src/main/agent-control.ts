import type { AgentSupervisor } from './agent-supervisor';
import type { ConfigManager } from './config';
import type { DeviceManager } from './devices';

export interface AgentControlResult {
  ok: boolean;
  message: string;
}

export interface AgentControlDeps {
  supervisor: Pick<
    AgentSupervisor,
    'start' | 'stop' | 'getStatus' | 'getLastError'
  >;
  config: Pick<ConfigManager, 'load' | 'save'>;
  devices: Pick<DeviceManager, 'getLocalAgentId' | 'getDeviceCredential'>;
  /** Absolute path for the agent's long-lived identity keypair (PM ruling R3). */
  identityPath: string;
}

/** How long to wait after spawn before checking whether the child already died. */
const STARTUP_GRACE_MS = 2000;

/**
 * Shared start/stop logic for the local agent (Ticket #154).
 *
 * Both the IPC handlers and the tray menu call this, so the two entry points
 * cannot drift. It exists because `AgentSupervisor` alone is not safe to drive
 * from UI events:
 *  - start/stop are serialized on one promise chain, so a double-click or a
 *    tray click racing the UI cannot interleave `stop()` with `start()`
 *    (PM ruling R4);
 *  - `stop()` is always awaited before `start()`, so a dying child can never
 *    have its config replaced mid-shutdown (PM ruling A);
 *  - a start is only reported successful once the process survived a short
 *    grace period, and a child that died surfaces its stderr tail instead
 *    (PM ruling C).
 */
export class AgentControlService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AgentControlDeps) {}

  /** Serialize every operation behind the previous one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    // Keep the chain alive even when an operation rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  start(): Promise<AgentControlResult> {
    return this.enqueue(() => this.startNow());
  }

  stop(): Promise<AgentControlResult> {
    return this.enqueue(async () => {
      await this.deps.supervisor.stop();
      this.deps.config.save({ agentAutoStart: false });
      return { ok: true, message: 'Agent stopped' };
    });
  }

  private async startNow(): Promise<AgentControlResult> {
    const cfg = this.deps.config.load();

    const agentId = this.deps.devices.getLocalAgentId();
    if (!agentId) {
      return { ok: false, message: 'Register this device first' };
    }
    if (!this.deps.devices.getDeviceCredential(agentId)) {
      return {
        ok: false,
        message: 'Device credential is missing; re-register this device',
      };
    }
    if (!cfg.hasServerUrl) {
      return { ok: false, message: 'Set a server URL first' };
    }

    if (this.deps.supervisor.getStatus() === 'connected') {
      // Idempotent: already running, and the user's intent (auto-start on
      // future launches) is still worth recording.
      this.deps.config.save({ agentAutoStart: true });
      return { ok: true, message: 'Agent already running' };
    }

    try {
      // Await a full stop before starting: a child still shutting down must
      // not have its config swapped underneath it (PM ruling A).
      await this.deps.supervisor.stop();
      this.deps.supervisor.start({
        agentId,
        serverUrl: cfg.serverUrl ?? '',
        allowInput: cfg.allowInput,
        identityPath: this.deps.identityPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start';
      return { ok: false, message };
    }

    // The child is spawned but not yet known to be healthy: it may exit at once
    // on a corrupt identity file. Give it a moment, then report the truth.
    await new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_MS));
    if (this.deps.supervisor.getStatus() !== 'connected') {
      const detail = this.deps.supervisor.getLastError();
      return {
        ok: false,
        message: detail
          ? this.explainFailure(detail)
          : 'Agent exited immediately after starting',
      };
    }

    this.deps.config.save({ agentAutoStart: true });
    return { ok: true, message: 'Agent starting' };
  }

  /**
   * Turn raw stderr into an actionable message. The identity case is the one
   * with a known remedy, and it is the one users hit after a profile reset.
   */
  private explainFailure(detail: string): string {
    if (/identity/i.test(detail)) {
      return `${detail}\n\nDelete the agent identity file and re-register this device.`;
    }
    return detail;
  }
}
