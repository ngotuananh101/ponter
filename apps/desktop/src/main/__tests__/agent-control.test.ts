import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentControlService } from '../agent-control';

/**
 * Ticket #154: the local agent needs a single, serialized control path shared by
 * the IPC handlers and the tray. PM rulings A, C and R4 are pinned here:
 * start/stop never interleave, a dying child is not reported as a success, and
 * a refused start explains exactly which prerequisite is missing.
 */
function buildDeps(overrides: Record<string, unknown> = {}) {
  let status = 'stopped';
  const supervisor = {
    start: vi.fn(() => {
      status = 'connected';
    }),
    stop: vi.fn(async () => {
      status = 'stopped';
    }),
    getStatus: vi.fn(() => status),
    getLastError: vi.fn((): string | null => null),
    setStatus: (next: string) => {
      status = next;
    },
  };
  let config: any = {
    serverUrl: 'https://ponter.ponta.dev',
    allowInput: false,
    theme: null,
    hasServerUrl: true,
    localAgentId: 'dev_local1',
    agentAutoStart: false,
  };
  const configMock = {
    load: vi.fn(() => config),
    save: vi.fn((payload: any) => {
      config = { ...config, ...payload };
    }),
    get current() {
      return config;
    },
  };
  const devices = {
    getLocalAgentId: vi.fn(() => 'dev_local1' as string | null),
    getDeviceCredential: vi.fn(() => 'secret-credential' as string | null),
  };

  const deps = {
    supervisor,
    config: configMock,
    devices,
    identityPath: '/tmp/userData/agent-identity.pkcs8',
    ...overrides,
  };
  return { deps: deps as any, supervisor, configMock, devices };
}

describe('AgentControlService (Ticket #154)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to start before a device is registered', async () => {
    const { deps, supervisor } = buildDeps();
    deps.devices.getLocalAgentId.mockReturnValue(null);
    const service = new AgentControlService(deps);

    const result = await service.start();

    expect(result).toEqual({
      ok: false,
      message: 'Register this device first',
    });
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it('refuses to start when the device credential is gone', async () => {
    const { deps, supervisor } = buildDeps();
    deps.devices.getDeviceCredential.mockReturnValue(null);
    const service = new AgentControlService(deps);

    const result = await service.start();

    expect(result).toEqual({
      ok: false,
      message: 'Device credential is missing; re-register this device',
    });
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it('refuses to start when no server is configured (PM ruling R4)', async () => {
    const { deps, supervisor, configMock } = buildDeps();
    configMock.load.mockReturnValue({
      ...configMock.current,
      hasServerUrl: false,
    });
    const service = new AgentControlService(deps);

    const result = await service.start();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/server/i);
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it('starts with the local id, server URL and an explicit identity path', async () => {
    const { deps, supervisor } = buildDeps();
    const service = new AgentControlService(deps);

    const pending = service.start();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result).toEqual({ ok: true, message: 'Agent starting' });
    expect(supervisor.stop).toHaveBeenCalled();
    expect(supervisor.start).toHaveBeenCalledWith({
      agentId: 'dev_local1',
      serverUrl: 'https://ponter.ponta.dev',
      allowInput: false,
      identityPath: '/tmp/userData/agent-identity.pkcs8',
    });
  });

  it('persists agentAutoStart when a start succeeds (PM ruling R5)', async () => {
    const { deps, configMock } = buildDeps();
    const service = new AgentControlService(deps);

    const pending = service.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(configMock.save).toHaveBeenCalledWith({ agentAutoStart: true });
  });

  it('clears agentAutoStart on stop (PM ruling R5)', async () => {
    const { deps, supervisor, configMock } = buildDeps();
    const service = new AgentControlService(deps);

    const result = await service.stop();

    expect(result.ok).toBe(true);
    expect(supervisor.stop).toHaveBeenCalled();
    expect(configMock.save).toHaveBeenCalledWith({ agentAutoStart: false });
  });

  it('is idempotent when the agent is already running', async () => {
    const { deps, supervisor } = buildDeps();
    supervisor.setStatus('connected');
    const service = new AgentControlService(deps);

    const result = await service.start();

    expect(result).toEqual({ ok: true, message: 'Agent already running' });
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  /**
   * Phase 16: the profile must reach the supervisor. The start-payload test
   * above cannot prove this on its own — a missing key and a key set to
   * `undefined` compare equal under `toHaveBeenCalledWith` — so this test
   * configures a non-default profile and asserts the exact value arrives.
   */
  it('forwards the configured desktop profile to the supervisor', async () => {
    const { deps, supervisor, configMock } = buildDeps();
    configMock.current.desktopProfile = '1080p60';
    const service = new AgentControlService(deps);

    const pending = service.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(supervisor.start).toHaveBeenCalledWith(
      expect.objectContaining({ desktopProfile: '1080p60' }),
    );
  });

  /**
   * PM ruling C: the agent exits immediately on a corrupt identity file. A
   * start that returns `ok: true` here would leave the UI claiming success
   * while the process is already dead.
   */
  it('reports the stderr tail when the child dies right after spawn', async () => {
    const { deps, supervisor } = buildDeps();
    supervisor.start.mockImplementation(() => {
      // Spawned, then died before the grace period elapsed.
      supervisor.setStatus('error');
    });
    supervisor.getLastError.mockReturnValue(
      'panic: failed to parse identity file',
    );
    const service = new AgentControlService(deps);

    const pending = service.start();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.message).toContain('failed to parse identity');
    expect(result.message).toMatch(/re-register this device/i);
  });

  it('does not persist agentAutoStart when the start fails', async () => {
    const { deps, supervisor, configMock } = buildDeps();
    supervisor.start.mockImplementation(() => {
      supervisor.setStatus('error');
    });
    const service = new AgentControlService(deps);

    const pending = service.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(configMock.save).not.toHaveBeenCalledWith({ agentAutoStart: true });
  });

  /**
   * PM ruling R4: the tray and the UI can both fire. Operations must be
   * serialized so a start cannot interleave with a stop that is still shutting
   * the old child down (PM ruling A).
   */
  it('serializes concurrent starts into a single spawn', async () => {
    const { deps, supervisor } = buildDeps();
    const service = new AgentControlService(deps);

    const first = service.start();
    const second = service.start();
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([first, second]);

    expect(supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('serializes stop behind an in-flight start', async () => {
    const { deps, supervisor } = buildDeps();
    const service = new AgentControlService(deps);

    const start = service.start();
    const stop = service.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([start, stop]);

    // The stop must land after the start completed, not interleave with it.
    const startOrder = supervisor.start.mock.invocationCallOrder[0]!;
    const lastStopOrder =
      supervisor.stop.mock.invocationCallOrder[
        supervisor.stop.mock.invocationCallOrder.length - 1
      ]!;
    expect(lastStopOrder).toBeGreaterThan(startOrder);
  });
});
