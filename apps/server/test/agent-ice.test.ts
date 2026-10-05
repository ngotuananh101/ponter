import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { agentConnections } from '../src/routes/ws.js';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { waitFor } from './helpers.js';

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

type IceServerEntry = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

describe('Agent ICE servers pushed over WebSocket', () => {
  let token: string;
  let userId: string;
  let credential: string;

  beforeEach(async () => {
    getDb(':memory:');

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

    const agentRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_ice_test',
          hostname: 'test-host',
          publicKey: 'pk_agent',
        }),
      }),
    );
    const agentData = (await agentRes.json()) as AgentResponse;
    credential = agentData.credential;
  });

  afterEach(() => {
    agentConnections.clear();
    closeDb();
  });

  /**
   * Connect an agent and collect every frame the server pushes.
   * The helper resolves once the socket is open.
   */
  async function connectAgentAndCollect(port: number) {
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

  it('1. pushes an ice-servers frame on connect when TURN is configured', async () => {
    process.env.TURN_SECRET = TURN_SECRET;
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { port } = await startOnEphemeral();
    const { ws, received } = await connectAgentAndCollect(port);

    const frame = await waitFor(() =>
      received.find((m) => m.includes('"ice-servers"')),
    );
    const parsed = JSON.parse(frame) as {
      type: string;
      data: { iceServers: IceServerEntry[] };
    };

    expect(parsed.type).toBe('ice-servers');
    expect(parsed.data.iceServers).toHaveLength(2);

    ws.close();
  });

  it('2. the pushed TURN entry carries valid HMAC-SHA1 credentials bound to the agent owner', async () => {
    process.env.TURN_SECRET = TURN_SECRET;
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { port } = await startOnEphemeral();
    const { ws, received } = await connectAgentAndCollect(port);

    const frame = await waitFor(() =>
      received.find((m) => m.includes('"ice-servers"')),
    );
    const parsed = JSON.parse(frame) as {
      data: { iceServers: IceServerEntry[] };
    };

    const turn = parsed.data.iceServers[1]!;
    expect(turn.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
    ]);
    expect(turn.username).toBeDefined();
    expect(turn.credential).toBeDefined();

    // username = "<expiry>:<userId>" — the agent belongs to `userId`.
    const [expiryStr, userIdPart] = (turn.username ?? '').split(':');
    expect(Number(expiryStr)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(userIdPart).toBe(userId);

    const { createHmac } = await import('node:crypto');
    const expectedCredential = createHmac('sha1', TURN_SECRET)
      .update(turn.username ?? '')
      .digest('base64');
    expect(turn.credential).toBe(expectedCredential);

    ws.close();
  });

  it('3. pushes a STUN-only ice-servers frame when TURN is not configured', async () => {
    process.env.TURN_SECRET = '';
    process.env.TURN_URL = '';
    process.env.STUN_URL = '';

    const { port } = await startOnEphemeral();
    const { ws, received } = await connectAgentAndCollect(port);

    const frame = await waitFor(() =>
      received.find((m) => m.includes('"ice-servers"')),
    );
    const parsed = JSON.parse(frame) as {
      data: { iceServers: IceServerEntry[] };
    };

    expect(parsed.data.iceServers).toHaveLength(1);
    expect(parsed.data.iceServers[0]!.urls).toEqual([
      'stun:stun.l.google.com:19302',
    ]);

    ws.close();
  });
});
