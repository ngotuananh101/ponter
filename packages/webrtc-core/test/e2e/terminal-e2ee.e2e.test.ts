import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLinux,
  setupE2E,
  teardownE2E,
  seedSignedTerminal,
  connectTerminal,
  sendKeystrokes,
  waitForTerminalOutput,
  waitFor,
  openE2eeTerminalPeer,
  negotiateTerminalE2ee,
} from './harness';
import type { E2eeContext } from '../../../terminal-core/src/e2ee';
import { generateUserKeyPair, importSigningPublicKeyRaw } from '@ponter/crypto';

describe.skipIf(!isLinux)('cross-language terminal E2EE (gate G3)', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  it('negotiates E2EE and round-trips terminal bytes across the language boundary', async () => {
    // Seed a signed agent whose answer carries the e2ee capability - the agent
    // advertises it on its answer when the offer proposed it (BE shipped Task 3).
    // `seedSignedTerminal` now also returns `agentSigningPublicKey` (additive).
    const seeded = await seedSignedTerminal({ capabilities: ['e2ee'] });

    // Build the browser-side E2EE context: a fresh ECDH keypair for the user,
    // the user's WS2 signing key, and the agent's WS2 signing public key.
    const ecdhKeyPair = await generateUserKeyPair();
    const agentSigningPublicKey = await importSigningPublicKeyRaw(
      seeded.agentSigningPublicKey,
    );
    const ctx: E2eeContext = {
      ecdhPrivateKey: ecdhKeyPair.privateKey,
      ecdhPublicKey: ecdhKeyPair.publicKey,
      signingPrivateKey: seeded.userSigning.privateKey,
      peerSigningPublicKey: agentSigningPublicKey,
      sessionId: seeded.sessionId,
    };

    // openE2eeTerminalPeer builds the offerer with capabilities ['terminal',
    // 'e2ee'], attaches identity, and constructs TerminalClient + TerminalE2ee.
    const peer = await openE2eeTerminalPeer({
      sessionId: seeded.sessionId,
      token: seeded.token,
      identity: seeded.identity,
      e2eeContext: ctx,
    });

    try {
      // negotiateTerminalE2ee calls createSession() (which auto-sends the
      // terminal-e2ee-hello via T5-C) and awaits the agent's ack installing the
      // session key. It returns the session so we don't open a second terminal.
      const session = await negotiateTerminalE2ee(peer.client, peer.e2ee);
      expect(peer.e2ee.isActive()).toBe(true);

      // T7-R2: drive the ENCRYPTING path via the client API, not sendKeystrokes.
      // The agent decrypts inbound terminal-data when active, so plaintext frames
      // are dropped - sendKeystrokes would hang. Read the DECRYPTED output via
      // session.onData, never the raw ciphertext `frames` array.
      const chunks: Uint8Array[] = [];
      session.onData((d: Uint8Array) => chunks.push(d));

      session.write('echo ponter-e2ee\n');

      await waitFor(
        () => {
          const text = new TextDecoder().decode(concatUint8(chunks));
          return text.includes('ponter-e2ee');
        },
        'E2EE round trip to contain "ponter-e2ee" (decrypted server-side)',
        30_000,
      );

      const decoded = new TextDecoder().decode(concatUint8(chunks));
      expect(decoded).toContain('ponter-e2ee');
    } finally {
      await peer.connection.close();
    }
  }, 100_000);

  it('a legacy agent (no e2ee capability) yields a plaintext, byte-identical terminal', async () => {
    // Offer WITHOUT e2ee - the agent's answer omits the capability and the
    // terminal path stays plaintext (Review Focus #5: fail-closed parity).
    const seeded = await seedSignedTerminal({ capabilities: ['terminal'] });

    const { offerer, frames } = await connectTerminal(
      seeded.sessionId,
      seeded.token,
      seeded.identity,
    );

    try {
      // The offer carried no 'e2ee' capability, so the answer cannot select it.
      expect(offerer.getRemoteCapabilities()).not.toContain('e2ee');

      // Plaintext round trip: sendKeystrokes is valid here because no E2EE
      // session was negotiated - the agent does not decrypt.
      sendKeystrokes(offerer, seeded.sessionId, 'echo ponter-plain\n');
      await waitForTerminalOutput(frames, 'ponter-plain');
    } finally {
      await offerer.close();
    }
  }, 90_000);
});

/** Concatenate a list of byte chunks into one Uint8Array (local helper). */
function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
