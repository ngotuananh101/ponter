import { Tray, Menu } from 'electron';
import * as path from 'path';

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

  createTray(): Tray {
    const iconName =
      process.platform === 'win32' ? 'ponter-tray.ico' : 'ponter-tray.png';

    this.tray = new Tray(path.join(__dirname, '../../resources', iconName));
    this.tray.setToolTip('Ponter Desktop');
    this.setupContextMenu();
    this.setupClickHandler();
    return this.tray;
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
