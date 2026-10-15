import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigManager } from '../config';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves runtime env URL before persisted or default URL (ADR-64)', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: 'http://runtime.example.com',
      buildDefaultUrl: 'http://build.example.com',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ serverUrl: 'http://persisted.example.com' }),
    );

    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('http://runtime.example.com');
    expect(cfg.hasServerUrl).toBe(true);
  });

  it('falls back to build default and then localhost when unset', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('http://localhost:8787');
    expect(cfg.hasServerUrl).toBe(false);
  });

  it('trims trailing slashes from server URLs', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: 'https://server.example.com///',
    });
    const cfg = manager.load();
    expect(cfg.serverUrl).toBe('https://server.example.com');
  });

  it('handles corrupt JSON gracefully by falling back to defaults', () => {
    const manager = new ConfigManager('/tmp/test-config.json');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json ');

    const cfg = manager.load();
    expect(cfg.allowInput).toBe(false);
    expect(cfg.serverUrl).toBe('http://localhost:8787');
  });
});
