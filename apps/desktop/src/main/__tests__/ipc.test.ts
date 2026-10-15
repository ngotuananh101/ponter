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
}));

import { ipcMain, BrowserWindow, net } from 'electron';
import { registerIpcHandlers } from '../ipc';

describe('IPC Handlers (Main Process)', () => {
  let deps: any;
  let statusListener: ((status: string) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(handlers)) {
      delete handlers[key];
    }
    statusListener = null;

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
    };
  });

  it('registers all 12 desktop:* channels including get-runtime-status', () => {
    registerIpcHandlers(deps);

    expect(ipcMain.handle).toHaveBeenCalledWith(
      'desktop:get-runtime-status',
      expect.any(Function),
    );
    expect(handlers['desktop:get-runtime-status']).toBeDefined();
    expect(handlers['desktop:get-runtime-status']()).toBe('connected');
    expect(deps.supervisor.getStatus).toHaveBeenCalled();
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
});
