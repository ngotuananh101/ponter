import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers: Record<string, (...args: any[]) => any> = {};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers[channel] = handler;
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  net: {
    fetch: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
  },
}));

import { ipcMain, BrowserWindow, net, shell } from 'electron';
import { registerIpcHandlers } from '../ipc';

describe('IPC Handlers (Main Process)', () => {
  let deps: any;
  let statusListener: ((status: string) => void) | null = null;
  let updateStatusListener: ((status: any) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(handlers)) {
      delete handlers[key];
    }
    statusListener = null;
    updateStatusListener = null;

    deps = {
      config: {
        load: vi.fn(() => ({ serverUrl: 'http://localhost:8787' })),
        save: vi.fn(),
      },
      session: {
        login: vi.fn(),
        logout: vi.fn(),
      },
      devices: {
        listDevices: vi.fn(),
        registerDevice: vi.fn(),
        deleteDevice: vi.fn(),
      },
      autostart: {
        setEnabled: vi.fn(),
        isEnabled: vi.fn(() => true),
      },
      fleet: {},
      window: {},
      supervisor: {
        getStatus: vi.fn(() => 'connected'),
        onStatusChange: vi.fn((cb: (status: string) => void) => {
          statusListener = cb;
        }),
      },
      updater: {
        checkForUpdates: vi.fn(async () => ({
          available: true,
          version: '1.0.0',
        })),
        downloadUpdate: vi.fn(async () => true),
        quitAndInstall: vi.fn(),
        getStatus: vi.fn(() => ({ status: 'idle' })),
        onStatusChange: vi.fn((cb: (status: any) => void) => {
          updateStatusListener = cb;
        }),
      },
    };
  });

  it('registers all 21 desktop:* channels including get-runtime-status and updater channels', async () => {
    registerIpcHandlers(deps);

    expect(ipcMain.handle).toHaveBeenCalledWith(
      'desktop:get-runtime-status',
      expect.any(Function),
    );
    expect(handlers['desktop:get-runtime-status']).toBeDefined();
    expect(handlers['desktop:get-runtime-status']()).toBe('connected');
    expect(deps.supervisor.getStatus).toHaveBeenCalled();

    // Check updater channels
    expect(handlers['desktop:check-for-updates']).toBeDefined();
    const checkRes = await handlers['desktop:check-for-updates']();
    expect(checkRes).toEqual({ available: true, version: '1.0.0' });
    expect(deps.updater.checkForUpdates).toHaveBeenCalled();

    expect(handlers['desktop:download-update']).toBeDefined();
    const dlRes = await handlers['desktop:download-update']();
    expect(dlRes).toBe(true);
    expect(deps.updater.downloadUpdate).toHaveBeenCalled();

    expect(handlers['desktop:quit-and-install']).toBeDefined();
    handlers['desktop:quit-and-install']();
    expect(deps.updater.quitAndInstall).toHaveBeenCalled();

    expect(handlers['desktop:get-update-status']).toBeDefined();
    const statusRes = handlers['desktop:get-update-status']();
    expect(statusRes).toEqual({ status: 'idle' });
    expect(deps.updater.getStatus).toHaveBeenCalled();

    // Check the new open-remote-session channel is registered
    expect(handlers['desktop:open-remote-session']).toBeDefined();
  });

  it('connects supervisor onStatusChange to broadcast runtime status to windows', () => {
    const sendMock = vi.fn();
    const mockWindow = { webContents: { send: sendMock } };
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as any]);

    registerIpcHandlers(deps);

    expect(deps.supervisor.onStatusChange).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(statusListener).toBeDefined();

    statusListener!('error');
    expect(sendMock).toHaveBeenCalledWith('desktop:runtime-status', 'error');
  });

  it('connects updater onStatusChange to broadcast update status to windows', () => {
    const sendMock = vi.fn();
    const mockWindow = { webContents: { send: sendMock } };
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as any]);

    registerIpcHandlers(deps);

    expect(deps.updater.onStatusChange).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(updateStatusListener).toBeDefined();

    updateStatusListener!({ status: 'downloaded', version: '1.0.0' });
    expect(sendMock).toHaveBeenCalledWith('desktop:update-status', {
      status: 'downloaded',
      version: '1.0.0',
    });
  });

  it('probes server reachable status via net.fetch (ADR-89 §6.1)', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as any);

    registerIpcHandlers(deps);

    const result = await handlers['desktop:probe-server'](
      {},
      'http://localhost:8787',
    );
    expect(net.fetch).toHaveBeenCalledWith(
      'http://localhost:8787/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result).toEqual({ ok: true, message: 'Server reachable' });
  });

  it('preserves the server path prefix when building the health probe URL', async () => {
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as any);

    registerIpcHandlers(deps);

    await handlers['desktop:probe-server']({}, 'https://example.com/ponter');

    expect(net.fetch).toHaveBeenCalledWith(
      'https://example.com/ponter/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('trims a trailing slash before appending the health path', async () => {
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as any);

    registerIpcHandlers(deps);

    await handlers['desktop:probe-server']({}, 'https://example.com/ponter/');

    expect(net.fetch).toHaveBeenCalledWith(
      'https://example.com/ponter/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('handles server probe failure via net.fetch', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as any);

    registerIpcHandlers(deps);

    const result = await handlers['desktop:probe-server'](
      {},
      'http://localhost:8787',
    );
    expect(result).toEqual({ ok: false, message: 'HTTP 503' });
  });

  it('rejects non-http(s) URLs before fetching (SSRF, tssecurity:S5144)', async () => {
    registerIpcHandlers(deps);

    const result = await handlers['desktop:probe-server'](
      {},
      'file:///etc/passwd',
    );

    expect(result).toEqual({
      ok: false,
      message: 'Only http:// and https:// URLs are allowed',
    });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('rejects unparseable URLs before fetching', async () => {
    registerIpcHandlers(deps);

    const result = await handlers['desktop:probe-server']({}, 'not a url');

    expect(result.ok).toBe(false);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  /**
   * Issue #150: saving a new server URL must take effect immediately. The
   * packaged app built its ApiClient once at boot, so without this hook the
   * persisted URL was ignored until the next launch and login kept hitting the
   * localhost fallback.
   */
  describe('desktop:save-config applies a new server URL at runtime', () => {
    it('applies the effective URL when the payload carries a new serverUrl', async () => {
      const applyServerUrlChange = vi.fn(async () => true);
      deps.applyServerUrlChange = applyServerUrlChange;
      deps.config.load = vi.fn(() => ({
        serverUrl: 'https://ponter.ponta.dev',
        allowInput: false,
        theme: null,
        hasServerUrl: true,
      }));

      registerIpcHandlers(deps);

      await handlers['desktop:save-config'](
        {},
        { serverUrl: 'https://ponter.ponta.dev' },
      );

      expect(deps.config.save).toHaveBeenCalledWith({
        serverUrl: 'https://ponter.ponta.dev',
      });
      // The effective URL (config precedence, ADR-64) is what gets applied —
      // not the raw payload — so a runtime env override still wins.
      expect(applyServerUrlChange).toHaveBeenCalledWith(
        'https://ponter.ponta.dev',
      );
    });

    it('does not touch the runtime when the payload has no serverUrl', async () => {
      const applyServerUrlChange = vi.fn(async () => true);
      deps.applyServerUrlChange = applyServerUrlChange;

      registerIpcHandlers(deps);

      await handlers['desktop:save-config']({}, { theme: 'dark' });

      expect(deps.config.save).toHaveBeenCalledWith({ theme: 'dark' });
      expect(applyServerUrlChange).not.toHaveBeenCalled();
    });

    it('keeps working when no runtime hook is wired', async () => {
      registerIpcHandlers(deps);

      await expect(
        handlers['desktop:save-config']({}, { theme: 'dark' }),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Ticket #154: the desktop app had no way to start its agent. These channels
   * are the only bridge between the UI/tray and the sidecar supervisor.
   */
  describe('agent control channels', () => {
    it('reports the local agent id from the device manager', () => {
      deps.devices.getLocalAgentId = vi.fn(() => 'dev_local1');

      registerIpcHandlers(deps);

      expect(handlers['desktop:get-local-agent-id']()).toBe('dev_local1');
    });

    it('returns null when this machine has no local device', () => {
      deps.devices.getLocalAgentId = vi.fn(() => null);

      registerIpcHandlers(deps);

      expect(handlers['desktop:get-local-agent-id']()).toBeNull();
    });

    it('delegates start to the shared agent control service', async () => {
      const result = { ok: true, message: 'Agent starting' };
      deps.agentControl = { start: vi.fn(async () => result) };

      registerIpcHandlers(deps);

      await expect(handlers['desktop:start-agent']()).resolves.toEqual(result);
      expect(deps.agentControl.start).toHaveBeenCalledTimes(1);
    });

    it('propagates a refusal from the service unchanged', async () => {
      const result = { ok: false, message: 'Register this device first' };
      deps.agentControl = { start: vi.fn(async () => result) };

      registerIpcHandlers(deps);

      await expect(handlers['desktop:start-agent']()).resolves.toEqual(result);
    });

    it('delegates stop to the shared agent control service', async () => {
      deps.agentControl = { stop: vi.fn(async () => {}) };

      registerIpcHandlers(deps);

      await handlers['desktop:stop-agent']();
      expect(deps.agentControl.stop).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Ticket #156: Desktop session restore and rememberMe in desktop:login.
   */
  describe('desktop:restore-session & desktop:login with rememberMe (Ticket #156)', () => {
    it('passes rememberMe to session.login', async () => {
      deps.session.login = vi.fn(async () => ({ id: 'u1', username: 'alice' }));

      registerIpcHandlers(deps);

      await handlers['desktop:login'](
        {},
        {
          username: 'alice',
          password: 'password123',
          rememberMe: false,
        },
      );

      expect(deps.session.login).toHaveBeenCalledWith(
        'alice',
        'password123',
        false,
      );
    });

    it('delegates restore-session to session.restoreSession', async () => {
      const mockUser = { id: 'u1', username: 'alice', role: 'admin' };
      deps.session.restoreSession = vi.fn(async () => mockUser);

      registerIpcHandlers(deps);

      const result = await handlers['desktop:restore-session']();
      expect(result).toEqual(mockUser);
      expect(deps.session.restoreSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('desktop:open-remote-session', () => {
    beforeEach(() => {
      vi.mocked(shell.openExternal).mockClear();
    });

    it.each([
      {
        description: 'default mode desktop',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: 'dev_aaaa0001' },
        expectedUrl:
          'http://localhost:8787/workspace/dev_aaaa0001?mode=desktop',
      },
      {
        description: 'custom mode terminal',
        serverUrl: 'https://example.com',
        payload: { agentId: 'dev_bbbb0002', mode: 'terminal' as const },
        expectedUrl: 'https://example.com/workspace/dev_bbbb0002?mode=terminal',
      },
      {
        description: 'mode files',
        serverUrl: 'https://example.com',
        payload: { agentId: 'dev_cccc0003', mode: 'files' as const },
        expectedUrl: 'https://example.com/workspace/dev_cccc0003?mode=files',
      },
      {
        description: 'subpath in serverUrl',
        serverUrl: 'https://example.com:8443/prefix',
        payload: { agentId: 'dev_dddd0004', mode: 'desktop' as const },
        expectedUrl:
          'https://example.com:8443/prefix/workspace/dev_dddd0004?mode=desktop',
      },
      {
        description: 'invalid mode falling back to desktop',
        serverUrl: 'https://example.com',
        payload: { agentId: 'dev_eeee0005', mode: 'invalid-mode' as any },
        expectedUrl: 'https://example.com/workspace/dev_eeee0005?mode=desktop',
      },
      {
        description: 'spaced device code',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: '749 281 903' },
        expectedUrl: 'http://localhost:8787/workspace/749281903?mode=desktop',
      },
      {
        description: 'hyphenated device code',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: '749-281-903' },
        expectedUrl: 'http://localhost:8787/workspace/749281903?mode=desktop',
      },
      {
        description: 'legacy agent id preserved',
        serverUrl: 'http://localhost:8787',
        payload: { agentId: 'dev_ab12cd34' },
        expectedUrl:
          'http://localhost:8787/workspace/dev_ab12cd34?mode=desktop',
      },
    ])(
      'opens remote session URL for $description',
      async ({ serverUrl, payload, expectedUrl }) => {
        deps.config.load = vi.fn(() => ({ serverUrl }));
        vi.mocked(shell.openExternal).mockResolvedValue(undefined);

        registerIpcHandlers(deps);

        const result = await handlers['desktop:open-remote-session'](
          {},
          payload,
        );

        expect(shell.openExternal).toHaveBeenCalledWith(expectedUrl);
        expect(result).toEqual({ ok: true, url: expectedUrl });
      },
    );

    it.each([
      ['empty string', { agentId: '' }],
      ['only whitespace', { agentId: '   ' }],
      ['null payload', null as any],
      ['missing agentId', { mode: 'desktop' } as any],
    ])('rejects invalid or missing agentId (%s)', async (_name, payload) => {
      registerIpcHandlers(deps);

      const result = await handlers['desktop:open-remote-session']({}, payload);

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        message: 'Invalid or missing agentId',
      });
    });

    it.each([
      ['not configured', null, 'Server URL not configured'],
      ['file: protocol', 'file:///etc/passwd', 'Invalid server URL protocol'],
      [
        'gopher: protocol',
        'gopher://example.com',
        'Invalid server URL protocol',
      ],
      ['unparseable format', 'not-a-url', 'Invalid server URL format'],
    ])('rejects when serverUrl is %s', async (_name, serverUrl, message) => {
      deps.config.load = vi.fn(() => ({ serverUrl }));

      registerIpcHandlers(deps);

      const result = await handlers['desktop:open-remote-session'](
        {},
        { agentId: 'dev_f001aaaa' },
      );

      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        message,
      });
    });

    it('returns an error message when shell.openExternal rejects', async () => {
      deps.config.load = vi.fn(() => ({ serverUrl: 'http://localhost:8787' }));
      vi.mocked(shell.openExternal).mockRejectedValue(
        new Error('No browser found'),
      );

      registerIpcHandlers(deps);

      const result = await handlers['desktop:open-remote-session'](
        {},
        { agentId: 'dev_f001aaaa', mode: 'desktop' },
      );

      expect(shell.openExternal).toHaveBeenCalledWith(
        'http://localhost:8787/workspace/dev_f001aaaa?mode=desktop',
      );
      expect(result).toEqual({
        ok: false,
        message: 'No browser found',
      });
    });
  });
});
