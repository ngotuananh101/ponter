import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DESKTOP_FILE_ID = 'com.ponter.desktop';

/**
 * Manages autostart (login item) configuration for the desktop app.
 *
 * ADR-78: macOS is not supported (native GUI Windows + Linux only).
 *
 * - Windows: uses Electron's `app.setLoginItemSettings`.
 * - Linux: writes a `.desktop` file under `$XDG_CONFIG_HOME/autostart/`.
 */
export class AutostartManager {
  private appPath: string;
  private desktopFilePath: string;

  constructor(appPath?: string) {
    this.appPath = appPath || process.execPath;
    const autostartDir = path.join(
      process.env.XDG_CONFIG_HOME ||
        path.join(process.env.HOME || '', '.config'),
      'autostart',
    );
    this.desktopFilePath = path.join(autostartDir, 'ponter-desktop.desktop');
  }

  /**
   * Enable or disable autostart on login.
   */
  setEnabled(enabled: boolean): void {
    if (enabled) {
      this.enableAutostart();
    } else {
      this.disableAutostart();
    }
  }

  private enableAutostart(): void {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: this.appPath,
      });
    } else {
      // Linux: write .desktop file
      this.writeDesktopFile();
    }
  }

  private disableAutostart(): void {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: false,
      });
    } else {
      // Linux: remove .desktop file
      if (fs.existsSync(this.desktopFilePath)) {
        fs.unlinkSync(this.desktopFilePath);
      }
    }
  }

  private writeDesktopFile(): void {
    const content = [
      '[Desktop Entry]',
      `Type=Application`,
      `Name=${DESKTOP_FILE_ID}`,
      `Exec=${this.appPath}`,
      `Terminal=false`,
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');

    const dir = path.dirname(this.desktopFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.desktopFilePath, content, 'utf-8');
  }

  /**
   * Check whether autostart is currently enabled.
   */
  isEnabled(): boolean {
    if (process.platform === 'win32') {
      const settings = app.getLoginItemSettings({
        path: this.appPath,
      });
      return settings.openAtLogin === true;
    }
    // Linux: check for the .desktop file
    return fs.existsSync(this.desktopFilePath);
  }
}
