import { BrowserWindow, Menu, app } from 'electron';
import * as path from 'path';

export interface WindowOptions {
  width?: number;
  height?: number;
  url?: string;
}

/**
 * Manages the main BrowserWindow for the desktop app.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private isQuitting: boolean = false;

  setQuitting(quitting: boolean): void {
    this.isQuitting = quitting;
  }

  isQuittingApp(): boolean {
    return this.isQuitting;
  }

  createWindow(options: WindowOptions = {}): BrowserWindow {
    const width = options.width ?? 800;
    const height = options.height ?? 600;

    Menu.setApplicationMenu(null);
    this.mainWindow = new BrowserWindow({
      width,
      height,
      minWidth: 480,
      minHeight: 500,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.mainWindow.removeMenu();

    // ADR-85: Deny unexpected window/popup opens to prevent external navigation
    this.mainWindow.webContents.setWindowOpenHandler(() => ({
      action: 'deny',
    }));

    if (options.url) {
      this.mainWindow.loadURL(options.url);
    } else if (process.env.ELECTRON_RENDERER_URL) {
      this.mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    }

    if (process.env.NODE_ENV !== 'production' || !app.isPackaged) {
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  getWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  restore(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  hide(): void {
    if (this.mainWindow) {
      this.mainWindow.hide();
    }
  }

  close(): void {
    if (this.mainWindow) {
      this.isQuitting = true;
      this.mainWindow.close();
      this.mainWindow = null;
    }
  }
}
