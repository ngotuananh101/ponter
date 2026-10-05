import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { agentConnections } from '../src/routes/ws.js';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// In-process secrets for tests
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const REFRESH_TOKEN_SECRET = 'test-refresh-secret-at-least-32-characters';

process.env.JWT_SECRET = JWT_SECRET;
process.env.REFRESH_TOKEN_SECRET = REFRESH_TOKEN_SECRET;

type AuthResponse = {
  user: { id: string; username: string };
  token: string;
  refreshToken: string;
  expiresIn: number;
};

type AgentResponse = {
  agent: {
    id: string;
    userId: string;
    publicKey: string;
    signingPublicKey: string | null;
  };
  credential: string;
};

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

/** Start the signaling server on an ephemeral port. */
async function startOnEphemeral(): Promise<{
  port: number;
  server: Server;
}> {
  const { server } = createSignalingServer();

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

const PROOF_PREFIX = 'ponter-ws2-agent-identity-v1\nnonce=';

/**
 * Helper: open the agent WebSocket and return it plus a receiver array that
 * captures every frame pushed by the server.
 */
async function connectAgent(
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

describe('WS2 agent peer identity (Task 6)', () => {
  let token: string;
  let credential: string;
  let agentId: string;

  beforeEach(async () => {
    getDb(':memory:');

    const { app } = createSignalingServer();

    // Register a user (auto-approved by default in test env via the first-user
    // bootstrap — the first registered user becomes an approved admin).
    const regRes = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ws2_agent_id_user',
          password: 'Password123!',
          publicKey: 'pk_tester',
        }),
      }),
    );
    const regData = (await regRes.json()) as AuthResponse;
    token = regData.token;

    // Register an agent WITHOUT a publicKey (optional per the contract).
    const agentRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_id_test',
          hostname: 'test-host',
        }),
      }),
    );
    const agentData = (await agentRes.json()) as AgentResponse;
    credential = agentData.credential;
    agentId = agentData.agent.id;
  });

  afterEach(() => {
    agentConnections.clear();
    closeDb();
  });

  it('sends an identity-challenge frame on connect, and stores the signed key', async () => {
    const { port } = await startOnEphemeral();

    // Generate an Ed25519 key pair for the agent.
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);

    // Export raw public key, base64-encode it.
    const rawPub = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
    const publicKeyB64 = Buffer.from(rawPub).toString('base64');

    const { ws, received } = await connectAgent(port, credential);

    // The first frame after ICE should be the identity-challenge.
    const challengeFrame = await waitFor(
      () =>
        received.find((m) => m.includes('"identity-challenge"')) as
          string | undefined,
    );

    const challenge = JSON.parse(challengeFrame) as {
      type: 'identity-challenge';
      data: { nonce: string };
    };

    expect(challenge.type).toBe('identity-challenge');
    expect(challenge.data.nonce).toBeTruthy();

    // Sign the nonce proof message.
    const msg = `${PROOF_PREFIX}${challenge.data.nonce}`;
    const sig = await webcrypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(msg),
    );
    const signatureB64 = Buffer.from(sig).toString('base64');

    // Send the agent-identity frame.
    ws.send(
      JSON.stringify({
        type: 'agent-identity',
        data: {
          publicKey: publicKeyB64,
          nonce: challenge.data.nonce,
          signature: signatureB64,
        },
      }),
    );

    // Wait for the server to process (it's synchronous-ish, but give it a tick).
    await wait(100);

    // Verify the key is stored via the REST API.
    const { app } = createSignalingServer();
    const listRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await listRes.json()) as AgentResponse[];
    const stored = list.find((a) => a.id === agentId);
    expect(stored).toBeDefined();
    expect(stored?.signingPublicKey).toBe(publicKeyB64);

    ws.close();
  });

  it('rejects a bad signature (4401) and does not store the key', async () => {
    const { port } = await startOnEphemeral();

    // Generate a real key pair so we have a valid public key shape.
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);
    const rawPub = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
    const publicKeyB64 = Buffer.from(rawPub).toString('base64');

    const { ws, received } = await connectAgent(port, credential);

    // Wait for the challenge.
    const challengeFrame = (await waitFor(() =>
      received.find((m) => m.includes('"identity-challenge"')),
    )) as string;
    const challenge = JSON.parse(challengeFrame) as {
      type: 'identity-challenge';
      data: { nonce: string };
    };

    // Capture the close code before sending the bad signature.
    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
    });

    // Send a deliberately wrong signature.
    ws.send(
      JSON.stringify({
        type: 'agent-identity',
        data: {
          publicKey: publicKeyB64,
          nonce: challenge.data.nonce,
          signature: 'AAAAAAAAAAAAAAAAAAAAAA==',
        },
      }),
    );

    // The socket should close with 4401.
    const closeFrame = await Promise.race([
      closePromise,
      // Fallback timeout to surface a genuine hang.
      new Promise<{ code: number }>((resolve) =>
        setTimeout(() => resolve({ code: 0 }), 2000),
      ),
    ]);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(closeFrame.code).toBe(4401);

    // Verify no key was stored.
    const { app } = createSignalingServer();
    const listRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await listRes.json()) as AgentResponse[];
    const stored = list.find((a) => a.id === agentId);
    expect(stored?.signingPublicKey).toBeNull();
  });

  it('re-connecting with the same key is idempotent', async () => {
    const { port } = await startOnEphemeral();

    // Generate one key pair for this test.
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);
    const rawPub = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
    const publicKeyB64 = Buffer.from(rawPub).toString('base64');

    // First connection: register the key.
    {
      const { ws, received } = await connectAgent(port, credential);
      const challengeFrame = (await waitFor(() =>
        received.find((m) => m.includes('"identity-challenge"')),
      )) as string;
      const challenge = JSON.parse(challengeFrame) as {
        type: 'identity-challenge';
        data: { nonce: string };
      };

      const msg = `${PROOF_PREFIX}${challenge.data.nonce}`;
      const sig = await webcrypto.subtle.sign(
        'Ed25519',
        keyPair.privateKey,
        new TextEncoder().encode(msg),
      );
      const signatureB64 = Buffer.from(sig).toString('base64');

      ws.send(
        JSON.stringify({
          type: 'agent-identity',
          data: {
            publicKey: publicKeyB64,
            nonce: challenge.data.nonce,
            signature: signatureB64,
          },
        }),
      );

      await wait(100);
      ws.close();
    }

    // Close handler needs time to run.
    await wait(200);

    // Second connection: same key, fresh nonce.
    {
      const { ws, received } = await connectAgent(port, credential);
      const challengeFrame = (await waitFor(() =>
        received.find((m) => m.includes('"identity-challenge"')),
      )) as string;
      const challenge = JSON.parse(challengeFrame) as {
        type: 'identity-challenge';
        data: { nonce: string };
      };

      const msg = `${PROOF_PREFIX}${challenge.data.nonce}`;
      const sig = await webcrypto.subtle.sign(
        'Ed25519',
        keyPair.privateKey,
        new TextEncoder().encode(msg),
      );
      const signatureB64 = Buffer.from(sig).toString('base64');

      ws.send(
        JSON.stringify({
          type: 'agent-identity',
          data: {
            publicKey: publicKeyB64,
            nonce: challenge.data.nonce,
            signature: signatureB64,
          },
        }),
      );

      await wait(100);
      ws.close();
    }

    // The stored key must still equal the one we registered.
    const { app } = createSignalingServer();
    const listRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await listRes.json()) as AgentResponse[];
    const stored = list.find((a) => a.id === agentId);
    expect(stored?.signingPublicKey).toBe(publicKeyB64);
  });
});
