import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { createApiClient } from '@ponter/api-client';
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

  it('setBaseUrl repoints the manager at a new server (Issue #150)', () => {
    const manager = new FleetManager(apiClientMock as any, sessionMock as any, {
      baseUrl: 'http://localhost:8787',
    });
    expect(manager.getBaseUrl()).toBe('http://localhost:8787');

    manager.setBaseUrl('https://ponter.ponta.dev');
    expect(manager.getBaseUrl()).toBe('https://ponter.ponta.dev');

    manager.destroy();
  });

  it('setBaseUrl is a no-op once destroyed', () => {
    const manager = new FleetManager(apiClientMock as any, sessionMock as any, {
      baseUrl: 'http://localhost:8787',
    });
    manager.destroy();

    manager.setBaseUrl('https://ponter.ponta.dev');
    expect(manager.getBaseUrl()).toBe('http://localhost:8787');
  });
});

/**
 * BE finding N1 on PR #151: a fleet ticket minted by the OLD server was still
 * used to open a WebSocket against the NEW host. A ticket is only valid on the
 * server that issued it, so the generation guard has to cover the gap between
 * awaiting the ticket and constructing the socket.
 */
describe('FleetManager ticket generation guard (Issue #150 N1)', () => {
  const OriginalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it('discards a ticket that was minted before the server changed', async () => {
    const apiClient = createApiClient({
      baseUrl: 'https://old.example',
      storage: {
        getAccessToken: vi.fn(async () => null),
        getRefreshToken: vi.fn(async () => null),
        setTokens: vi.fn(async () => {}),
        clearTokens: vi.fn(async () => {}),
      },
      fetch: vi.fn() as unknown as typeof fetch,
    });

    let releaseTicket!: (ticket: string) => void;
    const sessionMock = {
      retryOnceOn401: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            // Keep the FIRST resolver: `setBaseUrl()` starts a second attempt,
            // and the stale one is the one whose ticket must be discarded.
            releaseTicket ??= resolve;
          }),
      ),
    };

    const socketUrls: string[] = [];
    globalThis.WebSocket = vi.fn(function (url: string) {
      socketUrls.push(url);
      return { onmessage: null, onerror: null, onclose: null, close: vi.fn() };
    }) as any;

    const manager = new FleetManager(apiClient as any, sessionMock as any, {
      baseUrl: 'https://old.example',
    });
    manager.start();

    await vi.waitFor(() => expect(releaseTicket).toBeTypeOf('function'));

    // The user switches servers while the ticket request is still in flight.
    manager.setBaseUrl('https://new.example');
    releaseTicket('OLD-TICKET');
    await vi.waitFor(() =>
      expect(sessionMock.retryOnceOn401).toHaveBeenCalled(),
    );

    // Give the resumed continuation a turn to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(socketUrls.filter((url) => url.includes('OLD-TICKET'))).toEqual([]);
    expect(socketUrls.filter((url) => url.includes('new.example'))).toEqual([]);

    manager.destroy();
  });
});
