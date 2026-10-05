import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSignalingServer } from '../src/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { agentConnections } from '../src/routes/ws.js';
import type { IdentityProof } from '@ponter/shared';

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

type SessionResponse = {
  id: string;
  userId: string;
  agentId: string | null;
  status: string;
};

const VALID_PROOF: IdentityProof = {
  signature: 'dG90YWxseS1ub3QtYS1zaWduYXR1cmU=',
  fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
};

describe('WS2 signal peer identity proof transport (Task 7)', () => {
  let token: string;
  let sessionId: string;
  let app: ReturnType<typeof createSignalingServer>['app'];

  beforeEach(async () => {
    getDb(':memory:');

    const server = createSignalingServer();
    app = server.app;

    // Register user (first user becomes approved admin in test env).
    const regRes = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ws2_proof_user',
          password: 'Password123!',
          publicKey: 'pk_tester',
        }),
      }),
    );
    expect(regRes.status).toBe(201);
    const regData = (await regRes.json()) as AuthResponse;
    token = regData.token;

    // Register an agent.
    const agentRes = await app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: 'agent_proof_test',
          hostname: 'test-host',
          publicKey: 'pk_agent',
        }),
      }),
    );
    expect(agentRes.status).toBe(201);

    // Create a session bound to the agent.
    const sessRes = await app.fetch(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentId: 'agent_proof_test' }),
      }),
    );
    expect(sessRes.status).toBe(201);
    const sessData = (await sessRes.json()) as SessionResponse;
    sessionId = sessData.id;
  });

  afterEach(() => {
    agentConnections.clear();
    closeDb();
  });

  /** POST a signal; returns the raw Response (assert status in the test). */
  async function postSignal(path: string, body: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/api/signal/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Poll the session's signals; asserts 200 and returns the typed body. */
  async function pollSignals(): Promise<{
    signals: Array<{ type: string; payload: Record<string, unknown> }>;
  }> {
    const res = await app.fetch(
      new Request(`http://localhost/api/signal/poll/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      signals: Array<{ type: string; payload: Record<string, unknown> }>;
    };
  }

  it('POST offer with valid proof is pollable verbatim', async () => {
    const offerRes = await postSignal('offer', {
      sessionId,
      sdp: 'v=0-o=offer',
      capabilities: ['terminal', 'files'],
      proof: VALID_PROOF,
    });

    expect(offerRes.status).toBe(201);

    const pollBody = await pollSignals();
    expect(pollBody.signals).toHaveLength(1);
    expect(pollBody.signals[0]?.type).toBe('offer');

    const payload = pollBody.signals[0]?.payload;
    expect(payload.proof).toEqual(VALID_PROOF);
    expect(payload.proof?.signature).toBe(VALID_PROOF.signature);
    expect(payload.proof?.fingerprint).toBe(VALID_PROOF.fingerprint);
  });

  it('POST answer with valid proof is pollable verbatim', async () => {
    const answerRes = await postSignal('answer', {
      sessionId,
      sdp: 'v=0-o=answer',
      approved: true,
      proof: VALID_PROOF,
    });

    expect(answerRes.status).toBe(201);

    const pollBody = await pollSignals();
    expect(pollBody.signals).toHaveLength(1);
    expect(pollBody.signals[0]?.type).toBe('answer');

    const payload = pollBody.signals[0]?.payload;
    expect(payload.proof).toEqual(VALID_PROOF);
    expect(payload.proof?.signature).toBe(VALID_PROOF.signature);
    expect(payload.proof?.fingerprint).toBe(VALID_PROOF.fingerprint);
  });

  it('POST offer WITHOUT proof is backward compatible (no proof in poll)', async () => {
    const offerRes = await postSignal('offer', {
      sessionId,
      sdp: 'v=0-o=offer',
      capabilities: ['terminal'],
    });

    expect(offerRes.status).toBe(201);

    const pollBody = await pollSignals();
    expect(pollBody.signals).toHaveLength(1);
    expect(pollBody.signals[0]?.type).toBe('offer');
    expect(pollBody.signals[0]?.payload.proof).toBeUndefined();
  });

  it('POST offer with malformed proof (empty signature) drops proof (absent)', async () => {
    const malformedProof = {
      signature: '',
      fingerprint: 'AA:BB',
    };

    const offerRes = await postSignal('offer', {
      sessionId,
      sdp: 'v=0-o=offer',
      capabilities: ['terminal'],
      proof: malformedProof,
    });

    expect(offerRes.status).toBe(201);

    const pollBody = await pollSignals();
    expect(pollBody.signals).toHaveLength(1);
    expect(pollBody.signals[0]?.type).toBe('offer');
    // Malformed proof (empty signature) is dropped — treated as absent.
    expect(pollBody.signals[0]?.payload.proof).toBeUndefined();
  });

  it('POST offer with malformed proof (missing fingerprint) drops proof', async () => {
    const malformedProof = {
      signature: 'aGVsbG8=',
    };

    const offerRes = await postSignal('offer', {
      sessionId,
      sdp: 'v=0-o=offer',
      capabilities: [],
      proof: malformedProof,
    });

    expect(offerRes.status).toBe(201);

    const pollBody = await pollSignals();
    expect(pollBody.signals[0]?.payload.proof).toBeUndefined();
  });
});
