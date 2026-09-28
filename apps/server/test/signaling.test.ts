import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { agentConnections } from '../src/routes/ws.js';
import type { Database } from '../src/db/client.js';
import { agents, sessions, signals } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { SignalMessage, AgentSocketMessage } from '@remote/shared';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// In-process secrets for tests
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

const TURN_SECRET = 'test-turn-secret-123';

type AuthResponse = {
  user: { id: string; username: string };
  token: string;
  refreshToken: string;
  expiresIn: number;
};

type AgentResponse = {
  agent: { id: string; userId: string; publicKey: string };
  credential: string;
};

type SessionResponse = {
  id: string;
  userId: string;
  agentId: string | null;
  status: string;
};

/** Small delay helper for async WS propagation */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for a condition to become truthy. */
async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 1000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) return result;
    await wait(10);
  }
  throw new Error('Timed out waiting for condition');
}

/** Start the signaling server on an ephemeral port and return port + cleanup. */
async function startOnEphemeral(): Promise<{ port: number; server: Server }> {
  const app = createSignalingServer();
  const { server } = app;

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({ port: (addr as AddressInfo).port, server });
      } else {
        reject(new Error('Failed to get port'));
      }
    });
    server.on('error', reject);
  });
}

describe('WebRTC Signaling, WebSocket Dispatcher & ICE Servers', () => {
  let db: Database;
  let token: string;
  let userId: string;
  let credential: string;
  let agentId: string;
  let sessionId: string;
  let servers: Server[] = [];

  beforeEach(async () => {
    db = getDb(':memory:');

    // Register user and get JWT
    const signalingServer = createSignalingServer();
    const app = signalingServer.app;
    const regRes = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'tester',
          password: 'Password123!',
          publicKey: 'pk_tester',
        }),
      }),
    );

    const regData = (await regRes.json()) as AuthResponse;
    token = regData.token;
    userId = regData.user.id;

    // Register an agent
    const agentRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_ws_test',
          hostname: 'test-host',
          publicKey: 'pk_agent',
        }),
      }),
    );

    const agentData = (await agentRes.json()) as AgentResponse;
    credential = agentData.credential;
    agentId = agentData.agent.id;

    // Create a session bound to the agent
    const sessRes = await app.fetch(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId }),
      }),
    );

    const sessData = await sessRes.json() as SessionResponse;
    sessionId = sessData.id;
  });

  afterEach(() => {
    agentConnections.clear();
    closeDb();
  });

  describe('WebSocket connection & ping/pong', () => {
    it('rejects connection without Bearer credential with 401', async () => {
      const { port } = await startOnEphemeral();

      const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`);
      const result: number[] = [];

      await new Promise<void>((resolve) => {
        ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => {
          result.push(res.statusCode);
          ws.close();
          resolve();
        });
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', () => resolve());
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(401);
    }, 10000);

    it('agent connects, pings, and receives pong with last_ping_at updated', async () => {
      const { port } = await startOnEphemeral();

      const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
        headers: { Authorization: `Bearer ${credential}` },
      });

      await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Collect messages
      const received: string[] = [];
      ws.on('message', (data: Buffer) => {
        received.push(data.toString());
      });

      // Send ping
      ws.send(JSON.stringify({ type: 'ping' }));

      // Receive pong
      const msg = await waitFor(() => received[0]);

      expect(msg).toBe(JSON.stringify({ type: 'pong' }));

      ws.close();

      // Verify last_ping_at was updated in DB
      const agent = await db
        .select({ lastPingAt: agents.lastPingAt, isOnline: agents.isOnline })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get();

      expect(agent?.isOnline).toBe(true);
      expect(agent?.lastPingAt).not.toBeFalsy();
    });

    it('removes connection and marks offline on close', async () => {
      const { port, server: httpServer } = await startOnEphemeral();

      const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
        headers: { Authorization: `Bearer ${credential}` },
      });

      await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
      ws.close();

      await waitFor(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));

      // Allow the async close handler to persist isOnline=false to the DB.
      await wait(200);

      const agent = await db
        .select({ isOnline: agents.isOnline })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get();

      expect(agent?.isOnline).toBe(false);

      httpServer.close();
    });
  });

  describe('Signal routing via WebSocket', () => {
    it('browser posts offer and agent instantly receives signal over WS', async () => {
      const { port, server: httpServer } = await startOnEphemeral();

      // Connect agent
      const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
        headers: { Authorization: `Bearer ${credential}` },
      });

      await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));

      // Collect messages received by the agent
      const received: string[] = [];
      ws.on('message', (data: Buffer) => {
        received.push(data.toString());
      });

      await wait(50);

      // Browser posts offer via the HTTP server (same Hono instance)
      const offerRes = await fetch(`http://localhost:${port}/api/signal/offer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sessionId,
          sdp: 'v=0-o=offer',
          capabilities: ['terminal', 'files'],
        }),
      });

      expect(offerRes.status).toBe(201);
      const offerBody = await offerRes.json() as { id: string };
      expect(offerBody.id).toBeDefined();

      // Wait for the agent to receive the signal
      const signalMsg = await waitFor(() => {
        const signal = received.find((m) => {
          try {
            const parsed = JSON.parse(m) as AgentSocketMessage;
            return parsed.type === 'signal';
          } catch {
            return false;
          }
        });
        return signal ? (JSON.parse(signal) as AgentSocketMessage) : undefined;
      });

      expect(signalMsg.type).toBe('signal');
      const msg = signalMsg.data as SignalMessage;
      expect(msg.type).toBe('offer');
      expect(msg.data.sessionId).toBe(sessionId);

      // Verify signal was recorded in DB
      const signalRows = await db.select().from(signals).where(eq(signals.sessionId, sessionId)).all();
      expect(signalRows.length).toBeGreaterThanOrEqual(1);

      ws.close();
      httpServer.close();
    }, 10000);

    it('agent answer over WebSocket is recorded and browser can poll it', async () => {
      const { port, server: httpServer } = await startOnEphemeral();

      // Connect agent
      const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
        headers: { Authorization: `Bearer ${credential}` },
      });

      await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));

      const received: string[] = [];
      ws.on('message', (data: Buffer) => {
        received.push(data.toString());
      });

      await wait(50);

      // Agent sends answer
      const answerMsg: AgentSocketMessage = {
        type: 'signal',
        data: {
          type: 'answer',
          data: {
            sessionId,
            sdp: 'v=0-o=answer',
            approved: true,
          },
        },
      };

      ws.send(JSON.stringify(answerMsg));

      // Wait for the echo back
      const echoed = await waitFor(() => {
        const echo = received.find((m) => {
          try {
            const parsed = JSON.parse(m) as AgentSocketMessage;
            return parsed.type === 'signal' && parsed.data?.type === 'answer';
          } catch {
            return false;
          }
        });
        return echo ? (JSON.parse(echo) as AgentSocketMessage) : undefined;
      });

      expect(echoed?.type).toBe('signal');
      expect(echoed?.data?.type).toBe('answer');

      // Browser polls for signals via the same app instance
      const pollRes = await fetch(`http://localhost:${port}/api/signal/poll/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(pollRes.status).toBe(200);
      const pollBody = await pollRes.json() as { signals: Array<{ type: string }> };
      expect(pollBody.signals).toHaveLength(1);
      expect(pollBody.signals[0]?.type).toBe('answer');

      ws.close();
      httpServer.close();
    }, 10000);
  });

  describe('ICE servers endpoint', () => {
    beforeEach(() => {
      vi.stubEnv('TURN_SECRET', TURN_SECRET);
      vi.stubEnv('TURN_URL', 'turn:turn.example.com:3478');
      vi.stubEnv('STUN_URL', 'stun:stun.example.com:19302');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns STUN and TURN with HMAC-SHA1 credentials when TURN_SECRET is set', async () => {
      const { app } = createSignalingServer();
      const res = await app.fetch(
        new Request('http://localhost/api/webrtc/ice-servers', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
      };

      expect(body.iceServers).toHaveLength(2);

      // STUN server
      const stun = body.iceServers[0];
      expect(stun.urls).toContain('stun:stun.example.com:19302');

      // TURN server with credentials
      const turn = body.iceServers[1];
      expect(turn.urls).toEqual([
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:3478?transport=tcp',
      ]);
      expect(turn.username).toBeDefined();
      expect(turn.credential).toBeDefined();

      // Validate username format: "<expiry>:<userId>"
      const [expiryStr, userIdPart] = (turn.username ?? '').split(':');
      expect(Number(expiryStr)).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(userIdPart).toBe(userId);

      // Validate credential is correct HMAC-SHA1
      const { createHmac } = await import('node:crypto');
      const expectedCredential = createHmac('sha1', TURN_SECRET)
        .update(turn.username ?? '')
        .digest('base64');
      expect(turn.credential).toBe(expectedCredential);
    });

    it('returns default public STUN when TURN_SECRET is not set', async () => {
      vi.stubEnv('TURN_SECRET', '');
      const { app } = createSignalingServer();
      const res = await app.fetch(
        new Request('http://localhost/api/webrtc/ice-servers', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { iceServers: Array<{ urls: string | string[] }> };

      expect(body.iceServers).toHaveLength(1);
      expect(body.iceServers[0]?.urls).toEqual(['stun:stun.l.google.com:19302']);
    });

    it('rejects without auth with 401', async () => {
      const { app } = createSignalingServer();
      const res = await app.fetch(
        new Request('http://localhost/api/webrtc/ice-servers'),
      );

      expect(res.status).toBe(401);
    });
  });

  describe('Signal routes', () => {
    it('POST /api/signal/answer records signal and updates session status to active', async () => {
      const { app } = createSignalingServer();
      const res = await app.fetch(
        new Request('http://localhost/api/signal/answer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            sessionId,
            sdp: 'v=0-o=answer',
            approved: true,
          }),
        }),
      );

      expect(res.status).toBe(201);

      // Session should now be active
      const sess = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();

      expect(sess?.status).toBe('active');
    });

    it('GET /api/signal/poll/:sessionId returns signals for the session', async () => {
      const { app } = createSignalingServer();

      // First, record an offer signal via REST
      await app.fetch(
        new Request('http://localhost/api/signal/offer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            sessionId,
            sdp: 'v=0-o=offer',
            capabilities: [],
          }),
        }),
      );

      // Poll for signals
      const res = await app.fetch(
        new Request(`http://localhost/api/signal/poll/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { signals: Array<{ type: string }> };
      expect(body.signals).toHaveLength(1);
      expect(body.signals[0]?.type).toBe('offer');
    });
  });
});
