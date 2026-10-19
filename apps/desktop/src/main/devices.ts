import type { ApiClient } from '@ponter/api-client';
import type { SessionManager } from './session';
import type { KeychainService } from './keychain';
import type { ConfigManager } from './config';
import type { Agent } from '@ponter/shared';
import type { DesktopDevice } from '../shared/ipc-types';

/**
 * Device management service for the desktop app.
 *
 * Wraps authenticated agent API calls through SessionManager's
 * retryOnceOn401, and persists device credentials to the keychain
 * (Issue #107: 401 is auth-fatal, 403 is non-fatal).
 * ADR-13/ADR-52/R8: device credentials stored via safeStorage.
 *
 * Ticket #154: also tracks which registered device belongs to this machine
 * (`localAgentId` in the config) so the UI and tray can start its agent.
 */
export class DeviceManager {
  constructor(
    private apiClient: ApiClient,
    private session: SessionManager,
    private keychain: KeychainService,
    private config: ConfigManager,
  ) {}

  /**
   * List agents (devices) registered for the current user.
   */
  async listDevices(): Promise<DesktopDevice[]> {
    const agents = await this.session.retryOnceOn401(() =>
      this.apiClient.agents.list(),
    );
    const devices = this.mapAgentsToDevices(agents);
    const localId = this.config.load().localAgentId;
    const mine = devices.find((device) => device.id === localId);
    if (mine) {
      this.config.save({ deviceCode: mine.deviceCode });
    }
    return devices;
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
      deviceCode: agent.deviceCode ?? null,
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
   *
   * Ticket #154: also records the new id as this machine's local device. If a
   * previous local id is still configured but its credential is gone, that row
   * is an orphan — `agents.id` is caller-supplied, so reusing or ignoring it
   * leaves a row consuming the per-user agent quota (PM ruling R2). It is
   * removed best-effort first; a cleanup failure must not block registering.
   */
  async registerDevice(payload: {
    hostname?: string;
    capabilities?: string[];
  }): Promise<DesktopDevice> {
    await this.purgeStaleLocalAgent();

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

    // Ticket #154: remember which device belongs to this machine so the UI and
    // tray can start its agent after a restart. Cache the device code too so
    // "This Device" reads offline (spec §3.3, §5.4).
    this.config.save({
      localAgentId: result.agent.id,
      deviceCode: result.agent.deviceCode ?? null,
    });

    // Strip credential from response before returning to renderer (credential stored in keychain only)
    return this.mapAgentToDesktopDevice(result.agent);
  }

  /**
   * Remove a previously configured local device whose credential no longer
   * exists (PM ruling R2/D).
   *
   * Best-effort by design — registration must not be blocked — but the outcome
   * is NOT swallowed: `purgeOrphanAgent()` never throws, it reports what
   * happened, so a real failure is logged here instead of disappearing behind a
   * dead `catch`.
   */
  private async purgeStaleLocalAgent(): Promise<void> {
    const previous = this.config.load().localAgentId;
    if (!previous) return;
    if (this.keychain.getSecret(`device_credential_${previous}`)) return;

    const result = await this.purgeOrphanAgent(previous);
    if (result.outcome === 'failed') {
      // The stale row still occupies the per-user quota; a later register may
      // hit AGENT_LIMIT_REACHED. Surface it rather than hiding it.
      // S8689: Do not log the agentId or credentials to prevent secret disclosure
      console.warn('Failed to remove stale local agent:', result.message);
    }
  }

  /**
   * Delete an orphaned agent row, distinguishing outcomes (PM ruling D).
   *
   * `deleteDevice()` cannot serve here: it swallows every error and returns
   * false, so a row already removed elsewhere (404) is indistinguishable from a
   * real failure. This method reports which happened, letting the caller treat
   * 404 as clean and surface anything else.
   */
  async purgeOrphanAgent(
    agentId: string,
  ): Promise<
    | { outcome: 'deleted' }
    | { outcome: 'absent' }
    | { outcome: 'failed'; message: string }
  > {
    try {
      await this.session.retryOnceOn401(() =>
        this.apiClient.agents.delete(agentId),
      );
      return { outcome: 'deleted' };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        return { outcome: 'absent' };
      }
      const message =
        err instanceof Error ? err.message : 'Failed to remove stale agent';
      return { outcome: 'failed', message };
    }
  }

  /**
   * The device registered by this machine, or null (Ticket #154).
   *
   * The keychain is the source of truth: a configured id whose credential is
   * gone (keychain wiped, reinstall) cannot start an agent, so it is cleared
   * here and reported as absent rather than silently reused.
   */
  getLocalAgentId(): string | null {
    const id = this.config.load().localAgentId;
    if (!id) return null;
    if (!this.keychain.getSecret(`device_credential_${id}`)) {
      // Credential is gone: the cached device code is stale too.
      this.config.save({ localAgentId: null, deviceCode: null });
      return null;
    }
    return id;
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
      deviceCode: agent.deviceCode ?? null,
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
      // Ticket #154: deleting this machine's device means it no longer has a
      // local agent to start. The cached device code is stale too.
      if (this.config.load().localAgentId === agentId) {
        this.config.save({ localAgentId: null, deviceCode: null });
      }
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
