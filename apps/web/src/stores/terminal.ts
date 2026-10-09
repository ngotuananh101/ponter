import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import {
  TerminalClient,
  TerminalSession,
  TerminalE2ee,
  type TerminalSession as TerminalSessionType,
  type E2eeContext,
} from '@ponter/terminal-core';
import {
  PeerConnection,
  createBrowserAdapter,
  RESTPollingTransport,
  WebSocketSignalTransport,
  type PeerConnectionOptions,
} from '@ponter/webrtc-core';
import {
  loadPrivateKey,
  loadPublicKey,
  loadSigningKey,
  importSigningPublicKeyRaw,
  signProof,
  verifyProof,
} from '@ponter/crypto';
import { useAuthStore } from './auth';
import { DesktopClient, type DesktopStream } from '@ponter/desktop-core';
import {
  FileClient,
  FilesError,
  ServiceWorkerStreamWriter,
  type FileListResult,
  type TransferHandle,
  type TransferProgress,
} from '@ponter/file-core';
import {
  registerDownloadSW,
  initDownloadStream,
  swAvailable,
} from '@/lib/sw-download';
import type {
  DesktopInput,
  DesktopSourceInfo,
  DesktopStats,
  DesktopCursorPayload,
} from '@ponter/shared';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import type { InitStep } from '@/lib/connection-steps';
import { fileErrorMessage } from '@/lib/file-errors';
import { saveBlob } from '@/lib/save-blob';
import { useTransferQueueStore } from './transfer-queue';

export interface TabItem {
  id: string;
  agentId: string;
  /** Discriminates the tab body and which connection map owns its lifecycle. */
  kind: 'terminal' | 'desktop' | 'files';
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  /**
   * Which initialization stage the tab is in while `status === 'connecting'`.
   * The workspace renders this as a step list so a slow handshake shows
   * progress instead of an empty body.
   */
  initStep?: InitStep;
  exitCode?: number;
  /** Why the connection failed, when `status === 'error'`. */
  error?: string;
  /** Terminal tabs only. */
  session?: TerminalSessionType;
  /** Desktop tabs only: the render data. The client/peer live in `desktopConnections`. */
  desktopStream?: DesktopStream;
  /** Desktop tabs only: the agent's capture-source enumeration (spec §7.1). */
  desktopSources?: DesktopSourceInfo[];
  /** Desktop tabs only: best-effort telemetry from `desktop-stats`. */
  desktopStats?: DesktopStats;
  /** Desktop tabs only: the source the agent is streaming (or was asked to). */
  desktopSourceId?: string;
  /** Desktop tabs only: true iff the agent's input gate is open (ADR-29). */
  desktopInputEnabled?: boolean;
  /** Desktop tabs only: true iff the agent verified the peer identity (Phase 6a ADR-42). */
  desktopPeerVerified?: boolean;
  /** Desktop tabs only: the latest cursor-within-frame payload (Phase 6b ADR-45). */
  desktopCursor?: DesktopCursorPayload;
  /** Desktop tabs only: true iff the agent is emitting cursor-within-frame updates (Phase 6b ADR-45). */
  desktopCursorInFrame?: boolean;
  /** Desktop tabs only: one-way input echo latency in ms (Phase 6b ADR-47). */
  desktopEchoMs?: number;
  /** Files tabs only: current directory ('' = root, spec §7.2). */
  filesPath?: string;
  /** Files tabs only: the latest listing (spec §7.2). */
  fileList?: FileListResult;
  /** Files tabs only: last error text, mapped from `FilesError.code`. */
  fileError?: string | null;
  /** Files tabs only: active transfers with their handles (spec §7.2; `name`
   *  is what the §7.1 footer renders — see the ruling above). */
  fileTransfers?: Array<
    TransferProgress & {
      handle: TransferHandle;
      name: string;
      paused?: boolean;
      queueId?: string;
    }
  >;
}

/** Best-effort message from an unknown catch value; never `[object Object]`. */
function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown error';
}

/** True when `cause` is the client's synthetic local cancel code. */
function isCancelledError(cause: unknown): boolean {
  return cause instanceof FilesError && cause.code === 'CANCELLED';
}

/** Map a caught failure to banner text: wire code when known, else message. */
function fileErrorText(cause: unknown): string {
  return cause instanceof FilesError
    ? fileErrorMessage(cause.code)
    : toErrorMessage(cause);
}

/** An unsubscribe returned by every `on*` subscription in the transport stack. */
type Unsubscribe = () => void;

/**
 * Detach a connection's event subscriptions. The transport/peer callbacks are
 * scoped to an **agent id**, not a tab: a stale `onConnectionStateChange` from
 * a discarded peer would still iterate `tabs.value` and could mark a *new* tab
 * for the same agent as failed. Unsubscribing on teardown is what stops that.
 * Best-effort — one bad unsubscribe must not abort the rest of the teardown.
 */
function runUnsubscribers(unsubscribers: readonly Unsubscribe[]): void {
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      // A subscription that refuses to detach is not worth failing the close.
    }
  }
}

/**
 * Typed error thrown when a WS2 peer-identity proof cannot be produced for an
 * offer. The agent now treats a proof-less offer as a fail-closed admission
 * rejection, so the failure must be explicit (and landable in the tab error
 * surface) instead of silently degrading to a plaintext offer.
 */
export class PeerIdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerIdentityUnavailableError';
  }
}

/**
 * Resolve the WS2 peer-identity config for connecting to `agentId`.
 *
 * Reuses the auth store's `ensureUserSigningKey` to bootstrap a missing signing
 * key (legacy accounts) rather than duplicating key logic here. After the
 * ensure pass, all four keys must be present — otherwise this throws a typed
 * `PeerIdentityUnavailableError` (caught by the open-tab flow → tab `error`).
 *
 * `userSigningPublicKey` is intentionally NOT set by the browser: the server
 * injects it from the DB (`apps/server/src/routes/signal.ts` / `ws.ts`).
 */
async function resolvePeerIdentity(
  agentId: string,
): Promise<PeerConnectionOptions['identity']> {
  const auth = useAuthStore();
  const user = auth.user;
  if (!user) {
    throw new PeerIdentityUnavailableError(
      'Peer identity unavailable: no authenticated user.',
    );
  }

  // Best-effort bootstrap (never throws). If it could not reach `ready`,
  // identity is unrecoverable and we must not offer a proof-less connection.
  if (auth.identityStatus !== 'ready') {
    await auth.ensureUserSigningKey(user);
  }
  if (auth.identityStatus !== 'ready') {
    throw new PeerIdentityUnavailableError(
      'Peer identity unavailable on this device — re-register this account or clear and re-add its identity key.',
    );
  }

  const signingKey = await loadSigningKey(user.id);
  if (!signingKey) {
    throw new PeerIdentityUnavailableError(
      'Peer identity unavailable: no local signing key.',
    );
  }

  const agent = await apiClient.agents.get(agentId);
  if (!agent.signingPublicKey) {
    throw new PeerIdentityUnavailableError(
      'Peer identity unavailable: the agent has no signing key.',
    );
  }

  const agentKey = await importSigningPublicKeyRaw(agent.signingPublicKey);
  return {
    role: 'offerer',
    sign: (m) => signProof(signingKey, m),
    verifyPeer: (m, s) => verifyProof(agentKey, m, s),
  };
}

/**
 * Build the WS1 E2EE context for connecting to `agentId`, or null if any
 * key material is missing.
 *
 * Fail-closed (T5-C): a context is only returned when every required key is
 * present — if the user has no ECDH key, no signing key, or the agent has no
 * signing public key, E2EE cannot be offered and the store falls through to
 * the plaintext path.
 */
async function buildE2eeContext(
  agentId: string,
  sessionId: string,
): Promise<E2eeContext | null> {
  try {
    const userId = useAuthStore().user?.id;
    if (!userId) return null;

    const ecdhPrivateKey = await loadPrivateKey(userId);
    if (!ecdhPrivateKey) return null;
    const ecdhPublicKey = await loadPublicKey(userId);
    if (!ecdhPublicKey) return null;
    const signingPrivateKey = await loadSigningKey(userId);
    if (!signingPrivateKey) return null;

    const agent = await apiClient.agents.get(agentId);
    if (!agent.signingPublicKey) return null;
    const peerSigningPublicKey = await importSigningPublicKeyRaw(
      agent.signingPublicKey,
    );

    return {
      ecdhPrivateKey,
      ecdhPublicKey,
      signingPrivateKey,
      peerSigningPublicKey,
      sessionId,
    };
  } catch {
    return null;
  }
}

export const useTerminalStore = defineStore('terminal', () => {
  const tabs = ref<TabItem[]>([]);
  const activeTabId = ref<string | null>(null);
  const connections = new Map<
    string,
    {
      peer: PeerConnection;
      client: TerminalClient;
      sessionId: string;
      unsubscribers: Unsubscribe[];
    }
  >();
  const pendingConnections = new Map<string, Promise<TerminalClient>>();

  // Desktop clients are kept apart from terminal connections so a desktop
  // client is never handed to the terminal flow and vice versa. The tab holds
  // only `desktopStream` (render data); lifecycle stays here.
  const desktopConnections = new Map<
    string,
    {
      peer: PeerConnection;
      client: DesktopClient;
      sessionId: string;
      unsubscribers: Unsubscribe[];
      /** Monotonic input seq -> Date.now() when sent, for echo latency (ADR-47). */
      inputSentTimes: Map<number, number>;
    }
  >();

  // Files clients are kept apart like desktop ones: the tab holds only the
  // listing/transfer state; lifecycle stays here (spec §7.2).
  const fileConnections = new Map<
    string,
    {
      peer: PeerConnection;
      client: FileClient;
      sessionId: string;
      unsubscribers: Unsubscribe[];
    }
  >();

  // Transfer queue store — enforces one active transfer per direction so
  // concurrent drops don't overwhelm the Rust agent's single-slot-per-direction
  // contract (spec §7.7 AC#4, ADR-39).
  const transferQueue = useTransferQueueStore();

  /**
   * Registry of pending start closures for queued transfers. When a queued item
   * is promoted to `active` by the store's internal `pump()`, this watch fires
   * and invokes the closure to actually begin the transfer.
   */
  const pendingUploadStarts = new Map<string, () => Promise<void>>();
  const pendingDownloadStarts = new Map<string, () => Promise<void>>();

  // Promote queued transfers when the store advances them to active.
  watch(
    () => transferQueue.activeUploadId,
    (newId) => {
      if (!newId) return;
      const start = pendingUploadStarts.get(newId);
      if (start) {
        pendingUploadStarts.delete(newId);
        void start();
      }
    },
  );
  watch(
    () => transferQueue.activeDownloadId,
    (newId) => {
      if (!newId) return;
      const start = pendingDownloadStarts.get(newId);
      if (start) {
        pendingDownloadStarts.delete(newId);
        void start();
      }
    },
  );

  const activeTab = computed(() =>
    tabs.value.find((t) => t.id === activeTabId.value),
  );

  /**
   * Whether a tab is still open. Tabs are now pushed before their handshake
   * completes, so a user can close one mid-handshake; the open flows use this
   * to detect that and tear down the connection they just built instead of
   * leaking it (which would hold the agent's single session slot, ADR-14).
   */
  function isTabOpen(tabId: string): boolean {
    return tabs.value.some((t) => t.id === tabId);
  }

  /**
   * Advance the initialization step of every still-connecting tab for an
   * agent. Terminal tabs share one underlying connection, so two tabs opened
   * for the same agent must both track the same handshake progress — a
   * per-call callback would leave the second tab frozen on its first step.
   */
  function setInitStep(
    agentId: string,
    kind: 'terminal' | 'desktop' | 'files',
    step: InitStep,
  ): void {
    for (const tab of tabs.value) {
      if (
        tab.agentId === agentId &&
        tab.kind === kind &&
        tab.status === 'connecting'
      ) {
        tab.initStep = step;
      }
    }
  }

  /**
   * Build the signaling transport for a session. Shared by the terminal and
   * desktop flows so the WS/REST selection and the refresh callback cannot
   * drift apart between them.
   */
  async function createSignalingTransport(
    sessionId: string,
  ): Promise<WebSocketSignalTransport | RESTPollingTransport> {
    const token = await tokenStorage.getAccessToken();
    const useWsSignaling = import.meta.env.VITE_BROWSER_WS_SIGNALING === 'true';

    const restTransport = () =>
      new RESTPollingTransport({
        baseUrl: apiClient.http.baseUrl,
        sessionId,
        token: token ?? '',
        onUnauthorized: async () => apiClient.http.refreshAccessToken(),
      });

    return useWsSignaling
      ? new WebSocketSignalTransport({
          baseUrl: apiClient.http.baseUrl,
          sessionId,
          getToken: () => tokenStorage.getAccessToken(),
          onUnauthorized: () => apiClient.http.refreshAccessToken(),
          reconnect: true,
          fallback: restTransport(),
        })
      : restTransport();
  }

  async function getOrConnectAgent(agentId: string): Promise<TerminalClient> {
    const existing = connections.get(agentId);
    if (existing) return existing.client;

    const pending = pendingConnections.get(agentId);
    if (pending) return pending;

    const connectionPromise = (async () => {
      setInitStep(agentId, 'terminal', 'session');
      const sessionResp = await apiClient.sessions.create({ agentId });

      // Everything after the session exists is fallible, and the server has
      // already reserved the agent's single session slot (ADR-14). Without this
      // guard a rejection in `peer.start()` / `waitForChannel` would leave that
      // slot held by a session nobody can reach — the tab is set to `error`, but
      // the session is invisible to every teardown path because it never
      // reached `connections`.
      const unsubscribers: Unsubscribe[] = [];
      // Hoisted so the catch can close whatever was built before the failure.
      let peer: PeerConnection | null = null;
      try {
        const transport = await createSignalingTransport(sessionResp.id);

        // The server mints short-lived TURN credentials per user, so fetch the
        // ICE list here rather than caching it at module load. Without this the
        // RTCPeerConnection is built with an empty `iceServers` and ICE can only
        // ever succeed on a LAN.
        setInitStep(agentId, 'terminal', 'ice');
        const iceServers = await apiClient.webrtc.getIceServers();

        const rtcPeer = createBrowserAdapter({ iceServers });

        const identity = await resolvePeerIdentity(agentId);
        // T5-G: propose e2ee in the offer capabiities only when a context can
        // be built — otherwise the agent never echoes e2ee and the plaintext
        // path is byte-identical.
        const e2eeContext = await buildE2eeContext(agentId, sessionResp.id);
        const capabilities = e2eeContext ? ['terminal', 'e2ee'] : ['terminal'];
        peer = new PeerConnection(rtcPeer, transport, {
          role: 'offerer',
          channelLabels: ['terminal'],
          capabilities,
          sessionId: sessionResp.id,
          identity,
        });

        // A terminated session is pushed as an `error` frame, which never
        // reaches `PeerConnection` (it carries no `SignalMessage`). Without this
        // hook the tab would sit on "connecting" until `waitForChannel` timed
        // out with no explanation — the REST transport would only discover the
        // same fact on its next poll.
        if (transport instanceof WebSocketSignalTransport) {
          unsubscribers.push(
            transport.onServerError((code) => {
              if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
              const message =
                code === 'SESSION_TERMINATED'
                  ? 'Session terminated: the agent disconnected or the session was closed.'
                  : 'Session not found on the server.';
              for (const tab of tabs.value) {
                if (tab.agentId !== agentId || tab.kind !== 'terminal')
                  continue;
                tab.status = 'error';
                tab.error = message;
                tab.initStep = undefined;
              }
              discardTerminalConnection(agentId);
            }),
          );
        }

        await peer.start();
        setInitStep(agentId, 'terminal', 'negotiating');

        // ICE failure used to be observed by nobody. The only symptom was a tab
        // stuck on "connecting" for the full 10s `waitForChannel` timeout, with
        // nothing to tell an unreachable agent apart from a symmetric NAT both
        // sides could not get around. `failed` is the terminal state; `disconnected`
        // is transient and recovers on its own, so it is deliberately ignored.
        unsubscribers.push(
          peer.onConnectionStateChange((state) => {
            if (state !== 'failed') return;
            const message =
              'Connection failed: no direct route to the agent (ICE). Check that ' +
              'TURN is reachable, or that the agent is not behind a blocking NAT.';
            for (const tab of tabs.value) {
              if (tab.agentId !== agentId || tab.kind !== 'terminal') continue;
              tab.status = 'error';
              tab.error = message;
              tab.initStep = undefined;
            }
            // The peer is terminal; keeping it cached would make the next open or
            // retry hand back the same dead connection.
            discardTerminalConnection(agentId);
          }),
        );

        await peer.waitForChannel('terminal');

        // T5-C: pass the E2eeContext only when the agent advertised e2ee in its
        // answer AND we were able to build a context. If either is absent, the
        // client is constructed exactly as today (no 3rd arg) — plaintext parity.
        if (e2eeContext && peer.getRemoteCapabilities().includes('e2ee')) {
          const client = new TerminalClient(
            agentId,
            peer.dataChannels,
            new TerminalE2ee(e2eeContext),
          );
          connections.set(agentId, {
            peer,
            client,
            sessionId: sessionResp.id,
            unsubscribers,
          });
          return client;
        }

        const client = new TerminalClient(agentId, peer.dataChannels);
        connections.set(agentId, {
          peer,
          client,
          sessionId: sessionResp.id,
          unsubscribers,
        });
        return client;
      } catch (e) {
        // Release the half-built connection and the server session. Closing the
        // peer also tears down the signaling transport (which, left alone, would
        // keep reconnecting for a session that is about to be terminated).
        runUnsubscribers(unsubscribers);
        if (peer) void peer.close();
        void apiClient.sessions.terminate(sessionResp.id).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
        throw e;
      }
    })();

    pendingConnections.set(agentId, connectionPromise);
    try {
      return await connectionPromise;
    } finally {
      pendingConnections.delete(agentId);
    }
  }

  async function openTab(
    agentId: string,
    title?: string,
    shell?: string,
  ): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    // ADR-14 guard, extended for Week 10: a files session holds the agent's
    // single slot too (spec §7.2), so it blocks a terminal like a desktop does.
    const blocking = tabs.value.find(
      (t) => t.agentId === agentId && t.kind !== 'terminal',
    );
    if (blocking) {
      recordFailedTab(
        tabId,
        agentId,
        title,
        blocking.kind === 'files'
          ? 'Close the file transfer session before opening a terminal.'
          : 'Close the desktop stream before opening a terminal.',
      );
      return tabId;
    }

    // Push the tab BEFORE the handshake. The handshake can take seconds (ICE +
    // `waitForChannel`), and a tab that only appears once it is done leaves the
    // user staring at an unchanged workspace wondering whether the click
    // registered. The tab starts with no session; the workspace renders the
    // step list until one arrives.
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'terminal',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      initStep: 'session',
    });
    activeTabId.value = tabId;

    // Read the tab back through the proxy: the object pushed above is the raw
    // one, and mutating it directly would not notify the template.
    const live = tabs.value.find((t) => t.id === tabId);

    let client: TerminalClient;
    try {
      client = await getOrConnectAgent(agentId);
    } catch (e) {
      // A connection failure must land somewhere the user can see. Previously
      // this rejected into `handleConnect`, which neither awaited nor caught it:
      // an unhandled rejection, no tab, and no message. `waitForChannel` alone
      // accounts for the common case — the user clicked an agent and nothing
      // happened.
      //
      // If the tab was closed mid-handshake, `live` still references the
      // detached proxy; writing to it is harmless and nothing is shown. The
      // connection was never registered, so there is nothing to tear down.
      if (live) {
        live.status = 'error';
        live.error = toErrorMessage(e);
        live.initStep = undefined;
      }
      return tabId;
    }

    // The tab may have been closed while the handshake ran. Closing it cannot
    // have released this connection — `closeTab` found no session and no
    // registered connection at that point — so release it now, or the agent
    // keeps its single session slot (ADR-14) occupied by an orphan.
    if (!isTabOpen(tabId)) {
      releaseOrphanedTerminalConnection(agentId);
      return tabId;
    }

    const session = client.createSession({ cols: 80, rows: 24, shell });

    if (live) {
      live.terminalId = session.id;
      live.session = session;
      live.initStep = 'shell';

      session.onStateChange((state) => {
        live.status = state === 'closed' ? 'exited' : state;
        if (live.status !== 'connecting') live.initStep = undefined;
      });

      session.onExit((code) => {
        live.status = 'exited';
        live.exitCode = code;
        live.initStep = undefined;
      });

      client.onError?.((message) => {
        live.status = 'error';
        live.error = message;
        live.initStep = undefined;
      });
    }

    return tabId;
  }

  /**
   * Drop a cached terminal connection and detach its transport/peer
   * subscriptions, without touching the server session. Used by the error
   * callbacks (the peer is already dead) and by `closeTerminalConnection`.
   */
  function discardTerminalConnection(agentId: string): void {
    // A pending handshake for the same agent must also be dropped, or the next
    // open would be handed the promise for the connection just discarded.
    pendingConnections.delete(agentId);
    const conn = connections.get(agentId);
    if (!conn) return;
    runUnsubscribers(conn.unsubscribers);
    connections.delete(agentId);
  }

  /**
   * Tear down a terminal connection whose tab was closed mid-handshake, unless
   * another tab for the same agent still needs it (connections are shared per
   * agent).
   */
  function releaseOrphanedTerminalConnection(agentId: string): void {
    if (
      tabs.value.some((t) => t.agentId === agentId && t.kind === 'terminal')
    ) {
      return;
    }
    const conn = connections.get(agentId);
    if (!conn) return;
    conn.client.dispose();
    void conn.peer.close();
    runUnsubscribers(conn.unsubscribers);
    connections.delete(agentId);
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {
      // Best-effort: the session may already be gone server-side.
    });
  }

  /**
   * Open a tab that shows a failure instead of a terminal.
   *
   * `TerminalSession` is not constructible without a data channel, so the
   * session is a real one bound to a channel that will never open — it exists
   * only so the rest of the store (and the tab bar) can treat this tab like any
   * other, and is replaced wholesale by `retryTab`.
   */
  function recordFailedTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    cause: unknown,
  ): void {
    const message = toErrorMessage(cause);

    const session = new TerminalSession(
      `pending-${tabId}`,
      80,
      24,
      () => {},
      () => {},
      () => {},
    );

    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'terminal',
      terminalId: `pending-${tabId}`,
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
      session,
    });
    activeTabId.value = tabId;
  }

  /**
   * A desktop tab that shows a failure instead of a video element.
   */
  function recordDesktopErrorTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    message: string,
  ): void {
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'desktop',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
    });
    activeTabId.value = tabId;
  }

  /**
   * A files tab that shows a failure instead of a file browser.
   */
  function recordFilesErrorTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    message: string,
  ): void {
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'files',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
    });
    activeTabId.value = tabId;
  }

  /**
   * Open a view-only desktop stream tab (ADR-18/ADR-19).
   *
   * Exclusivity is enforced client-side per agent: one session per agent at a
   * time (ADR-14 makes the server refuse a second anyway, but the user should
   * see why before any network call). The check is deliberately before
   * `sessions.create`, so a rejected click costs nothing.
   */
  async function openDesktopTab(
    agentId: string,
    title?: string,
  ): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    if (tabs.value.some((t) => t.agentId === agentId)) {
      recordDesktopErrorTab(
        tabId,
        agentId,
        title,
        'This agent already has an open session tab (one session per agent). Close it first.',
      );
      return tabId;
    }

    // Push the tab up front, same reasoning as `openTab`: the desktop handshake
    // waits up to 20s for the first video track, and an absent tab reads as a
    // dead click.
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'desktop',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      initStep: 'session',
    });
    activeTabId.value = tabId;
    const live = tabs.value.find((t) => t.id === tabId);

    // Set once the server session exists; the catch block uses it to release
    // that session if any later step fails (the tab cannot, because it never
    // reached `desktopConnections`).
    let sessionId: string | null = null;

    try {
      const sessionResp = await apiClient.sessions.create({ agentId });
      sessionId = sessionResp.id;
      const transport = await createSignalingTransport(sessionResp.id);
      if (live) live.initStep = 'ice';
      const iceServers = await apiClient.webrtc.getIceServers();
      const rtcPeer = createBrowserAdapter({ iceServers });

      // A control channel carries the source picker, bitrate, and stats. The
      // media path is unchanged; the label rides the existing manager (spec §5.2).
      const identity = await resolvePeerIdentity(agentId);
      // T6: build the WS1 E2EE context for the desktop session. The driver is
      // passed unconditionally; negotiateE2ee() is dormant until the agent acks,
      // so a legacy agent (no e2ee in its answer) stays plaintext — backward
      // compatible, byte-identical to today.
      const e2eeContext = await buildE2eeContext(agentId, sessionResp.id);
      const capabilities = e2eeContext ? ['desktop', 'e2ee'] : ['desktop'];
      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['control'],
        capabilities,
        media: { video: true },
        sessionId: sessionResp.id,
        identity,
      });

      const unsubscribers: Unsubscribe[] = [];

      if (transport instanceof WebSocketSignalTransport) {
        unsubscribers.push(
          transport.onServerError((code) => {
            if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
            const message =
              code === 'SESSION_TERMINATED'
                ? 'Session terminated: the agent disconnected or the session was closed.'
                : 'Session not found on the server.';
            for (const tab of tabs.value) {
              if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
              tab.status = 'error';
              tab.error = message;
              tab.initStep = undefined;
            }
            discardDesktopConnection(agentId);
          }),
        );
      }

      unsubscribers.push(
        peer.onConnectionStateChange((state) => {
          if (state !== 'failed') return;
          const message =
            'Connection failed: no direct route to the agent (ICE). Check that ' +
            'TURN is reachable, or that the agent is not behind a blocking NAT.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
            tab.status = 'error';
            tab.error = message;
            tab.initStep = undefined;
          }
          discardDesktopConnection(agentId);
        }),
      );

      const client = new DesktopClient(
        agentId,
        peer,
        { playoutDelayMs: 100 },
        e2eeContext ? new TerminalE2ee(e2eeContext) : undefined,
      );
      const inputSentTimes = new Map<number, number>();
      desktopConnections.set(agentId, {
        peer,
        client,
        sessionId: sessionResp.id,
        unsubscribers,
        inputSentTimes,
      });

      // The tab may have been closed while the handshake ran; `closeTab` found
      // no registered connection then, so release the one just built or the
      // agent's single session slot stays occupied by an orphan (ADR-14).
      if (!isTabOpen(tabId)) {
        client.close();
        void peer.close();
        runUnsubscribers(unsubscribers);
        desktopConnections.delete(agentId);
        void apiClient.sessions.terminate(sessionResp.id).catch(() => {});
        return tabId;
      }

      if (live) live.initStep = 'stream';
      const stream = await client.start();

      // The source the agent is actually streaming. Tracked so a refused pick
      // can snap the picker back (spec §2.2: "the UI keeps showing the old
      // source"); updated from the enumeration's `default` entry and from every
      // stats frame that confirms a swap.
      let confirmedSourceId: string | undefined;

      // The agent pushes its enumeration when the control channel opens, so the
      // subscription is registered after `start()` (the track arrives first).
      // Both unsubscribers go into the same list the teardown already drains.
      unsubscribers.push(
        client.onSources((payload) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (!tab) return;
          tab.desktopSources = payload.sources;
          tab.desktopInputEnabled = payload.inputEnabled;
          tab.desktopPeerVerified = payload.peerVerified;
          tab.desktopCursorInFrame = payload.cursorInFrame === true;
          const defaultId = payload.sources.find((s) => s.default)?.id;
          if (defaultId) confirmedSourceId = defaultId;
          tab.desktopSourceId ??= defaultId;
        }),
        client.onStats((stats) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (!tab) return;
          tab.desktopStats = stats;
          if (stats.status?.kind === 'select-refused') {
            // The agent kept streaming the old source; undo the optimistic pick
            // so the picker does not show a source that is not on screen.
            tab.desktopSourceId =
              confirmedSourceId ??
              tab.desktopSources?.find((s) => s.default)?.id;
            return;
          }
          // A stats frame with no refusal note confirms a pending switch.
          if (tab.desktopSourceId) confirmedSourceId = tab.desktopSourceId;
        }),
        client.onCursor((cursor) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (!tab) return;
          tab.desktopCursor = cursor;
          if (
            cursor.lastInputSeq != null &&
            inputSentTimes.has(cursor.lastInputSeq)
          ) {
            tab.desktopEchoMs = Math.max(
              0,
              Date.now() - inputSentTimes.get(cursor.lastInputSeq)!,
            );
            inputSentTimes.delete(cursor.lastInputSeq);
          }
        }),
      );

      // Mutate through the proxy (find on tabs.value) so Vue's reactivity
      // watchers fire. Mutating the raw local `tab` object after push does not
      // notify — `DesktopView`'s `watch` on `desktopStream` would never fire.
      if (live) {
        live.desktopStream = stream;
        live.status = 'active';
        live.initStep = undefined;
      }
      return tabId;
    } catch (e) {
      const message = toErrorMessage(e);
      // Drop the half-built connection so a retry does not reuse a dead peer.
      const half = desktopConnections.get(agentId);
      if (half) {
        half.client.close();
        void half.peer.close();
        runUnsubscribers(half.unsubscribers);
        desktopConnections.delete(agentId);
      }
      // Release the server session too. A failure between `sessions.create` and
      // `desktopConnections.set` left `half` undefined, so without this the
      // session held the agent's ADR-14 slot with nothing pointing at it.
      if (sessionId) {
        void apiClient.sessions.terminate(sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      if (live) {
        live.status = 'error';
        live.error = message;
        live.initStep = undefined;
      } else {
        recordDesktopErrorTab(tabId, agentId, title, message);
      }
      return tabId;
    }
  }

  /**
   * Open a files tab (Week 10, spec §7.2). Mirrors `openDesktopTab` step by
   * step: exclusivity first, tab pushed before the handshake, orphan release,
   * then the first `list('')` populates the view.
   */
  async function openFilesTab(
    agentId: string,
    title?: string,
  ): Promise<string> {
    const tabId = `tab-${crypto.randomUUID()}`;

    if (tabs.value.some((t) => t.agentId === agentId)) {
      recordFilesErrorTab(
        tabId,
        agentId,
        title,
        'This agent already has an open session tab (one session per agent). Close it first.',
      );
      return tabId;
    }

    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'files',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      initStep: 'session',
      filesPath: '',
    });
    activeTabId.value = tabId;
    const live = tabs.value.find((t) => t.id === tabId);

    let sessionId: string | null = null;

    try {
      const sessionResp = await apiClient.sessions.create({ agentId });
      sessionId = sessionResp.id;
      const transport = await createSignalingTransport(sessionResp.id);
      if (live) live.initStep = 'ice';
      const iceServers = await apiClient.webrtc.getIceServers();
      const rtcPeer = createBrowserAdapter({ iceServers });

      const identity = await resolvePeerIdentity(agentId);
      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['files'],
        capabilities: ['files'],
        sessionId: sessionResp.id,
        identity,
      });

      const unsubscribers: Unsubscribe[] = [];

      if (transport instanceof WebSocketSignalTransport) {
        unsubscribers.push(
          transport.onServerError((code) => {
            if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
            const message =
              code === 'SESSION_TERMINATED'
                ? 'Session terminated: the agent disconnected or the session was closed.'
                : 'Session not found on the server.';
            for (const tab of tabs.value) {
              if (tab.agentId !== agentId || tab.kind !== 'files') continue;
              tab.status = 'error';
              tab.error = message;
              tab.initStep = undefined;
            }
            discardFilesConnection(agentId);
          }),
        );
      }

      unsubscribers.push(
        peer.onConnectionStateChange((state) => {
          if (state !== 'failed') return;
          const message =
            'Connection failed: no direct route to the agent (ICE). Check that ' +
            'TURN is reachable, or that the agent is not behind a blocking NAT.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'files') continue;
            tab.status = 'error';
            tab.error = message;
            tab.initStep = undefined;
          }
          discardFilesConnection(agentId);
        }),
      );

      await peer.start();
      if (live) live.initStep = 'negotiating';

      try {
        await peer.waitForChannel('files');
      } catch {
        // Spec §7.4: webrtc-core's hardcoded refusal message says "one session
        // per agent", which is wrong for a gate refusal (ADR-32) and
        // indistinguishable from one. Show the honest combined wording.
        throw new Error(
          'The agent refused this session. It may be busy (one session per agent) or file access may not be configured on the agent.',
        );
      }

      if (live) live.initStep = 'channel';
      const client = new FileClient(agentId, peer.dataChannels);
      fileConnections.set(agentId, {
        peer,
        client,
        sessionId: sessionResp.id,
        unsubscribers,
      });

      // The tab may have been closed while the handshake ran; `closeTab` found
      // no registered connection then, so release the one just built (ADR-14).
      if (!isTabOpen(tabId)) {
        client.dispose();
        void peer.close();
        runUnsubscribers(unsubscribers);
        fileConnections.delete(agentId);
        void apiClient.sessions.terminate(sessionResp.id).catch(() => {});
        return tabId;
      }

      const first = await client.list('');
      if (live) {
        live.fileList = first;
        live.filesPath = first.path;
        live.status = 'active';
        live.initStep = undefined;
      }
      return tabId;
    } catch (e) {
      const message = toErrorMessage(e);
      const half = fileConnections.get(agentId);
      if (half) {
        half.client.dispose();
        void half.peer.close();
        runUnsubscribers(half.unsubscribers);
        fileConnections.delete(agentId);
      }
      if (sessionId) {
        void apiClient.sessions.terminate(sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      if (live) {
        live.status = 'error';
        live.error = message;
        live.initStep = undefined;
      } else {
        recordFilesErrorTab(tabId, agentId, title, message);
      }
      return tabId;
    }
  }

  /**
   * Re-attempt a failed tab.
   *
   * Any half-built connection for the agent is dropped first, otherwise the
   * cached `PeerConnection` from the failed attempt is returned and the retry
   * silently "succeeds" with the same dead peer.
   */
  async function retryTab(tabId: string): Promise<void> {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;
    const failed = tabs.value[index];
    if (!failed) return;

    tabs.value.splice(index, 1);
    if (failed.kind === 'desktop') {
      const conn = desktopConnections.get(failed.agentId);
      if (conn) {
        conn.client.close();
        void conn.peer.close();
        runUnsubscribers(conn.unsubscribers);
        desktopConnections.delete(failed.agentId);
        void apiClient.sessions.terminate(conn.sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      await openDesktopTab(failed.agentId, failed.title);
    } else if (failed.kind === 'files') {
      const conn = fileConnections.get(failed.agentId);
      if (conn) {
        conn.client.dispose();
        void conn.peer.close();
        runUnsubscribers(conn.unsubscribers);
        fileConnections.delete(failed.agentId);
        void apiClient.sessions.terminate(conn.sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      await openFilesTab(failed.agentId, failed.title);
    } else {
      const conn = connections.get(failed.agentId);
      if (conn) {
        runUnsubscribers(conn.unsubscribers);
        connections.delete(failed.agentId);
        // The old session is abandoned otherwise: a retried tab gets a brand
        // new session, and the previous row would stay `active` server-side.
        void apiClient.sessions.terminate(conn.sessionId).catch(() => {
          // Best-effort: the session may already be gone server-side.
        });
      }
      pendingConnections.delete(failed.agentId);
      await openTab(failed.agentId, failed.title);
    }
  }

  function setActiveTab(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  /**
   * Drop a cached desktop connection and detach its transport/peer
   * subscriptions, without touching the server session. Used by the error
   * callbacks (the peer is already dead) and by `closeDesktopConnection`.
   */
  function discardDesktopConnection(agentId: string): void {
    const conn = desktopConnections.get(agentId);
    if (!conn) return;
    runUnsubscribers(conn.unsubscribers);
    desktopConnections.delete(agentId);
  }

  /** Close a desktop tab's connection: its client, its peer, and the server session. */
  function closeDesktopConnection(agentId: string): void {
    const conn = desktopConnections.get(agentId);
    if (!conn) return;
    conn.client.close();
    void conn.peer.close();
    runUnsubscribers(conn.unsubscribers);
    desktopConnections.delete(agentId);
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
  }

  /**
   * Drop a cached files connection and detach its subscriptions, without
   * touching the server session. Used by the error callbacks. The client is
   * disposed first so in-flight transfer handles reject with 'CANCELLED'
   * immediately instead of languishing until the idle timeout.
   */
  function discardFilesConnection(agentId: string): void {
    const conn = fileConnections.get(agentId);
    if (!conn) return;
    conn.client.dispose();
    runUnsubscribers(conn.unsubscribers);
    fileConnections.delete(agentId);
  }

  /**
   * Close a files tab's connection: dispose the client (which rejects in-flight
   * handles with 'CANCELLED'), close the peer, release the session.
   */
  function closeFilesConnection(agentId: string): void {
    const conn = fileConnections.get(agentId);
    if (!conn) return;
    conn.client.dispose();
    void conn.peer.close();
    runUnsubscribers(conn.unsubscribers);
    fileConnections.delete(agentId);
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
  }

  /**
   * Close a terminal tab's connection when no other terminal tab shares the
   * agent. A shared connection stays open so the remaining tab keeps working.
   */
  function closeTerminalConnection(removed: (typeof tabs.value)[number]): void {
    try {
      removed.session?.close();
    } catch {
      // session may be a mock in tests, or already closed
    }

    const hasOtherTabsForAgent = tabs.value.some(
      (t) => t.agentId === removed.agentId && t.kind === 'terminal',
    );
    if (hasOtherTabsForAgent) return;

    const conn = connections.get(removed.agentId);
    if (!conn) return;
    conn.client.dispose();
    void conn.peer.close();
    runUnsubscribers(conn.unsubscribers);
    connections.delete(removed.agentId);
    // Tell the server the session is over. Without this the session row
    // stays `active` after the tab closes, and the agent — which sees only
    // the peer going away — is left to notice by itself. Best-effort: a
    // failed terminate must not break the close path, and the agent now
    // ends the session when the peer dies even if this request never
    // lands.
    void apiClient.sessions.terminate(conn.sessionId).catch(() => {
      // The session may already be terminated server-side (agent
      // disconnect) — a rejection here is not actionable.
    });
  }

  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const removed = tabs.value.splice(index, 1)[0];
    if (!removed) return;

    // Re-select the active tab first so the branch below runs for both kinds.
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newActive = tabs.value[Math.max(0, index - 1)];
        if (newActive) activeTabId.value = newActive.id;
      } else {
        activeTabId.value = null;
      }
    }

    if (removed.kind === 'desktop') {
      closeDesktopConnection(removed.agentId);
    } else if (removed.kind === 'files') {
      closeFilesConnection(removed.agentId);
    } else {
      closeTerminalConnection(removed);
    }
  }

  /**
   * Ask the agent to switch the desktop stream to another source (ADR-22).
   *
   * The tab records the id immediately so the picker shows the user's choice;
   * the agent's next `desktop-stats` is what confirms the switch actually took.
   * A refused switch arrives as a `status` note on that frame, not as an error.
   */
  function selectDesktopSource(tabId: string, sourceId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.selectSource(sourceId);
    tab.desktopSourceId = sourceId;
  }

  /** Set the desktop stream's target bitrate (manual control, ADR-23). */
  function setDesktopBitrate(tabId: string, bitrateBps: number): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.setBitrate(bitrateBps);
  }

  /**
   * Forward one input event to the agent (Week 9, spec §7.3).
   *
   * PM-5: pointer-move, pointer-button, and wheel events are stamped with a
   * monotonic `seq` by `DesktopClient.sendInput` (Task 13). After the call,
   * the seq is read back off the same object to record the send timestamp in
   * the connection's bounded `inputSentTimes` map, so `onCursor` can later
   * compute one-way echo latency. The map is bounded: entries older than 5 s
   * are purged, and if it grows past 100 entries the oldest are trimmed.
   */
  function sendDesktopInput(tabId: string, event: DesktopInput): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.sendInput(event);
    if (
      (event.kind === 'pointer-move' ||
        event.kind === 'pointer-button' ||
        event.kind === 'wheel') &&
      'seq' in event &&
      typeof (event as { seq?: number }).seq === 'number'
    ) {
      const seq = (event as { seq: number }).seq;
      const now = Date.now();
      conn.inputSentTimes.set(seq, now);
      if (conn.inputSentTimes.size > 100) {
        for (const [s, t] of conn.inputSentTimes) {
          if (now - t > 5000 || conn.inputSentTimes.size > 100) {
            conn.inputSentTimes.delete(s);
          }
        }
      }
    }
  }

  /** The files-only fields a tab needs while transfers run. */
  interface FileTabLike {
    fileTransfers?: Array<
      TransferProgress & {
        handle: TransferHandle;
        name: string;
        paused?: boolean;
        queueId?: string;
      }
    >;
    fileError?: string | null;
  }

  /** Update the tab's transfer entry from a progress callback. */
  function fileProgressHandler(tab: FileTabLike) {
    return (p: TransferProgress): void => {
      const entry = tab.fileTransfers?.find(
        (t) => t.transferId === p.transferId,
      );
      if (!entry) return;
      entry.bytesTransferred = p.bytesTransferred;
      entry.totalBytes = p.totalBytes;
      entry.chunkIndex = p.chunkIndex;
    };
  }

  /** List `path` and show it (spec §7.2). */
  async function filesNavigate(tabId: string, path: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    try {
      const result = await conn.client.list(path);
      tab.filesPath = result.path;
      tab.fileList = result;
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /**
   * Download `path` and save it on completion (spec §7.1/§7.2).
   *
   * Tries the Service Worker streaming path first (GAP-D): lazy, feature-detected
   * SW registration; the download is streamed chunk-by-chunk to the SW via a
   * MessagePort so a 500 MB file never sits fully in memory. Falls back to the
   * in-memory `saveBlob` path for files <= 200 MB when the SW is unavailable or
   * fails; files > 200 MB with no SW surface a warning banner.
   *
   * Concurrency is gated by the transfer queue store (spec §7.7 AC#4): only one
   * download per direction runs at a time; queued items are started by the
   * `watch` on `activeDownloadId`.
   */
  async function filesDownload(tabId: string, path: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    const name = path.split('/').pop() || path;
    const knownEntry = tab.fileList?.entries.find((e) => e.path === path);
    const size = knownEntry?.size ?? 0;

    // Enqueue before starting any I/O (spec §7.7 AC#4).
    const queueId = crypto.randomUUID();
    const item = transferQueue.enqueue({
      id: queueId,
      name,
      path,
      size,
      direction: 'download',
    });

    // The actual download logic, extracted so both the active and queued paths
    // run the same code. Returns a promise that settles the queue item.
    const startDownload = (): Promise<void> => {
      // Re-check the tab/connection are still alive.
      const live = tabs.value.find((t) => t.id === tabId);
      if (live?.kind !== 'files') {
        transferQueue.cancel(queueId, 'tab closed before download started');
        return Promise.resolve();
      }
      const tab = live;
      const conn2 = fileConnections.get(tab.agentId);
      if (!conn2) {
        transferQueue.cancel(
          queueId,
          'connection lost before download started',
        );
        return Promise.resolve();
      }

      const MAX_BLOB_FALLBACK_BYTES = 200 * 1024 * 1024;

      // --- SW streaming path (GAP-D ruling) ---
      if (swAvailable()) {
        return runSwDownload(
          live as TabItem,
          conn2.client,
          name,
          path,
          queueId,
          transferQueue,
        );
      }

      // --- Fallback: in-memory saveBlob (spec ADR-38: <= 200 MB) ---
      if (knownEntry && knownEntry.size > MAX_BLOB_FALLBACK_BYTES) {
        tab.fileError =
          'File is too large to download without Service Worker support (over 200 MB)';
        transferQueue.cancel(queueId, 'file too large for saveBlob fallback');
        return Promise.resolve();
      }
      const handle = conn2.client.download(path, fileProgressHandler(tab));
      // Register the transfer entry on the tab synchronously.
      tab.fileTransfers = [
        ...(tab.fileTransfers ?? []),
        {
          transferId: handle.transferId,
          direction: handle.direction,
          bytesTransferred: 0,
          totalBytes: 0,
          chunkIndex: -1,
          handle,
          name,
          queueId,
        },
      ];
      return (async () => {
        try {
          const bytes = (await handle.done) as Uint8Array | void;
          if (bytes) {
            saveBlob(name, bytes);
          }
          transferQueue.markCompleted(queueId);
        } catch (e) {
          if (isCancelledError(e)) {
            transferQueue.cancel(queueId);
          } else {
            tab.fileError = fileErrorText(e);
            transferQueue.cancel(queueId, fileErrorText(e));
          }
        } finally {
          tab.fileTransfers = tab.fileTransfers?.filter(
            (t) => t.transferId !== handle.transferId,
          );
        }
      })();
    };

    if (item.status === 'active') {
      // Slot is free — start immediately. startDownload executes synchronously
      // up to the first await, so the handle is registered on fileTransfers
      // before the caller yields.
      return startDownload();
    }

    // Slot is busy — register the pending start for promotion.
    pendingDownloadStarts.set(queueId, startDownload);
  }

  /**
   * In-memory blob download fallback for when the Service Worker streaming path
   * is unavailable or fails. Enforces the 200 MB cap (ADR-38) and settles the
   * queue item on success or cancellation.
   */
  async function fallbackInMemoryDownload(
    live: TabItem,
    client: FileClient,
    name: string,
    path: string,
    queueId: string,
    transferQueue: ReturnType<typeof useTransferQueueStore>,
  ): Promise<void> {
    const MAX_BLOB_FALLBACK_BYTES = 200 * 1024 * 1024;
    const knownEntry = live.fileList?.entries.find((e) => e.path === path);
    if (knownEntry && knownEntry.size > MAX_BLOB_FALLBACK_BYTES) {
      live.fileError =
        'File is too large to download without Service Worker support (over 200 MB)';
      transferQueue.cancel(queueId, 'file too large for saveBlob fallback');
      return;
    }
    const handle = client.download(path, fileProgressHandler(live));
    live.fileTransfers = [
      ...(live.fileTransfers ?? []),
      {
        transferId: handle.transferId,
        direction: handle.direction,
        bytesTransferred: 0,
        totalBytes: 0,
        chunkIndex: -1,
        handle,
        name,
      },
    ];
    try {
      const bytes = (await handle.done) as Uint8Array | void;
      if (bytes) saveBlob(name, bytes);
      transferQueue.markCompleted(queueId);
    } catch (e) {
      if (isCancelledError(e)) {
        transferQueue.cancel(queueId);
      } else {
        live.fileError = fileErrorText(e);
        transferQueue.cancel(queueId, fileErrorText(e));
      }
    } finally {
      live.fileTransfers = live.fileTransfers?.filter(
        (t) => t.transferId !== handle.transferId,
      );
    }
  }

  /**
   * The SW streaming download path: register the SW, stream chunks to it via a
   * MessagePort, then navigate to the download URL. Settles the queue item.
   */
  async function runSwDownload(
    live: TabItem,
    client: FileClient,
    name: string,
    path: string,
    queueId: string,
    transferQueue: ReturnType<typeof useTransferQueueStore>,
  ): Promise<void> {
    let swHandle: TransferHandle | null = null;
    try {
      const reg = await registerDownloadSW();
      if (!reg) {
        throw new Error('Service Worker registration failed');
      }
      const { port1, port2 } = new MessageChannel();

      const writerRef: { current: ServiceWorkerStreamWriter | null } = {
        current: null,
      };
      const handle = client.download(
        path,
        fileProgressHandler(live),
        (chunk) => {
          void writerRef.current?.writeChunk(chunk).catch(() => {
            writerRef.current?.abort();
            handle.cancel();
          });
        },
      );
      swHandle = handle;
      void handle.done.catch(() => {});

      const writer = new ServiceWorkerStreamWriter(port1, {
        transferId: handle.transferId,
        filename: name,
        size: 0,
      });
      writerRef.current = writer;

      // Register the transfer entry on the tab.
      live.fileTransfers = [
        ...(live.fileTransfers ?? []),
        {
          transferId: handle.transferId,
          direction: handle.direction,
          bytesTransferred: 0,
          totalBytes: 0,
          chunkIndex: -1,
          handle,
          name,
          queueId,
        },
      ];

      try {
        await initDownloadStream(handle.transferId, name, 0, port2);
        // Trigger the virtual stream download via a hidden anchor rather than
        // top-level navigation, so a SW routing failure can't tear down the SPA
        // and destroy the WebRTC connection.
        const a = document.createElement('a');
        a.href = `/files-download-stream/${handle.transferId}/${encodeURIComponent(name)}`;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        await handle.done;
        await writer.end();
        transferQueue.markCompleted(queueId);
      } catch (e) {
        if (isCancelledError(e)) {
          // Explicit user cancellation: do not fall back, clean up and stop.
          live.fileTransfers = live.fileTransfers?.filter(
            (t) => t.transferId !== handle.transferId,
          );
          swHandle = null;
          transferQueue.cancel(queueId);
          return;
        }
        // Streaming failure (chunk-write error, SW crashed, port closed):
        // re-throw so the outer catch cancels swHandle and falls back to
        // the in-memory saveBlob path.
        throw e;
      }
      swHandle = null;
    } catch {
      swHandle?.cancel();
      swHandle = null;
      await fallbackInMemoryDownload(
        live,
        client,
        name,
        path,
        queueId,
        transferQueue,
      );
    }
  }

  /** Upload one picked file into the current directory (spec §7.2). */
  async function filesUpload(tabId: string, file: File): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    const name = file.name;

    // Enqueue before starting any I/O (spec §7.7 AC#4): the queue store gates
    // concurrency so concurrent drops don't overwhelm the Rust agent.
    const queueId = crypto.randomUUID();
    const item = transferQueue.enqueue({
      id: queueId,
      name,
      path: tab.filesPath ?? '',
      size: file.size,
      direction: 'upload',
    });

    // The actual upload work, deferred until the item is promoted to `active`.
    const start = async () => {
      // Re-check the tab is still open; a queued item whose tab closed must
      // not start against a dead connection.
      const live = tabs.value.find((t) => t.id === tabId);
      if (live?.kind !== 'files') {
        transferQueue.cancel(queueId, 'tab closed before upload started');
        return;
      }
      const tab = live;
      const conn2 = fileConnections.get(tab.agentId);
      if (!conn2) {
        transferQueue.cancel(queueId, 'connection lost before upload started');
        return;
      }
      // Read file bytes only when promoted (spec §7.7 AC#3: < 50 MB tab memory).
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isTabOpen(tabId)) {
        transferQueue.cancel(queueId, 'tab closed during upload');
        return;
      }
      const handle = conn2.client.upload(
        tab.filesPath ?? '',
        file.name,
        bytes,
        fileProgressHandler(tab),
      );
      // Register the handle on the tab and settle the queue based on outcome.
      tab.fileTransfers = [
        ...(tab.fileTransfers ?? []),
        {
          transferId: handle.transferId,
          direction: handle.direction,
          bytesTransferred: 0,
          totalBytes: 0,
          chunkIndex: -1,
          handle,
          name: file.name,
          queueId,
        },
      ];
      try {
        await handle.done;
        transferQueue.markCompleted(queueId);
      } catch (e) {
        if (isCancelledError(e)) {
          transferQueue.cancel(queueId);
        } else {
          tab.fileError = fileErrorText(e);
          transferQueue.cancel(queueId, fileErrorText(e));
        }
      } finally {
        tab.fileTransfers = tab.fileTransfers?.filter(
          (t) => t.transferId !== handle.transferId,
        );
      }
    };

    if (item.status === 'active') {
      // Slot is free — start immediately and await settlement.
      return start();
    }

    // Slot is busy — register the pending start for promotion. The watch on
    // activeUploadId will invoke `start` when this item is promoted.
    pendingUploadStarts.set(queueId, start);
  }

  /** Cancel one active transfer by id (idempotent). */
  function filesCancelTransfer(tabId: string, transferId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    tab.fileTransfers
      ?.find((t) => t.transferId === transferId)
      ?.handle.cancel();
  }

  /** Dismiss the tab's error banner. */
  function clearFileError(tabId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind === 'files') tab.fileError = null;
  }

  /** Create a directory inside the tab's current path (spec §7.2). */
  async function filesMkdir(tabId: string, name: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    try {
      await conn.client.mkdir(tab.filesPath ?? '', name);
      await filesNavigate(tabId, tab.filesPath ?? '');
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /** Delete `path` relative to the tab's current path (spec §7.2). */
  async function filesDelete(
    tabId: string,
    path: string,
    recursive: boolean = false,
  ): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    try {
      await conn.client.delete(path, recursive);
      await filesNavigate(tabId, tab.filesPath ?? '');
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /** Rename `oldPath` to `newPath` (spec §7.2). */
  async function filesRename(
    tabId: string,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    tab.fileError = null;
    try {
      await conn.client.rename(oldPath, newPath);
      await filesNavigate(tabId, tab.filesPath ?? '');
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /** Pause an active transfer on the tab (spec §7.2). */
  async function filesPauseTransfer(
    tabId: string,
    transferId: string,
  ): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    const entry = tab.fileTransfers?.find((t) => t.transferId === transferId);
    if (!entry) return;
    try {
      await conn.client.pauseTransfer(transferId, entry.direction);
      entry.paused = true;
      if (entry.queueId) {
        transferQueue.pause(entry.queueId);
      }
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  /** Resume a paused transfer, resuming from the next chunk after the last
   *  contiguous one received/sent (spec §7.2). */
  async function filesResumeTransfer(
    tabId: string,
    transferId: string,
  ): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (tab?.kind !== 'files') return;
    const conn = fileConnections.get(tab.agentId);
    if (!conn) return;
    const entry = tab.fileTransfers?.find((t) => t.transferId === transferId);
    if (!entry) return;
    try {
      await conn.client.resumeTransfer(transferId, entry.chunkIndex + 1);
      entry.paused = false;
      if (entry.queueId) {
        transferQueue.resume(entry.queueId);
      }
    } catch (e) {
      tab.fileError = fileErrorText(e);
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    openDesktopTab,
    openFilesTab,
    retryTab,
    setActiveTab,
    closeTab,
    selectDesktopSource,
    setDesktopBitrate,
    sendDesktopInput,
    filesNavigate,
    filesDownload,
    filesUpload,
    filesCancelTransfer,
    clearFileError,
    filesMkdir,
    filesDelete,
    filesRename,
    filesPauseTransfer,
    filesResumeTransfer,
    getOrConnectAgentForTest: getOrConnectAgent,
  };
});
