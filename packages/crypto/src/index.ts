/** A freshly generated user keypair. */
export interface UserKeyPair {
  /** SPKI-encoded public key, base64. This is the value sent to the backend. */
  publicKeySpkiBase64: string;
  /** Non-extractable private key. Stored locally; never transmitted. */
  privateKey: CryptoKey;
  /** The public half, for local use. */
  publicKey: CryptoKey;
}

const DB_NAME = 'remote-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

const ECDH_ALGORITHM: EcKeyGenParams = {
  name: 'ECDH',
  namedCurve: 'P-256',
};

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    // Byte values are 0-255, where `fromCodePoint` and `fromCharCode` agree.
    binary += String.fromCodePoint(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    // `atob` yields a binary string (every code unit <= 0xFF), so the code
    // point at each index is always defined and identical to the code unit.
    bytes[i] = binary.codePointAt(i)!;
  }
  return bytes.buffer;
}

/**
 * Normalise an IndexedDB failure reason into an `Error`.
 *
 * `IDBRequest.error` and `IDBTransaction.error` are `DOMException | null`, and
 * a bare `null` is not an acceptable rejection reason. A `DOMException` already
 * is an `Error`, so only the null case needs synthesising.
 */
function toError(reason: DOMException | null, fallback: string): Error {
  return reason ?? new Error(fallback);
}

/** Close a handle without letting a close failure mask the transaction outcome. */
function closeQuietly(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    // A failed close must not replace the result we already have.
  }
}

/**
 * Run a single-operation readwrite transaction.
 *
 * Resolves on `complete`. Rejects with an `Error` on `error` or `abort` — the
 * `onabort` hook matters because a transaction can be torn down without ever
 * reaching `complete`, and without it the promise would never settle. The
 * `settled` guard stops a later `abort` from overwriting an outcome already
 * reported to the caller.
 */
function runWriteTransaction(
  db: IDBDatabase,
  failureMessage: string,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: DOMException | null) => {
      if (settled) return;
      settled = true;
      closeQuietly(db);
      reject(toError(reason, failureMessage));
    };

    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      closeQuietly(db);
      resolve();
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);

    run(tx.objectStore(STORE_NAME));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(toError(request.error, 'Failed to open the key database'));
  });
}

/** Generate an ECDH P-256 keypair for a new user identity. */
export async function generateUserKeyPair(): Promise<UserKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    ECDH_ALGORITHM,
    false, // extractable: false for private key
    ['deriveBits'],
  )) as CryptoKeyPair;

  const spkiBase64 = await exportPublicKeySpki(keyPair.publicKey);

  return {
    publicKeySpkiBase64: spkiBase64,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

/** Export a public key to SPKI base64 (the wire format for `user.publicKey`). */
export async function exportPublicKeySpki(key: CryptoKey): Promise<string> {
  const spkiBuffer = await crypto.subtle.exportKey('spki', key);
  return bufferToBase64(spkiBuffer);
}

/** Import a public key from SPKI base64. */
export async function importPublicKeySpki(
  spkiBase64: string,
): Promise<CryptoKey> {
  const buffer = base64ToBuffer(spkiBase64);
  return await crypto.subtle.importKey(
    'spki',
    buffer,
    ECDH_ALGORITHM,
    true, // extractable
    [],
  );
}

/** Persist a user's private key locally, keyed by user ID. */
export async function savePrivateKey(
  userId: string,
  key: CryptoKey,
): Promise<void> {
  const db = await openDatabase();
  return runWriteTransaction(db, 'Failed to save private key', (store) => {
    store.put(key, userId);
  });
}

/** Load a user's private key, or null if none is stored. */
export async function loadPrivateKey(
  userId: string,
): Promise<CryptoKey | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: DOMException | null) => {
      if (settled) return;
      settled = true;
      closeQuietly(db);
      reject(toError(reason, 'Failed to load private key'));
    };

    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(userId);

    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      closeQuietly(db);
      const result: unknown = request.result;
      resolve(result instanceof CryptoKey ? result : null);
    };
    request.onerror = () => fail(request.error);
    // Without this, a transaction aborted before the request settles would
    // leave the returned promise pending forever.
    tx.onabort = () => fail(tx.error);
  });
}

/** Remove a user's private key from local storage. */
export async function deletePrivateKey(userId: string): Promise<void> {
  const db = await openDatabase();
  return runWriteTransaction(db, 'Failed to delete private key', (store) => {
    store.delete(userId);
  });
}
