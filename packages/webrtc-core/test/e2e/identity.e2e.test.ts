import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  waitForAgentSigningKey,
  seedSignedTerminal,
  openTerminalPeer,
  sendKeystrokes,
  waitForTerminalOutput,
  agents,
  BASE_URL,
} from './harness';
import type { SignalMessage } from '@ponter/shared';

/**
 * Layer 3, WS2 peer identity: a real Ed25519 keypair on each side, signing a
 * canonical proof message over the SDP fingerprint and session id.
 *
 * The agent's `verify_offer_identity` runs before any PTY spawn (spec H3 gate),
 * so a tampered offer must refuse the connection fast — no terminal channel
 * opens and no PTY output is produced.
 *
 * Linux-only (the Rust binary must be built for the host).
 */
describe.skipIf(!isLinux)('cross-language WS2 peer identity', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  /**
   * Happy path: both sides sign, both verifications pass, and the terminal
   * echo round-trips exactly as it would without identity — proving the proof
   * binding did not break the handshake.
   */
  it('completes a signed terminal handshake and echoes', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    const { offerer, frames } = await openTerminalPeer(
      new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
      sessionId,
      identity,
    );

    try {
      sendKeystrokes(offerer, sessionId, 'echo signed-identity\n');

      await waitForTerminalOutput(frames, 'signed-identity');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  /**
   * Negative — tampered SDP fingerprint: the offer's proof is still valid for
   * the *original* SDP, but the `fingerprint` inside the proof no longer matches
   * `parseSdpFingerprint` of the rewritten SDP. The agent's `verify_offer_identity`
   * must bail before the PTY gate.
   *
   * The tamper seam is a `RESTPollingTransport` subclass whose `send()` rewrites
   * the `a=fingerprint:` line in the offer SDP for `offer` signals only, leaving
   * the `proof` field intact (so the signature itself still verifies — but
   * against the wrong SDP). We assert that no channel opens within a short bound.
   */
  it('refuses a tampering offer whose fingerprint does not match the SDP', async () => {
    const { token, sessionId, identity } = await seedSignedTerminal();

    // A transport wrapper that rewrites the offer SDP fingerprint but leaves
    // the proof (signed over the original fingerprint) unchanged.
    class TamperFingerprintTransport extends RESTPollingTransport {
      override async send(msg: SignalMessage): Promise<void> {
        if (msg.type === 'offer' && msg.data.sdp) {
          const tampered = msg.data.sdp.replace(
            /a=fingerprint:sha-256 [0-9A-Fa-f:]+/i,
            'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
          );
          (msg.data as { sdp: string }).sdp = tampered;
        }
        return super.send(msg);
      }
    }

    await expect(
      openTerminalPeer(
        new TamperFingerprintTransport({
          baseUrl: BASE_URL,
          sessionId,
          token,
        }),
        sessionId,
        identity,
      ),
    ).rejects.toThrow(/refus|declin|timeout/i);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toMatch(
      /fingerprint does not match|identity proof|malformed DTLS|fingerprint|refused|closing/i,
    );
  }, 60_000);

  /**
   * Fail-closed — no proof at all: the offer carries no `proof` field and no
   * `userSigningPublicKey`, so the agent's gate must reject it. No PTY.
   */
  it('refuses an offer with no identity proof (fail-closed)', async () => {
    const { token, agentId, credential, sessionId } = await seed();

    spawnAgent(agentId, credential);
    await waitForAgentOnline(token, agentId);
    await waitForAgentSigningKey(token, agentId);

    // No `identity` option → no proof in the offer.
    await expect(
      openTerminalPeer(
        new RESTPollingTransport({ baseUrl: BASE_URL, sessionId, token }),
        sessionId,
      ),
    ).rejects.toThrow(/refus|declin|timeout/i);

    const agentLog = agents.map((a) => a.output()).join('\n');
    expect(agentLog).toMatch(/identity proof|no identity proof|refused/i);
  }, 60_000);
});
