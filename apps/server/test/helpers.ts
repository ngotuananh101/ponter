import { WebSocket } from 'ws';
import { createSignalingServer } from '../src/index.js';
import type { SignalingServerOptions } from '../src/index.js';
import { closeDb } from '../src/db/client.js';
import { agentConnections, browserConnections } from '../src/routes/ws.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** Resolve after `ms` milliseconds. */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` every 10ms until it returns a defined value, or throw on timeout. */
export async function waitFor<T>(
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

/**
 * Open an agent WebSocket on an ephemeral server and collect every frame the
 * server pushes. The message handler is registered before waiting for `open`
 * so a frame pushed immediately on connect is never missed. Shared by the
 * signaling, ICE, and WS2 identity test files so the connect-and-collect
 * boilerplate lives in exactly one place.
 */
export async function connectAgentCollect(
  port: number,
  credential: string,
): Promise<{ ws: WebSocket; received: string[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  const received: string[] = [];
  ws.on('message', (data: Buffer) => {
    received.push(data.toString());
  });
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
  return { ws, received };
}

export type AuthResponse = {
  user: { id: string; username: string };
  token: string;
  refreshToken: string;
};

/** Loose view of a frame as parsed from the wire. Superset of what the ws suites read. */
export type AnyFrame = {
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

export async function startOnEphemeral(opts?: SignalingServerOptions): Promise<{
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

export async function registerUser(
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

export async function registerAgent(
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

export async function mintTicket(
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
export function resetConnectionState(): void {
  agentConnections.clear();
  browserConnections.clear();
  closeDb();
}

export function collectFrames(ws: WebSocket): AnyFrame[] {
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

export function connectBrowser(
  port: number,
  ticket: string,
  origin?: string,
): WebSocket {
  const url = `ws://127.0.0.1:${port}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`;
  return new WebSocket(url, origin ? { origin } : {});
}

export function connectAgent(port: number, credential: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/ws/agent`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

export async function waitOpen(ws: WebSocket): Promise<void> {
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
}

export async function waitClosed(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.on('close', (code: number) => resolve({ code }));
  });
}

export async function sendFrame(ws: WebSocket, frame: unknown): Promise<void> {
  ws.send(JSON.stringify(frame));
  await wait(30);
}
