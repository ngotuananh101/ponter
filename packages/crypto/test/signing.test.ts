import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  generateSigningKeyPair,
  exportSigningPublicKeyRaw,
  importSigningPublicKeyRaw,
  signProof,
  verifyProof,
  saveSigningKey,
  loadSigningKey,
  savePrivateKey,
  loadPrivateKey,
  generateUserKeyPair,
} from '../src/index';

describe('Ed25519 signing identity', () => {
  it('round-trips a signature through raw public-key export/import', async () => {
    const pair = await generateSigningKeyPair();
    const raw = await exportSigningPublicKeyRaw(pair.publicKey);
    const rawBytes = new Uint8Array(
      atob(raw)
        .split('')
        .map((c) => c.charCodeAt(0)),
    );
    expect(rawBytes).toHaveLength(32);

    const msg = 'ponter-ws2-v1\nrole=offerer\nsessionId=s1';
    const sig = await signProof(pair.privateKey, msg);

    const imported = await importSigningPublicKeyRaw(raw);
    expect(await verifyProof(imported, msg, sig)).toBe(true);
  });

  it('rejects a signature over different bytes', async () => {
    const pair = await generateSigningKeyPair();
    const sig = await signProof(pair.privateKey, 'a');
    expect(await verifyProof(pair.publicKey, 'b', sig)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const sig = await signProof(a.privateKey, 'm');
    expect(await verifyProof(b.publicKey, 'm', sig)).toBe(false);
  });

  it('rejects a malformed signature without throwing', async () => {
    const pair = await generateSigningKeyPair();
    expect(await verifyProof(pair.publicKey, 'm', 'not-base64!!')).toBe(false);
  });
});

describe('saveSigningKey / loadSigningKey', () => {
  beforeEach(async () => {
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((resolve, reject) => {
      req.onsuccess = resolve;
      req.onerror = reject;
    });
  });

  it('round-trips the private key for a user id', async () => {
    const pair = await generateSigningKeyPair();
    const userId = 'signer-123';

    await saveSigningKey(userId, pair.privateKey);
    const loaded = await loadSigningKey(userId);

    expect(loaded).not.toBeNull();
    expect(loaded!.extractable).toBe(false);
    expect(loaded!.type).toBe('private');
  });
});

describe('signing store is separate from ECDH store', () => {
  beforeEach(async () => {
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((resolve, reject) => {
      req.onsuccess = resolve;
      req.onerror = reject;
    });
  });

  it('after savePrivateKey and saveSigningKey, each load returns its own key', async () => {
    const ecdhPair = await generateUserKeyPair();
    const signPair = await generateSigningKeyPair();

    const userId = 'user-isolated';

    await savePrivateKey(userId, ecdhPair.privateKey);
    await saveSigningKey(userId, signPair.privateKey);

    const loadedEcdh = await loadPrivateKey(userId);
    const loadedSign = await loadSigningKey(userId);

    expect(loadedEcdh).not.toBeNull();
    expect(loadedSign).not.toBeNull();

    // ECDH key derives bits; signing key signs — different capabilities confirm isolation
    const ecdhBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ecdhPair.publicKey },
      loadedEcdh!,
      256,
    );
    expect(ecdhBits.byteLength).toBe(32);

    const signSig = await crypto.subtle.sign(
      'Ed25519',
      loadedSign!,
      new TextEncoder().encode('isolated'),
    );
    expect(signSig.byteLength).toBe(64);
  });
});

describe('opening a legacy v1 database (pre-WS2, no signing store)', () => {
  beforeEach(async () => {
    // Reproduce a database created by a pre-Week-13 build: version 1 with only
    // the ECDH 'keys' store. The WS2 signing store was added to
    // `onupgradeneeded` without a version bump, so on such a database the
    // upgrade never runs and the store stays missing.
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase('remote-crypto');
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => resolve();
    });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('remote-crypto', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('keys');
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });

  it('creates the signing store on the next open and round-trips a key', async () => {
    const pair = await generateSigningKeyPair();

    await saveSigningKey('legacy-user', pair.privateKey);
    const loaded = await loadSigningKey('legacy-user');

    expect(loaded).not.toBeNull();
    expect(loaded!.type).toBe('private');
  });
});
