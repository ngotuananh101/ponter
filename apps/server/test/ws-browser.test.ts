import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSignalingServer,
  closeAllSignalingSockets,
} from '../src/index.js';
import type { SignalingServerOptions } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import {
  agentConnections,
  browserConnections,
  handleBrowserSubscribe,
  pushToBrowser,
} from '../src/routes/ws.js';
import { registerWsTicket, consumeWsTicket } from '../src/utils/ws-ticket.js';
import { signWsTicket } from '../src/utils/jwt.js';
import { verifyWsTicket } from '../src/utils/auth.js';
import { recordSignal } from '../src/utils/signals.js';
import { eq, sql } from 'drizzle-orm';
import { signals } from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import type { SignalMessage } from '@ponter/shared';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

type AuthResponse = {
  user: { id: string; username: string };
  token: string;
  refreshToken: string;
};

/** Loose view of a frame as parsed from the wire. */
type AnyFrame = {
  type?: string;
  code?: string;
  id?: string;
  data?: {
    type?: string;
    data?: { sessionId?: string; sdp?: string; candidate?: string };
    sessionId?: string;
    after?: string | null;
    hasMore?: boolean;
  };
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 3000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) return result;
    await wait(10);
  }
  throw new Error('Timed out waiting for condition');
}

async function startOnEphemeral(opts?: SignalingServerOptions): Promise<{
  port: number;
  server: Server;
  app: ReturnType<typeof createSignalingServer>['app'];
}> {
  const { app, server } = createSignalingServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address() as AddressInfo;
  return { port: addr.port, server, app };
}

async function registerUser(
  app: ReturnType<typeof createSignalingServer>['app'],
  username: string,
): Promise<{ token: string; userId: string }> {
  const res = await app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'Password123!',
        publicKey: `pk_${username}`,
      }),
    }),
  );
  const data = (await res.json()) as AuthResponse;
  return { token: data.token, userId: data.user.id };
}

async function registerAgent(
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
  id: string,
): Promise<{ agentId: string; credential: string }> {
  const res = await app.fetch(
    new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id,
        hostname: 'test-host',
        publicKey: 'pk_agent',
      }),
    }),
  );
  const data = (await res.json()) as {
    agent: { id: string };
    credential: string;
  };
  return { agentId: data.agent.id, credential: data.credential };
}

async function createSession(
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
  agentId: string,
): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId }),
    }),
  );
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function mintTicket(
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/api/ws/ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const data = (await res.json()) as { ticket: string; expiresIn: number };
  return data.ticket;
}

/** Clear per-test server state. */
function resetConnectionState(): void {
  agentConnections.clear();
  browserConnections.clear();
  closeDb();
}

function collectFrames(ws: WebSocket): AnyFrame[] {
  const frames: AnyFrame[] = [];
  ws.on('message', (data: Buffer) => {
    try {
      frames.push(JSON.parse(data.toString()) as AnyFrame);
    } catch {
      // ignore non-JSON
    }
  });
  return frames;
}

function connectBrowser(
  port: number,
  ticket: string,
  origin?: string,
): WebSocket {
  const url = `ws://127.0.0.1:${port}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`;
  return new WebSocket(url, origin ? { origin } : {});
}

function connectAgent(port: number, credential: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/ws/agent`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

async function waitOpen(ws: WebSocket): Promise<void> {
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
}

async function waitClosed(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.on('close', (code: number) => resolve({ code }));
  });
}

/** Attempt an upgrade and resolve with the HTTP status, or 200 on success. */
async function attemptUpgrade(
  port: number,
  path: string,
  origin?: string,
): Promise<number> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${path}`,
    origin ? { origin } : {},
  );
  return new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.close();
    });
    ws.on('open', () => {
      ws.close();
      resolve(200);
    });
    ws.on('error', () => resolve(-1));
  });
}

async function sendFrame(ws: WebSocket, frame: unknown): Promise<void> {
  ws.send(JSON.stringify(frame));
  await wait(30);
}

/** Open a browser socket and start collecting its frames. */
async function openBrowser(
  port: number,
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  const ticket = await mintTicket(app, token);
  const ws = connectBrowser(port, ticket);
  await waitOpen(ws);
  return { ws, frames: collectFrames(ws) };
}

/** Open a browser socket, subscribe it, and wait for the ack. */
async function openSubscribed(
  port: number,
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
  sessionId: string,
): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  const { ws, frames } = await openBrowser(port, app, token);
  await sendFrame(ws, { type: 'subscribe', data: { sessionId } });
  await waitFor(() => frames.find((f) => f.type === 'subscribed'));
  return { ws, frames };
}

describe('browser WS ticket endpoint', () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token, userId } = await registerUser(app, 'tester'));
  });

  afterEach(resetConnectionState);

  it('rejects minting without a Bearer token with 401', async () => {
    const { app } = createSignalingServer();
    const res = await app.fetch(
      new Request('http://localhost/api/ws/ticket', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  it('mints a ticket with a 15s TTL', async () => {
    const { app } = createSignalingServer();
    const res = await app.fetch(
      new Request('http://localhost/api/ws/ticket', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresIn: number };
    expect(body.expiresIn).toBe(15);
    expect(body.ticket.split('.')).toHaveLength(3);

    // The ticket is a scoped access token, not a second kind of JWT.
    const payload = await verifyWsTicket(body.ticket, JWT_SECRET);
    expect(payload.sub).toBe(userId);
    expect(payload.scope).toBe('ws-ticket');
    expect(payload.type).toBe('access');
  });

  it('rejects a ws-ticket used as a REST access token with 401', async () => {
    const { app } = createSignalingServer();
    const ticket = await mintTicket(app, token);

    const res = await app.fetch(
      new Request('http://localhost/api/sessions', {
        headers: { Authorization: `Bearer ${ticket}` },
      }),
    );

    // Scope separation, REST side: without the middleware guard the ticket
    // would authenticate here — it is a validly signed 'access' JWT.
    expect(res.status).toBe(401);
  });

  it('rejects a plain access token as a ws-ticket', async () => {
    await expect(verifyWsTicket(token, JWT_SECRET)).rejects.toThrow();
  });

  it('rejects an expired ws-ticket', async () => {
    const { ticket } = await signWsTicket('u1', 'user', JWT_SECRET, -1);
    await expect(verifyWsTicket(ticket, JWT_SECRET)).rejects.toThrow();
  });
});

describe('ws-ticket one-time registry', () => {
  it('accepts a ticket once and rejects the second use', () => {
    registerWsTicket('jti-one', 60_000);
    expect(consumeWsTicket('jti-one')).toBe(true);
    expect(consumeWsTicket('jti-one')).toBe(false);
  });

  it('rejects an unknown ticket', () => {
    expect(consumeWsTicket('jti-missing')).toBe(false);
  });

  it('rejects an expired ticket', async () => {
    registerWsTicket('jti-expired', 20);
    await wait(40);
    expect(consumeWsTicket('jti-expired')).toBe(false);
  });
});

describe('browser WS upgrade', () => {
  let token: string;

  beforeEach(async () => {
    getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token } = await registerUser(app, 'tester'));
  });

  afterEach(() => {
    agentConnections.clear();
    browserConnections.clear();
    vi.unstubAllEnvs();
    closeDb();
  });

  it('upgrades with a valid ticket', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects a missing ticket with 401', async () => {
    const { port } = await startOnEphemeral();
    const status = await attemptUpgrade(port, '/api/ws/browser');
    expect(status).toBe(401);
  });

  it('rejects an access token passed as a ticket with 401', async () => {
    const { port } = await startOnEphemeral();
    const status = await attemptUpgrade(
      port,
      `/api/ws/browser?ticket=${encodeURIComponent(token)}`,
    );
    expect(status).toBe(401);
  });

  it('rejects a second use of the same ticket with 401', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);

    const first = connectBrowser(port, ticket);
    await waitOpen(first);
    first.close();
    await wait(50);

    const status = await attemptUpgrade(
      port,
      `/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
    );
    expect(status).toBe(401);
  });

  it('rejects a disallowed Origin with 403 when an allowlist is set', async () => {
    vi.stubEnv('CORS_ORIGIN', 'http://allowed.test');
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const status = await attemptUpgrade(
      port,
      `/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
      'http://evil.test',
    );
    expect(status).toBe(403);
  });

  it('rejects a missing Origin with 403 when an allowlist is set', async () => {
    vi.stubEnv('CORS_ORIGIN', 'http://allowed.test');
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const status = await attemptUpgrade(
      port,
      `/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
    );
    expect(status).toBe(403);
  });

  it('accepts an allowlisted Origin', async () => {
    vi.stubEnv('CORS_ORIGIN', 'http://allowed.test');
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket, 'http://allowed.test');
    await waitOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts any Origin when CORS_ORIGIN is *', async () => {
    vi.stubEnv('CORS_ORIGIN', '*');
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket, 'http://anywhere.test');
    await waitOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // The ticket in the query string is a credential: the server must never put
  // it in a log line, where it would outlive the 15s TTL it was minted with.
  it('logs a rejected upgrade without the ticket value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await startOnEphemeral();
    const status = await attemptUpgrade(
      port,
      `/api/ws/browser?ticket=${encodeURIComponent('not-a-real-ticket')}`,
    );
    expect(status).toBe(401);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('401');
    expect(logged).toContain('/api/ws/browser');
    expect(logged).not.toContain('not-a-real-ticket');

    warn.mockRestore();
  });
});

describe('browser subscribe + replay', () => {
  let db: Database;
  let token: string;
  let userId: string;
  let agentId: string;
  let sessionId: string;

  beforeEach(async () => {
    db = getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token, userId } = await registerUser(app, 'tester'));
    ({ agentId } = await registerAgent(app, token, 'agent_sub_1'));
    sessionId = await createSession(app, token, agentId);
  });

  afterEach(resetConnectionState);

  async function subscribe(
    ws: WebSocket,
    sid: string,
    after?: string,
  ): Promise<AnyFrame[]> {
    const frames = collectFrames(ws);
    await sendFrame(ws, {
      type: 'subscribe',
      data: after ? { sessionId: sid, after } : { sessionId: sid },
    });
    await waitFor(() =>
      frames.find((f) => f.type === 'subscribed') ? true : undefined,
    );
    return frames;
  }

  it('replays recorded signals in insertion order then acks', async () => {
    const offer: SignalMessage = {
      type: 'offer',
      data: { sessionId, sdp: 'v=0-offer', capabilities: ['terminal'] },
    };
    const cand: SignalMessage = {
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: 'candidate:1',
        sdpMid: null,
        sdpMLineIndex: 0,
      },
    };
    const answer: SignalMessage = {
      type: 'answer',
      data: { sessionId, sdp: 'v=0-answer', approved: true },
    };
    const s1 = await recordSignal(db, offer);
    const s2 = await recordSignal(db, cand);
    const s3 = await recordSignal(db, answer);

    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    const frames = await subscribe(ws, sessionId);

    const signalFrames = frames.filter((f) => f.type === 'signal');
    expect(signalFrames.map((f) => f.id)).toEqual([s1!.id, s2!.id, s3!.id]);
    expect(signalFrames.map((f) => f.data?.type)).toEqual([
      'offer',
      'ice-candidate',
      'answer',
    ]);

    const ack = frames.find((f) => f.type === 'subscribed');
    expect(ack?.data).toEqual({
      sessionId,
      after: s3!.id,
      hasMore: false,
    });

    ws.close();
  });

  it('replays only signals after the given cursor', async () => {
    const mk = (n: number): SignalMessage => ({
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: `candidate:${n}`,
        sdpMid: null,
        sdpMLineIndex: 0,
      },
    });
    const s1 = await recordSignal(db, mk(1));
    const s2 = await recordSignal(db, mk(2));

    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    const frames = await subscribe(ws, sessionId, s1!.id);

    const signalFrames = frames.filter((f) => f.type === 'signal');
    expect(signalFrames.map((f) => f.id)).toEqual([s2!.id]);
    ws.close();
  });

  it('does not replay from scratch when the cursor was reaped (time-bound)', async () => {
    // A signal old enough that cleanup would have removed it, had it expired.
    const old = await recordSignal(db, {
      type: 'offer',
      data: { sessionId, sdp: 'v=0-old', capabilities: [] },
    });
    await db.run(
      sql`UPDATE signals SET created_at = datetime('now', '-10 minutes') WHERE id = ${old!.id}`,
    );
    const fresh = await recordSignal(db, {
      type: 'answer',
      data: { sessionId, sdp: 'v=0-fresh', approved: true },
    });

    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    // Cursor no longer resolves (reaped): without the 5-minute bound the
    // COALESCE fallback would replay the whole session from the beginning.
    const frames = await subscribe(ws, sessionId, 'reaped-cursor-id');

    const signalFrames = frames.filter((f) => f.type === 'signal');
    expect(signalFrames.map((f) => f.id)).toEqual([fresh!.id]);
    ws.close();
  });

  it('paginates replay with hasMore when more than 200 signals wait', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) {
      const row = await recordSignal(db, {
        type: 'ice-candidate',
        data: {
          sessionId,
          candidate: `candidate:${i}`,
          sdpMid: null,
          sdpMLineIndex: 0,
        },
      });
      ids.push(row!.id);
    }

    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    const frames = await subscribe(ws, sessionId);
    const signalFrames = frames.filter((f) => f.type === 'signal');
    expect(signalFrames).toHaveLength(200);
    expect(signalFrames[0]?.id).toBe(ids[0]);
    expect(signalFrames[199]?.id).toBe(ids[199]);

    const ack = frames.find((f) => f.type === 'subscribed');
    expect(ack?.data?.hasMore).toBe(true);
    expect(ack?.data?.after).toBe(ids[199]);

    // Page two: the client re-subscribes from the last id it saw.
    const more = await subscribe(ws, sessionId, ids[199]);
    const moreSignals = more.filter((f) => f.type === 'signal');
    expect(moreSignals).toHaveLength(5);
    expect(moreSignals[0]?.id).toBe(ids[200]);
    expect(moreSignals[4]?.id).toBe(ids[204]);
    const ack2 = more.find((f) => f.type === 'subscribed');
    expect(ack2?.data?.hasMore).toBe(false);
    ws.close();
  });

  it("rejects subscribing to another user's session with NOT_FOUND", async () => {
    const { app } = createSignalingServer();
    const other = await registerUser(app, 'other-user');
    const otherAgent = await registerAgent(app, other.token, 'agent_other_1');
    const otherSession = await createSession(
      app,
      other.token,
      otherAgent.agentId,
    );

    const { port, app: serverApp } = await startOnEphemeral();
    const ticket = await mintTicket(serverApp, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    const frames = collectFrames(ws);
    await sendFrame(ws, {
      type: 'subscribe',
      data: { sessionId: otherSession },
    });

    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('NOT_FOUND');
    // No ack: the subscription was refused, not established.
    expect(frames.find((f) => f.type === 'subscribed')).toBeUndefined();
    ws.close();
  });

  it('buffers a live signal that races replay and delivers it exactly once', async () => {
    const s1 = await recordSignal(db, {
      type: 'offer',
      data: { sessionId, sdp: 'v=0-offer', capabilities: [] },
    });

    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);

    const frames = collectFrames(ws);
    await sendFrame(ws, { type: 'subscribe', data: { sessionId } });
    await waitFor(() => frames.find((f) => f.type === 'subscribed'));

    const connection = [...(browserConnections.get(userId) ?? [])][0]!;

    // The raced signal exists in the DB *and* arrives as a live push while
    // the second subscribe replays it. handleBrowserSubscribe flips the
    // subscription to 'replaying' synchronously, so the push below is
    // buffered — then deduped against the replay batch.
    const s2 = await recordSignal(db, {
      type: 'answer',
      data: { sessionId, sdp: 'v=0-answer', approved: true },
    });
    const replayPromise = handleBrowserSubscribe(
      connection,
      sessionId,
      s1!.id,
      db,
    );
    pushToBrowser(userId, sessionId, {
      type: 'signal',
      data: {
        type: 'answer',
        data: { sessionId, sdp: 'v=0-answer', approved: true },
      },
      id: s2!.id,
    });
    await replayPromise;

    // The replay page itself carries s2; the buffered push for the same id
    // was deduped. Wait for the frame to cross the socket before counting.
    await waitFor(() =>
      frames.find((f) => f.type === 'signal' && f.id === s2!.id),
    );
    const withS2 = frames.filter((f) => f.type === 'signal' && f.id === s2!.id);
    expect(withS2).toHaveLength(1);
    ws.close();
  });
});

describe('browser live push', () => {
  let db: Database;
  let token: string;
  let agentId: string;
  let credential: string;
  let sessionId: string;

  beforeEach(async () => {
    db = getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token } = await registerUser(app, 'tester'));
    ({ agentId, credential } = await registerAgent(app, token, 'agent_push_1'));
    sessionId = await createSession(app, token, agentId);
  });

  afterEach(resetConnectionState);

  it('delivers an agent signal to a subscribed browser instantly, with id', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const browser = connectBrowser(port, ticket);
    await waitOpen(browser);
    const frames = collectFrames(browser);
    await sendFrame(browser, { type: 'subscribe', data: { sessionId } });
    await waitFor(() => frames.find((f) => f.type === 'subscribed'));

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    const agentFrames = collectFrames(agent);
    await waitFor(() => agentFrames.length > 0); // ice-servers frame

    await sendFrame(agent, {
      type: 'signal',
      data: {
        type: 'answer',
        data: { sessionId, sdp: 'v=0-answer', approved: true },
      },
    });

    const pushed = await waitFor(() =>
      frames.find((f) => f.type === 'signal' && f.data?.type === 'answer'),
    );
    expect(pushed.id).toBeTruthy();
    expect(pushed.data?.data?.sessionId).toBe(sessionId);

    // The frame's id is the persisted signal's id (the replay cursor).
    const row = await db
      .select({ id: signals.id })
      .from(signals)
      .where(eq(signals.sessionId, sessionId))
      .get();
    expect(pushed.id).toBe(row!.id);

    browser.close();
    agent.close();
  });

  it('fans out one signal to two browser connections of the same user', async () => {
    const { port, app } = await startOnEphemeral();
    const t1 = await mintTicket(app, token);
    const t2 = await mintTicket(app, token);
    const b1 = connectBrowser(port, t1);
    const b2 = connectBrowser(port, t2);
    await waitOpen(b1);
    await waitOpen(b2);
    const f1 = collectFrames(b1);
    const f2 = collectFrames(b2);
    await sendFrame(b1, { type: 'subscribe', data: { sessionId } });
    await sendFrame(b2, { type: 'subscribe', data: { sessionId } });
    await waitFor(() => f1.find((f) => f.type === 'subscribed'));
    await waitFor(() => f2.find((f) => f.type === 'subscribed'));

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    const agentFrames = collectFrames(agent);
    await waitFor(() => agentFrames.length > 0);
    await sendFrame(agent, {
      type: 'signal',
      data: {
        type: 'answer',
        data: { sessionId, sdp: 'v=0-answer', approved: true },
      },
    });

    // Both connections must receive the same signal, with the same id — the
    // id is the replay cursor, so a divergence would split their replay
    // positions.
    const onB1 = await waitFor(() =>
      f1.find((f) => f.type === 'signal' && f.data?.type === 'answer'),
    );
    const onB2 = await waitFor(() =>
      f2.find((f) => f.type === 'signal' && f.data?.type === 'answer'),
    );
    expect(onB1.id).toBeTruthy();
    expect(onB2.id).toBe(onB1.id);
    expect(onB1.data?.data?.sessionId).toBe(sessionId);

    b1.close();
    b2.close();
    agent.close();
  });

  it('accepts an inbound browser signal, forwards to the agent, and skips the echo', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const browser = connectBrowser(port, ticket);
    await waitOpen(browser);
    const browserFrames = collectFrames(browser);
    await sendFrame(browser, { type: 'subscribe', data: { sessionId } });
    await waitFor(() => browserFrames.find((f) => f.type === 'subscribed'));

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    const agentFrames = collectFrames(agent);
    await waitFor(() => agentFrames.length > 0);

    await sendFrame(browser, {
      type: 'signal',
      data: {
        type: 'offer',
        data: { sessionId, sdp: 'v=0-offer', capabilities: ['terminal'] },
      },
    });

    const toAgent = await waitFor(() =>
      agentFrames.find((f) => f.type === 'signal' && f.data?.type === 'offer'),
    );
    expect(toAgent).toBeTruthy();

    // The sender does not get its own signal echoed back (the offerer would
    // otherwise re-apply its own offer), but the row is persisted.
    const echoed = browserFrames.filter(
      (f) => f.type === 'signal' && f.data?.type === 'offer',
    );
    expect(echoed).toHaveLength(0);
    const row = await db
      .select({ id: signals.id })
      .from(signals)
      .where(eq(signals.sessionId, sessionId))
      .get();
    expect(row).toBeTruthy();

    browser.close();
    agent.close();
  });

  it('answers ping with pong', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openBrowser(port, app, token);
    await sendFrame(ws, { type: 'ping' });
    const pong = await waitFor(() => frames.find((f) => f.type === 'pong'));
    expect(pong).toEqual({ type: 'pong' });
    ws.close();
  });

  it('replies MALFORMED_JSON to an oversized frame without parsing it', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openBrowser(port, app, token);
    ws.send('x'.repeat(256 * 1024 + 1));
    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('MALFORMED_JSON');
    ws.close();
  });

  it('rejects an oversized frame measured in bytes, not UTF-16 code units', async () => {
    // The guard's whole job is to stop a large payload before `JSON.parse`.
    // Measuring `string.length` counts UTF-16 code units: a frame of astral
    // characters (2 code units, 4 UTF-8 bytes each) stays under the limit as a
    // string while its on-the-wire bytes are nearly double it — so the check
    // passes and the oversized payload is parsed anyway. Measure bytes.
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openBrowser(port, app, token);
    // Valid JSON: an unknown field is ignored by `normalizeBrowserFrame`, so a
    // bypass is observable as a `pong` (the frame was parsed and accepted)
    // rather than an error. 70_000 emoji = 140_000 UTF-16 code units (< 256 KiB
    // as a string) but 280_000 UTF-8 bytes (> 256 KiB on the wire).
    const pad = '\u{1F600}'.repeat(70_000);
    expect(pad.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(pad, 'utf8')).toBeGreaterThan(256 * 1024);
    const raw = JSON.stringify({ type: 'ping', pad });
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(256 * 1024);
    ws.send(raw);
    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('MALFORMED_JSON');
    ws.close();
  });

  it('replies VALIDATION_ERROR to an unknown frame type', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openBrowser(port, app, token);
    await sendFrame(ws, { type: 'nonsense' });
    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('VALIDATION_ERROR');
    ws.close();
  });
});

describe('SESSION_TERMINATED notification', () => {
  let token: string;
  let agentId: string;
  let credential: string;
  let sessionId: string;

  beforeEach(async () => {
    getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token } = await registerUser(app, 'tester'));
    ({ agentId, credential } = await registerAgent(app, token, 'agent_term_1'));
    sessionId = await createSession(app, token, agentId);
  });

  afterEach(resetConnectionState);

  async function subscribeBrowser(
    port: number,
    app: ReturnType<typeof createSignalingServer>['app'],
  ): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
    return openSubscribed(port, app, token, sessionId);
  }

  it('pushes SESSION_TERMINATED when the agent socket closes', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await subscribeBrowser(port, app);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    agent.close();
    await waitClosed(agent);

    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('SESSION_TERMINATED');
    ws.close();
  });

  it('pushes SESSION_TERMINATED when the session is deleted over REST', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await subscribeBrowser(port, app);

    const res = await app.fetch(
      new Request(`http://localhost/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);

    const err = await waitFor(() => frames.find((f) => f.type === 'error'));
    expect(err.code).toBe('SESSION_TERMINATED');
    ws.close();
  });
});

describe('browser keepalive and lifecycle', () => {
  let token: string;
  let credential: string;

  beforeEach(async () => {
    getDb(':memory:');
    const { app } = createSignalingServer();
    ({ token } = await registerUser(app, 'tester'));
    ({ credential } = await registerAgent(app, token, 'agent_ka_1'));
  });

  afterEach(resetConnectionState);

  it('closes a silent browser with 4408 after the pong timeout', async () => {
    const { port, app } = await startOnEphemeral({
      pingIntervalMs: 30,
      pongTimeoutMs: 120,
    });
    const ticket = await mintTicket(app, token);
    // autoPong: false simulates a browser that cannot answer protocol pings.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
      { autoPong: false },
    );
    const closed = waitClosed(ws);
    await waitOpen(ws);
    const { code } = await closed;
    expect(code).toBe(4408);
  });

  it('keeps a pong-answering browser connected past the timeout', async () => {
    const { port, app } = await startOnEphemeral({
      pingIntervalMs: 30,
      pongTimeoutMs: 120,
    });
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);
    await wait(250);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('removes the connection from browserConnections on close', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);
    await waitFor(() =>
      (browserConnections.get('u-missing') ?? undefined) === undefined
        ? true
        : undefined,
    );
    const before = [...browserConnections.values()].reduce(
      (n, set) => n + set.size,
      0,
    );
    expect(before).toBe(1);
    ws.close();
    await waitClosed(ws);
    await waitFor(() =>
      [...browserConnections.values()].reduce((n, set) => n + set.size, 0) === 0
        ? true
        : undefined,
    );
  });

  it('closes browser and agent sockets with 1001 on shutdown', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const browser = connectBrowser(port, ticket);
    await waitOpen(browser);
    const browserClosed = waitClosed(browser);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    const agentClosed = waitClosed(agent);

    closeAllSignalingSockets();

    expect((await browserClosed).code).toBe(1001);
    expect((await agentClosed).code).toBe(1001);
  });
});
