import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLinux,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  waitFor,
  agentConnectCount,
  postJson,
  seedSignedTerminal,
  connectTerminal,
  sendKeystrokes,
  waitForTerminalOutput,
  sendTerminalCreate,
} from './harness';

/**
 * Layer 3, WS3: session-hardening regressions that need the real binary and
 * the real server. Each test here pins one audit finding — M2 (close-code
 * handling), M3 (foreign-candidate rejection), H1 (shell allowlist) — through
 * a path that a unit test cannot reach (the webrtc 0.21 `PeerConnection`
 * trait is sealed, and the shell gate's refusal must travel over a real data
 * channel).
 *
 * Linux-only (the Rust binary must be built for the host).
 */
describe.skipIf(!isLinux)('cross-language WS3 session hardening', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  /**
   * M2, the eviction half: the server evicts the previous socket with 4409
   * when a second connection registers the same agent id. Before the fix the
   * old agent treated that as transient and reconnected — which evicted the
   * *newcomer* in turn, a flap between two processes. The old agent must exit
   * instead, and stay exited: the connect count must not grow again.
   */
  it('exits instead of reconnecting when the server replaces it (4409)', async () => {
    const { token, agentId, credential } = await seed();

    const first = spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);

    // A second process with the same id and credential. The server closes the
    // first socket with 4409 ('Replaced by new connection').
    spawnAgent(agentId, credential);

    await waitFor(
      () => first.child.exitCode !== null || first.child.signalCode !== null,
      'the first agent to exit after being replaced',
      20_000,
    );

    // The regression this test exists for: a flapping agent reconnects after
    // the eviction. Give it a generous window (the backoff ladder is
    // 200ms..2s) and require the count to hold still.
    const afterEviction = agentConnectCount(first.output);
    await delay(4_000);
    expect(
      agentConnectCount(first.output),
      `the replaced agent reconnected — its output:\n${first.output()}`,
    ).toBe(afterEviction);

    // The log line names the verdict so a failure of THIS test is diagnosable
    // from the output alone.
    expect(first.output()).toMatch(/not reconnecting/i);
  }, 60_000);

  /**
   * M3: a candidate addressed to a session this agent is not running must be
   * dropped by the live session's router, not applied to its peer connection.
   *
   * The guard landed in 2de7a23 (before the spec's baseline) but had no test —
   * this is that test, and Step 3 proves it is load-bearing by mutation.
   *
   * The debug log is the observable: the live session logs the drop with both
   * ids. A candidate is delivered through the REST route for session B while
   * session A is live; the server pushes it to the same agent socket, the live
   * session's `route_inbound` sees `candidate.session_id != session_id` and
   * drops it. Session A must stay healthy across the event.
   */
  it('drops a candidate for a foreign session while a session is live (M3)', async () => {
    const { token, agentId, sessionId, identity, agent } =
      await seedSignedTerminal({ env: { RUST_LOG: 'debug' } });

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      sendKeystrokes(offerer, sessionId, 'echo before-foreign-candidate\n');
      await waitForTerminalOutput(frames, 'before-foreign-candidate');

      // A second session for the same agent: a legitimate row the agent will
      // never serve (ADR-14), used only as a foreign session id.
      const foreign = await postJson<{ id: string }>(
        '/api/sessions',
        { agentId },
        token,
      );

      await postJson<{ id: string }>(
        '/api/signal/ice-candidate',
        {
          sessionId: foreign.id,
          candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
        token,
      );

      await waitFor(
        () =>
          agent
            .output()
            .includes('dropping a candidate for a session that is not live'),
        'the live session to log the foreign-candidate drop',
        10_000,
      );

      // The live session must be unaffected by the dropped candidate.
      sendKeystrokes(offerer, sessionId, 'echo after-foreign-candidate\n');
      await waitForTerminalOutput(frames, 'after-foreign-candidate');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  /**
   * H1, the allowed half: an explicitly allowlisted shell still spawns, so the
   * policy did not break the feature it hardens. `/bin/sh` is in the floor on
   * every unix host.
   */
  it('spawns a terminal for an allowlisted client-supplied shell', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      const terminalId = `term-allowed-${sessionId}`;
      sendTerminalCreate(offerer, terminalId, 80, 24, '/bin/sh');
      await delay(500);

      sendKeystrokes(offerer, terminalId, 'echo allowlist-ok\n');
      await waitForTerminalOutput(frames, 'allowlist-ok');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  /**
   * H1, the refused half: a client-supplied shell outside the allowlist must
   * be refused with a `terminal-error` frame (code `pty-spawn-failed`, the
   * pinned contract) and no PTY may ever run for that terminal id.
   *
   * `sleep` is chosen because it exists, is executable, and is categorically
   * not a shell: if the gate ever regresses, the spawned process would run
   * and the test would catch bytes on the channel.
   */
  it('refuses a client-supplied shell outside the allowlist (H1)', async () => {
    const { token, sessionId, identity, agent } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      const terminalId = `term-refused-${sessionId}`;
      sendTerminalCreate(offerer, terminalId, 80, 24, '/bin/sleep');

      // The refusal must be visible on the channel, not only in the log.
      const deadline = Date.now() + 15_000;
      let refusal: { code?: string; message?: string } | undefined;
      while (Date.now() < deadline && !refusal) {
        refusal = frames.find(
          (f) =>
            f.type === 'terminal-error' &&
            (f.payload as { terminalId?: string }).terminalId === terminalId,
        )?.payload as { code?: string; message?: string } | undefined;
        if (!refusal) await delay(100);
      }

      expect(
        refusal,
        `no terminal-error frame for ${terminalId}\n--- agent output ---\n${agent.output()}`,
      ).toBeDefined();
      expect(refusal?.code).toBe('pty-spawn-failed');
      expect(refusal?.message).toMatch(/refused/i);

      // No PTY ran: a shell would have produced output; `sleep` produces
      // nothing, so the strong assertion is the log — no spawn line for this
      // terminal id — plus no data frames carrying this terminalId (the
      // refusal frame itself is a `terminal-error`, not data).
      expect(agent.output()).toMatch(/refused a client-supplied shell/);
      expect(
        frames.filter(
          (f) =>
            f.type === 'terminal-data' && f.payload.terminalId === terminalId,
        ),
      ).toHaveLength(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
