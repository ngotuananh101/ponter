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
      );
      const device = await manager.registerDevice({
        hostname: 'my-host',
        capabilities: ['control'],
      });

      // Verify agents.create was called with generated device ID format
      expect(apiClientMock.agents.create).toHaveBeenCalledWith({
        id: expect.stringMatching(/^dev_[a-f0-9]{8}$/),
        hostname: 'my-host',
        platform: 'linux',
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
      );
      const cred = manager.getDeviceCredential('agent-1');

      expect(cred).toBeNull();
    });
  });
});
