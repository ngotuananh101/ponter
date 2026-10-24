// apps/agent/test/signalling/client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logging/index.js';
import {
  SignallingClient,
  type SignallingDeps,
  type SignallingSocket,
} from '../../src/signalling/client.js';
import { loadConfig } from '../../src/config.js';

function fakeSocket() {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const sent: string[] = [];
  const socket: SignallingSocket = {
    send: (d) => sent.push(d),
    close: (code) => emit('close', code ?? 1000),
    on: (ev, cb) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), cb]);
    },
  };
  function emit(ev: string, ...args: unknown[]) {
    for (const cb of handlers.get(ev) ?? []) cb(...args);
  }
  return { socket, sent, emit };
}

function harness() {
  let clock = 0;
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const logLines: string[] = [];
  let socketHandle = fakeSocket();
  let connects = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const deps: SignallingDeps = {
    connect: (url: string, headers: Record<string, string>) => {
      connects += 1;
      calls.push({ url, headers });
      return socketHandle.socket;
    },
    logger: createLogger({ RUST_LOG: 'debug' }, (l) => logLines.push(l)),
    now: () => clock,
    every: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers) if (!t.cancelled) t.fn();
  };
  return {
    deps,
    sent: () => socketHandle.sent,
    emit: (...a: [string, ...unknown[]]) => socketHandle.emit(...a),
    logLines,
    connects: () => connects,
    calls: () => calls,
    advance,
    reset: () => {
      socketHandle = fakeSocket();
    },
  };
}

const config = loadConfig({
  AGENT_ID: 'a1',
  AGENT_CREDENTIAL: 'ag_secret',
  AGENT_SERVER: 'ws://h:8787/api/ws/agent',
});
const identity = {
  publicKeyBase64: 'cGs=',
  sign: () => new Uint8Array([1, 2, 3]),
};

function makeClient(h: ReturnType<typeof harness>, overrides = {}) {
  const handlers = {
    onOffer: vi.fn(),
    onIceServers: vi.fn(),
    onAnswer: vi.fn(),
    onCandidate: vi.fn(),
    onChallenge: vi.fn(),
    ...overrides,
  };
  return {
    client: new SignallingClient(h.deps, config, identity, handlers),
    handlers,
  };
}

describe('SignallingClient.runOnce', () => {
  it('connects to the configured URL with a Bearer header', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('close', 4409);
    await done;
    expect(h.calls()[0]).toEqual({
      url: 'ws://h:8787/api/ws/agent',
      headers: { Authorization: 'Bearer ag_secret' },
    });
  });

  it('routes a signal frame to the matching handler', async () => {
    const h = harness();
    const { client, handlers } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit(
      'message',
      '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s","sdp":"v"}}}',
    );
    h.emit('close', 4409);
    await done;
    expect(handlers.onOffer).toHaveBeenCalledWith({
      type: 'offer',
      data: { sessionId: 's', sdp: 'v' },
    });
  });

  it('answers an identity challenge with a signed frame', async () => {
    const h = harness();
    const { client, handlers } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{"type":"identity-challenge","data":{"nonce":"n1"}}');
    h.emit('close', 4409);
    await done;
    expect(handlers.onChallenge).not.toHaveBeenCalled();
    const reply = JSON.parse(h.sent()[0] as string);
    expect(reply.type).toBe('agent-identity');
    expect(reply.data.nonce).toBe('n1');
    expect(reply.data.publicKey).toBe('cGs=');
    expect(reply.data.signature).toBe(
      Buffer.from([1, 2, 3]).toString('base64'),
    );
  });

  it('ends the run transiently when the socket dies without a close frame', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('close', null);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('ends the run terminally on 4409 and on 4401', async () => {
    for (const code of [4401, 4409]) {
      const h = harness();
      const { client } = makeClient(h);
      const done = client.runOnce();
      h.emit('open');
      h.emit('close', code);
      await expect(done).resolves.toEqual({ kind: 'terminal', code });
    }
  });

  it('ends the run terminally on a server UNAUTHORIZED error frame', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit(
      'message',
      '{"type":"error","code":"UNAUTHORIZED","message":"bad credential"}',
    );
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4401 });
  });

  it('keeps the socket open for a 403 error frame and ends transiently later', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit(
      'message',
      '{"type":"error","code":"FORBIDDEN","message":"not your session"}',
    );
    h.emit('close', 1006);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('drops an oversize frame and keeps the socket open', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', 'x'.repeat(256 * 1024 + 1));
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
    expect(h.logLines.some((l) => l.includes('exceeds'))).toBe(true);
  });

  it('drops a malformed frame and keeps the socket open', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.emit('message', '{not json');
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
  });

  it('sends a ping on every keepalive tick', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.advance(30_000);
    h.emit('close', 4409);
    await done;
    expect(h.sent().some((s) => s.includes('"ping"'))).toBe(true);
  });

  it('ends the run transiently after 90 s of complete silence', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    h.advance(90_000);
    await expect(done).resolves.toEqual({ kind: 'transient' });
  });

  it('does not time out while frames keep arriving', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.runOnce();
    h.emit('open');
    for (let i = 0; i < 4; i += 1) {
      h.advance(30_000);
      h.emit('message', '{"type":"pong"}');
    }
    h.emit('close', 4409);
    await expect(done).resolves.toEqual({ kind: 'terminal', code: 4409 });
  });
});

describe('SignallingClient.run', () => {
  it('stops without reconnecting after a terminal close', async () => {
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    h.emit('open');
    h.emit('close', 4409);
    await expect(done).resolves.toBeUndefined();
    expect(h.connects()).toBe(1);
  });

  it('reconnects after a transient close, waiting between attempts', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    h.emit('open');
    h.emit('close', 1006);
    h.reset(); // the NEXT connect() must capture the fresh socket
    await vi.advanceTimersByTimeAsync(199);
    expect(h.connects()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connects()).toBe(2);
    h.emit('open');
    h.emit('close', 4409);
    await done;
    vi.useRealTimers();
  });

  it('resets the ladder after a successful connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { client } = makeClient(h);
    const done = client.run();
    // First death without ever connecting: 200 ms.
    h.emit('close', 1006);
    h.reset(); // the NEXT connect() must capture the fresh socket
    await vi.advanceTimersByTimeAsync(200);
    // Second attempt connects, then dies: the ladder must be back at 200.
    h.emit('open');
    h.emit('close', 1006);
    h.reset();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.connects()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.connects()).toBe(3);
    h.emit('open');
    h.emit('close', 4409);
    await done;
    vi.useRealTimers();
  });
});
