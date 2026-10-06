import { describe, it, expect } from 'vitest';
import {
  IV_BYTES,
  deriveSharedSecret,
  hkdfSha256,
  importAesGcmKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
  EncryptionManager,
  generateUserKeyPair,
} from '../src/index';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Vectors {
  hkdfSha256: { ikmHex: string; saltHex: string; infoHex: string; length: number; okmHex: string };
  aesGcm256: {
    keyHex: string; ivHex: string; plaintextHex: string;
    ciphertextHex: string; tagHex: string;
  };
  ecdhP256: {
    privateJwk: JsonWebKey; peerPublicRawHex: string; secretHex: string;
  };
}

const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vectors/e2ee-vectors.json', import.meta.url)), 'utf8'),
);

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('WS1 EncryptionManager primitives', () => {
  it('1. hkdfSha256 reproduces RFC 5869 A.1 (L=42)', async () => {
    const okm = await hkdfSha256(
      hex(vectors.hkdfSha256.ikmHex),
      hex(vectors.hkdfSha256.saltHex),
      hex(vectors.hkdfSha256.infoHex),
      vectors.hkdfSha256.length,
    );
    expect(toHex(okm)).toBe(vectors.hkdfSha256.okmHex);
  });

  it('2. aesGcmEncrypt reproduces the known-answer test (ciphertext||tag)', async () => {
    const key = await importAesGcmKey(hex(vectors.aesGcm256.keyHex));
    const out = await aesGcmEncrypt(key, hex(vectors.aesGcm256.ivHex), hex(vectors.aesGcm256.plaintextHex));
    expect(toHex(out)).toBe(vectors.aesGcm256.ciphertextHex + vectors.aesGcm256.tagHex);
  });

  it('3. aesGcmDecrypt round-trips and rejects a tampered tag', async () => {
    const key = await importAesGcmKey(hex(vectors.aesGcm256.keyHex));
    const iv = hex(vectors.aesGcm256.ivHex);
    const ct = hex(vectors.aesGcm256.ciphertextHex + vectors.aesGcm256.tagHex);
    expect(toHex(await aesGcmDecrypt(key, iv, ct))).toBe(vectors.aesGcm256.plaintextHex);

    const tampered = ct.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    await expect(aesGcmDecrypt(key, iv, tampered)).rejects.toThrow();
  });

  it('4. deriveSharedSecret reproduces the fixed ECDH vector', async () => {
    const priv = await crypto.subtle.importKey(
      'jwk', vectors.ecdhP256.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
    );
    const peer = await crypto.subtle.importKey(
      'raw', hex(vectors.ecdhP256.peerPublicRawHex),
      { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    expect(toHex(await deriveSharedSecret(priv, peer))).toBe(vectors.ecdhP256.secretHex);
  });

  it('5. two peers derive the same secret; a third key does not', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const carol = await generateUserKeyPair();
    const ab = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const ba = await deriveSharedSecret(bob.privateKey, alice.publicKey);
    const ac = await deriveSharedSecret(alice.privateKey, carol.publicKey);
    expect(toHex(ab)).toBe(toHex(ba));
    expect(toHex(ab)).not.toBe(toHex(ac));
  });

  it('6. EncryptionManager round-trips and rejects a tampered frame', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const salt = utf8('session-1');
    const a = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, salt);
    const b = await EncryptionManager.derive(bob.privateKey, alice.publicKey, info, salt);

    const plaintext = utf8('ls -la\n');
    const framed = await a.encrypt(plaintext);
    expect(framed.length).toBe(IV_BYTES + plaintext.length + 16);
    expect(await b.decrypt(framed)).toEqual(plaintext);

    const tampered = framed.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    await expect(b.decrypt(tampered)).rejects.toThrow();
  });

  it('7. a different salt (session) yields a key that cannot decrypt', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const a1 = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s1'));
    const a2 = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s2'));
    const framed = await a1.encrypt(utf8('x'));
    await expect(a2.decrypt(framed)).rejects.toThrow();
  });

  it('8. a short frame is rejected before decryption', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const a = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s1'));
    await expect(a.decrypt(new Uint8Array(IV_BYTES))).rejects.toThrow(/too short/);
  });
});
