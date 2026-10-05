import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { webcrypto } from 'node:crypto';
import { Hono } from 'hono';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import type { Database } from '../db/client.js';
import type { AppContext } from '../types.js';
import { agents, sessions, users } from '../db/schema.js';
import { sha256Hex } from '../utils/crypto.js';
import { NOW_SQL, recordSignal } from '../utils/signals.js';
import { buildIceServers } from '../utils/ice.js';
import { signWsTicket } from '../utils/jwt.js';
import type { TokenPayload } from '../utils/jwt.js';
import { verifyWsTicket } from '../utils/auth.js';
import { registerWsTicket, consumeWsTicket } from '../utils/ws-ticket.js';
import { getAllowedOrigins } from '../utils/cors.js';
import { getJwtSecret } from '../utils/env.js';
import { authMiddleware } from '../middleware/auth.js';
import type {
  SignalMessage,
  BrowserMessageInit,
  BrowserSocketMessage,
  IdentityProof,
} from '@ponter/shared';

const MAX_INBOUND_FRAME_BYTES = 256 * 1024;

/** WS2 agent-identity proof-of-possession: `"ponter-ws2-agent-identity-v1\nnonce=<nonce>"`. */
const WS2_IDENTITY_PROOF_PREFIX = 'ponter-ws2-agent-identity-v1\nnonce=';

/**
 * Generate a nonce for the WS2 agent-identity proof-of-possession challenge.
 *
 * 32 bytes of randomness, hex-encoded. The agent signs the proof message
 * containing this nonce, so it must not be predictable.
 */
function generateNonce(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Replay page size. Mirrors the REST poll's cap (`signal.ts:210`). */
const REPLAY_LIMIT = 200;

export interface AgentConnection {
  agentId: string;
  userId: string;
  socket: WebSocket;
  send: (data: string) => void;
  /** WS2: the nonce most recently sent in an `identity-challenge` frame. */
  identityNonce: string | null;
}

export const agentConnections = new Map<string, AgentConnection>();

/**
 * Best-effort delivery of a freshly persisted signal to the owning agent.
 *
 * Never throws. A miss (no socket in this process) is an ordinary outcome:
 * the row is already in the DB, so the agent can still recover the signal
 * through polling.
 */
export function pushToAgent(agentId: string, message: SignalMessage): boolean {
  if (!agentId) return false;

  const connection = agentConnections.get(agentId);
  if (!connection) return false;

  try {
    connection.send(JSON.stringify({ type: 'signal', data: message }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscription state for one session on one browser socket.
 *
 * `replaying` means a replay query is in flight and live pushes must be
 * buffered; `live` means pushes may go straight to the socket. The window is
 * the only moment ordering can break — a push that lands mid-replay would
 * otherwise overtake the replayed rows — so the state flips synchronously
 * before the first `await` and only back after the buffer is drained.
 *
 * `replayedIds` spans every page of a paginated replay, which is what makes
 * the dedup correct across `hasMore` rounds.
 */
export interface BrowserSubscription {
  state: 'replaying' | 'live';
  replayedIds: Set<string>;
  buffer: BrowserSocketMessage[];
}

export interface BrowserConnection {
  userId: string;
  socket: WebSocket;
  send: (data: string) => void;
  subscriptions: Map<string, BrowserSubscription>;
  lastPongAt: number;
}

export const browserConnections = new Map<string, Set<BrowserConnection>>();

/**
 * Close every live browser socket belonging to a user.
 *
 * Called when the user's right to be connected ends — a logout, or an admin
 * deactivating or rejecting the account. Without it a revocation only stopped
 * *new* connections: an already-open socket kept streaming until the tab
 * closed.
 */
export function closeUserSockets(
  userId: string,
  code = 4401,
  reason = 'Session revoked',
): void {
  const connections = browserConnections.get(userId);
  if (!connections) return;
  for (const connection of connections) {
    try {
      connection.socket.close(code, reason);
    } catch {
      // A socket already closing is an ordinary outcome.
    }
  }
}

/**
 * Best-effort delivery of a message to every browser socket of a user that is
 * subscribed to the session.
 *
 * While a subscription is `replaying`, the message is buffered instead of
 * sent: the replay is the older history, and sending now would deliver it out
 * of order. Never throws — a browser that is mid-disconnect is an ordinary
 * outcome, and the signal is already durable in the DB (pollable via REST).
 *
 * `exclude` is the sender's own connection when the message originated from
 * a browser signal frame: a peer must not receive its own signal back, which
 * for an offerer would mean re-applying its own offer.
 */
export function pushToBrowser(
  userId: string,
  sessionId: string,
  msg: BrowserSocketMessage,
  exclude?: BrowserConnection,
): boolean {
  const set = browserConnections.get(userId);
  if (!set) return false;

  let delivered = false;
  for (const connection of set) {
    if (connection === exclude) continue;
    const subscription = connection.subscriptions.get(sessionId);
    if (!subscription) continue;
    try {
      if (subscription.state === 'replaying') {
        subscription.buffer.push(msg);
      } else {
        connection.send(JSON.stringify(msg));
      }
      delivered = true;
    } catch {
      // Best-effort: a failing socket must not break the other subscribers.
    }
  }
  return delivered;
}

interface ReplayRow {
  id: string;
  sessionId: string;
  type: string;
  payload: string;
  createdAt: string;
}

/**
 * Replay the signals a (re)subscribing browser missed, then ack.
 *
 * Ordering is enforced by construction: the subscription is flipped to
 * `replaying` before the first await, so any push that races the query is
 * buffered; after the page is sent, the buffer is drained with ids that were
 * already in the page removed (a live push for a row that the replay also
 * returned must be delivered exactly once).
 *
 * A cursor whose row no longer exists (reaped by cleanup after the 5-minute
 * TTL) must NOT fall back to replaying the session from the beginning — the
 * time bound keeps the window honest. The client treats a missing old signal
 * as normal; a terminated session arrives as a live push.
 */
/**
 * The session's subscription, flipped back to `replaying` on a re-subscribe.
 *
 * A re-subscribe (pagination or client retry) keeps `replayedIds` and the
 * buffer, so dedup spans pages and buffered pushes stay in order.
 */
function getOrResetSubscription(
  connection: BrowserConnection,
  sessionId: string,
): BrowserSubscription {
  const existing = connection.subscriptions.get(sessionId);
  if (existing) {
    existing.state = 'replaying';
    return existing;
  }
  const created: BrowserSubscription = {
    state: 'replaying',
    replayedIds: new Set(),
    buffer: [],
  };
  connection.subscriptions.set(sessionId, created);
  return created;
}

/** Send one replay page, recording its ids in the subscription's dedup set. */
function sendReplayPage(
  subscription: BrowserSubscription,
  connection: BrowserConnection,
  page: ReplayRow[],
): void {
  for (const row of page) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue; // A corrupt payload cannot be delivered as a signal.
    }
    const message = parseSignalMessage({ type: row.type, data: payload });
    if (!message) continue;
    subscription.replayedIds.add(row.id);
    connection.send(
      JSON.stringify({ type: 'signal', data: message, id: row.id }),
    );
  }
}

/** Deliver pushes buffered while replaying, skipping rows already replayed. */
function drainBuffered(
  subscription: BrowserSubscription,
  connection: BrowserConnection,
): void {
  const buffered = subscription.buffer.splice(0);
  for (const frame of buffered) {
    if (frame.type === 'signal') {
      if (subscription.replayedIds.has(frame.id)) continue;
      subscription.replayedIds.add(frame.id);
    }
    connection.send(JSON.stringify(frame));
  }
}

export async function handleBrowserSubscribe(
  connection: BrowserConnection,
  sessionId: string,
  after: string | null,
  db: Database,
): Promise<void> {
  const subscription = getOrResetSubscription(connection, sessionId);

  // One statement covers both cases: with `after` NULL the subquery matches
  // no row, COALESCE yields 0, and the comparison accepts every rowid.
  const rows = await db.all<ReplayRow>(sql`
    SELECT id, session_id AS "sessionId", type, payload, created_at AS "createdAt"
    FROM signals
    WHERE session_id = ${sessionId}
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND created_at > datetime('now', '-5 minutes')
      AND rowid > COALESCE((SELECT rowid FROM signals WHERE id = ${after} AND session_id = ${sessionId}), 0)
    ORDER BY rowid ASC
    LIMIT ${REPLAY_LIMIT + 1}
  `);

  const hasMore = rows.length > REPLAY_LIMIT;
  const page = hasMore ? rows.slice(0, REPLAY_LIMIT) : rows;

  sendReplayPage(subscription, connection, page);

  // The ack cursor: the last replayed row's id, or the caller's cursor when
  // the page was empty.
  const lastId = page.at(-1)?.id ?? after;

  if (hasMore) {
    // More pages follow. Stay in `replaying`: pushes keep buffering, and the
    // buffer is drained only when the final page lands, so a push that is
    // newer than this page cannot overtake the next one.
    connection.send(
      JSON.stringify({
        type: 'subscribed',
        data: { sessionId, after: lastId, hasMore: true },
      }),
    );
    return;
  }

  drainBuffered(subscription, connection);

  // No await between draining the buffer and flipping to `live`: on a
  // single-threaded event loop this is the atomic handoff from replay to
  // live delivery.
  subscription.state = 'live';
  connection.send(
    JSON.stringify({
      type: 'subscribed',
      data: { sessionId, after: lastId, hasMore: false },
    }),
  );
}

/**
 * Validate and normalize one inbound browser frame.
 *
 * Deliberately a local mirror of `parseBrowserMessage` in `@ponter/shared`
 * rather than an import: the shared package ships TypeScript source, and the
 * production image runs `node apps/server/dist/index.js` — a runtime import
 * of it would fail at startup. The server has no other runtime dependency on
 * shared, and this keeps it that way.
 */
function normalizeBrowserFrame(frame: unknown): BrowserMessageInit | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return null;
  }

  const envelope = frame as { type?: unknown; data?: unknown };

  if (envelope.type === 'ping') {
    return { type: 'ping' };
  }

  if (envelope.type === 'subscribe') {
    const data = envelope.data as Record<string, unknown> | undefined;
    if (!data || typeof data.sessionId !== 'string' || !data.sessionId) {
      return null;
    }
    if (data.after === undefined || data.after === null) {
      return { type: 'subscribe', data: { sessionId: data.sessionId } };
    }
    if (typeof data.after !== 'string' || !data.after) {
      return null;
    }
    return {
      type: 'subscribe',
      data: { sessionId: data.sessionId, after: data.after },
    };
  }

  if (envelope.type !== 'signal') {
    return null;
  }

  const message = parseSignalMessage(envelope.data);
  if (!message) return null;
  return { type: 'signal', data: message };
}

/**
 * The session columns both signal paths check before recording a signal.
 *
 * Synchronous: better-sqlite3's `.get()` never awaits, so neither does this.
 */
function loadSignalSession(db: Database, sessionId: string) {
  return db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      agentId: sessions.agentId,
      status: sessions.status,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
}

/** Handle one inbound frame from a browser socket. Never throws. */
async function handleBrowserMessage(
  raw: unknown,
  connection: BrowserConnection,
  db: Database,
): Promise<void> {
  const sendError = (code: string): void => {
    connection.send(JSON.stringify({ type: 'error', code }));
  };

  try {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    const data = Buffer.isBuffer(raw) ? raw.toString() : raw;

    // Size is checked before parsing, in BYTES. `string.length` counts UTF-16
    // code units, so a frame of astral characters passes a length check while
    // its on-the-wire size is nearly double the limit — measuring bytes is what
    // bounds the payload handed to `JSON.parse`.
    if (Buffer.byteLength(data, 'utf8') > MAX_INBOUND_FRAME_BYTES) {
      sendError('MALFORMED_JSON');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      sendError('MALFORMED_JSON');
      return;
    }

    const frame = normalizeBrowserFrame(parsed);
    if (!frame) {
      sendError('VALIDATION_ERROR');
      return;
    }

    if (frame.type === 'ping') {
      connection.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (frame.type === 'subscribe') {
      const session = await db
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.id, frame.data.sessionId))
        .get();

      // Tenancy: another user's session is indistinguishable from a missing
      // one, so both answer NOT_FOUND.
      if (session?.userId !== connection.userId) {
        sendError('NOT_FOUND');
        return;
      }

      await handleBrowserSubscribe(
        connection,
        frame.data.sessionId,
        frame.data.after ?? null,
        db,
      );
      return;
    }

    // frame.type === 'signal'
    const message = frame.data;
    const session = loadSignalSession(db, message.data.sessionId);

    // Ownership, an agent to forward to, and a session that can still carry
    // signals are all required.
    if (session?.userId !== connection.userId || !session.agentId) {
      sendError('NOT_FOUND');
      return;
    }

    if (session.status !== 'pending' && session.status !== 'active') {
      sendError('SESSION_TERMINATED');
      return;
    }

    const inserted = await recordSignal(db, message);
    if (!inserted) {
      sendError('INTERNAL_SERVER_ERROR');
      return;
    }

    // Fire-and-forget to the agent, mirroring the REST routes.
    pushToAgent(session.agentId, message);

    // Fan out to this user's other browser sockets subscribed to the session,
    // but never echo back to the sender.
    pushToBrowser(
      connection.userId,
      message.data.sessionId,
      { type: 'signal', data: message, id: inserted.id },
      connection,
    );
  } catch (err) {
    console.error('[browser-ws] message handler failed:', err);
    sendError('INTERNAL_SERVER_ERROR');
  }
}

/** The ticket-mint router, mounted by `app.ts` at `/api/ws`. */
export const wsTicketRouter = new Hono<AppContext>();

wsTicketRouter.post('/ticket', authMiddleware, async (c) => {
  const user = c.get('user');
  const { ticket, jti } = await signWsTicket(
    user.id,
    user.username,
    getJwtSecret(),
    15,
  );
  registerWsTicket(jti);
  return c.json({ ticket, expiresIn: 15 });
});

/**
 * Handle the WebSocket upgrade for an agent connection.
 *
 * Performs authentication against the agent credential before completing the
 * WebSocket handshake. If auth fails, sends an HTTP 401 response and returns
 * false. If auth succeeds, completes the upgrade and returns true.
 */
export async function handleAgentUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): Promise<boolean> {
  const raw = extractAgentCredential(request.headers.authorization);
  if (!raw) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n',
    );
    socket.destroy();
    return false;
  }

  // Explicit path, not the bare default: `getDb` is a singleton, so this call
  // must agree with the path `startServer` opened. An argument-less call here
  // would seed `:memory:` for a server that never reached the eager open (a
  // test, or an upgrade before `startServer`), and every credential lookup
  // would then miss.
  const db = getDb(process.env.DATABASE_PATH);
  const credentialHash = await sha256Hex(raw);

  const agent = await db
    .select({ id: agents.id, userId: agents.userId })
    .from(agents)
    .where(eq(agents.credentialHash, credentialHash))
    .get();

  if (!agent) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n',
    );
    socket.destroy();
    return false;
  }

  const agentId = agent.id;
  const userId = agent.userId;

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, agentId, userId, db);
  });

  return true;
}

/**
 * Handle the WebSocket upgrade for a browser connection.
 *
 * The ticket travels in the query string (the browser WebSocket API cannot
 * set headers), so the checks here are the only gate: a valid, unconsumed,
 * ws-scoped ticket AND an allowed Origin (CSWSH). Every failure writes a raw
 * HTTP response and destroys the socket — the handshake never completes, so
 * no WebSocket-level close code is available.
 *
 * The URL is never logged: it contains the ticket.
 */
export async function handleBrowserUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  options: BrowserWebSocketOptions = {},
): Promise<boolean> {
  const reject = (status: number, reason: string): false => {
    // The request URL carries the ticket, so log the path alone. A 401/403 on
    // this route is worth seeing in an incident (a misconfigured proxy, a
    // rotated secret), but the credential itself must not outlive its 15s TTL
    // in a log aggregator.
    const path = (request.url ?? '').split('?')[0] ?? '';
    console.warn(`[browser-ws] upgrade rejected: ${status} ${path}`);
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return false;
  };

  let ticket: string | null = null;
  try {
    const url = new URL(request.url ?? '', 'http://localhost');
    ticket = url.searchParams.get('ticket');
  } catch {
    return reject(401, 'Unauthorized');
  }

  if (!ticket) {
    return reject(401, 'Unauthorized');
  }

  let payload: TokenPayload;
  try {
    payload = await verifyWsTicket(ticket, getJwtSecret());
  } catch {
    return reject(401, 'Unauthorized');
  }

  // One-time: a consumed or unknown jti is indistinguishable from an invalid
  // ticket, and the response is the same 401.
  if (!consumeWsTicket(payload.jti)) {
    return reject(401, 'Unauthorized');
  }

  // A ticket is minted with a 15s TTL, so a user can be deactivated between
  // mint and upgrade. Re-check the account here: the ticket proves the token
  // was valid at mint time, not that the account still is.
  const db = getDb(process.env.DATABASE_PATH);
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();
  if (!user?.isActive || user.approvalStatus !== 'approved') {
    return reject(401, 'Unauthorized');
  }

  const allowed = getAllowedOrigins();
  if (allowed !== '*') {
    const origin = request.headers.origin;
    if (!origin || !allowed.includes(origin)) {
      return reject(403, 'Forbidden');
    }
  }

  const userId = payload.sub;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, userId, options);
  });
  return true;
}

export interface BrowserWebSocketOptions {
  /** How often the server sends a protocol-level ping. */
  pingIntervalMs?: number;
  /** How long without a pong before the socket is closed with 4408. */
  pongTimeoutMs?: number;
}

/**
 * Create the WebSocketServer that owns browser connections.
 *
 * Liveness uses protocol-level `ws.ping()`, not an application frame: the
 * browser answers pings in the WebSocket implementation itself (RFC 6455),
 * so a backgrounded tab whose JS is throttled still answers. An app-level
 * ping would wait on throttled JS and declare a healthy tab dead.
 */
export function createBrowserWebSocketServer(
  options: BrowserWebSocketOptions = {},
): WebSocketServer {
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 90_000;
  const wss = new WebSocketServer({ noServer: true });

  wss.on(
    'connection',
    (socket: WebSocket, _request: IncomingMessage, userId?: string) => {
      if (!userId) {
        socket.close(4401, 'Unauthorized');
        return;
      }

      const connection: BrowserConnection = {
        userId,
        socket,
        send: (data: string) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        },
        subscriptions: new Map(),
        lastPongAt: Date.now(),
      };

      let set = browserConnections.get(userId);
      if (!set) {
        set = new Set();
        browserConnections.set(userId, set);
      }
      set.add(connection);

      const keepalive = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - connection.lastPongAt > pongTimeoutMs) {
          socket.close(4408, 'Pong timeout');
          return;
        }
        try {
          socket.ping();
        } catch {
          // A socket that cannot be pinged is about to emit 'close'.
        }
      }, pingIntervalMs);
      // Do not hold the event loop open on the timer's account alone.
      keepalive.unref?.();

      socket.on('pong', () => {
        connection.lastPongAt = Date.now();
      });

      socket.on('message', (rawMsg: unknown) => {
        void handleBrowserMessage(
          rawMsg,
          connection,
          getDb(process.env.DATABASE_PATH),
        );
      });

      socket.on('close', () => {
        clearInterval(keepalive);
        const currentSet = browserConnections.get(userId);
        if (!currentSet) return;
        currentSet.delete(connection);
        if (currentSet.size === 0) {
          browserConnections.delete(userId);
        }
      });
    },
  );

  wss.on('error', (err: Error) => {
    console.error('[BrowserWebSocketServer] error:', err);
  });

  return wss;
}

/**
 * Create a WebSocketServer with the agent connection handler attached.
 * The server is configured for `noServer: true` and is driven by the HTTP
 * server's `upgrade` event.
 */
export function createAgentWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on(
    'connection',
    async (
      socket: WebSocket,
      _request: IncomingMessage,
      agentId?: string,
      userId?: string,
      db?: Database,
    ) => {
      if (!agentId || !userId || !db) {
        socket.close(4401, 'Unauthorized');
        return;
      }

      // Evict any previous connection for this agent (reconnect supersedes).
      const previous = agentConnections.get(agentId);
      if (previous) {
        previous.socket.close(4409, 'Replaced by new connection');
      }

      const connection: AgentConnection = {
        agentId,
        userId,
        socket,
        send: (data: string) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        },
        identityNonce: null,
      };
      agentConnections.set(agentId, connection);

      // Hand the agent its ICE configuration. An agent cannot call
      // `GET /api/webrtc/ice-servers` — that route authenticates a user JWT,
      // while this socket is authenticated by the agent credential — so without
      // this push the agent builds its RTCPeerConnection with no STUN/TURN and
      // only reaches a browser on the same LAN.
      socket.send(
        JSON.stringify({
          type: 'ice-servers',
          data: { iceServers: buildIceServers(userId) },
        }),
      );

      // WS2: challenge the agent to prove possession of its Ed25519 signing key.
      // The agent signs the proof message `"<prefix>\nnonce=<nonce>"` with the
      // private half and echoes the nonce back; the server verifies and stores
      // the public key on the agent row. Sent after the ICE push so the ordering
      // on the wire is deterministic (ICE config, then identity challenge).
      const nonce = generateNonce();
      connection.identityNonce = nonce;
      socket.send(
        JSON.stringify({
          type: 'identity-challenge',
          data: { nonce },
        }),
      );

      // Mark online immediately so a freshly connected agent is not reported offline.
      await db
        .update(agents)
        .set({ isOnline: true, lastPingAt: NOW_SQL })
        .where(eq(agents.id, agentId));

      socket.on('message', (rawMsg: unknown) => {
        void handleInboundMessage(rawMsg, connection, db);
      });

      socket.on('close', async () => {
        // Guard against stale close evicting a live socket (superseded reconnects).
        const current = agentConnections.get(agentId);
        if (current?.socket !== socket) return;

        agentConnections.delete(agentId);

        await db
          .update(agents)
          .set({ isOnline: false })
          .where(eq(agents.id, agentId));

        // End sessions bound to this agent that are still active, and tell
        // each browser waiting on one that the handshake can no longer
        // complete — otherwise the tab sits on "connecting" until its own
        // timeout, with no way to tell a dead agent from a slow one.
        const terminated = await db
          .update(sessions)
          .set({ status: 'terminated', endedAt: NOW_SQL, updatedAt: NOW_SQL })
          .where(
            and(
              eq(sessions.agentId, agentId),
              inArray(sessions.status, ['pending', 'active']),
            ),
          )
          .returning({ id: sessions.id, userId: sessions.userId });

        for (const row of terminated) {
          pushToBrowser(row.userId, row.id, {
            type: 'error',
            code: 'SESSION_TERMINATED',
          });
        }
      });
    },
  );

  wss.on('error', (err: Error) => {
    console.error('[WebSocketServer] error:', err);
  });

  return wss;
}

/**
 * Verify an agent's WS2 identity proof and persist its Ed25519 signing public key.
 *
 * On a valid signature: `UPDATE agents SET signing_public_key = ? WHERE id = ?`.
 * On a bad or missing signature: close the socket with 4401 and do NOT store.
 *
 * Fail-closed — any exception or malformed input rejects the proof without
 * writing the key.
 */
async function handleAgentIdentity(
  data: unknown,
  connection: AgentConnection,
  db: Database,
): Promise<void> {
  // Validate the frame shape first; a malformed proof must not throw.
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    connection.socket.close(4401, 'Invalid agent-identity frame');
    return;
  }

  const { publicKey, nonce, signature } = data as {
    publicKey?: unknown;
    nonce?: unknown;
    signature?: unknown;
  };

  if (
    typeof publicKey !== 'string' ||
    typeof nonce !== 'string' ||
    typeof signature !== 'string'
  ) {
    connection.socket.close(4401, 'Invalid agent-identity fields');
    return;
  }

  // The nonce must match the one we sent on connect. A mismatch (replay, stale
  // frame, or wrong agent) is a 4401.
  if (connection.identityNonce !== nonce) {
    connection.socket.close(4401, 'Nonce mismatch');
    return;
  }

  const expectedMessage = `${WS2_IDENTITY_PROOF_PREFIX}${nonce}`;

  try {
    const key = await webcrypto.subtle.importKey(
      'raw',
      Buffer.from(publicKey, 'base64'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    const valid = await webcrypto.subtle.verify(
      'Ed25519',
      key,
      Buffer.from(signature, 'base64'),
      new TextEncoder().encode(expectedMessage),
    );

    if (!valid) {
      connection.socket.close(4401, 'Bad signature');
      return;
    }

    await db
      .update(agents)
      .set({ signingPublicKey: publicKey })
      .where(eq(agents.id, connection.agentId));

    // Clear the nonce so a stale replay cannot be re-verified.
    connection.identityNonce = null;
  } catch {
    // Import/verify/crypto failure: fail closed, do not store the key.
    connection.socket.close(4401, 'Identity proof failed');
    return;
  }
}

/**
 * Handle an inbound frame from an agent socket.
 *
 * Every failure is an error *frame*, never a throw: this runs inside a
 * `message` event listener.
 */
async function handleInboundMessage(
  raw: unknown,
  connection: AgentConnection,
  db: Database,
): Promise<void> {
  // Binary frames carry no defined meaning on this socket.
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;

  const data = Buffer.isBuffer(raw) ? raw.toString() : raw;

  // Size is checked before parsing, in BYTES (see `handleBrowserMessage`).
  if (Buffer.byteLength(data, 'utf8') > MAX_INBOUND_FRAME_BYTES) {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }),
    );
    return;
  }

  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }),
    );
    return;
  }

  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }),
    );
    return;
  }

  const envelope = frame as { type?: unknown; data?: unknown };

  if (envelope.type === 'ping') {
    await db
      .update(agents)
      .set({ isOnline: true, lastPingAt: NOW_SQL })
      .where(eq(agents.id, connection.agentId));
    connection.socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  // WS2: proof-of-possession of the agent's Ed25519 signing key.
  if (envelope.type === 'agent-identity') {
    await handleAgentIdentity(envelope.data, connection, db);
    return;
  }

  if (envelope.type !== 'signal') {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }),
    );
    return;
  }

  const message = parseSignalMessage(envelope.data);
  if (!message) {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }),
    );
    return;
  }

  const session = loadSignalSession(db, message.data.sessionId);

  // Tenancy is BOTH halves. An agentless session is also rejected.
  if (
    !session ||
    session.userId !== connection.userId ||
    session.agentId !== connection.agentId
  ) {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'NOT_FOUND' }),
    );
    return;
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'SESSION_NOT_ACTIVE' }),
    );
    return;
  }

  const inserted = await recordSignal(db, message);
  if (!inserted) {
    connection.socket.send(
      JSON.stringify({ type: 'error', code: 'INTERNAL_SERVER_ERROR' }),
    );
    return;
  }

  // Fan the agent's signal out to every browser socket subscribed to this
  // session. This is the browser-side replacement for polling: the row is
  // durable, but a waiting tab should not have to ask for it.
  pushToBrowser(session.userId, message.data.sessionId, {
    type: 'signal',
    data: message,
    id: inserted.id,
  });

  // Echo the accepted signal so the agent can correlate it with the DB row.
  connection.socket.send(JSON.stringify({ type: 'signal', data: message }));
}

function extractAgentCredential(
  header: string | string[] | undefined,
): string | null {
  if (!header || Array.isArray(header)) return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  return token;
}

/**
 * Shape-only validation for IdentityProof (spec §1): the server is a pure
 * relay and never verifies the signature. Returns the proof verbatim when well
 * formed, or `undefined` when absent/malformed (dropped, not rejected).
 */
function normalizeProof(proof: unknown): IdentityProof | undefined {
  if (proof === undefined || proof === null) return undefined;
  if (typeof proof !== 'object' || Array.isArray(proof)) return undefined;
  const p = proof as Record<string, unknown>;
  const signature =
    typeof p.signature === 'string' && p.signature ? p.signature : null;
  const fingerprint =
    typeof p.fingerprint === 'string' && p.fingerprint ? p.fingerprint : null;
  if (!signature || !fingerprint) return undefined;
  return { signature, fingerprint };
}

function parseSignalMessage(frame: unknown): SignalMessage | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
    return null;
  const data = frame as Record<string, unknown>;

  if (data.type === 'offer') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.sdp !== 'string' || !inner.sdp) return null;
    const capabilities = Array.isArray(inner.capabilities)
      ? inner.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    // Server is a pure relay for IdentityProof (spec §1): transport verbatim.
    // The browser-to-agent path drops unknown fields elsewhere, so proof must
    // be carried explicitly here.
    const proof = normalizeProof(inner.proof);
    return {
      type: 'offer',
      data: {
        sessionId: inner.sessionId,
        sdp: inner.sdp,
        capabilities,
        ...(proof ? { proof } : {}),
      },
    } as SignalMessage;
  }

  if (data.type === 'answer') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.sdp !== 'string' || !inner.sdp) return null;
    // Server is a pure relay for IdentityProof (spec §1): transport verbatim.
    const proof = normalizeProof(inner.proof);
    return {
      type: 'answer',
      data: {
        sessionId: inner.sessionId,
        sdp: inner.sdp,
        approved: inner.approved !== false,
        ...(proof ? { proof } : {}),
      },
    } as SignalMessage;
  }

  if (data.type === 'ice-candidate') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.candidate !== 'string' || !inner.candidate) return null;
    const sdpMid = typeof inner.sdpMid === 'string' ? inner.sdpMid : null;
    const sdpMLineIndex =
      typeof inner.sdpMLineIndex === 'number' &&
      Number.isInteger(inner.sdpMLineIndex) &&
      inner.sdpMLineIndex >= 0 &&
      inner.sdpMLineIndex <= 65535
        ? inner.sdpMLineIndex
        : null;
    return {
      type: 'ice-candidate',
      data: {
        sessionId: inner.sessionId,
        candidate: inner.candidate,
        sdpMid,
        sdpMLineIndex,
      },
    } as SignalMessage;
  }

  return null;
}
