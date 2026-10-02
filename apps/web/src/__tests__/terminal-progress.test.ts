import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';

/** A promise whose resolution the test drives, to observe intermediate steps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sessionCreate = vi.fn();
const getIceServers = vi.fn();

vi.mock('../services/client', () => ({
  apiClient: {
    http: { baseUrl: 'http://localhost:8787', refreshAccessToken: vi.fn() },
    sessions: {
      create: (...args: unknown[]) => sessionCreate(...args),
      terminate: vi.fn(async () => ({ success: true })),
    },
    webrtc: { getIceServers: (...args: unknown[]) => getIceServers(...args) },
  },
}));

vi.mock('../services/token-storage', () => ({
  tokenStorage: { getAccessToken: vi.fn(async () => 'access-123') },
}));

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: class {
    start = vi.fn(async () => {});
    waitForChannel = vi.fn(async () => ({}));
    close = vi.fn(async () => {});
    onConnectionStateChange = vi.fn(() => () => {});
    dataChannels = {
      onMessage: vi.fn(() => () => {}),
      sendJson: vi.fn(),
    };
  },
  createBrowserAdapter: vi.fn(() => ({})),
  RESTPollingTransport: class {
    onServerError = vi.fn();
  },
  WebSocketSignalTransport: class {
    onServerError = vi.fn();
  },
}));

describe('terminal store connection progress', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('shows the tab immediately, before the handshake resolves', () => {
    const create = deferred<{ id: string }>();
    sessionCreate.mockReturnValue(create.promise);

    const store = useTerminalStore();
    // Deliberately not awaited: the tab must exist as soon as openTab is called
    // so the user sees a reaction to the click without waiting for ICE.
    void store.openTab('ag-1', 'Host 1');

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.status).toBe('connecting');
    expect(store.tabs[0]?.initStep).toBe('session');
    expect(store.activeTabId).toBe(store.tabs[0]?.id);
  });

  it('advances the step as each handshake stage starts', async () => {
    const create = deferred<{ id: string }>();
    const ice = deferred<unknown[]>();
    sessionCreate.mockReturnValue(create.promise);
    getIceServers.mockReturnValue(ice.promise);

    const store = useTerminalStore();
    const opening = store.openTab('ag-1', 'Host 1');

    expect(store.tabs[0]?.initStep).toBe('session');

    // Session created -> the store moves on to preparing the connection.
    create.resolve({ id: 'session-1' });
    await flushPromises();
    expect(store.tabs[0]?.initStep).toBe('ice');

    // ICE resolved -> the handshake moves to channel negotiation, which the
    // mocked peer completes instantly, landing on the shell step.
    ice.resolve([]);
    await opening;
    expect(store.tabs[0]?.initStep).toBe('shell');
    expect(store.tabs[0]?.session).toBeDefined();
  });

  it('attaches the session and clears the step once the tab goes active', async () => {
    sessionCreate.mockResolvedValue({ id: 'session-1' });
    getIceServers.mockResolvedValue([]);

    const store = useTerminalStore();
    await store.openTab('ag-1', 'Host 1');

    const tab = store.tabs[0]!;
    expect(tab.session).toBeDefined();
    expect(tab.terminalId).toBe(tab.session!.id);

    // First shell output flips the session active; the step list must go away.
    tab.session!.receiveOutput(new Uint8Array([1, 2, 3]));
    expect(tab.status).toBe('active');
    expect(tab.initStep).toBeUndefined();
  });

  it('releases the connection when the tab is closed mid-handshake', async () => {
    const create = deferred<{ id: string }>();
    sessionCreate.mockReturnValue(create.promise);

    const store = useTerminalStore();
    const opening = store.openTab('ag-1', 'Host 1');

    // Close before the handshake finishes: `closeTab` has no connection to
    // release yet, so the open flow must clean up once it lands.
    store.closeTab(store.tabs[0]!.id);
    expect(store.tabs).toHaveLength(0);

    create.resolve({ id: 'session-1' });
    await opening;

    // The orphaned session is terminated server-side rather than left holding
    // the agent's single ADR-14 slot.
    const { apiClient } = await import('../services/client');
    expect(apiClient.sessions.terminate).toHaveBeenCalledWith('session-1');
    // And no phantom tab was resurrected.
    expect(store.tabs).toHaveLength(0);
  });

  it('marks the pre-pushed tab as errored when the handshake fails', async () => {
    sessionCreate.mockRejectedValue(new Error('sessions API down'));

    const store = useTerminalStore();
    await store.openTab('ag-1', 'Host 1');

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.status).toBe('error');
    expect(store.tabs[0]?.error).toContain('sessions API down');
    expect(store.tabs[0]?.initStep).toBeUndefined();
  });
});
