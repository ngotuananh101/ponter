// apps/agent/test/identity/frame.test.ts
import { describe, expect, it } from 'vitest';
import { buildAgentIdentityFrame } from '../../src/identity/frame.js';

const identity = {
  publicKeyBase64: 'cGs=',
  sign: (bytes: Uint8Array) =>
    new Uint8Array(Buffer.from(`sig:${Buffer.from(bytes).toString()}`)),
};

describe('buildAgentIdentityFrame', () => {
  it('signs the canonical agent-identity string', () => {
    const frame = buildAgentIdentityFrame('nonce-1', identity);
    const parsed = JSON.parse(frame);
    const signed = Buffer.from(parsed.data.signature, 'base64').toString();
    expect(signed).toBe('sig:ponter-ws2-agent-identity-v1\nnonce=nonce-1');
  });

  it('carries the nonce and the base64 public key', () => {
    const parsed = JSON.parse(buildAgentIdentityFrame('n', identity));
    expect(parsed).toMatchObject({
      type: 'agent-identity',
      data: { nonce: 'n', publicKey: 'cGs=' },
    });
  });

  it('is a single line of JSON with no trailing newline', () => {
    const frame = buildAgentIdentityFrame('n', identity);
    expect(frame).not.toContain('\n');
    expect(frame.trim()).toBe(frame);
  });

  it('produces a different signature for a different nonce', () => {
    const a = JSON.parse(buildAgentIdentityFrame('a', identity)).data.signature;
    const b = JSON.parse(buildAgentIdentityFrame('b', identity)).data.signature;
    expect(a).not.toBe(b);
  });
});
