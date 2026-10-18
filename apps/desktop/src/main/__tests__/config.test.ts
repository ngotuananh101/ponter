import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigManager } from '../config';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
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

  /**
   * Issue #150: saving a preference must not invent a server URL. The old code
   * carried `current.serverUrl` (the *effective* value, i.e. the localhost
   * fallback when nothing was configured) into the file, so a theme save on a
   * fresh install persisted the fallback — the next launch then believed a
   * server was configured and skipped Server Setup.
   */
  it('does not persist the localhost fallback when no URL was ever set', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ theme: 'dark' });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written).toEqual({
      serverUrl: null,
      allowInput: false,
      theme: 'dark',
      localAgentId: null,
      agentAutoStart: false,
      rememberMe: true,
      savedUsername: null,
    });
    expect(manager.load().hasServerUrl).toBe(false);
  });

  it('preserves a previously persisted URL when saving a preference', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ serverUrl: 'https://ponter.ponta.dev' }),
    );
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ allowInput: true });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.serverUrl).toBe('https://ponter.ponta.dev');
    expect(written.allowInput).toBe(true);
  });

  /**
   * Ticket #154: the desktop app must remember which registered device belongs
   * to this machine, so the UI/tray can offer to start its agent and the
   * DevicesView can mark it "This device".
   */
  it('persists localAgentId and reports it from load()', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ localAgentId: 'dev_abc12345' });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.localAgentId).toBe('dev_abc12345');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(written));
    expect(manager.load().localAgentId).toBe('dev_abc12345');
  });

  it('clears localAgentId on an explicit null without touching other fields', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        serverUrl: 'https://ponter.ponta.dev',
        allowInput: true,
        theme: 'dark',
        localAgentId: 'dev_abc12345',
      }),
    );
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ localAgentId: null });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.localAgentId).toBeNull();
    expect(written.serverUrl).toBe('https://ponter.ponta.dev');
    expect(written.allowInput).toBe(true);
    expect(written.theme).toBe('dark');
  });

  it('preserves localAgentId when saving an unrelated field', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ localAgentId: 'dev_abc12345' }),
    );
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ theme: 'light' });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.localAgentId).toBe('dev_abc12345');
    expect(written.theme).toBe('light');
  });

  /**
   * Ticket #156: desktop app supports "Remember me".
   * - rememberMe defaults to true if unset.
   * - savedUsername persists the last successfully remembered username.
   */
  it('persists rememberMe and savedUsername and reports them from load()', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ rememberMe: true, savedUsername: 'alice' });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.rememberMe).toBe(true);
    expect(written.savedUsername).toBe('alice');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(written));
    const loaded = manager.load();
    expect(loaded.rememberMe).toBe(true);
    expect(loaded.savedUsername).toBe('alice');
  });

  it('defaults rememberMe to true and savedUsername to null when unset', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const loaded = manager.load();
    expect(loaded.rememberMe).toBe(true);
    expect(loaded.savedUsername).toBeNull();
  });

  it('clears savedUsername when rememberMe is set to false', () => {
    const manager = new ConfigManager('/tmp/test-config.json', {
      runtimeEnvUrl: '',
      buildDefaultUrl: '',
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        rememberMe: true,
        savedUsername: 'alice',
      }),
    );
    vi.mocked(fs.writeFileSync).mockClear();

    manager.save({ rememberMe: false });

    const written = JSON.parse(
      vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string,
    );
    expect(written.rememberMe).toBe(false);
    expect(written.savedUsername).toBeNull();
  });
});
