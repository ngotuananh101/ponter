import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { watch, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';

// The store builds a DesktopClient for every desktop tab. Mock the module so
// the test drives `start()` deterministically and can assert `close()`.
const desktopStart = vi.fn();
const desktopClose = vi.fn();
const desktopSelectSource = vi.fn();
const desktopSetBitrate = vi.fn();
let desktopSourcesHandler: ((sources: unknown[]) => void) | null = null;
let desktopStatsHandler: ((stats: unknown) => void) | null = null;
const desktopOnSourcesOff = vi.fn();
const desktopOnStatsOff = vi.fn();

vi.mock('@ponter/desktop-core', () => ({
  DesktopClient: function (
    this: Record<string, unknown>,
    _agentId: string,
    _peer: unknown,
  ) {
    this.start = desktopStart;
    this.close = desktopClose;
    this.selectSource = desktopSelectSource;
    this.setBitrate = desktopSetBitrate;
    this.onSources = vi.fn((handler: (sources: unknown[]) => void) => {
      desktopSourcesHandler = handler;
      return desktopOnSourcesOff;
    });
    this.onStats = vi.fn((handler: (stats: unknown) => void) => {
      desktopStatsHandler = handler;
      return desktopOnStatsOff;
    });
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

const peerOptions: Array<Record<string, unknown>> = [];

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: function (
    this: Record<string, unknown>,
    _rtcPeer: unknown,
    _transport: unknown,
    options: Record<string, unknown>,
  ) {
    peerOptions.push(options);
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
    peerOptions.length = 0;
    desktopSourcesHandler = null;
    desktopStatsHandler = null;
    desktopStart.mockReset();
    desktopSelectSource.mockReset();
    desktopSetBitrate.mockReset();
    desktopOnSourcesOff.mockReset();
    desktopOnStatsOff.mockReset();
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

  it('openTab refuses when the agent already has an open desktop tab (reverse guard)', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    // Seed an open desktop tab for the agent — the second session would be
    // refused server-side (ADR-14), but the client guard must fire first.
    store.tabs.push({
      id: 'tab-d-1',
      agentId: 'ag-3',
      kind: 'desktop',
      terminalId: '',
      title: 'Host 3',
      status: 'active',
      desktopStream: { track: { kind: 'video' }, streams: [] } as never,
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openTab('ag-3', 'Host 3');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)?.status).toBe('error');
    expect(store.tabs.find((t) => t.id === tabId)?.error).toMatch(
      /close the desktop stream/i,
    );
  });

  it('openDesktopTab mutates the tab through the proxy so a watcher fires', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });

    // A read-back assertion would pass even on the raw-object bug (the mutated
    // raw object is the same reference stored in the array). What the view
    // actually depends on is reactivity, so pin that: a watcher must fire.
    let fired = 0;
    const stop = watch(
      () => store.tabs.find((t) => t.kind === 'desktop')?.desktopStream,
      () => {
        fired++;
      },
    );
    const tabId = await store.openDesktopTab('ag-4', 'Host 4');
    await nextTick();
    stop();

    expect(fired).toBeGreaterThan(0);
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('active');
    expect(tab?.desktopStream?.track).toEqual({ kind: 'video' });
  });

  it('offers a control channel for a desktop tab', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });

    await store.openDesktopTab('ag-1', 'Host 1');

    expect(peerOptions.at(-1)).toMatchObject({ channelLabels: ['control'] });
  });

  it('populates desktopSources and selects the default entry', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    desktopSourcesHandler?.([
      { id: 'monitor:1', default: false },
      { id: 'monitor:2', default: true },
    ]);
    await nextTick();

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.desktopSources).toHaveLength(2);
    expect(tab?.desktopSourceId).toBe('monitor:2');
  });

  it('records desktopStats from the agent', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    desktopStatsHandler?.({
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
    });
    await nextTick();

    expect(
      store.tabs.find((t) => t.id === tabId)?.desktopStats?.targetBitrateBps,
    ).toBe(6_000_000);
  });

  it('selectDesktopSource calls the client and records the id', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.selectDesktopSource(tabId, 'window:0x4a00007');
    await nextTick();

    expect(desktopSelectSource).toHaveBeenCalledWith('window:0x4a00007');
    expect(store.tabs.find((t) => t.id === tabId)?.desktopSourceId).toBe(
      'window:0x4a00007',
    );
  });

  it('setDesktopBitrate calls the client', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.setDesktopBitrate(tabId, 3_000_000);

    expect(desktopSetBitrate).toHaveBeenCalledWith(3_000_000);
  });

  it('tears down the control subscriptions on closeTab', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.closeTab(tabId);

    expect(desktopOnSourcesOff).toHaveBeenCalled();
    expect(desktopOnStatsOff).toHaveBeenCalled();
  });
});
