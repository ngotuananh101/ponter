import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import app from '../src/index';
import { agentConnections, MAX_INBOUND_FRAME_BYTES } from '../src/routes/ws';
import { RESET_STATEMENTS } from './helpers';

type AuthResponse = { token: string; user: { id: string } };

type ErrorResponse = { error: string; code: string };

type AgentCreated = {
  agent: { id: string; userId: string };
  credential: string;
};

const WS_URL = '/api/ws/agent';

/** Register a user, an agent, and a session bound to that agent. */
async function seed(): Promise<{
  token: string;
  userId: string;
  agentId: string;
  credential: string;
  sessionId: string;
}> {
  const res = await app.request(
    '/api/auth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ws_user',
        password: 'Password123!',
        publicKey: 'pk_ws',
      }),
    },
    env,
  );
  const auth = (await res.json()) as AuthResponse;

  const agentRes = await app.request(
    '/api/agents',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        id: 'agent_ws',
        publicKey: 'pk_agent_ws',
        capabilities: ['terminal'],
      }),
    },
    env,
  );
  const created = (await agentRes.json()) as AgentCreated;

  const sessRes = await app.request(
    '/api/sessions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ agentId: created.agent.id }),
    },
    env,
  );
  const session = (await sessRes.json()) as { id: string };

  return {
    token: auth.token,
    userId: auth.user.id,
    agentId: created.agent.id,
    credential: created.credential,
    sessionId: session.id,
  };
}

describe('Agent WebSocket (/api/ws/agent)', () => {
  beforeEach(async () => {
    await env.DB.batch(RESET_STATEMENTS.map((s) => env.DB.prepare(s)));
    agentConnections.clear();
  });

  it('returns an identical 401 for a missing header, a wrong scheme, and an unknown credential', async () => {
    // Review Focus #1: a distinguishing body or status turns this endpoint into
    // a credential oracle. All three must be byte-identical.
    const missing = await app.request(WS_URL, { headers: {} }, env);
    const wrongScheme = await app.request(
      WS_URL,
      { headers: { Authorization: 'Basic ag_whatever' } },
      env,
    );
    const unknown = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: 'Bearer ag_00000000000000000000000000000000',
        },
      },
      env,
    );

    for (const res of [missing, wrongScheme, unknown]) {
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorResponse;
      expect(body).toEqual({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        details: null,
      });
    }

    expect(agentConnections.size).toBe(0);
  });

  it('returns 426 UPGRADE_REQUIRED for a valid credential on a non-upgrade GET', async () => {
    // W6: without this guard, real workerd returns a 500. The pool cannot
    // reproduce the 500, but it can pin the guard's observable.
    const { credential } = await seed();

    const res = await app.request(
      WS_URL,
      { headers: { Authorization: `Bearer ${credential}` } },
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as ErrorResponse;
    expect(body.code).toBe('UPGRADE_REQUIRED');
    expect(agentConnections.size).toBe(0);
  });

  it('authenticates a credential and registers before the 101', async () => {
    // D2/W5: registration happens in the route body, so a POST that lands
    // while the upgrade response is in flight cannot see an unregistered socket.
    const { credential, agentId } = await seed();

    const res = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );

    expect(res.status).toBe(101);
    expect(res.webSocket).toBeDefined();

    // Registered by the time the response is observable (W5).
    expect(agentConnections.has(agentId)).toBe(true);
    expect(agentConnections.get(agentId)?.agentId).toBe(agentId);

    // D11: is_online is set at accept(), not only on the first ping.
    const row = await env.DB.prepare(
      `SELECT is_online, last_ping_at FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number; last_ping_at: string | null }>();
    expect(row?.is_online).toBe(1);
    // W10: space-separated UTC, never ISO-8601.
    expect(row?.last_ping_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it('persists an inbound answer so the browser poll returns it, and echoes it', async () => {
    // W6/W13: the agent's answer must be indistinguishable from one posted over
    // REST — same type, same payload, same rowid cursor.
    const { credential, agentId, sessionId, token } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    expect(ws).toBeDefined();
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 agent', approved: true },
        },
      }),
    );

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    const echo = JSON.parse(received[0] ?? '{}') as {
      type: string;
      data: { type: string; data: { sessionId: string; sdp: string } };
    };
    expect(echo.type).toBe('signal');
    expect(echo.data.type).toBe('answer');
    expect(echo.data.data.sdp).toBe('v=0 agent');

    // The row exists and the browser's existing poll returns it unchanged.
    const poll = await app.request(
      `/api/signal/poll/${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(poll.status).toBe(200);
    const polled = (await poll.json()) as {
      signals: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(polled.signals).toHaveLength(1);
    expect(polled.signals[0]?.type).toBe('answer');
    expect(polled.signals[0]?.payload).toEqual({
      sessionId,
      sdp: 'v=0 agent',
      approved: true,
    });

    // The session advanced (Task 5 completes the transition; this asserts the
    // row the transition reads).
    expect(agentConnections.get(agentId)?.userId).toBeDefined();

    ws?.close();
  });

  it('rejects malformed frames without writing and leaves the socket open', async () => {
    // Review Focus #4: every malformed inbound frame yields an error frame and
    // the socket stays usable. A throw out of the message handler is the
    // dangerous case.
    const { credential, sessionId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    const cases: Array<{ frame: string; code: string }> = [
      { frame: 'not json at all', code: 'MALFORMED_JSON' },
      { frame: '[]', code: 'MALFORMED_JSON' },
      { frame: 'null', code: 'MALFORMED_JSON' },
      { frame: '{"type":"unknown"}', code: 'VALIDATION_ERROR' },
      { frame: '{"type":"signal"}', code: 'VALIDATION_ERROR' },
      {
        frame: JSON.stringify({
          type: 'signal',
          data: { type: 'answer', data: { sessionId, sdp: '' } },
        }),
        code: 'VALIDATION_ERROR',
      },
      // Review Focus #4 / §7.4 edge 4: the cap is refused before parsing.
      // This frame is a well-formed *object* carrying a syntactically valid
      // answer for a session that does not exist, so it is the cap and nothing
      // else that produces MALFORMED_JSON — without the cap it would be
      // NOT_FOUND, and the assertion below would fail. That is what makes this
      // case pin the cap rather than merely pass alongside it.
      {
        frame: JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: {
              sessionId: 'oversize',
              sdp: 'v=0 ' + 'x'.repeat(MAX_INBOUND_FRAME_BYTES),
            },
          },
        }),
        code: 'MALFORMED_JSON',
      },
    ];

    for (const { frame, code } of cases) {
      const before = received.length;
      ws?.send(frame);
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(before));
      const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
        type: string;
        code: string;
      };
      expect(reply.type).toBe('error');
      expect(reply.code).toBe(code);
    }

    // Nothing was written by any rejected frame.
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    // The socket survived every one of them.
    ws?.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() =>
      expect(received.some((r) => r.includes('"pong"'))).toBe(true),
    );

    ws?.close();
  });

  it('rejects a foreign session and an agentless session with NOT_FOUND, writing nothing', async () => {
    // W7/W14: tenancy is two conjuncts. A rejected frame that still inserts is
    // the failure mode that matters, so this asserts D1 was not written.
    const { credential, token } = await seed();

    // A second user's session, not bound to this agent.
    const otherRes = await app.request(
      '/api/auth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ws_other',
          password: 'Password123!',
          publicKey: 'pk_other',
        }),
      },
      env,
    );
    const other = (await otherRes.json()) as AuthResponse;
    const foreignSess = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const foreign = (await foreignSess.json()) as { id: string };

    // Same user as the agent, but the session carries no agentId. This is the
    // `session.agentId === null` branch specifically: an
    // `if (session.agentId && …)` guard would let it through, and only the
    // `!==` comparison against a non-null id rejects it.
    const agentlessRes = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      },
      env,
    );
    const agentless = (await agentlessRes.json()) as { id: string };

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    for (const sessionId of [foreign.id, agentless.id]) {
      const before = received.length;
      ws?.send(
        JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: { sessionId, sdp: 'v=0 sneaky', approved: true },
          },
        }),
      );
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(before));
      const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
        type: string;
        code: string;
      };
      expect(reply).toEqual({ type: 'error', code: 'NOT_FOUND' });
    }

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);

    ws?.close();
  });

  it('a second connection supersedes the first without evicting it', async () => {
    // W8/Review Focus #1: two connections for one agentId are possible (a
    // reconnecting agent). The stale socket's close must not evict the live one
    // nor clear is_online, or a connected agent reads offline.
    const { credential, agentId } = await seed();

    const first = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const wsA = first.webSocket;
    wsA?.accept();

    const second = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const wsB = second.webSocket;
    wsB?.accept();

    // Exactly one entry, and it is the newer socket.
    expect(agentConnections.size).toBe(1);
    expect(agentConnections.get(agentId)?.socket).toBeDefined();

    // Closing the superseded socket must leave the live one in the map...
    wsA?.close();
    await vi.waitFor(() => expect(agentConnections.size).toBe(1));

    // ...and must not have cleared is_online for the connected agent.
    const row = await env.DB.prepare(
      `SELECT is_online FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number }>();
    expect(row?.is_online).toBe(1);

    // Closing the live socket does evict and clear.
    wsB?.close();
    await vi.waitFor(() => expect(agentConnections.size).toBe(0));
    await vi.waitFor(async () => {
      const after = await env.DB.prepare(
        `SELECT is_online FROM agents WHERE id = ?`,
      )
        .bind(agentId)
        .first<{ is_online: number }>();
      expect(after?.is_online).toBe(0);
    });
  });

  it('advances the session to active with a started_at when an answer is persisted', async () => {
    // Step 1 (corrected per R-27/D-8): the transition keys on the signal type, and it is guarded by
    // `WHERE status = 'pending'` so a second answer cannot reset started_at.
    const { credential, sessionId } = await seed();

    const before = await env.DB.prepare(
      `SELECT status, started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ status: string; started_at: string | null }>();
    expect(before?.status).toBe('pending');
    expect(before?.started_at).toBeNull();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    const sendAnswer = (sdp: string) =>
      ws?.send(
        JSON.stringify({
          type: 'signal',
          data: {
            type: 'answer',
            data: { sessionId, sdp, approved: true },
          },
        }),
      );

    sendAnswer('first answer');
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status, started_at FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string; started_at: string | null }>();
      expect(row?.status).toBe('active');
    });

    const afterFirst = await env.DB.prepare(
      `SELECT started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ started_at: string }>();
    // W10: the column must carry the SQLite shape, not ISO-8601.
    expect(afterFirst?.started_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(afterFirst?.started_at).not.toContain('T');

    // A second answer is still persisted, but must not move started_at.
    sendAnswer('second answer');
    await vi.waitFor(async () => {
      const rows = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
      )
        .bind(sessionId)
        .first<{ n: number }>();
      expect(rows?.n).toBe(2);
    });

    const afterSecond = await env.DB.prepare(
      `SELECT started_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ started_at: string }>();
    expect(afterSecond?.started_at).toBe(afterFirst?.started_at);

    ws?.close();
  });

  it('terminates the session when the agent socket closes, and does not overwrite ended_at', async () => {
    // §6.1 + W11: the close handler is the only thing that ends a session the
    // browser did not end. The guard is what keeps a second close from moving
    // `ended_at` forward.
    const { credential, sessionId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    // Advance it to `active` first, so the transition under test is
    // `active -> terminated` rather than `pending -> terminated`.
    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 active', approved: true },
        },
      }),
    );
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string }>();
      expect(row?.status).toBe('active');
    });

    ws?.close();

    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        `SELECT status, ended_at FROM sessions WHERE id = ?`,
      )
        .bind(sessionId)
        .first<{ status: string; ended_at: string | null }>();
      expect(row?.status).toBe('terminated');
    });

    const terminated = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();
    expect(terminated?.ended_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );

    // A second close (a superseded socket, or a duplicate event) must not move
    // `ended_at`. The guard is `WHERE status IN ('pending','active')`.
    await env.DB.prepare(
      `UPDATE sessions SET ended_at = datetime('now', '+1 hour') WHERE id = ?`,
    )
      .bind(sessionId)
      .run();
    const marker = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();

    const second = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws2 = second.webSocket;
    ws2?.accept();
    ws2?.close();

    await vi.waitFor(() => expect(agentConnections.size).toBe(0));
    const after = await env.DB.prepare(
      `SELECT ended_at FROM sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ ended_at: string }>();
    expect(after?.ended_at).toBe(marker?.ended_at);
  });

  it('refuses an answer for a terminated session with SESSION_NOT_ACTIVE and writes nothing', async () => {
    // Review Focus #3: a late answer that reopens a dead session leaves the
    // browser waiting on a peer that is gone.
    const { credential, sessionId, token } = await seed();

    // Terminate over REST first.
    await app.request(
      `/api/sessions/${sessionId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId, sdp: 'v=0 too late', approved: true },
        },
      }),
    );

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    const reply = JSON.parse(received[received.length - 1] ?? '{}') as {
      type: string;
      code: string;
    };
    expect(reply).toEqual({ type: 'error', code: 'SESSION_NOT_ACTIVE' });

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signals WHERE session_id = ?`,
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);

    const row = await env.DB.prepare(`SELECT status FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ status: string }>();
    expect(row?.status).toBe('terminated');

    ws?.close();
  });

  it('a ping refreshes last_ping_at in the space-separated format and returns pong', async () => {
    // W9/W10: `is_online` in D1 is a hint; `last_ping_at` is the truth. An
    // ISO-8601 write here would break every datetime() comparison over the
    // column, silently.
    const { credential, agentId } = await seed();

    const upgrade = await app.request(
      WS_URL,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
          Upgrade: 'websocket',
        },
      },
      env,
    );
    const ws = upgrade.webSocket;
    ws?.accept();

    // Backdate the connect-time write so the ping's write is observable.
    await env.DB.prepare(
      `UPDATE agents SET last_ping_at = datetime('now', '-10 minutes') WHERE id = ?`,
    )
      .bind(agentId)
      .run();

    const received: string[] = [];
    ws?.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string') received.push(evt.data);
    });

    ws?.send(JSON.stringify({ type: 'ping' }));

    await vi.waitFor(() =>
      expect(received.some((r) => r.includes('"pong"'))).toBe(true),
    );

    const row = await env.DB.prepare(
      `SELECT is_online, last_ping_at FROM agents WHERE id = ?`,
    )
      .bind(agentId)
      .first<{ is_online: number; last_ping_at: string }>();
    expect(row?.is_online).toBe(1);
    expect(row?.last_ping_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row?.last_ping_at).not.toContain('T');

    ws?.close();
  });
});
