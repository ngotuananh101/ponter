import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { watch, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import type { TerminalSession } from '@ponter/terminal-core';
import type { DesktopStats } from '@ponter/shared';

// The store builds a DesktopClient for every desktop tab. Mock the module so
// the test drives `start()` deterministically and can assert `close()`.
const desktopStart = vi.fn();
const desktopClose = vi.fn();
const desktopSelectSource = vi.fn();
const desktopSetBitrate = vi.fn();
const desktopSendInput = vi.fn();
// The handler now receives a DesktopSourcesPayload (spec §5.3, breaking change).
let desktopSourcesHandler:
  ((payload: { sources: unknown[]; inputEnabled: boolean }) => void) | null =
  null;
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
    this.sendInput = desktopSendInput;
    this.onSources = vi.fn(
      (
        handler: (payload: {
          sources: unknown[];
          inputEnabled: boolean;
        }) => void,
      ) => {
        desktopSourcesHandler = handler;
        return desktopOnSourcesOff;
      },
    );
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
    desktopSendInput.mockReset();
    desktopOnSourcesOff.mockReset();
    desktopOnStatsOff.mockReset();
  });

  /** Push a `desktop-sources` payload through the mock client's handler. */
  function emitSources(
    sources: Array<{ id: string; default: boolean }>,
    inputEnabled = false,
  ): void {
    desktopSourcesHandler?.({ sources, inputEnabled });
  }

  /**
   * Open a desktop tab whose client then pushes `sources` on the control
   * channel. Returns the store and the tab id so a test can drive selects and
   * stats frames. Shared so the picker tests do not repeat the setup block.
   */
  async function openDesktopWithSources(
    sources: Array<{ id: string; default: boolean }>,
    inputEnabled = false,
  ) {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');
    emitSources(sources, inputEnabled);
    await nextTick();
    return { store, tabId };
  }

  /** Push one `desktop-stats` frame through the mock client's handler. */
  function emitStats(overrides: Partial<DesktopStats> = {}): void {
    desktopStatsHandler?.({
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
      ...overrides,
    });
  }

  const pickerId = (
    store: ReturnType<typeof useTerminalStore>,
    tabId: string,
  ) => store.tabs.find((t) => t.id === tabId)?.desktopSourceId;

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

    desktopSourcesHandler?.({
      sources: [
        { id: 'monitor:1', default: false },
        { id: 'monitor:2', default: true },
      ],
      inputEnabled: false,
    });
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

  it('rolls the picker back to the streaming source when a select is refused', async () => {
    const { store, tabId } = await openDesktopWithSources([
      { id: 'monitor:1', default: true },
      { id: 'window:9', default: false },
    ]);
    expect(pickerId(store, tabId)).toBe('monitor:1');

    // The user picks another source: the tab records it optimistically.
    store.selectDesktopSource(tabId, 'window:9');
    await nextTick();
    expect(pickerId(store, tabId)).toBe('window:9');

    // The agent refuses and keeps streaming the old source (spec §2.2). The
    // picker must snap back or it keeps showing a source that is not on screen.
    emitStats({
      status: { kind: 'select-refused', detail: 'unknown source id' },
    });
    await nextTick();

    expect(pickerId(store, tabId)).toBe('monitor:1');
  });

  it('rolls back to the last confirmed source, not the original default', async () => {
    const { store, tabId } = await openDesktopWithSources([
      { id: 'monitor:1', default: true },
      { id: 'monitor:2', default: false },
      { id: 'window:9', default: false },
    ]);

    // A first switch succeeds: the plain stats frame confirms it, so the
    // confirmed source advances from the original default to monitor:2.
    store.selectDesktopSource(tabId, 'monitor:2');
    await nextTick();
    emitStats();
    await nextTick();

    // A later switch is refused: the picker must roll back to monitor:2 — the
    // source actually on screen — not to the original monitor:1 default.
    store.selectDesktopSource(tabId, 'window:9');
    await nextTick();
    emitStats({
      status: { kind: 'select-refused', detail: 'unknown source id' },
    });
    await nextTick();

    expect(pickerId(store, tabId)).toBe('monitor:2');
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

  it('records desktopInputEnabled from the sources payload', async () => {
    const { store, tabId } = await openDesktopWithSources(
      [{ id: 'monitor:1', default: true }],
      true,
    );

    expect(store.tabs.find((t) => t.id === tabId)?.desktopInputEnabled).toBe(
      true,
    );
  });

  it('sendDesktopInput forwards to the client for an open desktop tab', async () => {
    const { store, tabId } = await openDesktopWithSources(
      [{ id: 'monitor:1', default: true }],
      true,
    );

    store.sendDesktopInput(tabId, { kind: 'text', text: 'a' });

    expect(desktopSendInput).toHaveBeenCalledWith({ kind: 'text', text: 'a' });
  });

  it('sendDesktopInput is a no-op for a non-desktop or unknown tab', () => {
    const store = useTerminalStore();

    store.sendDesktopInput('nope', { kind: 'text', text: 'a' });

    expect(desktopSendInput).not.toHaveBeenCalled();
  });

  it('still snaps the picker back on a refused select after the shape change', async () => {
    const { store, tabId } = await openDesktopWithSources([
      { id: 'monitor:1', default: true },
      { id: 'monitor:2', default: false },
    ]);

    store.selectDesktopSource(tabId, 'monitor:2');
    emitStats({
      status: { kind: 'select-refused', detail: 'unknown source id' },
    });
    await nextTick();

    expect(pickerId(store, tabId)).toBe('monitor:1');
  });
});
