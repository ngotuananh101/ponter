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
    const persisted = this.loadPersisted();

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
      localAgentId:
        typeof persisted.localAgentId === 'string' && persisted.localAgentId
          ? persisted.localAgentId
          : null,
      agentAutoStart: persisted.agentAutoStart === true,
      rememberMe: persisted.rememberMe !== false,
      savedUsername:
        typeof persisted.savedUsername === 'string' && persisted.savedUsername
          ? persisted.savedUsername
          : null,
    };
  }

  /**
   * Read the raw persisted file, without applying ADR-64 precedence.
   *
   * `load()` returns the *effective* URL, which falls back to
   * `http://localhost:8787` when nothing was ever configured. Writing that value
   * back (Issue #150) would make the next launch believe a server had been
   * chosen and skip Server Setup, so `save()` needs the persisted value alone.
   */
  private loadPersisted(): Partial<AppConfig> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  save(payload: SaveConfigPayload): void {
    const persisted = this.loadPersisted();
    const currentUrl = this.cleanUrl(persisted.serverUrl) || null;
    const persistedLocalAgentId =
      typeof persisted.localAgentId === 'string' && persisted.localAgentId
        ? persisted.localAgentId
        : null;
    const updated = {
      serverUrl:
        payload.serverUrl !== undefined
          ? payload.serverUrl
            ? this.cleanUrl(payload.serverUrl)
            : null
          : currentUrl,
      allowInput:
        payload.allowInput !== undefined
          ? payload.allowInput
          : persisted.allowInput === true,
      theme:
        payload.theme !== undefined
          ? payload.theme
          : persisted.theme === 'dark' || persisted.theme === 'light'
            ? persisted.theme
            : null,
      // Ticket #154: `undefined` = unchanged, `null` = forget this machine's
      // device. Kept independent of the other fields so a preference save can
      // never orphan or resurrect the local device identity.
      localAgentId:
        payload.localAgentId !== undefined
          ? payload.localAgentId
          : persistedLocalAgentId,
      agentAutoStart:
        payload.agentAutoStart ?? persisted.agentAutoStart === true,
      rememberMe:
        payload.rememberMe !== undefined && payload.rememberMe !== null
          ? payload.rememberMe
          : persisted.rememberMe !== false,
      savedUsername:
        payload.savedUsername !== undefined
          ? payload.savedUsername
          : payload.rememberMe === false
            ? null
            : typeof persisted.savedUsername === 'string' &&
                persisted.savedUsername
              ? persisted.savedUsername
              : null,
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
