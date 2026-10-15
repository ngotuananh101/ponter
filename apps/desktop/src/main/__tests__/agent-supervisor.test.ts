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
});
