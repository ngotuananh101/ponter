import { describe, expect, it } from 'vitest';
import { parseInbound } from '../../src/signalling/inbound.js';

describe('the signal envelope', () => {
  it('round-trips an offer with its capabilities and camelCase payload', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":["terminal"]}}}';
    const parsed = parseInbound(raw);
    expect(parsed).toMatchObject({
      type: 'offer',
      data: { sessionId: 's1', sdp: 'v=0' },
    });
    expect(JSON.stringify(parsed)).toContain('"sessionId"');
    expect(JSON.stringify(parsed)).not.toContain('session_id');
  });

  it('carries an identity proof', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","proof":{"signature":"c2ln","fingerprint":"AB"}}}}';
    expect(parseInbound(raw)).toMatchObject({
      data: { proof: { signature: 'c2ln', fingerprint: 'AB' } },
    });
  });

  it('treats the proof as optional for older peers', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0"}}}';
    expect(
      (parseInbound(raw) as unknown as { data: Record<string, unknown> }).data
        .proof,
    ).toBeUndefined();
  });

  it('round-trips the user signing key in camelCase', () => {
    const raw =
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","userSigningPublicKey":"cGs="}}}';
    expect(parseInbound(raw)).toMatchObject({
      data: { userSigningPublicKey: 'cGs=' },
    });
  });

  it('parses an ice-candidate with the WebRTC-spec capital M', () => {
    // `sdpMLineIndex` is not what any camelCase rule produces; the wire field is
    // capitalised because the WebRTC spec capitalises it. Both the browser and
    // the server emit this spelling, so the type must model it literally.
    const raw =
      '{"type":"signal","data":{"type":"ice-candidate","data":{"sessionId":"s1","candidate":"c","sdpMid":"0","sdpMLineIndex":0}}}';
    expect(parseInbound(raw)).toMatchObject({ data: { sdpMLineIndex: 0 } });
  });

  it('keeps a hostile sdpMLineIndex parseable so the boundary can reject it', () => {
    // -1 and 70000 must deserialize; the u16 narrowing happens at the peer
    // boundary, which turns them into a typed rejection rather than a generic
    // "malformed frame".
    for (const bad of [-1, 70000]) {
      const raw = `{"type":"signal","data":{"type":"ice-candidate","data":{"sessionId":"s1","candidate":"c","sdpMLineIndex":${bad}}}}`;
      expect(parseInbound(raw)).toMatchObject({ data: { sdpMLineIndex: bad } });
    }
  });

  it('returns null for a pong and for an error frame', () => {
    expect(parseInbound('{"type":"pong"}')).toBeNull();
    expect(
      parseInbound('{"type":"error","code":"VALIDATION_ERROR"}'),
    ).toBeNull();
  });

  it('throws on malformed JSON and on an unknown envelope type', () => {
    expect(() => parseInbound('{')).toThrow();
    expect(() => parseInbound('{"type":"hello","data":{}}')).toThrow();
  });

  it('rejects an oversize frame before parsing it', () => {
    expect(() => parseInbound('x'.repeat(256 * 1024 + 1))).toThrow(/exceeds/);
  });
});
