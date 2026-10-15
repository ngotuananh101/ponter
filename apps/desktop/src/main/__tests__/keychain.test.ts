import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron module at the top level so vi.mock picks it up before imports
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`encrypted:${s}`)),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString();
      return str.startsWith('encrypted:') ? str.slice(10) : str;
    }),
  },
}));

import { safeStorage } from 'electron';
import * as fs from 'fs';
import { KeychainService } from '../keychain';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

describe('KeychainService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  });

  it('throws when encryption is not available', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    const keychain = new KeychainService('/tmp/test-secrets.enc');
    expect(() => keychain.storeSecret('test', 'secret')).toThrow(
      'KEYCHAIN_UNAVAILABLE',
    );
  });

  it('encrypts and stores secrets to file via atomic write', () => {
    vi.mocked(safeStorage.encryptString).mockReturnValue(
      Buffer.from('encrypted:secret'),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const keychain = new KeychainService('/tmp/test-secrets.enc');
    keychain.storeSecret('refresh_token', 'my-refresh-token');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-secrets.enc.tmp.'),
      expect.stringContaining('refresh_token'),
      'utf-8',
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-secrets.enc.tmp.'),
      '/tmp/test-secrets.enc',
    );
  });

  it('retrieves and decrypts secrets from file', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(safeStorage.decryptString).mockReturnValue('my-refresh-token');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ refresh_token: 'encrypted:my-refresh-token' }),
    );

    const keychain = new KeychainService('/tmp/test-secrets.enc');
    const secret = keychain.getSecret('refresh_token');
    expect(secret).toBe('my-refresh-token');
  });

  it('returns null for unknown keys', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ other_key: 'encrypted:value' }),
    );

    const keychain = new KeychainService('/tmp/test-secrets.enc');
    const secret = keychain.getSecret('nonexistent_key');
    expect(secret).toBeNull();
  });

  it('deletes secrets and rewrites the store', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ key1: 'enc:a', key2: 'enc:b' }),
    );

    const keychain = new KeychainService('/tmp/test-secrets.enc');
    keychain.deleteSecret('key1');

    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-secrets.enc.tmp.'),
      '/tmp/test-secrets.enc',
    );
    const writtenContent = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenContent.key1).toBeUndefined();
    expect(writtenContent.key2).toBe('enc:b');
  });
});
