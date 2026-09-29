import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import type { Database } from '../db/client.js';
import { agents, sessions } from '../db/schema.js';
import { sha256Hex } from '../utils/crypto.js';
import { NOW_SQL, recordSignal } from '../utils/signals.js';
import { buildIceServers } from '../utils/ice.js';
import type { SignalMessage } from '@remote/shared';

const MAX_INBOUND_FRAME_BYTES = 256 * 1024;

export interface AgentConnection {
  agentId: string;
  userId: string;
  socket: WebSocket;
  send: (data: string) => void;
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

  const db = getDb();
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

        // End sessions bound to this agent that are still active.
        await db
          .update(sessions)
          .set({ status: 'terminated', endedAt: NOW_SQL, updatedAt: NOW_SQL })
          .where(
            and(
              eq(sessions.agentId, agentId),
              inArray(sessions.status, ['pending', 'active']),
            ),
          );
      });
    },
  );

  wss.on('error', (err: Error) => {
    console.error('[WebSocketServer] error:', err);
  });

  return wss;
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

  // Size is checked before parsing.
  if (data.length > MAX_INBOUND_FRAME_BYTES) {
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

  const session = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      agentId: sessions.agentId,
      status: sessions.status,
    })
    .from(sessions)
    .where(eq(sessions.id, message.data.sessionId))
    .get();

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
    return {
      type: 'offer',
      data: { sessionId: inner.sessionId, sdp: inner.sdp, capabilities },
    } as SignalMessage;
  }

  if (data.type === 'answer') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.sdp !== 'string' || !inner.sdp) return null;
    return {
      type: 'answer',
      data: {
        sessionId: inner.sessionId,
        sdp: inner.sdp,
        approved: inner.approved !== false,
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
