import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import { apiClient } from '../services/client';

const adapterCalls: Array<{ iceServers?: unknown }> = [];

vi.mock('@ponter/webrtc-core', () => ({
  createBrowserAdapter: vi.fn((config: { iceServers?: unknown }) => {
    adapterCalls.push(config ?? {});
    throw new Error('stop-after-adapter-construction');
  }),
  PeerConnection: class {},
  RESTPollingTransport: class {},
}));

vi.mock('../services/client', () => ({
  apiClient: {
    http: { baseUrl: 'http://localhost:8787' },
    sessions: {
      create: vi.fn(async () => ({ id: 'session-1' })),
    },
    webrtc: {
      getIceServers: vi.fn(async () => []),
    },
  },
}));

vi.mock('../services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(async () => 'access-123'),
  },
}));

const iceServers = [
  { urls: ['stun:stun.example.com:19302'] },
  {
    urls: ['turn:turn.example.com:3478?transport=udp'],
    username: '123:user-1',
    credential: 'cred-abc',
  },
];

describe('useTerminalStore ICE wiring', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    adapterCalls.length = 0;
    vi.mocked(apiClient.webrtc.getIceServers).mockResolvedValue(iceServers);
  });

  it('requests ICE servers from the API when opening a tab', async () => {
    const store = useTerminalStore();

    await store.openTab('ag-1').catch(() => undefined);

    expect(apiClient.webrtc.getIceServers).toHaveBeenCalledTimes(1);
  });

  it('passes the fetched ICE servers to the peer connection adapter', async () => {
    const store = useTerminalStore();
    await store.openTab('ag-1').catch(() => undefined);

    expect(adapterCalls[0]).toEqual({ iceServers });
  });
});
