import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DESKTOP_FILE_ID = 'com.ponter.desktop';

/**
 * Manages autostart (login item) configuration for the desktop app.
 *
 * - Windows / macOS: uses Electron's `app.setLoginItemSettings`.
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
    if (process.platform === 'linux') {
      this.writeDesktopFile();
    } else {
      // Windows and macOS
      app.setLoginItemSettings({
        openAtLogin: true,
        path: this.appPath,
      });
    }
  }

  private disableAutostart(): void {
    if (process.platform === 'linux') {
      if (fs.existsSync(this.desktopFilePath)) {
        fs.unlinkSync(this.desktopFilePath);
      }
    } else {
      app.setLoginItemSettings({
        openAtLogin: false,
      });
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
    if (process.platform === 'linux') {
      return fs.existsSync(this.desktopFilePath);
    }
    const settings = app.getLoginItemSettings({
      path: this.appPath,
    });
    return settings.openAtLogin === true;
  }
}
