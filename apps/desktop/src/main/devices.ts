import type { ApiClient } from '@ponter/api-client';
import type { SessionManager } from './session';
import type { KeychainService } from './keychain';
import type { Agent } from '@ponter/shared';
import type { DesktopDevice } from '../shared/ipc-types';

/**
 * Device management service for the desktop app.
 *
 * Wraps authenticated agent API calls through SessionManager's
 * retryOnceOn401, and persists device credentials to the keychain
 * (Issue #107: 401 is auth-fatal, 403 is non-fatal).
 * ADR-13/ADR-52/R8: device credentials stored via safeStorage.
 */
export class DeviceManager {
  constructor(
    private apiClient: ApiClient,
    private session: SessionManager,
    private keychain: KeychainService,
  ) {}

  /**
   * List agents (devices) registered for the current user.
   */
  async listDevices(): Promise<DesktopDevice[]> {
    const agents = await this.session.retryOnceOn401(() =>
      this.apiClient.agents.list(),
    );
    return this.mapAgentsToDevices(agents);
  }

  private mapAgentsToDevices(agents: Agent[]): DesktopDevice[] {
    return agents.map((agent: Agent) => ({
      id: agent.id,
      userId: agent.userId,
      hostname: agent.hostname ?? '',
      platform: agent.platform ?? null,
      osVersion: agent.osVersion ?? null,
      agentVersion: agent.agentVersion ?? null,
      publicKey: agent.publicKey,
      signingPublicKey: agent.signingPublicKey ?? null,
      isOnline: agent.isOnline,
      lastHeartbeat: agent.lastHeartbeat ?? null,
      capabilities: agent.capabilities ?? [],
      createdAt: agent.createdAt,
    }));
  }

  /**
   * Register a new device (agent) and persist its credential to the keychain.
   *
   * Per ADR-13/ADR-52/R8: the device credential is stored via safeStorage
   * and stripped from the response before returning to the renderer.
   */
  async registerDevice(payload: {
    hostname?: string;
    capabilities?: string[];
  }): Promise<DesktopDevice> {
    const deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;

    const result = await this.session.retryOnceOn401(() =>
      this.apiClient.agents.create({
        id: deviceId,
        hostname: payload.hostname,
        platform: this.detectPlatform(),
        capabilities: payload.capabilities,
      }),
    );

    // Persist the device credential to keychain
    // (ADR-13: device_credential_${device.id})
    if (result?.credential) {
      this.keychain.storeSecret(
        `device_credential_${result.agent.id}`,
        result.credential,
      );
    }

    // Strip credential from response before returning to renderer
    const { credential: _credential, ...device } = result.agent;
    return this.mapAgentToDesktopDevice(result.agent);
  }

  private mapAgentToDesktopDevice(agent: Agent): DesktopDevice {
    return {
      id: agent.id,
      userId: agent.userId,
      hostname: agent.hostname ?? '',
      platform: agent.platform ?? null,
      osVersion: agent.osVersion ?? null,
      agentVersion: agent.agentVersion ?? null,
      publicKey: agent.publicKey,
      signingPublicKey: agent.signingPublicKey ?? null,
      isOnline: agent.isOnline,
      lastHeartbeat: agent.lastHeartbeat ?? null,
      capabilities: agent.capabilities ?? [],
      createdAt: agent.createdAt,
    };
  }

  /**
   * Delete a device (agent) by ID.
   * Also removes the stored device credential from the keychain.
   */
  async deleteDevice(agentId: string): Promise<boolean> {
    try {
      await this.session.retryOnceOn401(() =>
        this.apiClient.agents.delete(agentId),
      );
      this.keychain.deleteSecret(`device_credential_${agentId}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve a stored device credential from the keychain.
   */
  getDeviceCredential(deviceId: string): string | null {
    return this.keychain.getSecret(`device_credential_${deviceId}`);
  }

  private detectPlatform(): string {
    return process.platform === 'win32' ? 'windows' : 'linux';
  }
}
