import type { Logger } from '../logging/index.js';
import { MAX_INBOUND_FRAME_BYTES } from './constants.js';
import type { IceServerEntry, SignalMessage } from './messages.js';

export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

type Envelope =
  | { type: 'signal'; data: SignalMessage }
  | { type: 'pong' }
  | { type: 'error'; code?: string };

function guardSize(raw: string): void {
  if (raw.length > MAX_INBOUND_FRAME_BYTES) {
    throw new InboundParseError(
      `inbound frame exceeds ${MAX_INBOUND_FRAME_BYTES} bytes`,
    );
  }
}

/**
 * A `signal` frame nests `{type, data}` inside `{type:'signal', data}`: the
 * outer `type` is the transport discriminator, the inner one names the signal.
 *
 * `hello` is deliberately absent — the server's inbound handler has no arm for
 * it and answers `VALIDATION_ERROR`.
 */
export function parseInbound(
  raw: string,
  logger?: Logger,
): SignalMessage | null {
  guardSize(raw);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    throw new InboundParseError('malformed inbound frame');
  }
  if (envelope?.type === 'signal' && envelope.data) return envelope.data;
  if (envelope?.type === 'pong') return null;
  if (envelope?.type === 'error') {
    logger?.warn(
      { code: envelope.code ?? 'unknown' },
      'server sent an error frame',
    );
    return null;
  }
  throw new InboundParseError(`unknown inbound envelope type`);
}

/**
 * The `ice-servers` frame the server pushes on connect. Returns `null` for any
 * frame that is not one, so the caller falls through to the next parser.
 */
export function parseIceServers(raw: string): IceServerEntry[] | null {
  guardSize(raw);
  let frame: { type?: string; data?: { iceServers?: IceServerEntry[] } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  if (frame?.type !== 'ice-servers') return null;
  return frame.data?.iceServers ?? [];
}

/**
 * The WS2 `identity-challenge` nonce. Returns `null` for any frame that is not
 * one. An oversize frame throws, like the other parsers.
 */
export function parseIdentityChallenge(raw: string): string | null {
  guardSize(raw);
  let frame: { type?: string; data?: { nonce?: string } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return null;
  }
  if (frame?.type !== 'identity-challenge') return null;
  return typeof frame.data?.nonce === 'string' ? frame.data.nonce : null;
}

export type InboundEvent =
  | { kind: 'signal'; message: SignalMessage }
  | { kind: 'ice'; servers: IceServerEntry[] }
  | { kind: 'challenge'; nonce: string }
  | { kind: 'ignored' };

/**
 * The cascade, in the only order that works.
 *
 * `parseIdentityChallenge` and `parseIceServers` return `null` for "not mine";
 * `parseInbound` throws for anything that is not a signal frame. So the two
 * specific parsers must run first: run `parseInbound` first and every
 * `identity-challenge` and `ice-servers` frame becomes a logged parse error, and
 * the agent builds its peer with no TURN and never answers the identity
 * challenge — which makes every downstream offer-proof gate fail closed.
 */
export function dispatchInbound(raw: string, logger: Logger): InboundEvent {
  const nonce = parseIdentityChallenge(raw);
  if (nonce !== null) return { kind: 'challenge', nonce };

  const servers = parseIceServers(raw);
  if (servers !== null) return { kind: 'ice', servers };

  const message = parseInbound(raw, logger);
  if (message === null) return { kind: 'ignored' };
  return { kind: 'signal', message };
}
