import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer, closeAllSignalingSockets } from '../src/index';
import { getDb, closeDb } from '../src/db/client';
import { closeUserSockets, browserConnections } from '../src/routes/ws';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';
// LƯU Ý: Load-bearing — bob là user thứ 2 trong DB :memory:, mặc định 'pending',
// cần approved để mint được WS ticket. env var này bật auto-approve cho bob.
process.env.E2E_AUTO_APPROVE_USERS = 'true';

let server: Server | undefined;

/** Register a user through the real endpoint and mint a one-time WS ticket. */
async function registerAndTicket(
  app: ReturnType<typeof createSignalingServer>['app'],
  username: string,
): Promise<{ userId: string; ticket: string; token: string }> {
  const reg = await app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'Password123!',
        publicKey: 'pk',
      }),
    }),
  );
  const { token, user } = (await reg.json()) as {
    token: string;
    user: { id: string };
  };
  const ticketRes = await app.fetch(
    new Request('http://localhost/api/ws/ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  return { userId: user.id, ticket, token };
}

function connect(port: number, ticket: string): WebSocket {
  return new WebSocket(
    `ws://127.0.0.1:${port}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`,
  );
}

beforeEach(() => {
  browserConnections.clear();
  closeDb();
  getDb(':memory:');
});

afterEach(async () => {
  closeAllSignalingSockets();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('revocation closes live sockets', () => {
  it('closeUserSockets closes a user socket with 4401', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    const { userId, ticket } = await registerAndTicket(app, 'alice');
    const ws = connect(port, ticket);
    await new Promise<void>((r) => ws.once('open', () => r()));
    expect(browserConnections.get(userId)?.size).toBe(1);

    const closed = new Promise<number>((r) =>
      ws.once('close', (code) => r(code)),
    );
    closeUserSockets(userId, 4401, 'revoked');
    expect(await closed).toBe(4401);
  });
});

describe('revocation closes live sockets via route call sites', () => {
  it('logout route closes alice socket with 4401', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    const { userId, ticket, token } = await registerAndTicket(app, 'alice');
    const ws = connect(port, ticket);
    await new Promise<void>((r) => ws.once('open', () => r()));
    expect(browserConnections.get(userId)?.size).toBe(1);

    // POST /api/auth/logout with alice's access token
    const closed = new Promise<number>((r) =>
      ws.once('close', (code) => r(code)),
    );
    const logoutRes = await app.fetch(
      new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(logoutRes.status).toBe(200);
    expect(await closed).toBe(4401);
  });

  it('admin PATCH deactivate closes bob socket with 4401', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    const alice = await registerAndTicket(app, 'alice');
    // bob is user #2 → with E2E_AUTO_APPROVE_USERS=true gets approved + token
    const bob = await registerAndTicket(app, 'bob');

    const ws = connect(port, bob.ticket);
    await new Promise<void>((r) => ws.once('open', () => r()));
    expect(browserConnections.get(bob.userId)?.size).toBe(1);

    const closed = new Promise<number>((r) =>
      ws.once('close', (code) => r(code)),
    );
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/users/${bob.userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.token}`,
        },
        body: JSON.stringify({ isActive: false }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await closed).toBe(4401);
  });

  it('admin PATCH reject closes bob socket with 4401', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    const alice = await registerAndTicket(app, 'alice');
    const bob = await registerAndTicket(app, 'bob');

    const ws = connect(port, bob.ticket);
    await new Promise<void>((r) => ws.once('open', () => r()));
    expect(browserConnections.get(bob.userId)?.size).toBe(1);

    const closed = new Promise<number>((r) =>
      ws.once('close', (code) => r(code)),
    );
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/users/${bob.userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.token}`,
        },
        body: JSON.stringify({ approvalStatus: 'rejected' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await closed).toBe(4401);
  });
});

describe('revocation blocks WebSocket upgrade (M10)', () => {
  it('rejects upgrade with 401 when user deactivated after minting ticket', async () => {
    const { app, server: s } = createSignalingServer();
    server = s;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;

    // alice is first user → approved admin
    const alice = await registerAndTicket(app, 'alice');
    // bob is second user → approved via E2E_AUTO_APPROVE_USERS=true, gets a ticket
    const bob = await registerAndTicket(app, 'bob');

    // Deactivate bob via the real admin route before he ever connects.
    const deactivateRes = await app.fetch(
      new Request(`http://localhost/api/admin/users/${bob.userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${alice.token}`,
        },
        body: JSON.stringify({ isActive: false }),
      }),
    );
    expect(deactivateRes.status).toBe(200);

    // Now attempt the upgrade with bob's (still unconsumed) ticket.
    const ws = connect(port, bob.ticket);

    let opened = false;
    let rejected = false;
    let statusCode: number | undefined;

    ws.on('open', () => {
      opened = true;
    });
    ws.on('unexpected-response', (_req, res) => {
      rejected = true;
      statusCode = res.statusCode;
      ws.close();
    });
    ws.on('error', () => {
      rejected = true;
    });

    // Race 'open' vs 'error'/'unexpected-response' with a short timeout.
    const outcome = await Promise.race([
      new Promise<'opened'>((r) => ws.once('open', () => r('opened'))),
      new Promise<'rejected' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 1000);
        ws.on('unexpected-response', () => {
          clearTimeout(timer);
          resolve('rejected');
        });
        ws.on('error', () => {
          clearTimeout(timer);
          resolve('rejected');
        });
      }),
    ]);

    expect(opened).toBe(false);
    expect(outcome).toBe('rejected');
    expect(rejected).toBe(true);
    expect(statusCode).toBe(401);
  });
});
