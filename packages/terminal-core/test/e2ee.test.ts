import { describe, it, expect } from 'vitest';
import {
  generateUserKeyPair,
  generateSigningKeyPair,
  importSigningPublicKeyRaw,
} from '@ponter/crypto';
import { TerminalE2ee } from '../src/e2ee';

async function makePeer(sessionId: string) {
  const ecdh = await generateUserKeyPair();
  const signing = await generateSigningKeyPair();
  const peerSigningPublicKey = await importSigningPublicKeyRaw(
    signing.publicKeyRawBase64,
  );
  return {
    ecdhPrivateKey: ecdh.privateKey,
    ecdhPublicKey: ecdh.publicKey,
    signingPrivateKey: signing.privateKey,
    peerSigningPublicKey,
    sessionId,
  };
}

describe('WS1 terminal E2EE negotiation', () => {
  it('two peers negotiate and round-trip terminal bytes', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const tb = new TerminalE2ee({
      ...b,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });

    const ack = await tb.handleHello(await ta.buildHello('t1'));
    await ta.handleAck(ack);

    expect(ta.isActive()).toBe(true);
    expect(tb.isActive()).toBe(true);

    const plaintext = new TextEncoder().encode('echo hi\n');
    expect(await tb.decrypt(await ta.encrypt(plaintext))).toEqual(plaintext);
  });

  it('a hello whose signature does not verify leaves the session plaintext', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const mallory = await makePeer('sess');
    const malloryE2ee = new TerminalE2ee({
      ...mallory,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });
    const tb = new TerminalE2ee({
      ...b,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });

    await expect(
      tb.handleHello(await malloryE2ee.buildHello('t1')),
    ).rejects.toThrow();
    expect(tb.isActive()).toBe(false);
  });

  it('isNegotiationFrame matches only the two negotiation frame types', () => {
    expect(TerminalE2ee.isNegotiationFrame('terminal-e2ee-hello')).toBe(true);
    expect(TerminalE2ee.isNegotiationFrame('terminal-e2ee-ack')).toBe(true);
    expect(TerminalE2ee.isNegotiationFrame('terminal-data')).toBe(false);
  });

  it('before negotiation, encrypt/decrypt are identity (dormant)', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    expect(ta.isActive()).toBe(false);
    const data = new TextEncoder().encode('x');
    expect(await ta.encrypt(data)).toEqual(data);
    expect(await ta.decrypt(data)).toEqual(data);
  });
});

import { TerminalClient } from '../src/client';
import type { DataChannelManager } from '@ponter/webrtc-core';
import type { DataChannelMessage } from '@ponter/shared';

function mockChannel() {
  const frames: Array<{ type: string; payload: unknown }> = [];
  let handler: ((m: DataChannelMessage) => void) | undefined;
  const manager = {
    sendJson: (_ch: string, type: string, payload: unknown) =>
      frames.push({ type, payload }),
    onMessage: (_ch: string, cb: (m: DataChannelMessage) => void) => {
      handler = cb;
      return () => {};
    },
  } as unknown as DataChannelManager;
  return { manager, frames, emit: (m: DataChannelMessage) => handler?.(m) };
}

// `createSession()` sends a `terminal-create` frame first; these helpers isolate
// the `terminal-data` frames the assertions care about.
const dataFrames = (frames: Array<{ type: string; payload: unknown }>) =>
  frames.filter((f) => f.type === 'terminal-data');

it('plaintext parity: no e2ee context sends the exact same frame as today', () => {
  const { manager, frames } = mockChannel();
  const client = new TerminalClient('agent-1', manager);
  const session = client.createSession();
  session.write('hello world');
  expect(dataFrames(frames)).toEqual([
    {
      type: 'terminal-data',
      payload: {
        terminalId: session.id,
        data: Buffer.from('hello world').toString('base64'),
      },
    },
  ]);
});

it('encrypts when active and preserves submission order', async () => {
  const a = await makePeer('sess');
  const b = await makePeer('sess');
  const ta = new TerminalE2ee({
    ...a,
    peerSigningPublicKey: b.peerSigningPublicKey,
  });
  const tb = new TerminalE2ee({
    ...b,
    peerSigningPublicKey: a.peerSigningPublicKey,
  });
  await ta.handleAck(await tb.handleHello(await ta.buildHello('t1')));

  const { manager, frames } = mockChannel();
  const client = new TerminalClient('agent-1', manager, ta);
  const session = client.createSession();
  session.write('one');
  session.write('two');
  await new Promise((r) => setTimeout(r, 0)); // let the ordered chain drain

  const decoded = await Promise.all(
    dataFrames(frames).map((f) =>
      tb.decrypt(
        new Uint8Array(
          Buffer.from((f.payload as { data: string }).data, 'base64'),
        ),
      ),
    ),
  );
  expect(decoded.map((d) => new TextDecoder().decode(d))).toEqual([
    'one',
    'two',
  ]);
});
