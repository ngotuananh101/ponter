import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceManager } from '../devices';
import { ApiError } from '@ponter/api-client';

/**
 * Mock factory for ApiClient.
 * The real ApiClient exposes:
 *  - `agents.list()` → Agent[]
 *  - `agents.create(payload)` → { agent: Agent, credential: string }
 *  - `agents.delete(agentId)` → void
 */
function createApiClientMock() {
  return {
    agents: {
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
}

const keychainMock = {
  getSecret: vi.fn(),
  storeSecret: vi.fn(),
  deleteSecret: vi.fn(),
};

const sessionMock = {
  retryOnceOn401: vi.fn(),
};

/** Config mock — Ticket #154 persists the local device identity here. */
function createConfigMock(localAgentId: string | null = null) {
  let current: any = {
    serverUrl: 'https://ponter.ponta.dev',
    allowInput: false,
    theme: null,
    hasServerUrl: true,
    localAgentId,
    agentAutoStart: false,
  };
  return {
    load: vi.fn(() => current),
    save: vi.fn((payload: any) => {
      current = { ...current, ...payload };
    }),
  };
}

describe('DeviceManager', () => {
  let apiClientMock: ReturnType<typeof createApiClientMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock = createApiClientMock();
  });

  describe('listDevices', () => {
    it('fetches agents via session.retryOnceOn401 and maps to DesktopDevice', async () => {
      const agents = [
        {
          id: 'agent-1',
          userId: 'user-1',
          hostname: 'host-1',
          platform: 'linux',
          osVersion: '5.15.0',
          agentVersion: '1.0.0',
          publicKey: 'pubkey-1',
          signingPublicKey: 'signing-1',
          isOnline: true,
          lastHeartbeat: '2026-01-01T00:00:00Z',
          capabilities: ['capture'],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      sessionMock.retryOnceOn401.mockResolvedValue(agents);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const result = await manager.listDevices();

      expect(sessionMock.retryOnceOn401).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'agent-1',
        userId: 'user-1',
        hostname: 'host-1',
        platform: 'linux',
        osVersion: '5.15.0',
        agentVersion: '1.0.0',
        publicKey: 'pubkey-1',
        signingPublicKey: 'signing-1',
        isOnline: true,
        lastHeartbeat: '2026-01-01T00:00:00Z',
        capabilities: ['capture'],
        createdAt: '2026-01-01T00:00:00Z',
      });
    });

    it('handles agents with null optional fields', async () => {
      const agents = [
        {
          id: 'agent-2',
          userId: 'user-2',
          hostname: null,
          platform: null,
          osVersion: null,
          agentVersion: null,
          publicKey: 'pubkey-2',
          signingPublicKey: null,
          isOnline: false,
          lastHeartbeat: null,
          capabilities: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      sessionMock.retryOnceOn401.mockResolvedValue(agents);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const result = await manager.listDevices();

      expect(result).toHaveLength(1);
      expect(result[0].hostname).toBe('');
      expect(result[0].platform).toBeNull();
      expect(result[0].osVersion).toBeNull();
      expect(result[0].capabilities).toEqual([]);
    });
  });

  describe('registerDevice', () => {
    it('generates device ID, stores credential in keychain, and strips credential', async () => {
      const createdAgent = {
        id: 'agent-new',
        userId: 'user-1',
        hostname: 'my-host',
        platform: 'linux',
        osVersion: '5.15.0',
        agentVersion: '1.0.0',
        publicKey: 'pubkey-new',
        signingPublicKey: 'signing-new',
        isOnline: true,
        lastHeartbeat: null,
        capabilities: ['control'],
        createdAt: '2026-01-01T00:00:00Z',
      };
      const apiResult = {
        agent: createdAgent,
        credential: 'secret-credential',
      };
      sessionMock.retryOnceOn401.mockImplementation(async (fn) => fn());
      apiClientMock.agents.create.mockResolvedValue(apiResult);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const device = await manager.registerDevice({
        hostname: 'my-host',
        capabilities: ['control'],
      });

      // Verify agents.create was called with generated device ID format.
      // `platform` is produced by DeviceManager.detectPlatform() from
      // process.platform, so the expectation must track the runtime OS
      // (CI runs both ubuntu-latest and windows-latest).
      expect(apiClientMock.agents.create).toHaveBeenCalledWith({
        id: expect.stringMatching(/^dev_[a-f0-9]{8}$/),
        hostname: 'my-host',
        platform: process.platform === 'win32' ? 'windows' : 'linux',
        capabilities: ['control'],
      });

      // Verify credential was stored in keychain
      expect(keychainMock.storeSecret).toHaveBeenCalledWith(
        'device_credential_agent-new',
        'secret-credential',
      );

      // Verify returned device has the agent id (not the credential)
      expect(device.id).toBe('agent-new');
      expect(device.publicKey).toBe('pubkey-new');
    });

    it('returns DesktopDevice with null optional fields mapped correctly', async () => {
      const createdAgent = {
        id: 'agent-new',
        userId: 'user-1',
        hostname: null,
        platform: null,
        osVersion: null,
        agentVersion: null,
        publicKey: 'pubkey-new',
        signingPublicKey: null,
        isOnline: false,
        lastHeartbeat: null,
        capabilities: [],
        createdAt: '2026-01-01T00:00:00Z',
      };
      sessionMock.retryOnceOn401.mockResolvedValue({
        agent: createdAgent,
        credential: 'cred',
      });

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const device = await manager.registerDevice({});

      expect(device.hostname).toBe('');
      expect(device.platform).toBeNull();
      expect(device.osVersion).toBeNull();
    });
  });

  describe('deleteDevice', () => {
    it('calls agents.delete and removes credential from keychain', async () => {
      sessionMock.retryOnceOn401.mockResolvedValue(undefined);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const result = await manager.deleteDevice('agent-1');

      expect(sessionMock.retryOnceOn401).toHaveBeenCalled();
      expect(keychainMock.deleteSecret).toHaveBeenCalledWith(
        'device_credential_agent-1',
      );
      expect(result).toBe(true);
    });

    it('returns false on error without throwing', async () => {
      sessionMock.retryOnceOn401.mockRejectedValue(new Error('Network error'));

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const result = await manager.deleteDevice('agent-1');

      expect(result).toBe(false);
    });
  });

  describe('getDeviceCredential', () => {
    it('retrieves credential from keychain with correct key', () => {
      keychainMock.getSecret.mockReturnValue('stored-cred');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const cred = manager.getDeviceCredential('agent-1');

      expect(keychainMock.getSecret).toHaveBeenCalledWith(
        'device_credential_agent-1',
      );
      expect(cred).toBe('stored-cred');
    });

    it('returns null when keychain has no credential', () => {
      keychainMock.getSecret.mockReturnValue(null);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );
      const cred = manager.getDeviceCredential('agent-1');

      expect(cred).toBeNull();
    });
  });

  /**
   * Ticket #154: the app has to know which registered device belongs to this
   * machine. The config holds the id, but the keychain is the source of truth —
   * an id whose credential is gone (keychain wiped, reinstall) is stale and must
   * not be reported as a usable local device.
   */
  describe('local agent identity', () => {
    it('persists the registered agent id as the local device', async () => {
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.create.mockResolvedValue({
        agent: {
          id: 'agent-new',
          userId: 'user-1',
          hostname: 'my-host',
          platform: 'linux',
          osVersion: null,
          agentVersion: null,
          publicKey: 'pubkey-new',
          signingPublicKey: null,
          isOnline: false,
          lastHeartbeat: null,
          capabilities: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
        credential: 'secret-credential',
      });
      const configMock = createConfigMock();

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );
      await manager.registerDevice({});

      expect(configMock.save).toHaveBeenCalledWith({
        localAgentId: 'agent-new',
      });
    });

    it('returns the configured id when the credential is still present', () => {
      keychainMock.getSecret.mockReturnValue('secret-credential');
      const configMock = createConfigMock('agent-new');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );

      expect(manager.getLocalAgentId()).toBe('agent-new');
      expect(keychainMock.getSecret).toHaveBeenCalledWith(
        'device_credential_agent-new',
      );
    });

    it('clears the id and returns null when the credential is gone', () => {
      keychainMock.getSecret.mockReturnValue(null);
      const configMock = createConfigMock('agent-new');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );

      expect(manager.getLocalAgentId()).toBeNull();
      expect(configMock.save).toHaveBeenCalledWith({ localAgentId: null });
    });

    it('returns null without a config entry', () => {
      keychainMock.getSecret.mockReturnValue('secret-credential');
      const configMock = createConfigMock(null);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );

      expect(manager.getLocalAgentId()).toBeNull();
      expect(configMock.save).not.toHaveBeenCalled();
    });

    it('forgets the local id when that device is deleted', async () => {
      sessionMock.retryOnceOn401.mockResolvedValue(undefined);
      const configMock = createConfigMock('agent-1');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );
      await manager.deleteDevice('agent-1');

      expect(configMock.save).toHaveBeenCalledWith({ localAgentId: null });
    });

    it('keeps the local id when a different device is deleted', async () => {
      sessionMock.retryOnceOn401.mockResolvedValue(undefined);
      const configMock = createConfigMock('agent-1');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );
      await manager.deleteDevice('agent-2');

      expect(configMock.save).not.toHaveBeenCalledWith({
        localAgentId: null,
      });
    });

    /**
     * PM ruling R2: `agents.id` is a caller-supplied primary key, so reusing a
     * stale id returns 409 AGENT_EXISTS and the orphan row keeps consuming the
     * per-user agent quota. A stale id (no credential) is deleted best-effort
     * before registering a new one.
     */
    it('deletes the orphaned device row before registering a replacement', async () => {
      keychainMock.getSecret.mockReturnValue(null);
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.delete.mockResolvedValue(undefined);
      apiClientMock.agents.create.mockResolvedValue({
        agent: {
          id: 'agent-fresh',
          userId: 'user-1',
          hostname: null,
          platform: 'linux',
          osVersion: null,
          agentVersion: null,
          publicKey: 'pub',
          signingPublicKey: null,
          isOnline: false,
          lastHeartbeat: null,
          capabilities: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
        credential: 'cred',
      });
      const configMock = createConfigMock('agent-orphan');

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );
      await manager.registerDevice({});

      expect(apiClientMock.agents.delete).toHaveBeenCalledWith('agent-orphan');
      expect(configMock.save).toHaveBeenCalledWith({
        localAgentId: 'agent-fresh',
      });
    });

    it('still registers when deleting the orphan fails', async () => {
      keychainMock.getSecret.mockReturnValue(null);
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.delete.mockRejectedValue(
        new ApiError('Forbidden', 403, 'FORBIDDEN'),
      );
      apiClientMock.agents.create.mockResolvedValue({
        agent: {
          id: 'agent-fresh',
          userId: 'user-1',
          hostname: null,
          platform: 'linux',
          osVersion: null,
          agentVersion: null,
          publicKey: 'pub',
          signingPublicKey: null,
          isOnline: false,
          lastHeartbeat: null,
          capabilities: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
        credential: 'cred',
      });
      const configMock = createConfigMock('agent-orphan');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );

      await expect(manager.registerDevice({})).resolves.toMatchObject({
        id: 'agent-fresh',
      });
      expect(apiClientMock.agents.delete).toHaveBeenCalledWith('agent-orphan');
      // Ruling D: the failed cleanup is surfaced, not swallowed.
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to remove stale local agent:',
        'Forbidden',
      );
      warnSpy.mockRestore();
    });

    it('surfaces AGENT_LIMIT_REACHED without treating it as auth-fatal', async () => {
      keychainMock.getSecret.mockReturnValue('cred');
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.create.mockRejectedValue(
        new ApiError('Agent limit reached', 403, 'AGENT_LIMIT_REACHED'),
      );
      const configMock = createConfigMock(null);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        configMock as any,
      );

      await expect(manager.registerDevice({})).rejects.toThrow(
        'Agent limit reached',
      );
      expect(configMock.save).not.toHaveBeenCalled();
    });
  });

  /**
   * PM ruling D: orphan cleanup needs to distinguish "the row is already gone"
   * (404 — safe to continue) from a real failure (403/network/5xx — surface it).
   * `deleteDevice()` cannot be reused: it swallows everything and returns false.
   */
  describe('purgeOrphanAgent', () => {
    it('reports deleted when the server removes the row', async () => {
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.delete.mockResolvedValue(undefined);

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );

      await expect(manager.purgeOrphanAgent('agent-orphan')).resolves.toEqual({
        outcome: 'deleted',
      });
    });

    it('reports absent on 404 so registration can continue', async () => {
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.delete.mockRejectedValue(
        new ApiError('Not found', 404, 'NOT_FOUND'),
      );

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );

      await expect(manager.purgeOrphanAgent('agent-orphan')).resolves.toEqual({
        outcome: 'absent',
      });
    });

    it('reports failed with the server message for any other error', async () => {
      sessionMock.retryOnceOn401.mockImplementation(async (fn: any) => fn());
      apiClientMock.agents.delete.mockRejectedValue(
        new ApiError('Forbidden', 403, 'FORBIDDEN'),
      );

      const manager = new DeviceManager(
        apiClientMock as any,
        sessionMock as any,
        keychainMock as any,
        createConfigMock() as any,
      );

      await expect(manager.purgeOrphanAgent('agent-orphan')).resolves.toEqual({
        outcome: 'failed',
        message: 'Forbidden',
      });
    });
  });
});
