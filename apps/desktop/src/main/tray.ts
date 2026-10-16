import { Tray, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface TrayOptions {
  onShowWindow: () => void;
  onQuit: () => void;
}

/**
 * Manages the system tray icon and context menu.
 *
 * ADR-78: macOS is not supported (native GUI Windows + Linux only).
 * Uses standard icon for Windows (.ico) and Linux (.png).
 */
export class TrayManager {
  private tray: Tray | null = null;

  constructor(private options: TrayOptions) {}

  private resolveIconPath(): string {
    const iconName =
      process.platform === 'win32' ? 'ponter-tray.ico' : 'ponter-tray.png';

    if (process.resourcesPath) {
      const prodPath = path.join(process.resourcesPath, iconName);
      if (fs.existsSync(prodPath)) return prodPath;
    }

    const devPath = path.join(__dirname, '../../resources', iconName);
    if (fs.existsSync(devPath)) return devPath;

    return devPath;
  }

  createTray(): Tray | null {
    const iconPath = this.resolveIconPath();
    try {
      this.tray = new Tray(iconPath);
      this.tray.setToolTip('Ponter Desktop');
      this.setupContextMenu();
      this.setupClickHandler();
      return this.tray;
    } catch (err) {
      console.warn('Failed to initialize system tray:', err);
      this.tray = null;
      return null;
    }
  }

  private setupContextMenu(): void {
    if (!this.tray) return;

    const { onShowWindow, onQuit } = this.options;

    const template = [
      {
        label: 'Show Window',
        click: () => {
          onShowWindow();
        },
      },
      {
        label: 'Status',
        click: () => {
          // Shows runtime status in the main window
        },
      },
      {
        type: 'separator' as const,
      },
      {
        label: 'Quit',
        click: () => {
          onQuit();
        },
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
  }

  private setupClickHandler(): void {
    if (!this.tray) return;

    this.tray.on('click', () => {
      this.options.onShowWindow();
    });
  }

  getTray(): Tray | null {
    return this.tray;
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
