import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { AutostartManager } from '../autostart';

describe('AutostartManager', () => {
  const originalPlatform = process.platform;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let testTempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponter-autostart-test-'));
    process.env.XDG_CONFIG_HOME = testTempDir;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in test temp dir
    }
  });

  describe('Linux platform', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
    });

    it('reports autostart as disabled when desktop file does not exist', () => {
      const manager = new AutostartManager('/usr/bin/ponter-desktop');
      expect(manager.isEnabled()).toBe(false);
    });

    it('enables autostart by creating the autostart directory and .desktop file', () => {
      const customAppPath = '/opt/ponter/ponter-desktop';
      const manager = new AutostartManager(customAppPath);

      manager.setEnabled(true);

      expect(manager.isEnabled()).toBe(true);

      const desktopFile = path.join(testTempDir, 'autostart', 'ponter-desktop.desktop');
      expect(fs.existsSync(desktopFile)).toBe(true);

      const content = fs.readFileSync(desktopFile, 'utf-8');
      expect(content).toContain('[Desktop Entry]');
      expect(content).toContain('Type=Application');
      expect(content).toContain('Name=com.ponter.desktop');
      expect(content).toContain(`Exec=${customAppPath}`);
      expect(content).toContain('X-GNOME-Autostart-enabled=true');
    });

    it('disables autostart by removing the .desktop file', () => {
      const manager = new AutostartManager('/usr/bin/ponter-desktop');

      manager.setEnabled(true);
      expect(manager.isEnabled()).toBe(true);

      manager.setEnabled(false);
      expect(manager.isEnabled()).toBe(false);

      const desktopFile = path.join(testTempDir, 'autostart', 'ponter-desktop.desktop');
      expect(fs.existsSync(desktopFile)).toBe(false);
    });

    it('does not throw when disabling autostart if file already does not exist', () => {
      const manager = new AutostartManager('/usr/bin/ponter-desktop');
      expect(() => manager.setEnabled(false)).not.toThrow();
      expect(manager.isEnabled()).toBe(false);
    });
  });

  describe('Windows platform', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
    });

    it('enables autostart via app.setLoginItemSettings with path', () => {
      const appPath = 'C:\\Program Files\\Ponter\\ponter-desktop.exe';
      const manager = new AutostartManager(appPath);

      manager.setEnabled(true);

      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        path: appPath,
      });
    });

    it('disables autostart via app.setLoginItemSettings', () => {
      const manager = new AutostartManager('C:\\Program Files\\Ponter\\ponter-desktop.exe');

      manager.setEnabled(false);

      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: false,
      });
    });

    it('queries isEnabled via app.getLoginItemSettings', () => {
      const appPath = 'C:\\Program Files\\Ponter\\ponter-desktop.exe';
      const manager = new AutostartManager(appPath);

      vi.mocked(app.getLoginItemSettings).mockReturnValueOnce({
        openAtLogin: true,
      } as any);

      expect(manager.isEnabled()).toBe(true);
      expect(app.getLoginItemSettings).toHaveBeenCalledWith({
        path: appPath,
      });

      vi.mocked(app.getLoginItemSettings).mockReturnValueOnce({
        openAtLogin: false,
      } as any);

      expect(manager.isEnabled()).toBe(false);
    });
  });
});
