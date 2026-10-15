import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getCanonicalConfigPath } from './config';

export class KeychainService {
  private storeFile: string;

  constructor(storeFile?: string) {
    if (storeFile) {
      this.storeFile = storeFile;
    } else {
      const configPath = getCanonicalConfigPath();
      this.storeFile = path.join(path.dirname(configPath), 'secrets.enc');
    }
  }

  private readStore(): Record<string, string> {
    if (!fs.existsSync(this.storeFile)) return {};
    try {
      const raw = fs.readFileSync(this.storeFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeStore(store: Record<string, string>): void {
    const dir = path.dirname(this.storeFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify(store, null, 2), 'utf-8');
  }

  storeSecret(key: string, secret: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('KEYCHAIN_UNAVAILABLE: OS encryption service not ready');
    }
    const encrypted = safeStorage.encryptString(secret).toString('base64');
    const store = this.readStore();
    store[key] = encrypted;
    this.writeStore(store);
  }

  getSecret(key: string): string | null {
    const store = this.readStore();
    const encryptedBase64 = store[key];
    if (!encryptedBase64) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('KEYCHAIN_UNAVAILABLE: OS encryption service not ready');
    }
    try {
      const buffer = Buffer.from(encryptedBase64, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
  }

  deleteSecret(key: string): void {
    const store = this.readStore();
    if (store[key]) {
      delete store[key];
      this.writeStore(store);
    }
  }
}
