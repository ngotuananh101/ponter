import { describe, it, expect } from 'vitest';
import { canonicalUserIdentityMessage as serverMirror } from '../src/utils/identity-proof';
import {
  canonicalUserIdentityMessage as sharedSource,
  USER_IDENTITY_PROOF_PREFIX,
} from '@ponter/shared';

// The server keeps a local copy of this pure function because @ponter/shared
// ships TypeScript source and the production image runs compiled JS — a runtime
// import would crash the server at boot (ERR_MODULE_NOT_FOUND). These tests pin
// the mirror to the shared source so the two can never drift: the browser signs
// the shared string and the server verifies the mirror, so a divergence would
// silently break signing-key bootstrap.
describe('canonicalUserIdentityMessage (server mirror)', () => {
  const inputs = [
    'u1',
    'user-abc-123',
    '',
    '  spaced  ',
    'unicode-✓-🚀',
    'with=newline\nin=id',
    'a'.repeat(500),
  ];

  it('matches @ponter/shared byte-for-byte on representative inputs', () => {
    for (const id of inputs) {
      expect(serverMirror(id)).toBe(sharedSource(id));
    }
  });

  it('uses the shared version prefix', () => {
    expect(serverMirror('u1')).toBe(`${USER_IDENTITY_PROOF_PREFIX}\nuserId=u1`);
  });

  it('is byte-stable across calls', () => {
    expect(serverMirror('u1')).toBe(serverMirror('u1'));
  });
});
