// apps/agent/test/signalling/auth.test.ts
import { describe, expect, it } from 'vitest';
import { isAuthFatal } from '../../src/signalling/auth.js';

describe('isAuthFatal', () => {
  it('treats a 401 status as fatal', () => {
    expect(isAuthFatal({ status: 401, code: 'API_ERROR' })).toBe(true);
  });

  it('treats an UNAUTHORIZED code as fatal even without a status', () => {
    expect(isAuthFatal({ code: 'UNAUTHORIZED' })).toBe(true);
  });

  it('does NOT treat a 403 as fatal', () => {
    // Issue #107 / PR #110 settled this: a 403 means "this peer may not do
    // that", not "this credential is dead". Reconnecting is the wrong response
    // and the Rust test `not_auth_fatal_on_other_failures` pins it.
    expect(isAuthFatal({ status: 403, code: 'FORBIDDEN' })).toBe(false);
  });

  it('does not treat a server error or a bare status as fatal', () => {
    expect(isAuthFatal({ status: 500, code: 'SERVER_ERROR' })).toBe(false);
    expect(isAuthFatal({ status: 200, code: 'API_ERROR' })).toBe(false);
    expect(isAuthFatal({})).toBe(false);
  });
});
