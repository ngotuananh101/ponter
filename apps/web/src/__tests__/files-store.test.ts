import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';
import { useTransferQueueStore } from '../stores/transfer-queue';
import type { TerminalSession } from '@ponter/terminal-core';
import type { RemoteFile } from '@ponter/shared';
import type { TransferProgress } from '@ponter/file-core';
import { saveBlob } from '@/lib/save-blob';

type TerminalStore = ReturnType<typeof useTerminalStore>;

// The store builds a FileClient for every files tab. Mock the module so the
// test drives `list`/`download`/`upload` deterministically and can assert
// `dispose` (mirrors the desktop mock in terminal-store.test.ts:24-51).
const filesList = vi.fn();
const filesDownloadFn = vi.fn();
const filesUploadFn = vi.fn();
const filesDispose = vi.fn();
const filesCancel = vi.fn();

vi.mock('@ponter/file-core', () => {
  class MockFilesError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    FilesError: MockFilesError,
    FileClient: function (this: Record<string, unknown>) {
      this.list = filesList;
      this.download = filesDownloadFn;
      this.upload = filesUploadFn;
      this.dispose = filesDispose;
      this.onError = vi.fn(() => () => {});
    },
  };
});

vi.mock('@/services/client', () => ({
  apiClient: {
    sessions: {
      create: vi.fn(async () => ({ id: 'sess-files' })),
      terminate: vi.fn(async () => ({ success: true })),
    },
    webrtc: { getIceServers: vi.fn(async () => []) },
    http: { baseUrl: 'http://localhost', refreshAccessToken: vi.fn() },
    agents: {
      get: vi.fn(async () => ({ signingPublicKey: 'agent-signing-pubkey' })),
    },
  },
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
  loadSigningPublicKey: vi.fn(async () => null),
  importSigningPublicKeyRaw: vi.fn(async () => ({}) as unknown as CryptoKey),
  signProof: vi.fn(async () => 'sig'),
  verifyProof: vi.fn(async () => true),
}));

const peerOptions: Array<Record<string, unknown>> = [];
const peerClose = vi.fn(async () => {});
const peerStart = vi.fn(async () => {});
let waitForChannelImpl: () => Promise<void> = async () => {};
// Captures the onConnectionStateChange handler so tests can drive the
// state-change callback that triggers discardFilesConnection (M5).
const connectionStateChangeHandlers: Array<(state: string) => void> = [];

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: function (
    this: Record<string, unknown>,
    _rtcPeer: unknown,
    _transport: unknown,
    options: Record<string, unknown>,
  ) {
    peerOptions.push(options);
    this.start = peerStart;
    this.close = peerClose;
    this.waitForChannel = vi.fn(() => waitForChannelImpl());
    this.onConnectionStateChange = vi.fn((cb: (state: string) => void) => {
      connectionStateChangeHandlers.push(cb);
      return () => {};
    });
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
  tokenStorage: { getAccessToken: vi.fn(async () => 'access-token') },
}));

vi.mock('@/lib/save-blob', () => ({ saveBlob: vi.fn() }));

/** A promise the test settles by hand, so progress can be asserted mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Per-call deferreds so multiple in-flight transfers don't share the same
 * `done` promise. Each call to upload/download gets its own deferred at the
 * index of the call. The test resolves/rejects the specific index it wants.
 */
let downloadDones: Array<ReturnType<typeof deferred<Uint8Array | void>>> = [];
let uploadDones: Array<ReturnType<typeof deferred<Uint8Array | void>>> = [];
let downloadProgress: ((p: TransferProgress) => void) | null = null;

const entry = (overrides: Partial<RemoteFile> = {}): RemoteFile => ({
  name: 'notes.txt',
  path: 'notes.txt',
  size: 3,
  isDirectory: false,
  modifiedAt: '2026-10-04T00:00:00Z',
  ...overrides,
});

describe('files store (Week 10, spec §7.2/§7.5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    peerOptions.length = 0;
    connectionStateChangeHandlers.length = 0;
    downloadDones = [];
    uploadDones = [];
    downloadProgress = null;
    waitForChannelImpl = async () => {};
    filesList.mockReset();
    filesDownloadFn.mockReset();
    filesUploadFn.mockReset();
    filesDispose.mockReset();
    filesCancel.mockReset();
    peerClose.mockClear();
    peerStart.mockClear();
    vi.mocked(saveBlob).mockClear();

    filesList.mockResolvedValue({ path: '', entries: [], truncated: false });
    filesDownloadFn.mockImplementation(
      (_path: string, onProgress?: (p: TransferProgress) => void) => {
        downloadProgress = onProgress ?? null;
        const done = deferred<Uint8Array | void>();
        downloadDones.push(done);
        return {
          transferId: `t-dl-${downloadDones.length - 1}`,
          direction: 'download',
          done: done.promise,
          cancel: filesCancel,
        };
      },
    );
    filesUploadFn.mockImplementation(
      (
        _dir: string,
        _name: string,
        _bytes: Uint8Array,
        _onProgress?: (p: TransferProgress) => void,
      ) => {
        const done = deferred<Uint8Array | void>();
        uploadDones.push(done);
        return {
          transferId: `t-up-${uploadDones.length - 1}`,
          direction: 'upload',
          done: done.promise,
          cancel: filesCancel,
        };
      },
    );
  });

  /**
   * Open a files tab whose handshake succeeds, with `list('')` resolving to
   * `entries`. Shared so the action tests do not repeat the setup block.
   */
  async function openFilesWithClient(entries: RemoteFile[] = []) {
    const store = useTerminalStore();
    filesList.mockResolvedValueOnce({ path: '', entries, truncated: false });
    const tabId = await store.openFilesTab('ag-1', 'Host 1');
    return { store, tabId };
  }

  it('openFilesTab offers one files channel and lists the root', async () => {
    const { store, tabId } = await openFilesWithClient([entry()]);

    expect(peerOptions.at(-1)).toMatchObject({
      channelLabels: ['files'],
      capabilities: ['files'],
    });
    expect(peerOptions.at(-1)).not.toHaveProperty('media');
    expect(filesList).toHaveBeenCalledWith('');

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.kind).toBe('files');
    expect(tab?.status).toBe('active');
    expect(tab?.filesPath).toBe('');
    expect(tab?.fileList?.entries).toHaveLength(1);
    expect(tab?.initStep).toBeUndefined();
  });

  it('openFilesTab refuses when the agent already has any open tab', async () => {
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

    const tabId = await store.openFilesTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    expect(tab?.error).toMatch(/already has/i);
  });

  /** Seed an active files tab in the store — shared by the guard tests. */
  function pushFilesTab(
    store: TerminalStore,
    agentId: string,
    title: string,
  ): void {
    store.tabs.push({
      id: 'tab-f-1',
      agentId,
      kind: 'files',
      terminalId: '',
      title,
      status: 'active',
      filesPath: '',
      fileList: { path: '', entries: [], truncated: false },
    });
  }

  /** Assert that `create` was never called and the guard tab landed on 'error'. */
  function assertGuardRefused(
    apiClient: { sessions: { create: unknown } },
    store: TerminalStore,
    tabId: string,
    errorPattern: RegExp,
  ): void {
    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    expect(tab?.error).toMatch(errorPattern);
  }

  it('openTab refuses when a files tab exists (extended guard)', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    pushFilesTab(store, 'ag-3', 'Host 3');
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openTab('ag-3', 'Host 3');

    assertGuardRefused(
      apiClient,
      store,
      tabId,
      /close the file transfer session/i,
    );
  });

  it('openDesktopTab refuses when a files tab exists', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    pushFilesTab(store, 'ag-4', 'Host 4');
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openDesktopTab('ag-4', 'Host 4');

    assertGuardRefused(apiClient, store, tabId, /already has/i);
  });

  it('pushes the tab before the handshake and releases an orphaned connection', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    const gate = deferred<void>();
    waitForChannelImpl = () => gate.promise;

    const openPromise = store.openFilesTab('ag-9', 'Host 9');
    // The tab exists before any await: a click shows progress immediately.
    expect(store.tabs).toHaveLength(1);
    const tabId = store.tabs[0]!.id;

    // The user closes it mid-handshake; the handshake then completes and the
    // freshly built connection must release itself (ADR-14 slot).
    store.closeTab(tabId);
    gate.resolve();
    await openPromise;

    expect(filesDispose).toHaveBeenCalled();
    expect(peerClose).toHaveBeenCalled();
    expect(apiClient.sessions.terminate).toHaveBeenCalledWith('sess-files');
    expect(filesList).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
  });

  it('marks the tab failed with the combined refusal message', async () => {
    const store = useTerminalStore();
    waitForChannelImpl = async () => {
      throw new Error(
        'the agent refused the connection (one session per agent; another session is already active)',
      );
    };

    const tabId = await store.openFilesTab('ag-5', 'Host 5');

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.status).toBe('error');
    // Spec §7.4: the hardcoded webrtc-core message is wrong for a gate
    // refusal, so the store shows the honest combined wording instead.
    expect(tab?.error).toMatch(/refused this session/i);
    expect(tab?.error).toMatch(/file access may not be configured/i);
  });

  it('filesNavigate lists the path and updates the tab', async () => {
    const { store, tabId } = await openFilesWithClient();
    filesList.mockResolvedValueOnce({
      path: 'docs',
      entries: [entry({ name: 'a.txt', path: 'docs/a.txt' })],
      truncated: true,
    });

    await store.filesNavigate(tabId, 'docs');

    expect(filesList).toHaveBeenLastCalledWith('docs');
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.filesPath).toBe('docs');
    expect(tab?.fileList?.truncated).toBe(true);
  });

  it('filesDownload wires progress into the tab and saves the blob on completion', async () => {
    const { store, tabId } = await openFilesWithClient();
    const bytes = new Uint8Array([1, 2, 3]);

    const pending = store.filesDownload(tabId, 'docs/notes.txt');
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(filesDownloadFn).toHaveBeenCalledWith(
      'docs/notes.txt',
      expect.any(Function),
    );
    expect(tab?.fileTransfers).toHaveLength(1);
    expect(tab?.fileTransfers?.[0]?.name).toBe('notes.txt');

    downloadProgress?.({
      transferId: 't-dl-0',
      direction: 'download',
      bytesTransferred: 3,
      totalBytes: 3,
      chunkIndex: 0,
    });
    await nextTick();
    expect(tab?.fileTransfers?.[0]?.bytesTransferred).toBe(3);

    downloadDones[0]!.resolve(bytes);
    await pending;

    expect(saveBlob).toHaveBeenCalledWith('notes.txt', bytes);
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(
      0,
    );
  });

  it('filesDownload maps a wire error code to the banner text', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    downloadDones[0]!.reject(new FilesError('TRANSFER_TIMEOUT', 'no progress'));
    await pending;

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBe(
      'The transfer timed out',
    );
  });

  it('filesCancelTransfer calls the handle cancel and is not an error', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    store.filesCancelTransfer(tabId, 't-dl-0');
    expect(filesCancel).toHaveBeenCalledTimes(1);

    downloadDones[0]!.reject(new FilesError('CANCELLED', 'cancelled'));
    await pending;

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeNull();
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(
      0,
    );
  });

  it('filesUpload reads the picked file and creates an upload handle', async () => {
    const { store, tabId } = await openFilesWithClient();
    const file = new File([new Uint8Array([1, 2, 3])], 'up.bin');

    const pending = store.filesUpload(tabId, file);
    // filesUpload awaits file.arrayBuffer() before calling client.upload(),
    // so the per-call deferred is registered on the next tick.
    await nextTick();
    uploadDones[0]!.resolve(undefined);
    await pending;

    expect(filesUploadFn).toHaveBeenCalledWith(
      '',
      'up.bin',
      expect.any(Uint8Array),
      expect.any(Function),
    );
    const bytes = filesUploadFn.mock.calls[0]?.[2] as Uint8Array;
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(store.tabs.find((t) => t.id === tabId)?.fileTransfers).toHaveLength(
      0,
    );
  });

  it('closeTab disposes the client and settles an in-flight handle', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');

    // The real FileClient.dispose() rejects in-flight handles with
    // 'CANCELLED' (Task 3, client.test.ts); the fake honors that contract so
    // this pins that the store routes closeTab through dispose().
    filesDispose.mockImplementationOnce(() => {
      downloadDones[0]!.reject(new FilesError('CANCELLED', 'client disposed'));
    });
    store.closeTab(tabId);

    expect(filesDispose).toHaveBeenCalled();
    await pending;
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
    expect(store.activeTabId).toBeNull();
  });

  it('discardFilesConnection on connection "failed" disposes the client and rejects an in-flight download handle with CANCELLED', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    store.filesDownload(tabId, 'a.bin');

    // Capture the TransferHandle the client handed back so we can observe its
    // `done` promise (the store's own filesDownload() swallows the rejection in
    // trackTransfer; the handle contract is what we pin here).
    const handle = filesDownloadFn.mock.results[0]?.value;
    expect(handle).toBeTypeOf('object');
    const donePromise = handle.done as Promise<Uint8Array | void>;

    // The real FileClient.dispose() rejects in-flight handles with 'CANCELLED';
    // the mock stands in for the client and must honor that contract so this pins
    // that discardFilesConnection routes through dispose() on the 'failed' path.
    filesDispose.mockImplementationOnce(() => {
      downloadDones[0]!.reject(new FilesError('CANCELLED', 'client disposed'));
    });

    // Driving the captured onConnectionStateChange handler with 'failed'
    // triggers discardFilesConnection (M5): the client must be disposed so
    // in-flight handles reject with CANCELLED instead of hanging to timeout.
    const handler = connectionStateChangeHandlers[0];
    expect(handler).toBeTypeOf('function');
    handler!('failed');

    expect(filesDispose).toHaveBeenCalled();
    await expect(donePromise).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'client disposed',
    });
  });

  it('clearFileError resets the banner', async () => {
    const { store, tabId } = await openFilesWithClient();
    const { FilesError } = await import('@ponter/file-core');
    const pending = store.filesDownload(tabId, 'a.bin');
    downloadDones[0]!.reject(new FilesError('NOT_FOUND', 'gone'));
    await pending;
    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeTruthy();

    store.clearFileError(tabId);

    expect(store.tabs.find((t) => t.id === tabId)?.fileError).toBeNull();
  });

  describe('files store transfer queue gate (Week 11, spec §7.7 AC#4)', () => {
    /**
     * The mock client returns a fixed transferId and the same done promise for
     * every call. These tests use per-call deferreds (downloadDones/uploadDones)
     * so that resolving one transfer does not settle another.
     */
    it('Gate (upload): 3 concurrent filesUpload calls → client.upload called once, 1 active + 2 queued', async () => {
      const { store, tabId } = await openFilesWithClient();
      const q = useTransferQueueStore();
      const file1 = new File([new Uint8Array([1])], 'a.bin');
      const file2 = new File([new Uint8Array([2])], 'b.bin');
      const file3 = new File([new Uint8Array([3])], 'c.bin');

      // Initiate all three uploads (do not settle any).
      // filesUpload awaits file.arrayBuffer() before calling client.upload(),
      // so the mock is registered on subsequent ticks.
      store.filesUpload(tabId, file1);
      store.filesUpload(tabId, file2);
      store.filesUpload(tabId, file3);
      await nextTick();

      // Only the first upload should have reached the client.
      expect(filesUploadFn).toHaveBeenCalledTimes(1);

      const uploads = q.items.filter((i) => i.direction === 'upload');
      expect(uploads).toHaveLength(3);
      const active = uploads.filter((i) => i.status === 'active');
      const queued = uploads.filter((i) => i.status === 'queued');
      expect(active).toHaveLength(1);
      expect(queued).toHaveLength(2);
      // FIFO order: first enqueued is active.
      expect(q.activeUploadId).toBe(uploads[0]!.id);
    });

    it('FIFO promotion (upload): settling transfer 1 promotes the next queued item', async () => {
      const { store, tabId } = await openFilesWithClient();
      const q = useTransferQueueStore();
      const file1 = new File([new Uint8Array([1])], 'a.bin');
      const file2 = new File([new Uint8Array([2])], 'b.bin');

      store.filesUpload(tabId, file1);
      store.filesUpload(tabId, file2);
      await nextTick();
      expect(filesUploadFn).toHaveBeenCalledTimes(1);

      // Settle transfer 1 (the active one).
      uploadDones[0]!.resolve(undefined);
      await nextTick();
      await nextTick();

      // After settling, the next queued item should have started.
      expect(filesUploadFn).toHaveBeenCalledTimes(2);
      const uploads = q.items.filter((i) => i.direction === 'upload');
      const active = uploads.filter((i) => i.status === 'active');
      expect(active).toHaveLength(1);
      // The second upload is now active (FIFO).
      expect(active[0]).toBe(uploads[1]);
    });

    it('Gate (download): 2 concurrent filesDownload calls → client.download called once, 1 active + 1 queued', async () => {
      const { store, tabId } = await openFilesWithClient();
      const q = useTransferQueueStore();

      store.filesDownload(tabId, 'a.txt');
      store.filesDownload(tabId, 'b.txt');
      await nextTick();

      expect(filesDownloadFn).toHaveBeenCalledTimes(1);

      const downloads = q.items.filter((i) => i.direction === 'download');
      expect(downloads).toHaveLength(2);
      const active = downloads.filter((i) => i.status === 'active');
      const queued = downloads.filter((i) => i.status === 'queued');
      expect(active).toHaveLength(1);
      expect(queued).toHaveLength(1);
      expect(q.activeDownloadId).toBe(downloads[0]!.id);
    });

    it('Settle mapping: completed on success, cancelled on cancel/error, then promote next', async () => {
      const { store, tabId } = await openFilesWithClient();
      const q = useTransferQueueStore();
      const file1 = new File([new Uint8Array([1])], 'a.bin');
      const file2 = new File([new Uint8Array([2])], 'b.bin');

      // --- Success path ---
      store.filesUpload(tabId, file1);
      store.filesUpload(tabId, file2);
      await nextTick();
      expect(filesUploadFn).toHaveBeenCalledTimes(1);

      uploadDones[0]!.resolve(undefined);
      await nextTick();
      await nextTick(); // allow trackTransfer to settle
      const item0 = q.items.find((i) => i.name === 'a.bin');
      expect(item0?.status).toBe('completed');

      // --- Error path ---
      const { FilesError } = await import('@ponter/file-core');
      const file3 = new File([new Uint8Array([3])], 'c.bin');
      store.filesUpload(tabId, file3);
      await nextTick();
      // file3 should be queued behind file2
      const file3Item = q.items.find((i) => i.name === 'c.bin');
      expect(file3Item?.status).toBe('queued');
      // Settle file2 with an error.
      uploadDones[1]!.reject(new FilesError('TRANSFER_BUSY', 'agent busy'));
      await nextTick();
      await nextTick();
      // file2 should be cancelled with error text, and file3 promoted to active.
      const item1 = q.items.find((i) => i.name === 'b.bin');
      expect(item1?.status).toBe('cancelled');
      expect(item1?.error).toBeTruthy();
      expect(file3Item?.status).toBe('active');
    });
  });
});
