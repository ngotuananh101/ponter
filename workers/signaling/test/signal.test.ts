import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { RESET_STATEMENTS } from './helpers';

type AuthResponse = {
  token: string;
  user: { id: string };
};

type SignalResponse = {
  id: string;
  sessionId: string;
  type: string;
  createdAt: string;
};

type PollResponse = {
  signals: Array<{
    id: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  cursor: string | null;
};

type ErrorResponse = {
  error: string;
  code: string;
};

describe('Signaling REST API (/api/signal)', () => {
  let tokenUserA: string;
  let tokenUserB: string;
  let sessionIdA: string;

  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));

    // Register User A
    const resA = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user_a',
          password: 'Password123!',
          publicKey: 'pk_a',
        }),
      },
      env,
    );
    const dataA = (await resA.json()) as AuthResponse;
    tokenUserA = dataA.token;

    // Register User B
    const resB = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user_b',
          password: 'Password123!',
          publicKey: 'pk_b',
        }),
      },
      env,
    );
    const dataB = (await resB.json()) as AuthResponse;
    tokenUserB = dataB.token;

    // Create session for User A
    const sessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const sessData = (await sessRes.json()) as { id: string };
    sessionIdA = sessData.id;
  });

  it('posts offer signal to active session', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1',
          capabilities: ['terminal'],
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.sessionId).toBe(sessionIdA);
    expect(data.type).toBe('offer');
    expect(data.id).toBeDefined();
  });

  it('posts answer signal to active session', async () => {
    const res = await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'v=0\r\no=- 456 2 IN IP4 127.0.0.1',
          approved: true,
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.type).toBe('answer');
  });

  it('posts ice-candidate signal to active session', async () => {
    const res = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as SignalResponse;
    expect(data.type).toBe('ice-candidate');
  });

  it('polls signals for a session and parses JSON payloads', async () => {
    // 1. Post offer
    await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({
          sessionId: sessionIdA,
          sdp: 'offer_sdp',
        }),
      },
      env,
    );

    // 2. Poll signals
    const pollRes = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    expect(pollRes.status).toBe(200);
    const data = (await pollRes.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.type).toBe('offer');
    expect(data.signals[0]?.payload.sdp).toBe('offer_sdp');
    expect(data.cursor).toBe(data.signals[0]?.id);
  });

  it('advances cursor on poll and skips previously returned signals', async () => {
    // Post two candidates
    const r1 = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, candidate: 'cand_1' }),
      },
      env,
    );
    const sig1 = (await r1.json()) as SignalResponse;

    await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, candidate: 'cand_2' }),
      },
      env,
    );

    // Poll after sig1
    const pollRes = await app.request(
      `/api/signal/poll/${sessionIdA}?after=${sig1.id}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const data = (await pollRes.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.payload.candidate).toBe('cand_2');
  });

  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('rejects foreign-session post with 404 NOT_FOUND (ownership boundary)', async () => {
    // User B attempts to post to User A's session
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserB}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );

    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('rejects foreign-session poll with 404 NOT_FOUND (ownership boundary)', async () => {
    // User B attempts to poll User A's session
    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserB}` },
      },
      env,
    );

    expect(res.status).toBe(404);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('rejects signaling on terminated session with 409 SESSION_NOT_ACTIVE', async () => {
    // Terminate session
    await app.request(
      `/api/sessions/${sessionIdA}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'v=0' }),
      },
      env,
    );

    expect(res.status).toBe(409);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('rejects missing sessionId with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sdp: 'v=0' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing sdp on offer/answer with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/offer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing candidate on ice-candidate with 400 VALIDATION_ERROR', async () => {
    const res = await app.request(
      '/api/signal/ice-candidate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('clamps limit to maximum 200 on poll', async () => {
    // Seed 201 signals in one statement so the clamp is observable. Without a
    // clamp this session returns all 201 and the DoS vector spec §7 names is
    // live; with the clamp it returns exactly 200.
    await env.DB.prepare(
      `INSERT INTO signals (id, session_id, type, payload)
       WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 201)
       SELECT 'sig_' || x, ?, 'ice-candidate', '{"candidate":"c' || x || '"}' FROM cnt`,
    )
      .bind(sessionIdA)
      .run();

    const res = await app.request(
      `/api/signal/poll/${sessionIdA}?limit=500`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as PollResponse;
    expect(data.signals).toHaveLength(200);
  });

  it('filters out signals whose expires_at has passed', async () => {
    // A live signal alongside the expired one: without it, a route that returns
    // nothing at all would satisfy the assertion below.
    await env.DB.prepare(
      `INSERT INTO signals (id, session_id, type, payload)
       VALUES ('sig_live', ?, 'offer', '{"sdp":"live"}')`,
    )
      .bind(sessionIdA)
      .run();

    await env.DB.prepare(
      `INSERT INTO signals (id, session_id, type, payload, expires_at)
       VALUES ('sig_expired', ?, 'offer', '{"sdp":"expired"}', datetime('now', '-10 minutes'))`,
    )
      .bind(sessionIdA)
      .run();

    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      {
        headers: { Authorization: `Bearer ${tokenUserA}` },
      },
      env,
    );

    const data = (await res.json()) as PollResponse;
    expect(data.signals.find((s) => s.id === 'sig_live')).toBeDefined();
    expect(data.signals.find((s) => s.id === 'sig_expired')).toBeUndefined();
  });

  it('still returns signals for a terminated session (poll drain)', async () => {
    // Mutant #5 (Week 4 R24): adding a status check to the poll route leaves
    // the suite green. Week 5 makes the poll load-bearing — the browser must be
    // able to read the final answer written before the agent's socket closed.
    await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA, sdp: 'final_answer' }),
      },
      env,
    );

    await app.request(
      `/api/sessions/${sessionIdA}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tokenUserA}` } },
      env,
    );

    const res = await app.request(
      `/api/signal/poll/${sessionIdA}`,
      { headers: { Authorization: `Bearer ${tokenUserA}` } },
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as PollResponse;
    expect(data.signals).toHaveLength(1);
    expect(data.signals[0]?.payload.sdp).toBe('final_answer');
  });

  it('rejects a missing sdp on the answer route with 400 VALIDATION_ERROR', async () => {
    // Mutant #6 (Week 4 R24): deleting the sdp check at
    // src/routes/signal.ts:99-105 leaves the suite green because the existing
    // coverage only posts to the offer route.
    const res = await app.request(
      '/api/signal/answer',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenUserA}`,
        },
        body: JSON.stringify({ sessionId: sessionIdA }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const err = (await res.json()) as ErrorResponse;
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});
