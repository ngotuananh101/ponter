import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSupervisor } from '../agent-supervisor';

describe('AgentSupervisor (ADR-86 Sidecar Contract)', () => {
  const spawnMock = vi.fn();
  const keychainMock = {
    getSecret: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assembles exact environment variables per spec contract', () => {
    keychainMock.getSecret.mockReturnValue('ag_secret_credential_123');
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: spawnMock as any,
    });

    const env = supervisor.buildEnvironment({
      agentId: 'dev_laptop_01',
      serverUrl: 'http://localhost:8787',
      allowInput: true,
      filesRoot: '/home/user/ponter-files',
      identityPath: '/home/user/.config/ponter/identity.pkcs8',
    });

    expect(env).toEqual(
      expect.objectContaining({
        AGENT_ID: 'dev_laptop_01',
        AGENT_SERVER: 'ws://localhost:8787/api/ws/agent',
        AGENT_CREDENTIAL: 'ag_secret_credential_123',
        STUN_SERVER: 'stun:stun.l.google.com:19302',
        AGENT_ALLOW_INPUT: 'true',
        AGENT_FILES_ROOT: '/home/user/ponter-files',
        AGENT_IDENTITY_PATH: '/home/user/.config/ponter/identity.pkcs8',
      }),
    );
  });

  it('calculates bounded exponential backoff correctly (1s up to max 30s)', () => {
    const supervisor = new AgentSupervisor(keychainMock as any);
    expect(supervisor.getBackoffDelay(0)).toBe(1000);
    expect(supervisor.getBackoffDelay(1)).toBe(2000);
    expect(supervisor.getBackoffDelay(2)).toBe(4000);
    expect(supervisor.getBackoffDelay(3)).toBe(8000);
    expect(supervisor.getBackoffDelay(4)).toBe(16000);
    expect(supervisor.getBackoffDelay(5)).toBe(30000);
    expect(supervisor.getBackoffDelay(10)).toBe(30000);
  });

  it('unsets AGENT_FILES_ROOT when files gate is closed (ADR-32)', () => {
    keychainMock.getSecret.mockReturnValue('ag_token');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_01',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
    });
    expect(env.AGENT_FILES_ROOT).toBeUndefined();
    expect(env.AGENT_ALLOW_INPUT).toBe('false');
  });

  it('supports construction with (config, keychain) and reports stopped when idle', () => {
    const configMock = { load: vi.fn() };
    const supervisor = new AgentSupervisor(
      configMock as any,
      keychainMock as any,
    );
    expect(supervisor.getStatus()).toBe('stopped');
  });

  it('registers status listeners via onStatusChange and emits on stop', async () => {
    const supervisor = new AgentSupervisor(keychainMock as any);
    const listener = vi.fn();
    supervisor.onStatusChange(listener);

    await supervisor.stop();
    expect(listener).toHaveBeenCalledWith('stopped');
    expect(supervisor.getStatus()).toBe('stopped');
  });

  /**
   * PM ruling A: `start()` used to overwrite `currentConfig` even when a child
   * was already alive, so a respawn after an exit would reconnect to the NEW
   * server while still carrying the OLD server's credential in its env — the
   * same cross-host leak class as B1/B2. A second start while running must be
   * refused, not silently ignored.
   */
  it('refuses a second start while the child is alive and keeps the first config', () => {
    keychainMock.getSecret.mockReturnValue('cred');
    const child = {
      on: vi.fn(),
      kill: vi.fn(),
    };
    const spawnMock = vi.fn(() => child);
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: spawnMock as any,
    });

    supervisor.start({
      agentId: 'dev_1',
      serverUrl: 'https://old.example',
      allowInput: false,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    expect(() =>
      supervisor.start({
        agentId: 'dev_1',
        serverUrl: 'https://new.example',
        allowInput: false,
      }),
    ).toThrow(/already running/i);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The original config must survive: a later respawn has to reconnect to the
    // server the credential in its env actually belongs to.
    expect(supervisor.getCurrentServerUrl()).toBe('https://old.example');
  });

  /**
   * PM ruling C: the agent exits immediately on a corrupt identity file
   * (fail-closed by design — regenerating would break the WS2 trust binding).
   * The supervisor must capture stderr so the UI can show the real cause
   * instead of reporting a successful start.
   */
  it('captures the tail of stderr and exposes it as getLastError', () => {
    keychainMock.getSecret.mockReturnValue('cred');
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const child = {
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        listeners[event] = cb;
      }),
      kill: vi.fn(),
      stderr: {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === 'data') {
            cb(Buffer.from('panic: failed to parse identity file\n'));
          }
        }),
      },
      exitCode: null,
    };
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: vi.fn(() => child) as any,
    });

    supervisor.start({
      agentId: 'dev_1',
      serverUrl: 'https://ponter.example',
      allowInput: false,
    });

    expect(supervisor.getLastError()).toContain('failed to parse identity');
  });

  it('clears the last error on a fresh start', () => {
    keychainMock.getSecret.mockReturnValue('cred');
    const child = { on: vi.fn(), kill: vi.fn(), stderr: { on: vi.fn() } };
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: vi.fn(() => child) as any,
    });

    supervisor.start({
      agentId: 'dev_1',
      serverUrl: 'https://ponter.example',
      allowInput: false,
    });

    expect(supervisor.getLastError()).toBeNull();
  });

  /**
   * BE blocking-1: `spawn()` does not throw synchronously when the binary is
   * missing — it emits an async 'error' event. Without a listener Node treats
   * it as uncaught and kills the Electron main process, so a user clicking
   * "Start Agent" with a missing sidecar would crash the whole app.
   */
  it('survives a spawn error instead of crashing the main process', () => {
    keychainMock.getSecret.mockReturnValue('cred');
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const child = {
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        listeners[event] = cb;
      }),
      kill: vi.fn(),
      stderr: { on: vi.fn() },
      stdout: { resume: vi.fn() },
    };
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: vi.fn(() => child) as any,
    });
    const statuses: string[] = [];
    supervisor.onStatusChange((status) => statuses.push(status));

    supervisor.start({
      agentId: 'dev_1',
      serverUrl: 'https://ponter.example',
      allowInput: false,
    });

    expect(listeners['error']).toBeTypeOf('function');
    expect(() =>
      listeners['error']!(
        Object.assign(new Error('spawn ponter-agent ENOENT'), {
          code: 'ENOENT',
        }),
      ),
    ).not.toThrow();

    expect(statuses).toContain('error');
    expect(supervisor.getLastError()).toContain('ENOENT');
    expect(supervisor.getStatus()).not.toBe('connected');
  });

  it('does not schedule a respawn after a spawn failure', async () => {
    vi.useFakeTimers();
    try {
      keychainMock.getSecret.mockReturnValue('cred');
      const listeners: Record<string, (arg?: unknown) => void> = {};
      const child = {
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = cb;
        }),
        kill: vi.fn(),
        stderr: { on: vi.fn() },
        stdout: { resume: vi.fn() },
      };
      const spawnMock = vi.fn(() => child);
      const supervisor = new AgentSupervisor(keychainMock as any, {
        spawn: spawnMock as any,
      });

      supervisor.start({
        agentId: 'dev_1',
        serverUrl: 'https://ponter.example',
        allowInput: false,
      });
      listeners['error']!(
        Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      );

      // ENOENT is permanent: retrying it in a backoff loop would spin forever.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * BE blocking-2: the agent logs to STDOUT (tracing's default writer), but the
   * supervisor only read stderr. A full pipe (~64KB) blocks the agent inside
   * write() forever, while the UI still reports "Running" because the process
   * is alive. The chosen fix is to not create a stdout pipe at all.
   */
  it('does not create an unread stdout pipe for the agent', () => {
    keychainMock.getSecret.mockReturnValue('cred');
    const child = {
      on: vi.fn(),
      kill: vi.fn(),
      stderr: { on: vi.fn() },
      stdout: { resume: vi.fn() },
    };
    const spawnMock = vi.fn(() => child);
    const supervisor = new AgentSupervisor(keychainMock as any, {
      spawn: spawnMock as any,
    });

    supervisor.start({
      agentId: 'dev_1',
      serverUrl: 'https://ponter.example',
      allowInput: false,
    });

    const call = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { stdio: string[] },
    ];
    const options = call[2];
    expect(options.stdio[1]).toBe('ignore');
    // stderr stays piped: PM ruling C needs the tail.
    expect(options.stdio[2]).toBe('pipe');
  });

  it('emits AGENT_DESKTOP_PROFILE with the configured value', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
      desktopProfile: '1080p60',
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p60');
  });

  it('emits the safe default when no profile is configured', () => {
    keychainMock.getSecret.mockReturnValue('ag_credential');
    const supervisor = new AgentSupervisor(keychainMock as any);
    const env = supervisor.buildEnvironment({
      agentId: 'dev_aaaaaaaa',
      serverUrl: 'http://localhost:8787',
      allowInput: false,
    });
    expect(env.AGENT_DESKTOP_PROFILE).toBe('1080p30');
  });
});
