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

  /**
   * A transaction torn down without ever completing must still settle the
   * returned promise. Per the IndexedDB spec, `abort()` leaves
   * `transaction.error` as `null`, so the raw `reject(tx.error)` pattern
   * rejected with `null` — not an `Error` — and a missing `onabort` handler
   * left the promise pending forever.
   *
   * fake-indexeddb does not reproduce that: aborting a pending request
   * synthesises an `AbortError` DOMException, which already is an `Error`. So
   * these tests swap in a fully fake database whose transaction fires the
   * chosen event with `error` still `null`, exercising the exact spec'd path.
   *
   * The database is faked end to end (not just `transaction`) on purpose: the
   * failure under test leaves the promise unsettled, so a real connection
   * would never be closed, and the still-open handle would block the
   * `beforeEach` `deleteDatabase` for every following test.
   */
  type FakeTransaction = {
    error: DOMException | null;
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    objectStore: () => { put: () => void; delete: () => void };
  };

  function installFakeDatabase(fire: 'onerror' | 'onabort'): {
    restore: () => void;
  } {
    const fakeTx: FakeTransaction = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => ({
        put: () => {
          queueMicrotask(() => fakeTx[fire]?.());
        },
        delete: () => {
          queueMicrotask(() => fakeTx[fire]?.());
        },
      }),
    };

    const fakeDb = {
      close: () => {},
      transaction: () => fakeTx as unknown as IDBTransaction,
    };

    // The global is replaced wholesale rather than patching `IDBDatabase`
    // methods, so no real connection is ever opened — see the note above about
    // a leaked handle blocking `beforeEach`.
    const realIndexedDB = globalThis.indexedDB;
    const fakeRequest: {
      result: IDBDatabase;
      onupgradeneeded: (() => void) | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = {
      result: fakeDb as unknown as IDBDatabase,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };

    globalThis.indexedDB = {
      open: () => {
        queueMicrotask(() => fakeRequest.onsuccess?.());
        return fakeRequest as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    return {
      restore: () => {
        globalThis.indexedDB = realIndexedDB;
      },
    };
  }

  it('8. A transaction aborted with a null error rejects with an Error, not null', async () => {
    const pair = await generateUserKeyPair();
    const { restore } = installFakeDatabase('onabort');

    try {
      const outcome = await Promise.race([
        savePrivateKey('user-abort-test', pair.privateKey).then(
          () => 'resolved' as const,
          (reason: unknown) => reason,
        ),
        // A promise left pending (no `onabort` handler) would never reject.
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 250),
        ),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Failed to save private key');
    } finally {
      restore();
    }
  });

  it('9. A transaction error with a null reason rejects with an Error, not null', async () => {
    const pair = await generateUserKeyPair();
    const { restore } = installFakeDatabase('onerror');

    try {
      const outcome = await Promise.race([
        savePrivateKey('user-null-error', pair.privateKey).then(
          () => 'resolved' as const,
          (reason: unknown) => reason,
        ),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 250),
        ),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Failed to save private key');
    } finally {
      restore();
    }
  });

  it('10. deletePrivateKey normalises a null transaction error the same way', async () => {
    const { restore } = installFakeDatabase('onabort');

    try {
      const outcome = await Promise.race([
        deletePrivateKey('user-delete-abort').then(
          () => 'resolved' as const,
          (reason: unknown) => reason,
        ),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 250),
        ),
      ]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Failed to delete private key');
    } finally {
      restore();
    }
  });
});
