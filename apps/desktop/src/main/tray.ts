import { Tray, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface TrayOptions {
  onShowWindow: () => void;
  onQuit: () => void;
  /**
   * Agent controls (Ticket #154). All optional: when omitted the menu keeps its
   * original shape, so existing embedders and tests are unaffected.
   */
  getAgentStatus?: () => string;
  onStartAgent?: () => Promise<unknown> | unknown;
  onStopAgent?: () => Promise<unknown> | unknown;
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

  /** True when the embedder supplied agent controls. */
  private hasAgentControls(): boolean {
    return (
      typeof this.options.getAgentStatus === 'function' &&
      (typeof this.options.onStartAgent === 'function' ||
        typeof this.options.onStopAgent === 'function')
    );
  }

  /**
   * Rebuild the context menu, e.g. after the supervisor reports a status
   * change. No-op when the tray has not been created yet.
   */
  updateAgentStatus(_status?: string): void {
    if (!this.tray) return;
    this.setupContextMenu();
  }

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

    const { onShowWindow, onQuit, getAgentStatus, onStartAgent, onStopAgent } =
      this.options;

    const template: Array<{
      label?: string;
      type?: 'separator';
      enabled?: boolean;
      click?: () => void;
    }> = [
      {
        label: 'Show Window',
        click: () => {
          onShowWindow();
        },
      },
    ];

    if (this.hasAgentControls()) {
      // `connected` means the process is alive, not that it authenticated over
      // the WebSocket (see AgentSupervisor.emitStatus).
      const status = getAgentStatus?.() ?? 'unknown';
      template.push({
        label: `Agent: ${status}`,
        enabled: false,
      });

      if (status === 'connected' || status === 'starting') {
        template.push({
          label: 'Stop Agent',
          click: () => {
            this.runAgentAction(onStopAgent);
          },
        });
      } else {
        template.push({
          label: 'Start Agent',
          click: () => {
            this.runAgentAction(onStartAgent);
          },
        });
      }
    } else {
      template.push({
        label: 'Status',
        click: () => {
          // Shows runtime status in the main window
        },
      });
    }

    template.push({ type: 'separator' });
    template.push({
      label: 'Quit',
      click: () => {
        onQuit();
      },
    });

    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
  }

  /**
   * Fire an agent action and surface a refusal.
   *
   * The service returns `{ ok, message }` rather than throwing, so an ignored
   * result would make a failed start invisible from the tray. The window shows
   * the detailed message; the console line is the fallback when it is hidden.
   */
  private runAgentAction(action?: () => Promise<unknown> | unknown): void {
    if (!action) return;
    void Promise.resolve(action())
      .then((result) => {
        const failure = result as { ok?: boolean; message?: string } | null;
        if (failure && failure.ok === false) {
          console.warn(`Agent action failed: ${failure.message ?? 'unknown'}`);
        }
      })
      .catch((err) => {
        console.warn('Agent action failed:', err);
      });
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
