import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Create a mock autoUpdater instance using EventEmitter
class MockAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  logger: unknown = console;
  checkForUpdates = vi.fn();
  downloadUpdate = vi.fn();
  quitAndInstall = vi.fn();
}

let mockUpdater: MockAutoUpdater;

vi.mock('electron-updater', () => {
  return {
    autoUpdater: new Proxy(
      {},
      {
        get: (_target, prop) => {
          return (mockUpdater as any)[prop];
        },
        set: (_target, prop, value) => {
          (mockUpdater as any)[prop] = value;
          return true;
        },
      },
    ),
  };
});

import { UpdaterManager } from '../updater';

describe('UpdaterManager', () => {
  let manager: UpdaterManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdater = new MockAutoUpdater();
    manager = new UpdaterManager(mockUpdater as any);
  });

  it('configures autoUpdater defaults on initialization', () => {
    expect(mockUpdater.autoDownload).toBe(false);
    expect(mockUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mockUpdater.logger).toBeNull();
    expect(manager.getStatus()).toEqual({ status: 'idle' });
  });

  describe('checkForUpdates', () => {
    it('sets status to checking and returns available=true when update is found', async () => {
      mockUpdater.checkForUpdates.mockImplementation(async () => {
        mockUpdater.emit('checking-for-update');
        mockUpdater.emit('update-available', { version: '0.2.0' });
        return {
          updateInfo: { version: '0.2.0' },
        };
      });

      const result = await manager.checkForUpdates();

      expect(mockUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ available: true, version: '0.2.0' });
      expect(manager.getStatus()).toEqual({
        status: 'available',
        version: '0.2.0',
      });
    });

    it('sets status to idle and returns available=false when no update is found', async () => {
      mockUpdater.checkForUpdates.mockImplementation(async () => {
        mockUpdater.emit('checking-for-update');
        mockUpdater.emit('update-not-available', { version: '0.1.0' });
        return {
          updateInfo: { version: '0.1.0' },
        };
      });

      const result = await manager.checkForUpdates();

      expect(result).toEqual({ available: false, version: '0.1.0' });
      expect(manager.getStatus()).toEqual({ status: 'idle', version: '0.1.0' });
    });

    it('catches offline / network errors gracefully and sets error status without throwing', async () => {
      mockUpdater.checkForUpdates.mockRejectedValue(
        new Error('net::ERR_INTERNET_DISCONNECTED'),
      );

      const result = await manager.checkForUpdates();

      expect(result).toEqual({
        available: false,
        error: 'net::ERR_INTERNET_DISCONNECTED',
      });
      expect(manager.getStatus()).toEqual({
        status: 'error',
        error: 'net::ERR_INTERNET_DISCONNECTED',
      });
    });

    it('handles autoUpdater error event', () => {
      mockUpdater.emit('error', new Error('Update feed unreachable'));

      expect(manager.getStatus()).toEqual({
        status: 'error',
        error: 'Update feed unreachable',
      });
    });
  });

  describe('downloadUpdate', () => {
    it('initiates update download and tracks progress to downloaded state', async () => {
      mockUpdater.downloadUpdate.mockResolvedValue(['installer.exe']);

      const downloadPromise = manager.downloadUpdate();

      expect(manager.getStatus().status).toBe('downloading');

      mockUpdater.emit('download-progress', { percent: 45.6 });
      expect(manager.getStatus()).toEqual({
        status: 'downloading',
        progress: 46,
      });

      mockUpdater.emit('update-downloaded', { version: '0.2.0' });
      expect(manager.getStatus()).toEqual({
        status: 'downloaded',
        version: '0.2.0',
        progress: 100,
      });

      const ok = await downloadPromise;
      expect(ok).toBe(true);
      expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('catches download errors gracefully and sets error status', async () => {
      mockUpdater.downloadUpdate.mockRejectedValue(
        new Error('Checksum mismatch'),
      );

      const ok = await manager.downloadUpdate();

      expect(ok).toBe(false);
      expect(manager.getStatus()).toEqual({
        status: 'error',
        error: 'Checksum mismatch',
      });
    });
  });

  describe('quitAndInstall', () => {
    it('delegates to autoUpdater.quitAndInstall', () => {
      manager.quitAndInstall();
      expect(mockUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  describe('onStatusChange', () => {
    it('notifies subscribers on status changes and allows unsubscribing', () => {
      const listener = vi.fn();
      const unsubscribe = manager.onStatusChange(listener);

      mockUpdater.emit('checking-for-update');
      expect(listener).toHaveBeenCalledWith({ status: 'checking' });

      mockUpdater.emit('update-available', { version: '1.0.0' });
      expect(listener).toHaveBeenCalledWith({
        status: 'available',
        version: '1.0.0',
      });

      unsubscribe();

      mockUpdater.emit('update-downloaded', { version: '1.0.0' });
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });
});
