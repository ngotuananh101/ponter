import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { agentConnections } from '../src/routes/ws.js';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { wait, waitFor, connectAgentCollect } from './helpers.js';

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

  /** Generate an Ed25519 keypair and its raw base64 public key. */
  async function agentKey(): Promise<{
    keyPair: webcrypto.CryptoKeyPair;
    publicKeyB64: string;
  }> {
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);
    const rawPub = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
    return { keyPair, publicKeyB64: Buffer.from(rawPub).toString('base64') };
  }

  /** Wait for the identity-challenge frame and return its parsed object. */
  async function waitForChallenge(received: string[]): Promise<{
    type: 'identity-challenge';
    data: { nonce: string };
  }> {
    const frame = (await waitFor(() =>
      received.find((m) => m.includes('"identity-challenge"')),
    )) as string;
    return JSON.parse(frame) as {
      type: 'identity-challenge';
      data: { nonce: string };
    };
  }

  /** Sign the nonce and send the agent-identity frame over `ws`. */
  async function sendIdentity(
    ws: WebSocket,
    keyPair: webcrypto.CryptoKeyPair,
    publicKeyB64: string,
    nonce: string,
    signatureOverride?: string,
  ): Promise<void> {
    const sig =
      signatureOverride ??
      Buffer.from(
        await webcrypto.subtle.sign(
          'Ed25519',
          keyPair.privateKey,
          new TextEncoder().encode(`${PROOF_PREFIX}${nonce}`),
        ),
      ).toString('base64');
    ws.send(
      JSON.stringify({
        type: 'agent-identity',
        data: { publicKey: publicKeyB64, nonce, signature: sig },
      }),
    );
  }

  /** Fetch the agent list and return the stored agent's signing key. */
  async function storedSigningKey(): Promise<string | null | undefined> {
    const { app } = createSignalingServer();
    const listRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const list = (await listRes.json()) as AgentResponse[];
    return list.find((a) => a.id === agentId)?.signingPublicKey;
  }

  it('sends an identity-challenge frame on connect, and stores the signed key', async () => {
    const { port } = await startOnEphemeral();

    const { keyPair, publicKeyB64 } = await agentKey();
    const { ws, received } = await connectAgentCollect(port, credential);

    const challenge = await waitForChallenge(received);

    expect(challenge.type).toBe('identity-challenge');
    expect(challenge.data.nonce).toBeTruthy();

    await sendIdentity(ws, keyPair, publicKeyB64, challenge.data.nonce);
    await wait(100);

    expect(await storedSigningKey()).toBe(publicKeyB64);

    ws.close();
  });

  it('rejects a bad signature (4401) and does not store the key', async () => {
    const { port } = await startOnEphemeral();

    const { keyPair, publicKeyB64 } = await agentKey();
    const { ws, received } = await connectAgentCollect(port, credential);

    const challenge = await waitForChallenge(received);

    // Capture the close code before sending the bad signature.
    const closePromise = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code: number) => resolve({ code }));
    });

    await sendIdentity(
      ws,
      keyPair,
      publicKeyB64,
      challenge.data.nonce,
      'AAAAAAAAAAAAAAAAAAAAAA==',
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

    expect(await storedSigningKey()).toBeNull();
  });

  it('re-connecting with the same key is idempotent', async () => {
    const { port } = await startOnEphemeral();

    const { keyPair, publicKeyB64 } = await agentKey();

    // First connection: register the key.
    {
      const { ws, received } = await connectAgentCollect(port, credential);
      const challenge = await waitForChallenge(received);
      await sendIdentity(ws, keyPair, publicKeyB64, challenge.data.nonce);
      await wait(100);
      ws.close();
    }

    // Close handler needs time to run.
    await wait(200);

    // Second connection: same key, fresh nonce.
    {
      const { ws, received } = await connectAgentCollect(port, credential);
      const challenge = await waitForChallenge(received);
      await sendIdentity(ws, keyPair, publicKeyB64, challenge.data.nonce);
      await wait(100);
      ws.close();
    }

    expect(await storedSigningKey()).toBe(publicKeyB64);
  });
});
