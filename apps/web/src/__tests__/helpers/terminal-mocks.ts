import { vi } from 'vitest';

/**
 * Shared mock factories for `@ponter/crypto` and `../stores/auth`.
 *
 * These bodies were previously duplicated verbatim across
 * `terminal-errors.test.ts`, `terminal-cleanup.test.ts`,
 * `terminal-progress.test.ts`, `terminal-refresh.test.ts`, and
 * `files-store.test.ts`. Extracting them into a single module keeps the
 * mock shape consistent and removes the copy-paste dedup block that was
 * flagged by SonarCloud on PR #90.
 *
 * `cryptoMock` returns the SUPERSET of the per-file mocks: every file
 * imports it, and `files-store.test.ts` (which also needs
 * `loadSigningPublicKey`) gets it for free without a separate definition.
 */
export function authMock() {
  return {
    useAuthStore: () => ({
      user: { id: 'user-e2ee' },
      identityStatus: 'ready',
      ensureUserSigningKey: async () => {},
    }),
  };
}

export function cryptoMock() {
  return {
    loadPrivateKey: vi.fn(async () => null),
    loadPublicKey: vi.fn(async () => null),
    loadSigningKey: vi.fn(async () => ({}) as unknown as CryptoKey),
    loadSigningPublicKey: vi.fn(async () => null),
    importSigningPublicKeyRaw: vi.fn(async () => ({}) as unknown as CryptoKey),
    signProof: vi.fn(async () => 'sig'),
    verifyProof: vi.fn(async () => true),
  };
}
