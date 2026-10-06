//! Application-layer E2EE for the browser side of WS1 (Phase 5, Week 15).
//!
//! Key schedule: ECDH P-256 -> HKDF-SHA256 -> AES-GCM-256. The raw shared secret
//! is never used as a key: HKDF binds the derived key to a session (`salt`) and a
//! purpose (`info`). Ciphertext framing is `[12-byte IV][ct || 16-byte tag]`,
//! matching `docs/ARCHITECTURE.md` §7.2 and the Rust implementation (Week 16).

export const IV_BYTES = 12;

/** TS 6 narrows Web Crypto byte inputs to `ArrayBufferView<ArrayBuffer>`; every
 *  byte here originates from Web Crypto / TextEncoder / base64 decode (all
 *  `ArrayBuffer`-backed), so narrowing at the call site is sound. */
function bs(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

/** ECDH P-256 shared secret (32 bytes). */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

/** HKDF-SHA256 (RFC 5869). `length` is in bytes. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Import a raw 32-byte key as an AES-GCM-256 key. */
export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM encrypt with an explicit IV; returns `ciphertext || tag`. */
export async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(plaintext),
  );
  return new Uint8Array(out);
}

/** AES-GCM decrypt with an explicit IV. Throws on a bad tag. */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(ciphertext),
  );
  return new Uint8Array(out);
}

/** A per-session symmetric key with framed encrypt/decrypt. */
export class EncryptionManager {
  private constructor(private readonly key: CryptoKey) {}

  /**
   * Derive a session key from our ECDH private key and the peer's ECDH public
   * key. `salt` binds the key to one session; `info` binds it to one purpose.
   */
  static async derive(
    privateKey: CryptoKey,
    peerPublicKey: CryptoKey,
    info: Uint8Array,
    salt: Uint8Array,
  ): Promise<EncryptionManager> {
    const secret = await deriveSharedSecret(privateKey, peerPublicKey);
    const raw = await hkdfSha256(secret, salt, info, 32);
    return new EncryptionManager(await importAesGcmKey(raw));
  }

  /** Encrypt with a fresh random IV; the IV is prefixed to the output. */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await aesGcmEncrypt(this.key, iv, plaintext);
    const framed = new Uint8Array(IV_BYTES + ct.length);
    framed.set(iv, 0);
    framed.set(ct, IV_BYTES);
    return framed;
  }

  /** Decrypt a `[iv][ct||tag]` frame. Throws if short or if the tag fails. */
  async decrypt(framed: Uint8Array): Promise<Uint8Array> {
    if (framed.length <= IV_BYTES) {
      throw new Error('e2ee frame is too short to contain an IV');
    }
    const iv = framed.subarray(0, IV_BYTES);
    const ct = framed.subarray(IV_BYTES);
    return aesGcmDecrypt(this.key, iv, ct);
  }
}
