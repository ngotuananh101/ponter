import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

describe('FleetManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs with apiClient and session', async () => {
    const { FleetManager } = await import('../fleet');
    const sessionMock = { retryOnceOn401: vi.fn() };
    const manager = new FleetManager({} as any, sessionMock as any);
    expect(manager).toBeDefined();
    manager.destroy();
  });

  it('emits fleet-changed event via subscription', async () => {
    const { FleetManager } = await import('../fleet');
    const sessionMock = {
      retryOnceOn401: vi.fn().mockResolvedValue({ agents: [] }),
    };
    const manager = new FleetManager({} as any, sessionMock as any);

    const handler = manager.onFleetChanged(() => {});
    expect(typeof handler).toBe('function');
    manager.destroy();
  });

  it('fetches agents via session.retryOnceOn401', async () => {
    const { FleetManager } = await import('../fleet');
    const agents = [{ id: 'agent-1', hostname: 'test-host' }];
    const sessionMock = {
      retryOnceOn401: vi.fn().mockResolvedValue({ agents }),
    };
    const manager = new FleetManager({} as any, sessionMock as any);

    await manager.refresh();
    expect(sessionMock.retryOnceOn401).toHaveBeenCalled();
    manager.destroy();
  });

  it('destroys cleanly without errors', async () => {
    const { FleetManager } = await import('../fleet');
    const sessionMock = {
      retryOnceOn401: vi.fn().mockResolvedValue({ agents: [] }),
    };
    const manager = new FleetManager({} as any, sessionMock as any);
    expect(() => manager.destroy()).not.toThrow();
  });
});
