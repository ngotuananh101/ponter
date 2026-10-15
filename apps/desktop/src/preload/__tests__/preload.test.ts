import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exposePonterApi } from '../index';

describe('Preload contextBridge API', () => {
  const ipcRendererMock = {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };

  const contextBridgeMock = {
    exposeInMainWorld: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes window.ponter with all required contract methods', () => {
    exposePonterApi(contextBridgeMock as any, ipcRendererMock as any);
    expect(contextBridgeMock.exposeInMainWorld).toHaveBeenCalledWith(
      'ponter',
      expect.objectContaining({
        getConfig: expect.any(Function),
        saveConfig: expect.any(Function),
        probeServer: expect.any(Function),
        login: expect.any(Function),
        logout: expect.any(Function),
        probeCapture: expect.any(Function),
        setAutostart: expect.any(Function),
        isAutostartEnabled: expect.any(Function),
        listDevices: expect.any(Function),
        registerDevice: expect.any(Function),
        deleteDevice: expect.any(Function),
        getRuntimeStatus: expect.any(Function),
        onFleetChanged: expect.any(Function),
        onRuntimeStatus: expect.any(Function),
      }),
    );
  });

  it('routes getConfig to ipcRenderer.invoke', async () => {
    ipcRendererMock.invoke.mockResolvedValueOnce({
      serverUrl: 'http://localhost:8787',
    });
    const api = exposePonterApi(
      contextBridgeMock as any,
      ipcRendererMock as any,
    );
    const result = await api.getConfig();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith('desktop:get-config');
    expect(result).toEqual({ serverUrl: 'http://localhost:8787' });
  });

  it('subscribes and unregisters event listeners for onFleetChanged', () => {
    const api = exposePonterApi(
      contextBridgeMock as any,
      ipcRendererMock as any,
    );
    const cb = vi.fn();
    const unsubscribe = api.onFleetChanged(cb);
    expect(ipcRendererMock.on).toHaveBeenCalledWith(
      'desktop:fleet-changed',
      expect.any(Function),
    );
    unsubscribe();
    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      'desktop:fleet-changed',
      expect.any(Function),
    );
  });

  it('imports without error (auto-invocation guard is safe in test env)', async () => {
    // The preload module auto-invokes exposePonterApi under a renderer process
    // guard at import time. In the test environment, this safely no-ops because
    // process.type !== 'renderer' and the try/catch swallows any contextBridge
    // errors. Verify the module loads cleanly.
    await expect(import('../index')).resolves.toBeDefined();
  });
});
