import { autoUpdater, type AppUpdater } from 'electron-updater';
import type { UpdateCheckResult, UpdateStatusInfo } from '../shared/ipc-types';

/**
 * Manages auto-updates for the desktop application using electron-updater.
 *
 * ADR-87: Replaces the legacy minisign updater with electron-updater
 * configured against GitHub Releases feeds (latest.yml / latest-linux.yml).
 *
 * Requirements:
 * - autoDownload = false (user or UI controls when download starts)
 * - autoInstallOnAppQuit = true (applies downloaded update when quit)
 * - Offline / dev-environment errors are caught gracefully without crashing
 */
export class UpdaterManager {
  private currentStatus: UpdateStatusInfo = { status: 'idle' };
  private listeners: Array<(status: UpdateStatusInfo) => void> = [];

  constructor(private updater: AppUpdater = autoUpdater) {
    this.configureDefaults();
    this.setupEventListeners();
  }

  private configureDefaults(): void {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = true;
  }

  private setupEventListeners(): void {
    this.updater.on('checking-for-update', () => {
      this.setStatus({ status: 'checking' });
    });

    this.updater.on('update-available', (info) => {
      this.setStatus({
        status: 'available',
        version: info?.version,
      });
    });

    this.updater.on('update-not-available', (info) => {
      this.setStatus({
        status: 'idle',
        version: info?.version,
      });
    });

    this.updater.on('download-progress', (progressObj) => {
      this.setStatus({
        status: 'downloading',
        version: this.currentStatus.version,
        progress: Math.round(progressObj?.percent ?? 0),
      });
    });

    this.updater.on('update-downloaded', (info) => {
      this.setStatus({
        status: 'downloaded',
        version: info?.version,
        progress: 100,
      });
    });

    this.updater.on('error', (err) => {
      const message = err?.message || String(err);
      this.setStatus({
        status: 'error',
        error: message,
      });
    });
  }

  private setStatus(next: UpdateStatusInfo): void {
    this.currentStatus = next;
    for (const listener of this.listeners) {
      try {
        listener(this.getStatus());
      } catch {
        // Suppress listener error
      }
    }
  }

  /**
   * Check for available updates. Catches network and dev errors gracefully.
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    try {
      this.setStatus({ status: 'checking' });
      const result = await this.updater.checkForUpdates();
      const version = result?.updateInfo?.version;

      if (this.currentStatus.status === 'available') {
        return {
          available: true,
          version: this.currentStatus.version ?? version,
        };
      }

      return {
        available: false,
        version: this.currentStatus.version ?? version,
      };
    } catch (err: any) {
      const errorMsg = err?.message || 'Failed to check for updates';
      this.setStatus({
        status: 'error',
        error: errorMsg,
      });
      return {
        available: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Download the available update.
   */
  async downloadUpdate(): Promise<boolean> {
    try {
      this.setStatus({
        status: 'downloading',
        version: this.currentStatus.version,
      });
      await this.updater.downloadUpdate();
      return true;
    } catch (err: any) {
      const errorMsg = err?.message || 'Failed to download update';
      this.setStatus({
        status: 'error',
        error: errorMsg,
      });
      return false;
    }
  }

  /**
   * Apply downloaded update and restart the application.
   */
  quitAndInstall(): void {
    this.updater.quitAndInstall();
  }

  /**
   * Get current updater state.
   */
  getStatus(): UpdateStatusInfo {
    return { ...this.currentStatus };
  }

  /**
   * Subscribe to updater status changes.
   */
  onStatusChange(callback: (status: UpdateStatusInfo) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }
}
