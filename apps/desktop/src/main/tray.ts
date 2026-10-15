import { Tray, app, BrowserWindow, Menu } from 'electron';
import * as path from 'path';

export interface TrayOptions {
  onShowWindow: () => void;
  onQuit: () => void;
}

/**
 * Manages the system tray icon and context menu.
 */
export class TrayManager {
  private tray: Tray | null = null;

  constructor(private options: TrayOptions) {}

  createTray(): Tray {
    const iconName =
      process.platform === 'linux'
        ? 'ponter-tray.png'
        : process.platform === 'darwin'
          ? 'ponter-tray.png'
          : 'ponter-tray.ico';

    this.tray = new Tray(path.join(__dirname, '../../resources', iconName));
    this.tray.setToolTip('Ponter Desktop');
    this.setupContextMenu();
    this.setupClickHandler();
    return this.tray;
  }

  private setupContextMenu(): void {
    if (!this.tray) return;

    const { onShowWindow, onQuit } = this.options;

    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: () => {
          onShowWindow();
        },
      },
      {
        label: 'Status',
        click: () => {
          // Shows runtime status
        },
      },
      {
        type: 'separator',
      },
      {
        label: 'Quit',
        click: () => {
          onQuit();
        },
      },
    ]);

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
