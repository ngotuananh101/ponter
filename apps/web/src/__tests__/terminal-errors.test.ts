import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';

// The failure this pins: `waitForChannel` throws after 10s, `openTab` rejects,
// and `handleConnect` in WorkspaceView.vue called it without await or catch. The
// result was an unhandled promise rejection, no tab, and no error anywhere in
// the UI — the user clicked an agent and nothing happened, silently.
//
// The store's internals are a closure, so a store spy cannot intercept them;
// the failure is injected at the module boundary instead, at the same point the
// real failure occurs: peer construction.
let failNext = true;

vi.mock('@remote/webrtc-core', () => {
  // The tests need to drive state changes on the peer the store just built, so
  // the class is a named declaration rather than an anonymous one in the
  // returned object — a class body cannot reference the object it lives in.
  class PeerConnection {
    static last: PeerConnection | undefined;

    start = vi.fn(async () => {});
    waitForChannel = vi.fn(async () => ({}));
    close = vi.fn();

    // The store must subscribe to this. Without a subscriber a failed ICE
    // gathering was observed by nobody, and the tab just sat on "connecting"
    // until `waitForChannel` gave up 10 seconds later.
    stateHandlers: Array<(s: string) => void> = [];
    onConnectionStateChange(handler: (s: string) => void) {
      this.stateHandlers.push(handler);
      return () => {};
    }
    emitState(state: string) {
      for (const h of this.stateHandlers) h(state);
    }

    // The real DataChannelManager is not reachable from here, but the store
    // hands it straight to `TerminalClient`, which calls `onMessage` in its
    // constructor and `sendJson` on `createSession`.
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
    createBrowserAdapter: vi.fn(() => {
      if (failNext) {
        throw new Error(
          'timeout waiting for channel "terminal" (saw state: connecting)',
        );
      }
      return { peer: {} };
    }),
    RESTPollingTransport: class {},
  };
});

vi.mock('../services/client', () => ({
  apiClient: {
    http: { baseUrl: 'http://localhost:8787' },
    sessions: { create: vi.fn(async () => ({ id: 'session-1' })) },
    webrtc: { getIceServers: vi.fn(async () => []) },
  },
}));

vi.mock('../services/token-storage', () => ({
  tokenStorage: { getAccessToken: vi.fn(async () => 'access-123') },
}));

/**
 * Push a `connectionState` onto the peer the store most recently built.
 *
 * The mock's `static last` is a test-only field the real `PeerConnection` type
 * does not have, so reaching it needs a cast through `unknown`.
 */
async function emitPeerState(state: string): Promise<void> {
  const mod = (await import('@remote/webrtc-core')) as unknown as {
    PeerConnection: { last?: { emitState: (s: string) => void } };
  };
  mod.PeerConnection.last?.emitState(state);
}

describe('terminal store error surfacing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    failNext = true;
  });

  it('shows a failed connection on the tab instead of throwing into the void', async () => {
    const store = useTerminalStore();

    await expect(store.openTab('agent-1')).resolves.toBeTypeOf('string');

    const tab = store.tabs[0];
    expect(tab?.status).toBe('error');
    expect(tab?.error).toContain('timeout waiting for channel');
  });

  it('never leaves a tab stuck on connecting', async () => {
    const store = useTerminalStore();
    await store.openTab('agent-1');
    expect(store.tabs[0]?.status).not.toBe('connecting');
  });

  it('reports the message the user would otherwise never see', async () => {
    // The specific string matters: it is the only diagnostic a user has for an
    // offline agent versus a blocked port.
    const store = useTerminalStore();
    await store.openTab('agent-1');
    expect(store.tabs[0]?.error).toMatch(/channel/i);
  });

  it('clears the stale error on retry instead of leaving it on the tab', async () => {
    const store = useTerminalStore();
    await store.openTab('agent-1');
    expect(store.tabs[0]?.status).toBe('error');
    expect(store.tabs[0]?.error).toBeTruthy();

    failNext = false;
    await store.retryTab(store.tabs[0]!.id);

    // A retry that left the old error behind would show a failure message on a
    // tab that is now retrying — the second most confusing state possible.
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.id).not.toBe(
      // a brand-new tab id, i.e. the failed one really was replaced
      'tab-never-matches',
    );
    expect(store.tabs[0]?.error).toBeUndefined();
  });

  it('drops the dead connection so a retry does not reuse the failed peer', async () => {
    // Without dropping the cached peer, `getOrConnectAgent` would return the
    // broken PeerConnection from attempt one and the retry would look like it
    // worked while being exactly as broken.
    const store = useTerminalStore();
    await store.openTab('agent-1');

    failNext = false;
    await store.retryTab(store.tabs[0]!.id);

    const { createBrowserAdapter } = await import('@remote/webrtc-core');
    // Two attempts, two adapter constructions: the retry built a fresh peer.
    expect(vi.mocked(createBrowserAdapter).mock.calls.length).toBe(2);
  });

  it('marks the tab failed when ICE gathering fails', async () => {
    // A failed `connectionState` used to be observed by nobody: the store
    // never subscribed, so the only symptom was a tab stuck on "connecting"
    // until `waitForChannel` gave up 10 seconds later — with no hint that ICE
    // was the actual problem.
    const store = useTerminalStore();
    failNext = false;
    await store.openTab('agent-1');
    expect(store.tabs[0]?.status).toBe('connecting');

    await emitPeerState('failed');

    expect(store.tabs[0]?.status).toBe('error');
    expect(store.tabs[0]?.error).toMatch(/ice|network|connect/i);
  });

  it('does not treat a transient disconnect as a failure', async () => {
    // `disconnected` recovers on its own; flipping the tab to error would strand
    // a working terminal the moment a network blipped.
    const store = useTerminalStore();
    failNext = false;
    await store.openTab('agent-1');

    await emitPeerState('disconnected');

    expect(store.tabs[0]?.status).toBe('connecting');
  });
});
