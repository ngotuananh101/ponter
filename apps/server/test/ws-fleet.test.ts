import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { updateSystemSettings } from '../src/utils/settings.js';
import { agentConnections, browserConnections } from '../src/routes/ws.js';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Database } from '../src/db/client.js';

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
  data?: {
    type?: string;
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

async function startOnEphemeral(): Promise<{
  port: number;
  server: Server;
  app: ReturnType<typeof createSignalingServer>['app'];
}> {
  const { app, server } = createSignalingServer();
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

/** Open a browser socket, subscribe it to fleet, and return the socket + frame collector. */
async function openFleetBrowser(
  port: number,
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
): Promise<{ ws: WebSocket; frames: AnyFrame[] }> {
  const ticket = await mintTicket(app, token);
  const ws = connectBrowser(port, ticket);
  await waitOpen(ws);
  const frames = collectFrames(ws);
  await sendFrame(ws, { type: 'subscribe-fleet' });
  await waitFor(() =>
    frames.find((f) => f.type === 'fleet-changed') ? undefined : true,
  );
  return { ws, frames };
}

async function sendFrame(ws: WebSocket, frame: unknown): Promise<void> {
  ws.send(JSON.stringify(frame));
  await wait(30);
}

/** Clear per-test server state. */
function resetConnectionState(): void {
  agentConnections.clear();
  browserConnections.clear();
  closeDb();
}

describe('fleet push over browser WebSocket', () => {
  let db: Database;
  let token: string;
  let userId: string;
  let agentId: string;
  let credential: string;

  beforeEach(async () => {
    closeDb();
    db = getDb(':memory:');
    await updateSystemSettings(db, { autoApproveUsers: true });
    const { app } = createSignalingServer();
    ({ token, userId } = await registerUser(app, 'tester'));
    ({ agentId, credential } = await registerAgent(
      app,
      token,
      'agent_fleet_1',
    ));
  });

  afterEach(resetConnectionState);

  it('emits fleet-changed on agent connect to a subscribed browser', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
    agent.close();
  });

  it('emits fleet-changed on agent disconnect to a subscribed browser', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    // Consume the connect emission.
    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));

    // Clear for the disconnect check.
    frames.length = 0;

    agent.close();
    await waitClosed(agent);

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('emits fleet-changed on agent created (POST /api/agents)', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_new',
          hostname: 'new-host',
          publicKey: 'pk_new',
        }),
      }),
    );

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('emits fleet-changed on agent updated (PATCH /api/agents/:id)', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    await app.fetch(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ capabilities: ['terminal'] }),
      }),
    );

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('emits fleet-changed on agent deleted (DELETE /api/agents/:id)', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    await app.fetch(
      new Request(`http://localhost/api/agents/${agentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('emits fleet-changed on device created (POST /api/devices)', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    await app.fetch(
      new Request('http://localhost/api/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fingerprint: 'fp_test_device_1',
          deviceName: 'Test Device',
          deviceType: 'desktop',
        }),
      }),
    );

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('emits fleet-changed on device deleted (DELETE /api/devices/:id)', async () => {
    const { port, app } = await startOnEphemeral();

    // Register a device first.
    const devCreate = await app.fetch(
      new Request('http://localhost/api/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fingerprint: 'fp_to_delete',
          deviceName: 'ToDelete',
          deviceType: 'desktop',
        }),
      }),
    );
    const devBody = (await devCreate.json()) as { id: string };

    const { ws, frames } = await openFleetBrowser(port, app, token);

    await app.fetch(
      new Request(`http://localhost/api/devices/${devBody.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    ws.close();
  });

  it('only subscribed connections receive fleet-changed', async () => {
    const { port, app } = await startOnEphemeral();

    // Subscribed browser.
    const subTicket = await mintTicket(app, token);
    const subWs = connectBrowser(port, subTicket);
    await waitOpen(subWs);
    const subFrames = collectFrames(subWs);
    await sendFrame(subWs, { type: 'subscribe-fleet' });

    // Unsubscribed browser.
    const unsubTicket = await mintTicket(app, token);
    const unsubWs = connectBrowser(port, unsubTicket);
    await waitOpen(unsubWs);
    const unsubFrames = collectFrames(unsubWs);

    // Trigger a fleet change via agent connect.
    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    // Subscribed receives it.
    await waitFor(() => subFrames.find((f) => f.type === 'fleet-changed'));
    // Unsubscribed does NOT (wait a reasonable window).
    await wait(200);
    expect(unsubFrames.find((f) => f.type === 'fleet-changed')).toBeUndefined();

    subWs.close();
    unsubWs.close();
    agent.close();
  });

  it('unsubscribe-fleet stops delivery', async () => {
    const { port, app } = await startOnEphemeral();
    const ticket = await mintTicket(app, token);
    const ws = connectBrowser(port, ticket);
    await waitOpen(ws);
    const frames = collectFrames(ws);

    await sendFrame(ws, { type: 'subscribe-fleet' });
    // Drain any immediate frame.
    await wait(50);
    frames.length = 0;

    await sendFrame(ws, { type: 'unsubscribe-fleet' });
    await wait(50);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    await wait(200);
    expect(frames.find((f) => f.type === 'fleet-changed')).toBeUndefined();

    ws.close();
    agent.close();
  });

  it('tenancy isolation: fleet change for user A does not reach user B', async () => {
    const { app } = createSignalingServer();
    const other = await registerUser(app, 'other-user');

    const { port } = await startOnEphemeral();

    // User A: subscribed browser.
    const aTicket = await mintTicket(app, token);
    const aWs = connectBrowser(port, aTicket);
    await waitOpen(aWs);
    const aFrames = collectFrames(aWs);
    await sendFrame(aWs, { type: 'subscribe-fleet' });

    // User B: subscribed browser.
    const bTicket = await mintTicket(app, other.token);
    const bWs = connectBrowser(port, bTicket);
    await waitOpen(bWs);
    const bFrames = collectFrames(bWs);
    await sendFrame(bWs, { type: 'subscribe-fleet' });

    // Connect an agent for user A — triggers fleet-changed for A only.
    const aAgent = connectAgent(port, credential);
    await waitOpen(aAgent);

    await waitFor(() => aFrames.find((f) => f.type === 'fleet-changed'));
    await wait(200);
    expect(bFrames.find((f) => f.type === 'fleet-changed')).toBeUndefined();

    aWs.close();
    bWs.close();
    aAgent.close();
  });

  it('pushFleetToUser never throws: one throwing socket does not block others', async () => {
    const { port, app } = await startOnEphemeral();

    // A real, healthy subscribed browser socket — it must still receive the frame.
    const t2 = await mintTicket(app, token);
    const ws2 = connectBrowser(port, t2);
    await waitOpen(ws2);
    const f2 = collectFrames(ws2);
    await sendFrame(ws2, { type: 'subscribe-fleet' });
    await wait(50);

    // A fake server-side BrowserConnection whose `send` throws. This exercises
    // the SERVER-side send path (connection.send, not the client ws.send),
    // proving the try/catch in pushFleetToUser isolates the failure.
    const { pushFleetToUser } = await import('../src/routes/ws.js');
    const throwingConn = {
      userId,
      socket: {} as unknown as WebSocket,
      send: () => {
        throw new Error('server-side send failure');
      },
      subscriptions: new Map(),
      fleetSubscribed: true,
      lastPongAt: 0,
    };

    const set = browserConnections.get(userId);
    if (set) set.add(throwingConn);
    else browserConnections.set(userId, new Set([throwingConn]));

    // Direct call must not throw.
    let delivered: number;
    expect(() => {
      delivered = pushFleetToUser(userId);
    }).not.toThrow();

    // The healthy real socket still received fleet-changed.
    await waitFor(() => f2.find((f) => f.type === 'fleet-changed'));
    // The throwing fake socket was skipped, so only the real socket was delivered to.
    expect(delivered).toBeGreaterThan(0);

    ws2.close();
  });

  it('pushFleetToUser never throws via route emit: throwing socket does not block others', async () => {
    const { port, app } = await startOnEphemeral();

    // Real healthy subscribed browser.
    const t2 = await mintTicket(app, token);
    const ws2 = connectBrowser(port, t2);
    await waitOpen(ws2);
    const f2 = collectFrames(ws2);
    await sendFrame(ws2, { type: 'subscribe-fleet' });
    await wait(50);

    // Fake server-side throwing connection.
    const throwingConn = {
      userId,
      socket: {} as unknown as WebSocket,
      send: () => {
        throw new Error('server-side send failure');
      },
      subscriptions: new Map(),
      fleetSubscribed: true,
      lastPongAt: 0,
    };
    const set = browserConnections.get(userId);
    if (set) set.add(throwingConn);
    else browserConnections.set(userId, new Set([throwingConn]));

    // Trigger a fleet change via a real REST route (POST /api/agents) and assert
    // the route still returns 201 and the healthy socket receives fleet-changed.
    const res = await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_throws',
          hostname: 'throw-host',
          publicKey: 'pk_throw',
        }),
      }),
    );
    expect(res.status).toBe(201);

    await waitFor(() => f2.find((f) => f.type === 'fleet-changed'));

    ws2.close();
  });

  it('agent connect emit preserves ordering: isOnline is true after emit', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    // Wait for the fleet-changed emit.
    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));

    // Now refetch agents via REST and check isOnline.
    const res = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await res.json()) as Array<{ id: string; isOnline: boolean }>;
    const found = list.find((a) => a.id === agentId);
    expect(found).toBeTruthy();
    expect(found!.isOnline).toBe(true);

    ws.close();
    agent.close();
  });

  it('agent disconnect emit preserves ordering: isOnline is false after emit', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
    frames.length = 0;

    agent.close();
    await waitClosed(agent);
    await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));

    const res = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await res.json()) as Array<{ id: string; isOnline: boolean }>;
    const found = list.find((a) => a.id === agentId);
    expect(found).toBeTruthy();
    expect(found!.isOnline).toBe(false);

    ws.close();
  });
});
