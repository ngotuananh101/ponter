import { DurableObject } from 'cloudflare:workers';
import type { Database } from '../db/client';
import { getDb } from '../db/client';
import { agents, sessions } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { NOW_SQL, parseSignalMessage, recordSignal } from '../utils/signals';
import { MAX_INBOUND_FRAME_BYTES, agentConnections } from '../routes/ws';
import type { Bindings } from '../types';

export class AgentSignalingDO extends DurableObject<Bindings> {
  private agentSocket: WebSocket | null = null;
  private agentId: string | null = null;
  private userId: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Push signal endpoint called by REST routes across isolates
    if (url.pathname === '/push' && request.method === 'POST') {
      const body = await request.json();
      if (this.agentSocket) {
        try {
          const payload =
            typeof body === 'object' &&
            body !== null &&
            'type' in body &&
            body.type === 'signal'
              ? JSON.stringify(body)
              : JSON.stringify({ type: 'signal', data: body });
          this.agentSocket.send(payload);
        } catch {
          // Socket might have closed
        }
      }
      return new Response('ok');
    }

    // WebSocket upgrade endpoint for the agent
    if (request.headers.get('Upgrade') === 'websocket') {
      const agentId = request.headers.get('X-Agent-Id');
      const userId = request.headers.get('X-User-Id');
      if (!agentId || !userId) {
        return new Response('Missing agent/user id', { status: 400 });
      }

      this.agentId = agentId;
      this.userId = userId;

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      this.agentSocket = server;
      server.accept();

      agentConnections.set(agentId, {
        agentId,
        userId,
        socket: server,
        push: (data: string) => {
          try {
            server.send(data);
          } catch {
            // Socket might have closed
          }
        },
        stop: () => {},
      });

      const db = getDb(this.env.DB);

      // Set online immediately upon connection accept (D11/W10)
      void db
        .update(agents)
        .set({ isOnline: true, lastPingAt: NOW_SQL })
        .where(eq(agents.id, agentId))
        .run();

      server.addEventListener('message', (evt) => {
        void this.handleInbound(evt.data, server, db, agentId, userId);
      });

      server.addEventListener('close', () => {
        if (this.agentSocket !== server) return;
        this.agentSocket = null;
        agentConnections.delete(agentId);

        void db
          .update(agents)
          .set({ isOnline: false })
          .where(eq(agents.id, agentId))
          .run();

        void db
          .update(sessions)
          .set({ status: 'terminated', endedAt: NOW_SQL, updatedAt: NOW_SQL })
          .where(
            and(
              eq(sessions.agentId, agentId),
              inArray(sessions.status, ['pending', 'active']),
            ),
          )
          .run();
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleInbound(
    raw: unknown,
    socket: WebSocket,
    db: Database,
    agentId: string,
    userId: string,
  ): Promise<void> {
    if (typeof raw !== 'string') return;
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
      await db
        .update(agents)
        .set({ isOnline: true, lastPingAt: NOW_SQL })
        .where(eq(agents.id, agentId))
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

    if (!session || session.userId !== userId || session.agentId !== agentId) {
      socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
      return;
    }

    if (session.status !== 'pending' && session.status !== 'active') {
      socket.send(
        JSON.stringify({ type: 'error', code: 'SESSION_NOT_ACTIVE' }),
      );
      return;
    }

    const inserted = await recordSignal(db, message);
    if (!inserted) {
      socket.send(
        JSON.stringify({ type: 'error', code: 'INTERNAL_SERVER_ERROR' }),
      );
      return;
    }

    socket.send(JSON.stringify({ type: 'signal', data: message }));
  }
}
