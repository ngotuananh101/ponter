import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';

// The store builds a DesktopClient for every desktop tab. Mock the module so
// the test drives `start()` deterministically and can assert `close()`.
const desktopStart = vi.fn();
const desktopClose = vi.fn();
const desktopStateHandler = vi.fn();
const desktopErrorHandler = vi.fn();

vi.mock('@ponter/desktop-core', () => ({
  DesktopClient: function (
    this: Record<string, unknown>,
    agentId: string,
    peer: unknown,
  ) {
    this.start = desktopStart;
    this.close = desktopClose;
    this.onConnectionStateChange = desktopStateHandler;
    this.onError = desktopErrorHandler;
  },
}));

vi.mock('@/services/client', () => ({
  apiClient: {
    sessions: {
      create: vi.fn(async () => ({ id: 'sess-desktop' })),
      terminate: vi.fn(async () => ({ success: true })),
    },
    webrtc: { getIceServers: vi.fn(async () => []) },
    http: { baseUrl: 'http://localhost', refreshAccessToken: vi.fn() },
  },
}));

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: function (this: Record<string, unknown>) {
    this.start = vi.fn(async () => {});
    this.close = vi.fn(async () => {});
    this.waitForChannel = vi.fn(async () => {});
    this.onConnectionStateChange = vi.fn(() => () => {});
    this.onRemoteTrack = vi.fn(() => () => {});
    this.dataChannels = {};
  },
  createBrowserAdapter: vi.fn(() => ({})),
  RESTPollingTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
  WebSocketSignalTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
}));

vi.mock('@/services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(async () => 'access-token'),
  },
}));

describe('useTerminalStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initializes with empty tabs and connections', () => {
    const store = useTerminalStore();
    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBeNull();
  });

  it('selects active tab and closes tab correctly', () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as unknown as TerminalSession,
    });
    store.setActiveTab('tab-1');
    expect(store.activeTabId).toBe('tab-1');

    store.closeTab('tab-1');
    expect(store.tabs.length).toBe(0);
    expect(store.activeTabId).toBeNull();
  });

  it('openDesktopTab creates a desktop tab that reaches active', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });

    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).toHaveBeenCalledWith({ agentId: 'ag-1' });
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.kind).toBe('desktop');
    expect(tab?.status).toBe('active');
    expect(tab?.desktopStream?.track).toEqual({ kind: 'video' });
  });

  it('openDesktopTab refuses when the agent already has an open tab', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as unknown as TerminalSession,
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)?.status).toBe('error');
    expect(store.tabs.find((t) => t.id === tabId)?.error).toMatch(
      /already has/i,
    );
  });

  it('closeTab on a desktop tab closes the client and its peer', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-2', 'Host 2');

    store.closeTab(tabId);

    expect(desktopClose).toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
  });
});
