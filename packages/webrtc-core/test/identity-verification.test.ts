import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';
import { PeerConnection } from '../src/connection';
import { ScriptedPeer, stubTransport } from './helpers';
import { canonicalProofMessage } from '@ponter/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FP_A =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_B =
  '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const SDP_A =
  'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/TLS/RTP/SPDIF *\r\na=fingerprint:sha-256 ' +
  FP_A +
  '\r\na=setup:acta\r\n';
const SDP_B =
  'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/TLS/RTP/SPDIF *\r\na=fingerprint:sha-256 ' +
  FP_B +
  '\r\na=setup:acta\r\n';

const SESSION_ID = 'sess_identity_test';

/** Extract and normalize the fingerprint from an SDP string. */
function fingerprintFromSdp(sdp: string): string {
  return sdp
    .split('\n')
    .find((l) => /^a=fingerprint:/i.test(l.trim()))!
    .trim()
    .replace(/^a=fingerprint:[^ ]+\s+/i, '')
    .toUpperCase();
}

/** Build a canonical proof message for the answerer role over the given SDP. */
function answerProofMessage(sessionId: string, sdp: string): string {
  const fingerprint = fingerprintFromSdp(sdp);
  const sdpSha256Hex = createHash('sha256').update(sdp, 'utf8').digest('hex');
  return canonicalProofMessage({
    role: 'answerer',
    sessionId,
    sdpSha256Hex,
    fingerprint,
  });
}

/** Sign a message with an Ed25519 private KeyObject, returning base64. */
function signMessage(privateKey: KeyObject, msg: string): string {
  return nodeSign(null, Buffer.from(msg, 'utf8'), privateKey).toString(
    'base64',
  );
}

/** Verify a base64 Ed25519 signature over a UTF-8 message. Never throws. */
function verifyMessage(
  publicKey: KeyObject,
  msg: string,
  sigB64: string,
): boolean {
  try {
    const sigBuf = Buffer.from(sigB64, 'base64');
    return nodeVerify(null, Buffer.from(msg, 'utf8'), publicKey, sigBuf);
  } catch {
    return false;
  }
}

describe('identity verification (WS2 peer identity)', () => {
  // Primary keypair used by the "agent" (answerer) in cases 2–5.
  const agentKey = generateKeyPairSync('ed25519');
  // A second keypair for case 5 (different key rejected).
  const impostorKey = generateKeyPairSync('ed25519');

  // Cases 2–5 share this setup: a ScriptedPeer offering SDP_A, a stub
  // transport, and an identity whose verifyPeer checks the agent's key.
  function answererCase(): {
    peer: ScriptedPeer;
    deliver: ReturnType<typeof stubTransport>['deliver'];
    pc: PeerConnection;
  } {
    const peer = new ScriptedPeer();
    peer.createOffer = async () => ({ type: 'offer', sdp: SDP_A });
    const { transport, deliver } = stubTransport();
    const verifyPeer = async (msg: string, sigB64: string): Promise<boolean> =>
      verifyMessage(agentKey.publicKey, msg, sigB64);
    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
      sessionId: SESSION_ID,
      identity: { role: 'offerer', sign: async () => '', verifyPeer },
    });
    return { peer, deliver, pc };
  }

  /** Build the agent's answer proof over `sdp` with the given private key. */
  function answerProof(privateKey: KeyObject, sdp: string) {
    const msg = answerProofMessage(SESSION_ID, sdp);
    return {
      signature: signMessage(privateKey, msg),
      fingerprint: FP_A.toUpperCase(),
    };
  }

  /** The shared refusal assertion for cases 3–5. */
  async function expectAnswerRefused(
    peer: ScriptedPeer,
    pc: PeerConnection,
  ): Promise<void> {
    expect(peer.setRemoteCalls.filter((d) => d.type === 'answer')).toHaveLength(
      0,
    );
    await expect(pc.waitForChannel('terminal', 500)).rejects.toThrow(
      /peer-identity verification/,
    );
  }

  it('1. offerer with a valid identity signs its offer with a proof', async () => {
    const peer = new ScriptedPeer();
    // Override createOffer to return a real SDP with a fingerprint.
    peer.createOffer = async () => ({ type: 'offer', sdp: SDP_A });

    const { transport, sent } = stubTransport();

    const signingKey = generateKeyPairSync('ed25519');
    const sign = (msg: string): Promise<string> =>
      Promise.resolve(signMessage(signingKey.privateKey, msg));

    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
      sessionId: SESSION_ID,
      identity: { role: 'offerer', sign, verifyPeer: async () => true },
    });

    await pc.start();

    const offer = sent.find((m) => m.type === 'offer');
    expect(offer).toBeDefined();
    expect(offer!.type).toBe('offer');
    expect(offer!.data.sessionId).toBe(SESSION_ID);

    const proof = (
      offer!.data as { proof?: { signature: string; fingerprint: string } }
    ).proof;
    expect(proof).toBeDefined();
    expect(proof!.fingerprint).toBe(FP_A.toUpperCase());

    // Verify the signature over the canonical message.
    const fingerprint = fingerprintFromSdp(SDP_A);
    const sdpSha256Hex = createHash('sha256')
      .update(SDP_A, 'utf8')
      .digest('hex');
    const message = canonicalProofMessage({
      role: 'offerer',
      sessionId: SESSION_ID,
      sdpSha256Hex,
      fingerprint,
    });
    expect(verifyMessage(signingKey.publicKey, message, proof!.signature)).toBe(
      true,
    );

    await pc.close();
  });

  it('2. correct answer proof is accepted and setRemoteDescription runs', async () => {
    const { peer, deliver, pc } = answererCase();

    // Agent signs the answer proof with its private key.
    const proof = answerProof(agentKey.privateKey, SDP_A);

    deliver({
      type: 'answer',
      data: { sessionId: SESSION_ID, sdp: SDP_A, approved: true, proof },
    });
    await sleep(20);

    expect(peer.setRemoteCalls.filter((d) => d.type === 'answer')).toHaveLength(
      1,
    );

    await pc.close();
  });

  it('3. tampered SDP in answer proof is rejected before setRemoteDescription', async () => {
    const { peer, deliver, pc } = answererCase();

    // Proof signed over SDP_A, but deliver SDP_B (different fingerprint).
    const proof = answerProof(agentKey.privateKey, SDP_A);

    deliver({
      type: 'answer',
      data: { sessionId: SESSION_ID, sdp: SDP_B, approved: true, proof },
    });
    await sleep(20);

    await expectAnswerRefused(peer, pc);
    await pc.close();
  });

  it('4. answer with no proof is rejected (fail-closed)', async () => {
    const { peer, deliver, pc } = answererCase();

    deliver({
      type: 'answer',
      data: { sessionId: SESSION_ID, sdp: SDP_A, approved: true },
    });
    await sleep(20);

    await expectAnswerRefused(peer, pc);
    await pc.close();
  });

  it('5. answer signed by a different key is rejected', async () => {
    const { peer, deliver, pc } = answererCase();

    // Sign with the impostor key instead of the agent key.
    const proof = answerProof(impostorKey.privateKey, SDP_A);

    deliver({
      type: 'answer',
      data: { sessionId: SESSION_ID, sdp: SDP_A, approved: true, proof },
    });
    await sleep(20);

    await expectAnswerRefused(peer, pc);
    await pc.close();
  });

  it('6. offer proof role is sourced from identity.role, not hardcoded', async () => {
    const peer = new ScriptedPeer();
    peer.createOffer = async () => ({ type: 'offer', sdp: SDP_A });

    const { transport, sent } = stubTransport();

    const signingKey = generateKeyPairSync('ed25519');
    // Capture the exact message string passed to sign.
    const signedMessages: string[] = [];
    const sign = (msg: string): Promise<string> => {
      signedMessages.push(msg);
      return Promise.resolve(signMessage(signingKey.privateKey, msg));
    };

    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
      sessionId: SESSION_ID,
      // Deliberately mismatched: peer role is 'offerer' (required to enter
      // start()) but identity.role is 'answerer'. The proof must carry the
      // identity.role value, not the peer role.
      identity: {
        role: 'answerer',
        sign,
        verifyPeer: async () => true,
      },
    });

    await pc.start();

    const offer = sent.find((m) => m.type === 'offer');
    expect(offer).toBeDefined();
    const proof = (
      offer!.data as { proof?: { signature: string; fingerprint: string } }
    ).proof;
    expect(proof).toBeDefined();

    // The canonical message has a line `role=<role>`. Assert identity.role was
    // used, not the hardcoded 'offerer'.
    expect(signedMessages).toHaveLength(1);
    expect(signedMessages[0]).toContain('role=answerer');
    expect(signedMessages[0]).not.toContain('role=offerer');

    await pc.close();
  });
});
