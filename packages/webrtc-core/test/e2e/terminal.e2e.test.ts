import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seedSignedTerminal,
  connectTerminal,
  frameBytes,
  postJson,
  sendKeystrokes,
  sendTerminalCreate,
  sendTerminalResize,
  waitFor,
  waitForTerminalOutput,
  agents,
} from './harness';

/**
 * Layer 3: the whole week in one file — a Rust agent, a TypeScript offerer, the
 * real `@ponter/server` backend, and real PTY bytes over a real DTLS/SCTP
 * connection.
 *
 * Linux-only. The Rust binary is built for the host, the Node server binds a
 * local port, and `iceServers: []` means loopback host candidates must be
 * enough. On any other platform the suite is SKIPPED, not failed (spec §7.3).
 */
describe.skipIf(!isLinux)('cross-language terminal E2E', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  it('runs real PTY output over a real DTLS/SCTP connection', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      // `sh` echoes the command back and then runs it, so "hello" appears in
      // the output either way; both arrive as separate frames.
      sendKeystrokes(offerer, sessionId, 'echo hello\n');

      await waitForTerminalOutput(frames, 'hello');

      // The envelope is the contract, not the JavaScript type of the raw
      // message. Week 4's 5b8ed86 proved that wrapping a string in a Buffer
      // silently downgrades a frame to WEBRTC_BINARY, so asserting on `typeof`
      // would pin an accident. These assertions come AFTER the byte assertion
      // on purpose: a failure should name the missing byte before it names a
      // shape mismatch, and with zero frames `frames[0]` would be undefined.
      expect(frames.length).toBeGreaterThan(0);
      const first = frames[0];
      expect(first).toBeDefined();
      expect(first?.channel).toBe('terminal');
      expect(first?.type).toBe('terminal-data');
      expect(typeof first?.payload.data).toBe('string');
      expect(first?.payload.terminalId).toBe(sessionId);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Review Focus #5, the second half: Task 6's Rust test proves the framing
  // round-trips 0xFF inside one process; this proves no layer between two
  // languages — Rust base64, the DTLS/SCTP data channel, the werift adapter,
  // the JS decode — turns it into U+FFFD.
  it('preserves a non-UTF-8 byte (0xFF) end to end', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      // `printf '\377'` is the POSIX way to emit the single byte 0xFF with no
      // trailing newline; `\377` is octal for 255.
      sendKeystrokes(offerer, sessionId, "printf '\\377'\n");

      // The shell echoes the command line back, so the FIRST frame is the
      // literal text `printf '\377'` — which contains no 0xFF. The byte arrives
      // in a later frame as the command's own output. Scan every frame's bytes
      // rather than the concatenated string: a lossy UTF-8 conversion anywhere
      // in the chain turns 0xFF into U+FFFD, and concatenating first would hide
      // that behind a valid-looking string.
      const deadline = Date.now() + 20_000;
      let sawFF = false;
      while (Date.now() < deadline && !sawFF) {
        sawFF = frames.some((f) => frameBytes(f).includes(0xff));
        if (!sawFF) await delay(100);
      }

      expect(
        sawFF,
        `no 0xFF byte in any of ${frames.length} frames\n` +
          `--- frames (hex) ---\n` +
          frames.map((f) => frameBytes(f).toString('hex')).join('\n') +
          `\n--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Week 6 multiplexing: two distinct terminalId values on the same DataChannel
  // must produce independent PTY output, each routed back by terminalId. This is
  // the cross-language proof that PtyManager's keyed dispatch works over a real
  // DTLS/SCTP transport, not just in the Rust unit test.
  it('multiplexes two terminal sessions over one DataChannel', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    // Two distinct terminal ids, each with a unique marker so we can verify
    // output isolation rather than mere presence.
    const terminalA = `term-a-${sessionId}`;
    const terminalB = `term-b-${sessionId}`;

    try {
      // Explicitly create both sessions so spawn-on-demand is not the path under
      // test. Each `terminal-create` is a distinct message with its own id.
      sendTerminalCreate(offerer, terminalA);
      sendTerminalCreate(offerer, terminalB);

      // Give the agent a moment to process the create frames and spawn the PTYs.
      await delay(500);

      // Send a unique echo to each terminal via terminal-data.
      sendKeystrokes(offerer, terminalA, 'echo MARKER-A-42\n');
      sendKeystrokes(offerer, terminalB, 'echo MARKER-B-99\n');

      // Collect output per terminalId, tracking which frames we've already seen
      // so interleaved frames from both sessions don't get reprocessed.
      const deadline = Date.now() + 20_000;
      const processed = new Set<number>();
      let foundA = false;
      let foundB = false;
      let decodedA = '';
      let decodedB = '';

      while (Date.now() < deadline && (!foundA || !foundB)) {
        for (let i = 0; i < frames.length; i++) {
          if (processed.has(i)) continue;
          processed.add(i);

          const frame = frames[i];
          if (!frame) continue;
          const bytes = frameBytes(frame);
          const text = bytes.toString('utf8');
          const tid = frame.payload.terminalId;

          if (tid === terminalA) {
            decodedA += text;
            if (decodedA.includes('MARKER-A-42')) foundA = true;
          } else if (tid === terminalB) {
            decodedB += text;
            if (decodedB.includes('MARKER-B-99')) foundB = true;
          }
        }

        if (!foundA || !foundB) await delay(100);
      }

      expect(
        foundA,
        `terminal ${terminalA} never produced its marker\n` +
          `--- decoded A ---\n${JSON.stringify(decodedA)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);

      expect(
        foundB,
        `terminal ${terminalB} never produced its marker\n` +
          `--- decoded B ---\n${JSON.stringify(decodedB)}\n` +
          `--- agent output ---\n${agents.map((a) => a.output()).join('\n')}`,
      ).toBe(true);

      // Verify output isolation: neither terminal received the other's marker.
      expect(
        decodedA,
        'terminal A received terminal B output — multiplexing is leaking',
      ).not.toContain('MARKER-B');
      expect(
        decodedB,
        'terminal B received terminal A output — multiplexing is leaking',
      ).not.toContain('MARKER-A');

      // Every received output frame must carry a terminalId so the browser can
      // demultiplex — no orphaned frames without a routing key.
      const orphaned = frames.filter(
        (f) =>
          !f.payload.terminalId ||
          (f.payload.terminalId !== terminalA &&
            f.payload.terminalId !== terminalB),
      );
      expect(
        orphaned,
        `found output frames for unexpected terminal ids:\n` +
          orphaned.map((f) => JSON.stringify(f.payload.terminalId)).join(', '),
      ).toHaveLength(0);
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Spec §6.3: terminal-resize must change the PTY window size. Verified by
  // running `stty size` in the shell, which prints "rows cols" from the PTY.
  it('applies terminal-resize and verifies via stty size', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      sendTerminalCreate(offerer, sessionId, 80, 24);
      await delay(500);

      sendTerminalResize(offerer, sessionId, 120, 40);
      await delay(500);

      sendKeystrokes(offerer, sessionId, 'stty size\n');

      await waitForTerminalOutput(frames, '40 120');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // The production bug of 2026-10-01: close every terminal tab, reopen one,
  // and the browser sits on `timeout waiting for channel "terminal" (saw
  // state: connecting)`. The agent never noticed the closed peer — its
  // session loop watched neither the data channel nor the connection state —
  // so the finished session held the single ADR-14 slot for up to the 1h cap,
  // and the reopened tab's offer was silently dropped ("ignoring a
  // non-candidate frame during a session").
  //
  // This is the reproduction as an assertion: closing the offerer (what
  // `closeTab` does — dispose + peer.close) must end the agent's session, and
  // a fresh session for the same agent must then connect.
  it('frees the agent for the next connection after the peer closes', async () => {
    const { token, agentId, sessionId, agent, identity } =
      await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    sendKeystrokes(offerer, sessionId, 'echo first-session\n');
    await waitForTerminalOutput(frames, 'first-session');

    // Simulate closing the last tab: the store disposes the client and closes
    // the peer, which closes the data channel and the whole connection.
    await offerer.close();

    // The agent must observe that close and end the session. The close signal
    // is the SCTP stream reset of the data channel: if the offerer tears the
    // transport down before the reset leaves, the agent sees nothing and only
    // notices ~30s later when ICE fails — past this test's timeout. So this
    // assertion guards both halves: the agent reacts to the close, and the
    // offerer gives the reset a chance to be acknowledged first.
    try {
      await waitFor(
        () => agent.output().includes('session ended'),
        'the agent to end the session after its peer closed',
        20_000,
      );
    } catch (error) {
      // The agent log is the evidence that matters when this fails: on a
      // losing race it shows no close signal at all, only ICE going quiet.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- agent output ---\n${agent.output()}`,
      );
    }

    // The reopened tab: a new session for the same agent. Without the fix the
    // offer is dropped by the still-running session and `waitForChannel`
    // times out after 20s — exactly the user's error message.
    const session2 = await postJson<{ id: string }>(
      '/api/sessions',
      { agentId },
      token,
    );

    const { offerer: offerer2, frames: frames2 } = await connectTerminal(
      session2.id,
      token,
      identity,
    );

    try {
      sendKeystrokes(offerer2, session2.id, 'echo second-session\n');
      await waitForTerminalOutput(frames2, 'second-session');
    } finally {
      await offerer2.close();
    }
  }, 120_000);

  // ADR-14: one session per agent, and a refused second offer must be
  // *refused* — a real answer with `approved: false` — not silently dropped.
  // Before the fix the second offer vanished inside the running session's
  // loop, so the browser had nothing to act on and burned its full 20s
  // channel timeout with a message that named neither the refusal nor why.
  it('refuses a second concurrent session with a fast, visible failure', async () => {
    const { token, agentId, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      sendKeystrokes(offerer, sessionId, 'echo holder\n');
      await waitForTerminalOutput(frames, 'holder');

      const session2 = await postJson<{ id: string }>(
        '/api/sessions',
        { agentId },
        token,
      );

      // A second, independent offerer for the same agent. `waitForChannel`
      // must reject fast with a refusal — not sit out its timeout.
      const transport2 = new RESTPollingTransport({
        baseUrl: BASE_URL,
        sessionId: session2.id,
        token,
      });
      const offerer2 = new PeerConnection(
        new WeriftAdapter({ iceServers: [] }),
        transport2,
        {
          role: 'offerer',
          channelLabels: ['terminal'],
          sessionId: session2.id,
          identity,
        },
      );

      try {
        await offerer2.start();
        const started = Date.now();
        await expect(
          offerer2.waitForChannel('terminal', 20_000),
        ).rejects.toThrow(/refus|declin/i);
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        await offerer2.close();
      }

      // ADR-14 refuses the second session; it does not evict the first.
      sendKeystrokes(offerer, sessionId, 'echo still-alive\n');
      await waitForTerminalOutput(frames, 'still-alive');
    } finally {
      await offerer.close();
    }
  }, 120_000);
});
