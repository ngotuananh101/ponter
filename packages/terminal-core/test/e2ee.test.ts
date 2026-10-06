import { describe, it, expect, vi } from 'vitest';
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

/**
 * Bounded condition-based wait: poll `predicate` until it returns truthy or
 * `capMs` elapses. Mirrors the existing `waitForDataFrames` drain but is
 * predicate-based so it works for any invariant (T5-E).
 */
async function waitFor(
  predicate: () => boolean,
  capMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > capMs) {
      throw new Error(
        `timed out waiting for predicate to be truthy after ${capMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Bounded drain for a specific frame type on the captured `frames` array.
 * Mirrors `waitForDataFrames` (filter to `type` === `expected`) (T5-E).
 */
async function waitForFrameType(
  frames: Array<{ type: string; payload: unknown }>,
  expected: string,
  capMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!frames.some((f) => f.type === expected)) {
    if (Date.now() - start > capMs) {
      throw new Error(
        `timed out waiting for frame type "${expected}" (got ${frames.length} frames) after ${capMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

// Bounded condition-based drain: poll `dataFrames(frames).length >= n` until
// the count is reached or `capMs` elapses. Used instead of a single
// `setTimeout(0)` which does not reliably drain async WebCrypto work under
// multi-worker CPU contention (confirmed: ~17% suite failures vs 0% in
// isolation). LOCAL to the test file — no production API change.
async function waitForDataFrames(
  frames: Array<{ type: string; payload: unknown }>,
  n: number,
  capMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (dataFrames(frames).length < n) {
    if (Date.now() - start > capMs) {
      throw new Error(
        `timed out waiting for ${n} terminal-data frames (got ${dataFrames(frames).length}) after ${capMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
  await waitForDataFrames(frames, 2); // bounded drain of the ordered sendChain

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

it('a send-chain failure is reported and does not poison later sends', async () => {
  // Stub TerminalE2ee shaped object: isActive() is true, encrypt rejects once
  // then recovers, decrypt is identity. This exercises the `.catch` on sendChain.
  let failNext = true;
  const failingE2ee = {
    isActive: () => true,
    encrypt: async (data: Uint8Array) => {
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      return data;
    },
    decrypt: async (data: Uint8Array) => data,
  } as unknown as TerminalE2ee;

  const { manager, frames } = mockChannel();
  const client = new TerminalClient('agent-1', manager, failingE2ee);
  const onError = vi.fn();
  client.onError(onError);
  const session = client.createSession();

  // First write: encrypt rejects.
  session.write('one');
  // Give the chain a tick to settle the rejection (no frame is emitted).
  await new Promise((r) => setTimeout(r, 10));

  expect(onError).toHaveBeenCalledTimes(1);
  const [msg] = onError.mock.calls[0]!;
  expect(msg).toContain('send chain failed');
  // No terminal-data frame should have been emitted for the failed write.
  expect(dataFrames(frames)).toHaveLength(0);

  // Second write: encrypt now succeeds and MUST still produce a frame.
  session.write('two');
  await waitForDataFrames(frames, 1);
  expect(dataFrames(frames)).toHaveLength(1);
});

describe('WS1 terminal E2EE client receive path', () => {
  it('decrypts an inbound terminal-data frame when active', async () => {
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

    const { manager, emit } = mockChannel();
    const client = new TerminalClient('agent-1', manager, ta);
    const session = client.createSession();

    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));

    const plaintext = new TextEncoder().encode('hello from peer\n');
    const framed = await tb.encrypt(plaintext);
    const b64 = Buffer.from(framed).toString('base64');

    emit({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: session.id, data: b64 },
      timestamp: 1,
    } as unknown as DataChannelMessage);

    const start = Date.now();
    while (got.length < 1) {
      if (Date.now() - start > 2000) {
        throw new Error(
          `timed out waiting for received data (got ${got.length}) after 2000ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(new TextDecoder().decode(got[0])).toEqual(
      new TextDecoder().decode(plaintext),
    );
  });

  it('reports decrypt failure and never delivers tampered ciphertext', async () => {
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

    const { manager, emit } = mockChannel();
    const client = new TerminalClient('agent-1', manager, ta);
    const onError = vi.fn();
    client.onError(onError);
    const session = client.createSession();

    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));

    const plaintext = new TextEncoder().encode('tamper me\n');
    const framed = await tb.encrypt(plaintext);
    // Flip the last byte (part of the AES-GCM auth tag) so decrypt fails.
    const last = framed.length - 1;
    framed[last] = (framed[last] ?? 0) ^ 0x01;
    const b64 = Buffer.from(framed).toString('base64');

    emit({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: session.id, data: b64 },
      timestamp: 1,
    } as unknown as DataChannelMessage);

    const start = Date.now();
    while (onError.mock.calls.length < 1) {
      if (Date.now() - start > 2000) {
        throw new Error(`timed out waiting for decrypt failure after 2000ms`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    const [msg] = onError.mock.calls[0]!;
    expect(msg).toContain('decrypt failed');

    // Give the receive chain a moment to settle before asserting no data was
    // delivered — `got` must stay empty so garbage is never rendered.
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(0);
  });
});

describe('WS1 terminal E2EE handleAck fail-closed', () => {
  it('rejects an ack whose signature was not made by the expected peer', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const mallory = await makePeer('sess');

    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const malloryE2ee = new TerminalE2ee({
      ...mallory,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });

    // Mallory builds a hello signed with its own key (not b's). When ta tries
    // to derive the session key from this ack, the binding signature will not
    // verify against ta's expected peer signing key (b's), so handleAck must
    // reject and ta must remain inactive.
    const malloryAck = await malloryE2ee.buildHello('t1');

    await expect(ta.handleAck(malloryAck)).rejects.toThrow();
    expect(ta.isActive()).toBe(false);
  });
});

describe('WS1 terminal E2EE client negotiation (createSession auto-hello)', () => {
  it('negotiates when the peer advertises e2ee: createSession sends hello, ack activates', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const { manager, frames, emit } = mockChannel();
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const tb = new TerminalE2ee({
      ...b,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });
    const client = new TerminalClient('agent-1', manager, ta);
    client.createSession(); // T5-C: drives hello on the sendChain after terminal-create

    await waitForFrameType(frames, 'terminal-e2ee-hello');
    const hello = frames.find((f) => f.type === 'terminal-e2ee-hello')!.payload as never;
    const ack = await tb.handleHello(hello);
    emit({
      type: 'terminal-e2ee-ack',
      channel: 'terminal',
      payload: ack,
      timestamp: 1,
    } as never);

    await waitFor(() => ta.isActive());
    expect(ta.isActive()).toBe(true);
  });

  it('never renders ciphertext: a data frame arriving after the ack decrypts, not renders raw', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const { manager, frames, emit } = mockChannel();
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const tb = new TerminalE2ee({
      ...b,
      peerSigningPublicKey: a.peerSigningPublicKey,
    });
    const client = new TerminalClient('agent-1', manager, ta);
    const session = client.createSession();
    const got: Uint8Array[] = [];
    session.onData((d) => got.push(d));

    // Drive hello via createSession, then handle the ack through the real path.
    await waitForFrameType(frames, 'terminal-e2ee-hello');
    const hello = frames.find((f) => f.type === 'terminal-e2ee-hello')!
      .payload as never;
    await ta.handleAck(await tb.handleHello(hello));

    const framed = await tb.encrypt(new TextEncoder().encode('decrypted text\n'));
    emit({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: session.id, data: Buffer.from(framed).toString('base64') },
      timestamp: 1,
    } as never);

    await waitFor(() => got.length === 1);
    // Delivered bytes are the plaintext — never the raw [IV][ct‖tag] frame.
    expect(new TextDecoder().decode(got[0])).toBe('decrypted text\n');
  });

  it('negotiate() is public and idempotent-safe: does not send a second hello', async () => {
    // T5-C: negotiate(terminalId) is a public method. Calling it twice for the
    // same session must not enqueue a second hello on the sendChain.
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const { manager, frames } = mockChannel();
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const client = new TerminalClient('agent-1', manager, ta);
    const session = client.createSession();

    await waitForFrameType(frames, 'terminal-e2ee-hello');
    client.negotiate(session.id); // explicit second call — should be a no-op

    const hellos = frames.filter((f) => f.type === 'terminal-e2ee-hello');
    expect(hellos).toHaveLength(1);
  });

  it('two createSession calls on the same client negotiate independently', async () => {
    // Each terminalId gets its own hello — the negotiatedTerminals set is keyed
    // by terminal ID, not by client.
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const { manager, frames } = mockChannel();
    const ta = new TerminalE2ee({
      ...a,
      peerSigningPublicKey: b.peerSigningPublicKey,
    });
    const client = new TerminalClient('agent-1', manager, ta);
    const s1 = client.createSession();
    const s2 = client.createSession();

    // Each createSession enqueues a hello on the sendChain. Wait until both
    // hello frames have been emitted (they are sequenced, so we poll).
    await waitFor(() => frames.filter((f) => f.type === 'terminal-e2ee-hello').length >= 2);

    const hellos = frames.filter((f) => f.type === 'terminal-e2ee-hello');
    expect(hellos).toHaveLength(2);
    // Each hello is for a distinct terminal ID.
    const helloPayload0 = hellos[0]!.payload as { terminalId: string };
    const helloPayload1 = hellos[1]!.payload as { terminalId: string };
    expect(helloPayload0.terminalId).toBe(s1.id);
    expect(helloPayload1.terminalId).toBe(s2.id);
  });
});
