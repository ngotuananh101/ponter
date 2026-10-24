// apps/agent/test/identity/store.test.ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../../src/identity/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ponter-identity-'));
}

describe('loadOrCreateIdentity', () => {
  it('creates the file on first use and reloads the same key', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    const first = loadOrCreateIdentity(path);
    const second = loadOrCreateIdentity(path);
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
  });

  it('writes the key file owner-only, mode 0600', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    loadOrCreateIdentity(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates the parent directory when it does not exist', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'id.pkcs8');
    expect(() => loadOrCreateIdentity(path)).not.toThrow();
  });

  it('never truncates an existing key — a corrupt file is an error, not a reset', () => {
    const path = join(tempDir(), 'agent-identity.pkcs8');
    writeFileSync(path, 'not a pkcs8 key', { mode: 0o600 });
    expect(() => loadOrCreateIdentity(path)).toThrow(
      /identity file is not a valid PKCS#8/,
    );
    expect(readFileSync(path, 'utf8')).toBe('not a pkcs8 key');
  });

  it('signs and verifies a round trip through the raw key the server imports', async () => {
    // The published key must be the RAW 32-byte form: the server imports it with
    // `subtle.importKey('raw', ...)` (`apps/server/src/routes/ws.ts:960`), and an
    // SPKI DER key (44 bytes) throws `DataError: Invalid keyData` there. This
    // assertion therefore goes through the server's own import path.
    const path = join(tempDir(), 'agent-identity.pkcs8');
    const identity = loadOrCreateIdentity(path);
    const message = Buffer.from('hello');
    const signature = identity.sign(message);
    const raw = Buffer.from(identity.publicKeyBase64, 'base64');
    const key = await webcrypto.subtle.importKey(
      'raw',
      raw,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    expect(
      await webcrypto.subtle.verify('Ed25519', key, signature, message),
    ).toBe(true);
  });
});
