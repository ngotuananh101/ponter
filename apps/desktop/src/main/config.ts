import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AppConfig, SaveConfigPayload } from '../shared/ipc-types';

export interface ConfigOptions {
  runtimeEnvUrl?: string;
  buildDefaultUrl?: string;
}

export function getCanonicalConfigPath(): string {
  const userData = app?.getPath ? app.getPath('userData') : '';
  const home =
    process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const baseDir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'com.ponter.desktop')
      : path.join(home, 'com.ponter.desktop');
  return path.join(baseDir, 'config.json');
}

export class ConfigManager {
  private filePath: string;
  private runtimeEnvUrl: string;
  private buildDefaultUrl: string;

  constructor(filePath?: string, options?: ConfigOptions) {
    this.filePath = filePath || getCanonicalConfigPath();
    this.runtimeEnvUrl =
      options?.runtimeEnvUrl ?? process.env.PONTER_SERVER_URL ?? '';
    this.buildDefaultUrl =
      options?.buildDefaultUrl ?? process.env.PONTER_DEFAULT_SERVER_URL ?? '';
  }

  private cleanUrl(url?: string | null): string {
    if (!url) return '';
    const trimmed = url.trim();
    return trimmed.replace(/\/+$/, '');
  }

  load(): AppConfig {
    let persisted: Partial<AppConfig> = {};
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        persisted = JSON.parse(raw);
      } catch {
        persisted = {};
      }
    }

    const envUrl = this.cleanUrl(this.runtimeEnvUrl);
    const persistedUrl = this.cleanUrl(persisted.serverUrl);
    const buildUrl = this.cleanUrl(this.buildDefaultUrl);

    let effectiveUrl = 'http://localhost:8787';
    let hasServerUrl = false;

    if (envUrl) {
      effectiveUrl = envUrl;
      hasServerUrl = true;
    } else if (persistedUrl) {
      effectiveUrl = persistedUrl;
      hasServerUrl = true;
    } else if (buildUrl) {
      effectiveUrl = buildUrl;
      hasServerUrl = true;
    }

    return {
      serverUrl: effectiveUrl,
      allowInput: persisted.allowInput === true,
      theme:
        persisted.theme === 'dark' || persisted.theme === 'light'
          ? persisted.theme
          : null,
      hasServerUrl,
    };
  }

  save(payload: SaveConfigPayload): void {
    const current = this.load();
    const updated = {
      serverUrl:
        payload.serverUrl !== undefined
          ? payload.serverUrl
            ? this.cleanUrl(payload.serverUrl)
            : null
          : current.serverUrl,
      allowInput:
        payload.allowInput !== undefined
          ? payload.allowInput
          : current.allowInput,
      theme: payload.theme !== undefined ? payload.theme : current.theme,
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }
}
