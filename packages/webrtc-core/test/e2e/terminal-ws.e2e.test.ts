import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PeerConnection } from '../../src/connection';
import { WebSocketSignalTransport } from '../../src/transport';
import type {
  DataChannelMessage,
  SignalMessage,
  TerminalDataMessage,
} from '@ponter/shared';
import type { PeerConnectionIdentity } from '../../src/types';
import {
  isLinux,
  PORT,
  BASE_URL,
  setupE2E,
  teardownE2E,
  startServerProcess,
  stopServerProcess,
  waitForPortFree,
  seedSignedTerminal,
  openTerminalPeer,
  sendKeystrokes,
  waitForTerminalOutput,
  waitFor,
  pollForCandidate,
  pollForSignal,
  agentConnectCount,
  agents,
  serverOutput,
} from './harness';

/**
 * Layer 3, WebSocket signaling variant: the same real Rust agent, real
 * `@ponter/server` backend and real DTLS/SCTP terminal, but the browser side
 * mints a ws-ticket and pushes signals over `/api/ws/browser` instead of
 * polling `/api/signal/poll`.
 *
 * This is the only test that exercises the ticket endpoint, the upgrade path
 * and the browser socket against the real server binary/process — the unit
 * suites mock either the socket or the fetch layer. The three behaviours that
 * unit tests cannot prove are here: signals really flow over the socket,
 * `SESSION_TERMINATED` really arrives when the agent's process dies, and a
 * ticket survives nothing — a fresh one is minted per (re)connect.
 *
 * Linux-only, like the REST variant: the Rust binary is built for the host.
 */
describe.skipIf(!isLinux)('cross-language terminal E2E', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E(() => {
      for (const transport of transports) {
        transport.close();
      }
      transports.length = 0;
    });
  }, 60_000);

  /**
   * Every transport this file creates, closed in `afterAll`.
   *
   * The ws transport owns a live socket; leaving one open would keep the
   * vitest process alive after the last assertion.
   */
  const transports: WebSocketSignalTransport[] = [];

  /**
   * A WS transport for `sessionId`, minting tickets from `token`.
   *
   * `maxRetries` is a parameter because the restart test must outlast the
   * server's own startup (tsx compile + listen + `/health`), which can exceed
   * the default 5-attempt ladder's ~5s of wall clock.
   */
  function wsTransport(
    sessionId: string,
    token: string,
    maxRetries = 5,
  ): WebSocketSignalTransport {
    const transport = new WebSocketSignalTransport({
      baseUrl: BASE_URL,
      sessionId,
      // The ticket endpoint authenticates with the access token, not a
      // credential: this is the browser path exactly as `terminal.ts` uses it.
      getToken: async () => token,
      reconnect: true,
      maxRetries,
    });
    transports.push(transport);
    return transport;
  }

  /**
   * Connect an offerer and wait for the `terminal` channel.
   *
   * The timeout is passed explicitly: `waitForChannel`'s default is 10000 ms
   * (`connection.ts:93`), and a real DTLS handshake against a binary that has
   * just started is worth more than that on a loaded CI runner.
   *
   * `existing` lets the restart test drive the *same* reconnected socket rather
   * than a fresh one: passing it in is what makes the handshake proof that the
   * surviving socket works, not that a new connection does.
   */
  async function connectTerminal(
    sessionId: string,
    token: string,
    identity?: PeerConnectionIdentity,
    existing?: WebSocketSignalTransport,
  ): Promise<{
    offerer: PeerConnection;
    frames: Array<DataChannelMessage<TerminalDataMessage>>;
    transport: WebSocketSignalTransport;
  }> {
    const transport = existing ?? wsTransport(sessionId, token);
    const { offerer, frames } = await openTerminalPeer(
      transport,
      sessionId,
      identity,
    );
    return { offerer, frames, transport };
  }

  // The point of this file: signals really travel over /api/ws/browser. The
  // unit suite fakes the socket, so only this run proves the ticket endpoint,
  // the upgrade, the subscribe/replay handshake and the live push work against
  // the real server process.
  it('runs real PTY output with signaling over the browser WebSocket', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      sendKeystrokes(offerer, sessionId, 'echo hello-ws\n');

      await waitForTerminalOutput(frames, 'hello-ws');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // The failure mode the REST transport cannot exercise: the ticket is
  // consumed at upgrade time, so every (re)connect mints a fresh one, and a
  // socket that outlived the server is useless. This is the browser signaling
  // socket's own reconnect, proven end to end: the server is stopped and
  // restarted under a live subscription, and a full handshake driven through
  // the *surviving* transport must still complete.
  //
  // Two gates, both honest, because the obvious ones lie:
  //  - The agent's readiness cannot come from `GET /api/agents`: the SIGKILLed
  //    server left `isOnline = true` in SQLite and `isAgentOnline` trusts that
  //    stale row, so the poll returns before the replacement socket exists. The
  //    agent's own "connected to the signaling server" log line (one per
  //    (re)connect) is the deterministic signal instead.
  //  - The browser socket's readiness cannot be a type-only signal poll: the
  //    pre-restart candidate is still in the table (signals are never deleted),
  //    so a `type === 'ice-candidate'` wait would be satisfied by the old row.
  //    The second candidate is matched by *value*.
  //
  // No session is started before the restart: an offer would start one that
  // survives the restart in-process, and the agent is a single-session
  // answerer (ADR-14), so it would refuse the post-restart offer with
  // `approved: false`. Candidates for an inactive session are dropped, so the
  // agent's one slot stays free for the real offer after the reconnect.
  //
  // The Rust agent's own reconnect loop (200ms->2s backoff) is exercised while
  // the server is down.
  it('reconnects its signaling socket and delivers signals after a server restart', async () => {
    const { token, sessionId, agent, identity } = await seedSignedTerminal();

    // A generous ladder: the server is down for the whole
    // kill -> port-free -> tsx start -> /health cycle, which is several seconds
    // and can exceed the default five-attempt budget. With no fallback
    // configured, exhausting the budget stops reconnecting for good, so the
    // test must not under-provision it.
    const transport = wsTransport(sessionId, token, 20);
    const received: SignalMessage[] = [];
    transport.subscribe((msg) => received.push(msg));

    // Baseline probe: a candidate is recorded (so a value-matched poll proves
    // the ticket minted, the upgrade completed and the subscribe ack arrived),
    // but the idle agent drops it, so no session starts (ADR-14).
    const beforeCandidate = 'candidate:1 1 udp 1 127.0.0.1 1 typ host';
    await transport.send({
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: beforeCandidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    await pollForCandidate(sessionId, token, beforeCandidate);

    const connectsBefore = agentConnectCount(agent.output);
    expect(connectsBefore).toBeGreaterThan(0);

    // Stop and restart the server under the live subscription. The port wait is
    // not redundant: `pnpm exec tsx` re-groups the listener, so the group kill
    // can leave `node` holding :8787 and the restart would die with
    // EADDRINUSE — failing the test for a harness reason, not a transport one.
    await stopServerProcess();
    await waitForPortFree(PORT);
    await startServerProcess();

    // The agent reconnects by itself and re-registers with the same id.
    await waitFor(
      () => agentConnectCount(agent.output) > connectsBefore,
      'the agent to reconnect after the restart',
      30_000,
    );

    // The transport reconnects on its own too: a fresh ticket, a new socket, a
    // new `subscribe`. The second candidate — matched by value, so the
    // pre-restart row cannot satisfy the wait — proves the reconnected socket's
    // sends reach the server.
    const afterCandidate = 'candidate:1 1 udp 1 127.0.0.1 2 typ host';
    await transport.send({
      type: 'ice-candidate',
      data: {
        sessionId,
        candidate: afterCandidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
    await pollForCandidate(sessionId, token, afterCandidate);

    // The real proof: a full offer/answer/ICE/DTLS handshake driven through the
    // surviving transport. `connectTerminal` reuses `transport`, so a channel
    // that opens is a channel negotiated over the *reconnected* socket — the
    // ticket, the upgrade, the subscribe, the offer, the answer and every
    // candidate all travelled after the restart.
    try {
      const { offerer, frames } = await connectTerminal(
        sessionId,
        token,
        identity,
        transport,
      );
      try {
        sendKeystrokes(offerer, sessionId, 'echo after-restart\n');

        await waitForTerminalOutput(frames, 'after-restart');
      } finally {
        await offerer.close();
      }
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `--- RECEIVED ---\n${JSON.stringify(received.map((m) => m.type))}\n` +
          `--- AGENT LOGS ---\n` +
          `${agents.map((a, i) => `=== AGENT #${i} ===\n${a.output()}`).join('\n')}\n` +
          `--- SERVER LOGS ---\n${serverOutput()}`,
      );
    }

    transport.close();
  }, 120_000);

  // SESSION_TERMINATED is pushed on the browser socket when the session ends
  // through the API (DELETE /api/sessions/:id) while a tab is subscribed. This
  // is the end-to-end proof that the transport's error frame arrives without a
  // poll: the REST transport would only discover it on the next poll tick.
  it('receives SESSION_TERMINATED on the socket when the session is deleted', async () => {
    const { token, sessionId } = await seedSignedTerminal();

    const transport = wsTransport(sessionId, token);
    const errors: string[] = [];
    transport.subscribe(() => {});
    transport.onServerError((code) => errors.push(code));

    // Readiness, not a sleep: the socket only sends a `signal` frame after the
    // server's `subscribed` ack (the transport gates sends on `awaitingAck`), so
    // finding the offer through the REST poll proves three things at once — the
    // ticket minted, the upgrade completed, and the subscription is `live`. A
    // DELETE before that would race the subscribe handshake and the push would
    // land on a connection with no subscription to deliver it to.
    await transport.send({
      type: 'offer',
      data: { sessionId, sdp: 'v=0-offer', capabilities: ['terminal'] },
    });
    await pollForSignal(sessionId, token, 'offer');

    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);

    await waitFor(
      () => errors.includes('SESSION_TERMINATED'),
      'SESSION_TERMINATED frame',
    );

    transport.close();
  }, 60_000);
});
