// apps/agent/src/identity/store.ts
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import {
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * The agent's long-lived Ed25519 identity (B47).
 *
 * Two properties are load-bearing and both are enforced by the filesystem call,
 * not by a subsequent `chmod`:
 *
 * - **`0o600` at creation.** A create-then-chmod leaves a window where the key
 *   is world-readable. `open(..., 0o600)` applies the mode atomically.
 * - **`wx`, never `w`.** An existing file must never be truncated: a truncated
 *   key is an unrecoverable identity loss, and the agent would happily
 *   regenerate one and present a new fingerprint to every peer. `wx` makes the
 *   second create throw `EEXIST`, which the caller turns into a hard error.
 *
 * Only the PKCS#8 private key is persisted. The public key is derived on load,
 * so the two can never disagree.
 */
export interface AgentIdentity {
  readonly publicKeyBase64: string;
  sign(bytes: Uint8Array): Uint8Array;
}

/**
 * Derive the **raw 32-byte** Ed25519 public key.
 *
 * The wire form is raw, not SPKI DER: `apps/server/src/routes/ws.ts:960` imports
 * it with `subtle.importKey('raw', ...)`, and the Rust's `public_key_base64`
 * (`identity.rs:46`) encodes `public_key_raw()`. An SPKI DER key (44 bytes) is
 * rejected there with `DataError: Invalid keyData`, which the server turns into
 * a 4401 'Identity proof failed' — an agent that can never authenticate.
 */
function rawPublicKeyBase64(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url').toString('base64');
}

function toIdentity(privateKey: KeyObject): AgentIdentity {
  return {
    publicKeyBase64: rawPublicKeyBase64(privateKey),
    sign: (bytes) =>
      new Uint8Array(nodeSign(null, Buffer.from(bytes), privateKey)),
  };
}

function readPrivateKey(path: string): KeyObject {
  try {
    return createPrivateKey({
      key: readFileSync(path),
      type: 'pkcs8',
      format: 'der',
    });
  } catch (error) {
    const wrapped = new Error(
      `identity file is not a valid PKCS#8 Ed25519 key (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // The errno `code` must survive the wrap: `loadOrCreateIdentity` uses it to
    // tell "no file yet" (ENOENT — a first run) from "the file is there and
    // unusable" (everything else — a hard error).
    (wrapped as NodeJS.ErrnoException).code = (
      error as NodeJS.ErrnoException
    ).code;
    throw wrapped;
  }
}

export function loadOrCreateIdentity(path: string): AgentIdentity {
  try {
    return toIdentity(readPrivateKey(path));
  } catch (error) {
    // A present-but-corrupt file is *not* a reason to mint a new identity:
    // doing so silently changes the agent's fingerprint and every peer's TOFU
    // record. Only a missing file is a first run.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, der);
  } finally {
    closeSync(fd);
  }
  return toIdentity(privateKey);
}
