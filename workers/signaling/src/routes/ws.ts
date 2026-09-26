import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../types';
import type { Database } from '../db/client';
import { getDb } from '../db/client';
import { agents, sessions } from '../db/schema';
import { AppError } from '../middleware/error';
import { sha256Hex } from '../utils/crypto';
import { NOW_SQL, parseSignalMessage, recordSignal } from '../utils/signals';
import type { SignalMessage } from '@remote/shared';

/**
 * Live agent sockets, keyed by `agents.id`.
 *
 * Module scope, and therefore **per isolate**: Cloudflare may run several
 * isolates, the socket lives in the isolate that accepted it, and a request
 * served elsewhere sees an empty map. Nothing may depend on a hit here — D1
 * plus the browser's poll is the delivery guarantee, and this map is a latency
 * optimisation (W15).
 */
export type AgentConnection = {
  agentId: string;
  userId: string;
  socket: WebSocket;
};

export const agentConnections = new Map<string, AgentConnection>();

/**
 * Refuse an inbound text frame larger than this before `JSON.parse` sees it.
 *
 * §7.4 edge 4: "the peer is authenticated but not trusted". A 64 KiB SDP is
 * already implausible and a megabyte frame is certainly hostile, so this bounds
 * the allocation a single frame can force. `parseSignalMessage` cannot help
 * here — by the time it runs, `JSON.parse` has already built the object graph.
 */
export const MAX_INBOUND_FRAME_BYTES = 256 * 1024;

/**
 * Best-effort delivery of a freshly persisted signal to the owning agent.
 *
 * Never throws. A miss (no socket in this isolate) and a dead socket are both
 * ordinary outcomes, not request failures: the row is already in D1, so the
 * agent can still recover the signal through the same poll the browser uses.
 * Returning `void` rather than a `Promise` makes that structural — there is
 * nothing for a future edit to `await` (D9).
 */
export function pushToAgent(
  agentId: string | null,
  message: SignalMessage,
): void {
  if (!agentId) return;

  const connection = agentConnections.get(agentId);
  if (!connection) return;

  try {
    connection.socket.send(JSON.stringify({ type: 'signal', data: message }));
  } catch {
    // W7: a server-side socket throws on send() once it has closed. Drop it so
    // the next push skips it. `close` also fires for this socket and is
    // identity-guarded, so removing the entry here cannot evict a newer one.
    if (agentConnections.get(agentId)?.socket === connection.socket) {
      agentConnections.delete(agentId);
    }
  }
}

// `NOW_SQL` is deliberately NOT defined here: Task 3 defines it once in
// `utils/signals.ts` and this file imports it. A second local copy is exactly
// how two files drift into `(datetime('now'))` vs `datetime('now')).

function extractAgentCredential(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  return token;
}

/**
 * Handle one inbound frame from an agent socket.
 *
 * Every failure is an error *frame*, never a throw: this runs inside a
 * `message` event listener, and an exception escaping it can tear down the
 * socket and, in the worst case, the isolate (Review Focus #4).
 */
async function handleInbound(
  raw: unknown,
  socket: { send: (data: string) => void },
  ctx: { db: Database; agentId: string; userId: string },
): Promise<void> {
  // Binary frames carry no defined meaning on this socket.
  if (typeof raw !== 'string') return;

  // Size is checked before parsing (D18). A frame at or over the cap is refused
  // without ever reaching `JSON.parse`, so a hostile peer cannot make the
  // isolate allocate an object graph proportional to the frame.
  if (raw.length > MAX_INBOUND_FRAME_BYTES) {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    socket.send(JSON.stringify({ type: 'error', code: 'MALFORMED_JSON' }));
    return;
  }

  const envelope = frame as { type?: unknown; data?: unknown };

  if (envelope.type === 'ping') {
    await ctx.db
      .update(agents)
      .set({ isOnline: true, lastPingAt: NOW_SQL })
      .where(eq(agents.id, ctx.agentId))
      .run();
    socket.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (envelope.type !== 'signal') {
    socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
    return;
  }

  const message = parseSignalMessage(envelope.data);
  if (!message) {
    socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
    return;
  }

  const session = await ctx.db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      agentId: sessions.agentId,
    })
    .from(sessions)
    .where(eq(sessions.id, message.data.sessionId))
    .get();

  // Tenancy is BOTH halves. `session.agentId` is nullable, so the `!==`
  // comparison against a non-null id rejects an agentless session too — an
  // `if (session.agentId && …)` guard would let it through. Every rejection
  // returns the same NOT_FOUND, so the socket cannot enumerate sessions.
  if (
    !session ||
    session.userId !== ctx.userId ||
    session.agentId !== ctx.agentId
  ) {
    socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
    return;
  }

  const inserted = await recordSignal(ctx.db, message);
  if (!inserted) {
    socket.send(
      JSON.stringify({ type: 'error', code: 'INTERNAL_SERVER_ERROR' }),
    );
    return;
  }

  // Echo the accepted signal so the agent can correlate it with the D1 row
  // without a second round trip. Same envelope as a push, so the Rust client
  // needs one arm (D15).
  socket.send(JSON.stringify({ type: 'signal', data: message }));
}

const router = new Hono<AppContext>();

router.get('/agent', async (c) => {
  // D4: authenticate before the Upgrade guard, so a request with no credential
  // is 401 and never 426.
  const raw = extractAgentCredential(c.req.header('Authorization'));
  const db = getDb(c.env.DB);

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.credentialHash, await sha256Hex(raw)))
    .get();

  if (!agent) {
    // Same status, message, and code as a malformed header, so the endpoint
    // cannot be used to enumerate credentials.
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }

  // D6/W6: without this, a valid credential plus a non-upgrade GET is a 500 in
  // real workerd.
  if (c.req.header('Upgrade') !== 'websocket') {
    throw new AppError('Upgrade Required', 426, 'UPGRADE_REQUIRED');
  }

  const agentId = agent.id;
  const userId = agent.userId;

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  // D2/W5: registered before the 101 is returned. A reconnect replaces the
  // previous socket, so the map holds exactly one entry per agent.
  agentConnections.set(agentId, { agentId, userId, socket: server });

  server.addEventListener('message', (evt) => {
    void handleInbound(evt.data, server, { db, agentId, userId });
  });

  server.addEventListener('close', () => {
    // D8/W8: a superseded socket may still fire close after a newer socket has
    // replaced it. Without this guard the stale close evicts the live socket
    // and clears `is_online` for a connected agent.
    const current = agentConnections.get(agentId);
    if (current?.socket !== server) return;

    agentConnections.delete(agentId);
    void db
      .update(agents)
      .set({ isOnline: false })
      .where(eq(agents.id, agentId))
      .run();
  });

  server.accept();

  // D11: set on connect, not only on the first ping, so a freshly connected
  // agent is not reported offline for up to one ping interval.
  await db
    .update(agents)
    .set({ isOnline: true, lastPingAt: NOW_SQL })
    .where(eq(agents.id, agentId))
    .run();

  return new Response(null, { status: 101, webSocket: client });
});

export default router;
