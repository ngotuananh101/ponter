import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';

// These pin the resource-leak fixes around the early tab push: the session is
// created *before* the connection is registered, so every failure in between
// has to release it explicitly, and the per-agent peer subscriptions have to be
// detached or a dead peer's callback can mark a later tab for the same agent as
// failed.

let mockFailWaitForChannel = false;
let mockFailDesktopStart = false;
/** Unsubscribers handed back by every `onConnectionStateChange` call. */
const mockStateUnsubscribers: Array<ReturnType<typeof vi.fn>> = [];

// The real DesktopClient.start() waits for a video track, which never arrives in
// a unit test — it would hang the desktop paths. Mock the module so `start`
// resolves immediately (or fails on demand) and `close` is observable.
vi.mock('@ponter/desktop-core', () => ({
  DesktopClient: function (this: Record<string, unknown>) {
    this.start = vi.fn(async () => {
      if (mockFailDesktopStart) throw new Error('desktop stream failed');
      return { track: { kind: 'video' }, streams: [] };
    });
    this.close = vi.fn();
  },
}));

vi.mock('@ponter/webrtc-core', () => {
  class PeerConnection {
    static last: PeerConnection | undefined;

    start = vi.fn(async () => {});
    waitForChannel = vi.fn(async () => {
      if (mockFailWaitForChannel) {
        throw new Error('timeout waiting for channel "terminal"');
      }
      return {};
    });
    close = vi.fn(async () => {});

    stateHandlers: Array<(s: string) => void> = [];
    onConnectionStateChange(handler: (s: string) => void) {
      this.stateHandlers.push(handler);
      const unsubscribe = vi.fn(() => {
        const idx = this.stateHandlers.indexOf(handler);
        if (idx >= 0) this.stateHandlers.splice(idx, 1);
      });
      mockStateUnsubscribers.push(unsubscribe);
      return unsubscribe;
    }
    emitState(state: string) {
      for (const handler of [...this.stateHandlers]) handler(state);
    }

    dataChannels = {
      onMessage: vi.fn(() => () => {}),
      sendJson: vi.fn(),
    };

    constructor() {
      PeerConnection.last = this;
    }
  }

  return {
    PeerConnection,
    createBrowserAdapter: vi.fn(() => ({})),
    RESTPollingTransport: class {
      onServerError = vi.fn(() => vi.fn());
    },
    WebSocketSignalTransport: class {
      onServerError = vi.fn(() => vi.fn());
    },
  };
});

vi.mock('@/services/client', () => ({
  apiClient: {
    http: { baseUrl: 'http://localhost:8787', refreshAccessToken: vi.fn() },
    sessions: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      terminate: vi.fn(async () => ({ success: true })),
    },
    webrtc: { getIceServers: vi.fn(async () => []) },
    agents: { get: vi.fn(async () => ({ signingPublicKey: 'agent-key' })) },
  },
}));

vi.mock('@/services/token-storage', () => ({
  tokenStorage: { getAccessToken: vi.fn(async () => 'access-123') },
}));

vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({
    user: { id: 'user-e2ee' },
    identityStatus: 'ready',
    ensureUserSigningKey: async () => {},
  }),
}));

vi.mock('@ponter/crypto', () => ({
  loadPrivateKey: vi.fn(async () => null),
  loadPublicKey: vi.fn(async () => null),
  loadSigningKey: vi.fn(async () => ({}) as unknown as CryptoKey),
  importSigningPublicKeyRaw: vi.fn(async () => ({}) as unknown as CryptoKey),
  signProof: vi.fn(async () => 'sig'),
  verifyProof: vi.fn(async () => true),
}));

async function emitPeerState(state: string): Promise<void> {
  const mod = (await import('@ponter/webrtc-core')) as unknown as {
    PeerConnection: { last?: { emitState: (s: string) => void } };
  };
  mod.PeerConnection.last?.emitState(state);
}

describe('terminal store resource cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockFailWaitForChannel = false;
    mockFailDesktopStart = false;
    mockStateUnsubscribers.length = 0;
  });

  it('terminates the server session when the terminal handshake fails after create', async () => {
    // `sessions.create` succeeded, so the agent's single ADR-14 slot is taken.
    // A failure in `waitForChannel` used to leave that session orphaned: the
    // tab showed an error, but nothing pointed at the session to release it.
    mockFailWaitForChannel = true;
    const store = useTerminalStore();

    await store.openTab('agent-1', 'Host 1');

    const { apiClient } = await import('@/services/client');
    expect(vi.mocked(apiClient.sessions.terminate)).toHaveBeenCalledWith(
      'session-1',
    );
    expect(store.tabs[0]?.status).toBe('error');
  });

  it('terminates the server session when a desktop handshake fails after create', async () => {
    // The desktop flow has no `peer.start()`; the fallible step is
    // `client.start()` waiting for the first video track.
    mockFailDesktopStart = true;
    const store = useTerminalStore();

    await store.openDesktopTab('agent-1', 'Host 1');

    const { apiClient } = await import('@/services/client');
    expect(vi.mocked(apiClient.sessions.terminate)).toHaveBeenCalledWith(
      'session-1',
    );
    expect(store.tabs[0]?.status).toBe('error');
  });

  it('detaches the peer subscription when the terminal tab closes', async () => {
    // A stale `onConnectionStateChange` keeps a closure over the agent id, so
    // it would still iterate `tabs.value` and could flip a *new* tab for the
    // same agent to `error`. Closing must unsubscribe it.
    const store = useTerminalStore();
    const tabId = await store.openTab('agent-1', 'Host 1');
    expect(mockStateUnsubscribers).toHaveLength(1);

    store.closeTab(tabId);

    expect(mockStateUnsubscribers[0]).toHaveBeenCalled();
  });

  it('detaches the peer subscription when the desktop tab closes', async () => {
    const store = useTerminalStore();
    const tabId = await store.openDesktopTab('agent-1', 'Host 1');
    expect(mockStateUnsubscribers).toHaveLength(1);

    store.closeTab(tabId);

    expect(mockStateUnsubscribers[0]).toHaveBeenCalled();
  });

  it('detaches the peer subscription when ICE fails', async () => {
    // The failure callback discards the connection; leaving its own
    // subscription attached would let it fire again for a future tab.
    const store = useTerminalStore();
    await store.openTab('agent-1', 'Host 1');

    await emitPeerState('failed');

    expect(mockStateUnsubscribers[0]).toHaveBeenCalled();
  });

  it('terminates the previous session when a terminal tab is retried', async () => {
    // The retry opens a brand-new session; the old row would otherwise stay
    // `active` server-side and hold the agent's ADR-14 slot.
    const store = useTerminalStore();
    const tabId = await store.openTab('agent-1', 'Host 1');

    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.sessions.terminate).mockClear();

    await store.retryTab(tabId);

    expect(vi.mocked(apiClient.sessions.terminate)).toHaveBeenCalledWith(
      'session-1',
    );
  });

  it('terminates the previous session when a desktop tab is retried', async () => {
    const store = useTerminalStore();
    const tabId = await store.openDesktopTab('agent-1', 'Host 1');

    const { apiClient } = await import('@/services/client');
    vi.mocked(apiClient.sessions.terminate).mockClear();

    await store.retryTab(tabId);

    expect(vi.mocked(apiClient.sessions.terminate)).toHaveBeenCalledWith(
      'session-1',
    );
  });
});
