import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { updateSystemSettings } from '../src/utils/settings.js';
import { browserConnections } from '../src/routes/ws.js';
import type { WebSocket } from 'ws';
import type { Database } from '../src/db/client.js';
import {
  wait,
  waitFor,
  startOnEphemeral,
  registerUser,
  registerAgent,
  mintTicket,
  resetConnectionState,
  collectFrames,
  connectBrowser,
  connectAgent,
  waitOpen,
  waitClosed,
  sendFrame,
  type AnyFrame,
} from './helpers.js';

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

/** Wait until the browser has received a fleet-changed invalidation. */
async function expectFleetChanged(frames: AnyFrame[]): Promise<void> {
  await waitFor(() => frames.find((f) => f.type === 'fleet-changed'));
}

/** Install a fake SERVER-side BrowserConnection whose send() throws, into userId's set. */
function addThrowingConnection(userId: string): void {
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
}

/** Refetch GET /api/agents and return the row for agentId (or undefined). */
async function refetchAgent(
  app: ReturnType<typeof createSignalingServer>['app'],
  token: string,
  agentId: string,
): Promise<{ id: string; isOnline: boolean } | undefined> {
  const res = await app.fetch(
    new Request('http://localhost/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const list = (await res.json()) as Array<{ id: string; isOnline: boolean }>;
  return list.find((a) => a.id === agentId);
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
  // `subscribe-fleet` has no server ack (ADR-74: it only flips a per-connection
  // flag), so there is nothing to wait for here — `sendFrame` already settles.
  return { ws, frames };
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

    await expectFleetChanged(frames);
    ws.close();
    agent.close();
  });

  it('emits fleet-changed on agent disconnect to a subscribed browser', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    // Consume the connect emission.
    await expectFleetChanged(frames);

    // Clear for the disconnect check.
    frames.length = 0;

    agent.close();
    await waitClosed(agent);

    await expectFleetChanged(frames);
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

    await expectFleetChanged(frames);
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

    await expectFleetChanged(frames);
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

    await expectFleetChanged(frames);
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

    await expectFleetChanged(frames);
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

    await expectFleetChanged(frames);
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
    await expectFleetChanged(subFrames);
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

    await expectFleetChanged(aFrames);
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
    addThrowingConnection(userId);

    // Direct call must not throw.
    let delivered: number;
    expect(() => {
      delivered = pushFleetToUser(userId);
    }).not.toThrow();

    // The healthy real socket still received fleet-changed.
    await expectFleetChanged(f2);
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
    addThrowingConnection(userId);

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

    await expectFleetChanged(f2);

    ws2.close();
  });

  /**
   * On the wire, isOnline comes from the persisted `agents.isOnline` column plus
   * lastPingAt recency (isAgentOnline in utils/agent.ts) — NOT from the in-memory
   * agentConnections map. This pins that the connect emit fires AFTER the DB
   * `isOnline: true` update, the invariant a browser's GET /api/agents refetch
   * depends on. Mutation proof: deleting that DB update turns this test RED.
   */
  it('agent connect emit preserves ordering: isOnline is true after emit', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);

    // Wait for the fleet-changed emit.
    await expectFleetChanged(frames);

    // Now refetch agents via REST and check isOnline.
    const found = await refetchAgent(app, token, agentId);
    expect(found).toBeTruthy();
    expect(found!.isOnline).toBe(true);

    ws.close();
    agent.close();
  });

  /**
   * Same contract on the disconnect path: the emit fires AFTER the DB
   * `isOnline: false` update. It also transitively requires the connect path to
   * have run agentConnections.set — the close handler's stale-socket guard needs
   * the map entry to find and clean up the connection.
   */
  it('agent disconnect emit preserves ordering: isOnline is false after emit', async () => {
    const { port, app } = await startOnEphemeral();
    const { ws, frames } = await openFleetBrowser(port, app, token);

    const agent = connectAgent(port, credential);
    await waitOpen(agent);
    await expectFleetChanged(frames);
    frames.length = 0;

    agent.close();
    await waitClosed(agent);
    await expectFleetChanged(frames);

    const found = await refetchAgent(app, token, agentId);
    expect(found).toBeTruthy();
    expect(found!.isOnline).toBe(false);

    ws.close();
  });
});
