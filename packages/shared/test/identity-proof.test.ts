import { describe, it, expect } from 'vitest';
import {
  PROOF_VERSION,
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
} from '../src/types/identity-proof';

const FP =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('canonicalProofMessage', () => {
  it('is byte-stable for identical inputs', () => {
    const a = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const b = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(a).toBe(b);
  });

  it('binds the role so an offer proof cannot verify as an answer proof', () => {
    const offer = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const answer = canonicalProofMessage({
      role: 'answerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(offer).not.toBe(answer);
  });

  it('binds the sessionId so a proof cannot be replayed into another session', () => {
    const s1 = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const s2 = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's2',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(s1).not.toBe(s2);
  });

  it('starts with the version tag and contains every field on its own line', () => {
    const msg = canonicalProofMessage({
      role: 'answerer',
      sessionId: 'sX',
      sdpSha256Hex: 'deadbeef',
      fingerprint: FP,
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe(PROOF_VERSION);
    expect(lines).toContain('role=answerer');
    expect(lines).toContain('sessionId=sX');
    expect(lines).toContain('sdpSha256=deadbeef');
    expect(lines).toContain(`fingerprint=${FP}`);
  });
});

describe('normalizeFingerprint', () => {
  it('normalizes a bare colon-separated value to uppercase', () => {
    expect(normalizeFingerprint(FP.toLowerCase())).toBe(FP);
  });

  it('strips the SDP prefix and normalizes', () => {
    expect(
      normalizeFingerprint(`a=fingerprint:sha-256 ${FP.toLowerCase()}`),
    ).toBe(FP);
  });

  it('rejects a value that is not 32 colon-separated hex byte pairs', () => {
    expect(() => normalizeFingerprint('AB:CD')).toThrow();
    expect(() => normalizeFingerprint('ZZ:'.repeat(31) + 'ZZ')).toThrow();
    expect(() => normalizeFingerprint('')).toThrow();
  });
});

describe('parseSdpFingerprint', () => {
  const sdp = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    `a=fingerprint:sha-256 ${FP.toLowerCase()}`,
    'a=setup:passive',
    '',
  ].join('\r\n');

  it('extracts and normalizes the fingerprint line', () => {
    expect(parseSdpFingerprint(sdp)).toBe(FP);
  });

  it('throws when the SDP carries no fingerprint', () => {
    expect(() => parseSdpFingerprint('v=0\r\n')).toThrow();
  });
});
