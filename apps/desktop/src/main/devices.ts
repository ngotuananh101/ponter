import type { SessionManager } from './session';
import type { KeychainService } from './keychain';
import type { Agent } from '@ponter/shared';
import type { DesktopDevice } from '../shared/ipc-types';

export interface DeviceRegistrationResult {
  device: DesktopDevice;
  credential?: string;
}

/**
 * Device management service for the desktop app.
 *
 * Wraps authenticated agent/device API calls through SessionManager's
 * retryOnceOn401, and persists device credentials to the keychain
 * (Issue #107: 401 is auth-fatal, 403 is non-fatal).
 */
export class DeviceManager {
  constructor(
    private session: SessionManager,
    private keychain: KeychainService,
  ) {}

  /**
   * List agents (devices) registered for the current user.
   */
  async listDevices(): Promise<DesktopDevice[]> {
    const resp = await this.session.retryOnceOn401(async () => {
      const agents: Agent[] = await this.fetchAgents();
      return this.mapAgentsToDevices(agents);
    });
    return resp;
  }

  private async fetchAgents(): Promise<Agent[]> {
    // Would use the apiClient.agents.list() via session context
    return [];
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
    const result = await this.session.retryOnceOn401(async () => {
      const resp: any = await this.createAgent({
        id: this.generateDeviceId(),
        hostname: payload.hostname,
        platform: this.detectPlatform(),
        osVersion: this.detectOsVersion() ?? undefined,
        agentVersion: this.getAgentVersion(),
        capabilities: payload.capabilities,
      });
      return resp;
    });

    // Persist the device credential to keychain (ADR-13: device_credential_${device.id})
    if (result?.credential) {
      this.keychain.storeSecret(
        `device_credential_${result.device.id}`,
        result.credential,
      );
    }

    // Strip credential from response before returning to renderer
    const { credential: _credential, ...device } = result;
    return device as DesktopDevice;
  }

  private async createAgent(input: {
    id: string;
    hostname?: string;
    platform?: string;
    osVersion?: string;
    agentVersion?: string;
    capabilities?: string[];
  }): Promise<DeviceRegistrationResult & { device: DesktopDevice }> {
    // Would call apiClient.agents.create via session.retryOnceOn401
    return {
      device: {
        id: input.id,
        userId: '',
        hostname: input.hostname ?? '',
        platform: input.platform ?? null,
        osVersion: input.osVersion ?? null,
        agentVersion: input.agentVersion ?? null,
        publicKey: '',
        signingPublicKey: null,
        isOnline: false,
        lastHeartbeat: null,
        capabilities: input.capabilities ?? [],
        createdAt: new Date().toISOString(),
      },
      credential: '',
    };
  }

  private generateDeviceId(): string {
    return `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private detectPlatform(): string {
    return process.platform;
  }

  private detectOsVersion(): string | null {
    return process.getSystemVersion ? process.getSystemVersion() : null;
  }

  private getAgentVersion(): string {
    return '1.0.0';
  }

  /**
   * Delete a device (agent) by ID.
   */
  async deleteDevice(agentId: string): Promise<boolean> {
    try {
      await this.session.retryOnceOn401(async () => {
        await this.deleteAgent(agentId);
        return true;
      });
      return true;
    } catch {
      return false;
    }
  }

  private async deleteAgent(id: string): Promise<void> {
    // Would call apiClient.agents.delete(id) via session.retryOnceOn401
  }

  /**
   * Retrieve a stored device credential from the keychain.
   */
  getDeviceCredential(deviceId: string): string | null {
    return this.keychain.getSecret(`device_credential_${deviceId}`);
  }
}
