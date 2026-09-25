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
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
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
    request.onerror = () => reject(request.error);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(key, userId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Load a user's private key, or null if none is stored. */
export async function loadPrivateKey(
  userId: string,
): Promise<CryptoKey | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(userId);
    request.onsuccess = () => {
      db.close();
      const result = request.result;
      resolve(result instanceof CryptoKey ? result : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Remove a user's private key from local storage. */
export async function deletePrivateKey(userId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(userId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
