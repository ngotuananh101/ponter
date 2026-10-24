import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logging/index.js';
import {
  dispatchInbound,
  parseIceServers,
  parseIdentityChallenge,
} from '../../src/signalling/inbound.js';

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ RUST_LOG: 'debug' }, (l) => lines.push(l));
  return { logger, lines };
}

describe('parseIceServers', () => {
  it('parses the pushed frame with a STUN and a dual-transport TURN entry', () => {
    const raw = JSON.stringify({
      type: 'ice-servers',
      data: {
        iceServers: [
          { urls: ['stun:stun.example.com:19302'] },
          {
            urls: [
              'turn:turn.example.com:3478?transport=udp',
              'turn:turn.example.com:3478?transport=tcp',
            ],
            username: '1700000000:user-1',
            credential: 'cred-abc',
          },
        ],
      },
    });
    expect(parseIceServers(raw)).toEqual([
      { urls: ['stun:stun.example.com:19302'] },
      {
        urls: [
          'turn:turn.example.com:3478?transport=udp',
          'turn:turn.example.com:3478?transport=tcp',
        ],
        username: '1700000000:user-1',
        credential: 'cred-abc',
      },
    ]);
  });

  it('parses a STUN-only frame', () => {
    const raw = JSON.stringify({
      type: 'ice-servers',
      data: { iceServers: [{ urls: ['stun:h:3478'] }] },
    });
    expect(parseIceServers(raw)).toHaveLength(1);
  });

  it('returns null for a frame that is not an ice-servers frame', () => {
    expect(parseIceServers('{"type":"pong"}')).toBeNull();
  });
});

describe('parseIdentityChallenge', () => {
  it('returns the nonce', () => {
    expect(
      parseIdentityChallenge(
        '{"type":"identity-challenge","data":{"nonce":"n1"}}',
      ),
    ).toBe('n1');
  });

  it('returns null for a non-challenge frame', () => {
    expect(
      parseIdentityChallenge(
        '{"type":"signal","data":{"type":"offer","data":{"sessionId":"s"}}}',
      ),
    ).toBeNull();
    expect(
      parseIdentityChallenge('{"type":"ice-servers","data":{"iceServers":[]}}'),
    ).toBeNull();
  });
});

describe('dispatchInbound', () => {
  it('classifies a challenge before anything else', () => {
    const { logger } = captureLogger();
    expect(
      dispatchInbound(
        '{"type":"identity-challenge","data":{"nonce":"n1"}}',
        logger,
      ),
    ).toEqual({ kind: 'challenge', nonce: 'n1' });
  });

  it('classifies the ICE push without logging a parse failure', () => {
    const { logger, lines } = captureLogger();
    const event = dispatchInbound(
      JSON.stringify({
        type: 'ice-servers',
        data: { iceServers: [{ urls: ['stun:h'] }] },
      }),
      logger,
    );
    expect(event.kind).toBe('ice');
    // The cascade order is what this asserts: an inverted order turns this
    // frame into a "dropping malformed inbound frame" warning.
    expect(lines.filter((l) => l.includes('malformed'))).toHaveLength(0);
    expect(lines.filter((l) => l.includes('WARN'))).toHaveLength(0);
  });

  it('classifies a signal frame', () => {
    const { logger } = captureLogger();
    const event = dispatchInbound(
      '{"type":"signal","data":{"type":"offer","data":{}}}',
      logger,
    );
    expect(event.kind).toBe('signal');
  });

  it('ignores a pong without a warning', () => {
    const { logger, lines } = captureLogger();
    expect(dispatchInbound('{"type":"pong"}', logger)).toEqual({
      kind: 'ignored',
    });
    expect(lines).toHaveLength(0);
  });

  it('logs a server error frame at warn and ignores it', () => {
    const { logger, lines } = captureLogger();
    expect(dispatchInbound('{"type":"error","code":"E"}', logger)).toEqual({
      kind: 'ignored',
    });
    expect(lines.some((l) => l.includes('server sent an error frame'))).toBe(
      true,
    );
  });
});
