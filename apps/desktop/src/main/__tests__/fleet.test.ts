import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { FleetManager } from '../fleet';

/**
 * Mock factory for ApiClient. The real ApiClient exposes:
 *  - `agents.list()` → Agent[]
 *  - `http.storage.getAccessToken()` → string | null
 */
function createApiClientMock() {
  return {
    agents: {
      list: vi.fn(),
    },
    http: {
      storage: {
        getAccessToken: vi.fn(),
      },
      request: vi.fn(),
    },
  };
}

interface SessionMock {
  retryOnceOn401: ReturnType<typeof vi.fn>;
}

describe('FleetManager', () => {
  let apiClientMock: ReturnType<typeof createApiClientMock>;
  let sessionMock: SessionMock;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock = createApiClientMock();
    sessionMock = { retryOnceOn401: vi.fn() };
  });

  it('constructs with apiClient and session', () => {
    const manager = new FleetManager(apiClientMock as any, sessionMock as any);
    expect(manager).toBeDefined();
    manager.destroy();
  });

  it('emits fleet-changed event via subscription', () => {
    const manager = new FleetManager(apiClientMock as any, sessionMock as any);

    const handler = manager.onFleetChanged(() => {});
    expect(typeof handler).toBe('function');
    manager.destroy();
  });

  it('fetches agents via session.retryOnceOn401', async () => {
    const agents = [{ id: 'agent-1', hostname: 'test-host' }];
    sessionMock.retryOnceOn401.mockResolvedValue(agents);

    const manager = new FleetManager(apiClientMock as any, sessionMock as any);
    await manager.refresh();

    expect(sessionMock.retryOnceOn401).toHaveBeenCalled();
    expect(manager.getAgents()).toEqual(agents);
    manager.destroy();
  });

  it('destroys cleanly without errors', () => {
    const manager = new FleetManager(apiClientMock as any, sessionMock as any);
    expect(() => manager.destroy()).not.toThrow();
  });
});
