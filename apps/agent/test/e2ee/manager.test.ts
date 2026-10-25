import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalKeyBinding } from '@ponter/shared';
import { TerminalE2ee } from '@ponter/terminal-core';
import { E2eeSession } from '../../src/e2ee/manager.js';

const SESSION_ID = 'sess-abc';

// The agent's own WS2 identity: Ed25519, published as the RAW 32-byte form.
const { privateKey: agentPrivate, publicKey: agentPublic } =
  generateKeyPairSync('ed25519');
const agentPublicRaw = Buffer.from(
  (agentPublic.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('base64');
const agentIdentity = {
  publicKeyBase64: agentPublicRaw,
  sign: (bytes: Uint8Array) =>
    new Uint8Array(nodeSign(null, Buffer.from(bytes), agentPrivate)),
};

// The peer's identity (the browser's). DELIBERATELY a different key from the
// agent's: the agent verifies the peer's hello, it never signs it. A fixture that
// reuses `agentPrivate` for both sides passes even when the verifier accepts its
// own signatures, which is the failure mode this whole task is about.
const { privateKey: peerPrivate, publicKey: peerPublic } =
  generateKeyPairSync('ed25519');
const peerPublicRaw = Buffer.from(
  (peerPublic.export({ format: 'jwk' }) as { x: string }).x,
  'base64url',
).toString('base64');

// A third key, for the wrong-signer must-error control.
const { privateKey: otherPrivate } = generateKeyPairSync('ed25519');

function peerHello(
  bindingFor?: (ecdhPublicKey: string) => string,
  signer = peerPrivate,
) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdhPublicKey = (
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  ).toString('base64');
  const message = bindingFor
    ? bindingFor(ecdhPublicKey)
    : canonicalKeyBinding(ecdhPublicKey);
  const signature = nodeSign(null, Buffer.from(message), signer).toString(
    'base64',
  );
  return { terminalId: 't1', ecdhPublicKey, signature };
}

describe('E2eeSession', () => {
  it('produces an ack carrying its ephemeral ECDH key and a signature', async () => {
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      peerPublicRaw,
    );
    expect(
      Buffer.from(result!.ack.ecdhPublicKey, 'base64').length,
    ).toBeGreaterThan(0);
    expect(result!.ack.signature.length).toBeGreaterThan(0);
  });

  it('returns null when the peer signing key is not 32 raw bytes', async () => {
    // `peer_signing_public_key_raw: &[u8; 32]` (e2ee.rs:203) is a length check the
    // type system cannot make in TS. An SPKI DER key is 44 bytes; letting one
    // through would import as the wrong key shape and reject every real hello.
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      Buffer.from('short').toString('base64'),
    );
    expect(result).toBeNull();
  });

  it('derives a session on a valid hello and round-trips a frame', async () => {
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      peerPublicRaw,
    );
    expect(result).not.toBeNull();
    const sealed = await result!.session.encrypt(Buffer.from('payload'));
    expect(Buffer.from(await result!.session.decrypt(sealed)).toString()).toBe(
      'payload',
    );
  });

  it('rejects a mis-signed hello and yields no session', async () => {
    const hello = peerHello(() => 'a different binding');
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      hello,
      peerPublicRaw,
    );
    expect(result).toBeNull();
  });

  it('rejects a hello signed by the wrong peer key', async () => {
    const hello = peerHello(undefined, otherPrivate);
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      hello,
      peerPublicRaw,
    );
    expect(result).toBeNull();
  });

  it('round-trips an EMPTY plaintext frame', async () => {
    // The Rust refused a 28-byte frame (12 IV + 16 tag) on decrypt while its own
    // encrypt produced exactly that for []. @ponter/crypto accepts it and returns
    // an empty buffer; that is the behaviour this port keeps, because it is the
    // one that round-trips.
    const result = (await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      peerPublicRaw,
    ))!;
    const sealed = await result.session.encrypt(new Uint8Array(0));
    expect(sealed).toHaveLength(28);
    expect(await result.session.decrypt(sealed)).toEqual(new Uint8Array(0));
  });

  it('rejects a tampered frame', async () => {
    const result = (await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      peerHello(),
      peerPublicRaw,
    ))!;
    const sealed = await result.session.encrypt(Buffer.from('secret'));
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(result.session.decrypt(tampered)).rejects.toThrow();
  });

  it('cross-side: decrypts frames encrypted by the browser under the same sessionId', async () => {
    // The ONLY assertion that can catch a wrong HKDF salt. A self-round-trip
    // encrypts and decrypts through one EncryptionManager derived from one salt,
    // so it is a mirror: it stays green under ANY salt, including a wrong one.
    // Here two independent parties derive the key from their own private half,
    // so `sessionId` is the only value that can make the GCM tag authenticate.
    const ecdh = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )) as CryptoKeyPair;
    const browserSigningKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(
        peerPrivate.export({ type: 'pkcs8', format: 'der' }) as Buffer,
      ),
      'Ed25519',
      false,
      ['sign'],
    );
    const agentSigningKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(agentPublicRaw, 'base64'),
      'Ed25519',
      true,
      ['verify'],
    );
    const browser = new TerminalE2ee({
      ecdhPrivateKey: ecdh.privateKey,
      ecdhPublicKey: ecdh.publicKey,
      signingPrivateKey: browserSigningKey,
      peerSigningPublicKey: agentSigningKey,
      sessionId: SESSION_ID,
    });

    const hello = await browser.buildHello('t1');
    const result = await E2eeSession.acceptHello(
      agentIdentity,
      SESSION_ID,
      hello,
      peerPublicRaw,
    );
    expect(result).not.toBeNull();
    await browser.handleAck(result!.ack);

    const encryptedByBrowser = await browser.encrypt(
      Buffer.from('terminal keystroke'),
    );
    expect(
      Buffer.from(await result!.session.decrypt(encryptedByBrowser)).toString(),
    ).toBe('terminal keystroke');
  });
});
