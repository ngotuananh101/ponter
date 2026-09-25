import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  generateUserKeyPair,
  exportPublicKeySpki,
  importPublicKeySpki,
  savePrivateKey,
  loadPrivateKey,
  deletePrivateKey,
} from '../src/index';

describe('packages/crypto', () => {
  beforeEach(async () => {
    // Clear IndexedDB between tests
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((resolve, reject) => {
      req.onsuccess = resolve;
      req.onerror = reject;
    });
  });

  it('1. generateUserKeyPair returns a base64 SPKI string and non-extractable private key', async () => {
    const pair = await generateUserKeyPair();
    expect(typeof pair.publicKeySpkiBase64).toBe('string');
    expect(pair.publicKeySpkiBase64.length).toBeGreaterThan(50);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.type).toBe('private');
    expect(pair.publicKey.type).toBe('public');
    expect(pair.privateKey.algorithm.name).toBe('ECDH');
  });

  it('2. exportPublicKeySpki -> importPublicKeySpki round-trips to a key that derives bits against a peer', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();

    const aliceExported = await exportPublicKeySpki(alice.publicKey);
    const aliceImported = await importPublicKeySpki(aliceExported);

    const bobBitsWithOriginal = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: alice.publicKey },
      bob.privateKey,
      256,
    );

    const bobBitsWithImported = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: aliceImported },
      bob.privateKey,
      256,
    );

    expect(new Uint8Array(bobBitsWithOriginal)).toEqual(
      new Uint8Array(bobBitsWithImported),
    );
  });

  it('3. The generated private key derives bits against the returned public key', async () => {
    const pair = await generateUserKeyPair();
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      pair.privateKey,
      256,
    );
    expect(bits.byteLength).toBe(32);
  });

  it('4. savePrivateKey -> loadPrivateKey persists a non-extractable CryptoKey that still derives bits', async () => {
    const pair = await generateUserKeyPair();
    const userId = 'user-test-123';

    await savePrivateKey(userId, pair.privateKey);
    const loaded = await loadPrivateKey(userId);

    expect(loaded).not.toBeNull();
    expect(loaded!.extractable).toBe(false);

    const bitsWithOriginal = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      pair.privateKey,
      256,
    );

    const bitsWithLoaded = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      loaded!,
      256,
    );

    expect(new Uint8Array(bitsWithOriginal)).toEqual(
      new Uint8Array(bitsWithLoaded),
    );
  });

  it('5. loadPrivateKey returns null for an unknown user ID', async () => {
    const loaded = await loadPrivateKey('non-existent-user');
    expect(loaded).toBeNull();
  });

  it('6. deletePrivateKey removes the record, and a subsequent load returns null', async () => {
    const pair = await generateUserKeyPair();
    const userId = 'user-delete-test';

    await savePrivateKey(userId, pair.privateKey);
    const loadedBefore = await loadPrivateKey(userId);
    expect(loadedBefore).not.toBeNull();

    await deletePrivateKey(userId);
    const loadedAfter = await loadPrivateKey(userId);
    expect(loadedAfter).toBeNull();
  });

  it('7. deletePrivateKey for a missing user ID does not throw (idempotent)', async () => {
    await expect(deletePrivateKey('never-existed')).resolves.toBeUndefined();
  });
});
