/** A peer's signed DTLS-fingerprint proof (WS2). */
export interface IdentityProof {
  /** Ed25519 signature (base64) over the canonical proof message. */
  signature: string;
  /** SHA-256 DTLS certificate fingerprint, normalized uppercase `XX:XX:…`. */
  fingerprint: string;
}

export interface SignalOffer {
  sessionId: string;
  sdp: string;
  capabilities: string[];
  /** Signed by the offerer's identity key. Absent only for legacy/loopback tests. */
  proof?: IdentityProof;
  /**
   * WS2: the session owner's Ed25519 signing public key (base64 raw).
   * Server-added on the offer pushed to the agent — never client-trusted; any
   * client-supplied value is overwritten by the server.
   */
  userSigningPublicKey?: string | null;
}

export interface SignalAnswer {
  sessionId: string;
  sdp: string;
  approved: boolean;
  /** Signed by the answerer's identity key. */
  proof?: IdentityProof;
  /**
   * WS1: capabilities the answerer supports (e.g. `"e2ee"`). Optional and
   * additive — absent today, so an answer without it behaves exactly as before.
   * The browser reads it to decide whether to negotiate terminal encryption.
   */
  capabilities?: string[];
}

export interface IceCandidateSignal {
  sessionId: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalMessage =
  | { type: 'offer'; data: SignalOffer }
  | { type: 'answer'; data: SignalAnswer }
  | { type: 'ice-candidate'; data: IceCandidateSignal };

/**
 * The WebSocket transport envelope for the agent socket.
 *
 * A signal frame nests `{ type, data }` inside `{ type: 'signal', data }`: the
 * outer `type` is the *transport* discriminator, the inner one is the *signal*
 * discriminator. Flattening them would make a transport frame ambiguous with a
 * bare `SignalMessage`, and would force every consumer to re-derive which union
 * it is holding.
 *
 * `SignalMessage` above is deliberately unchanged: `webrtc-core`'s
 * `SignalTransport` and the REST bodies keep one definition.
 */
export type AgentErrorCode =
  | 'MALFORMED_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR'
  | 'SESSION_NOT_ACTIVE';

export type AgentSocketMessage =
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage }
  | { type: 'identity-challenge'; data: { nonce: string } }
  | {
      type: 'agent-identity';
      data: { publicKey: string; nonce: string; signature: string };
    }
  | { type: 'error'; code: AgentErrorCode };

/**
 * Browser signaling socket — the counterpart of `AgentSocketMessage`.
 *
 * `SESSION_TERMINATED` exists only here: the agent socket has no reason to
 * hear that its own session ended, while a browser tab must be told to stop
 * waiting on a handshake that can no longer complete.
 */
export type BrowserErrorCode =
  | 'MALFORMED_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'TICKET_EXPIRED'
  | 'SESSION_TERMINATED'
  | 'INTERNAL_SERVER_ERROR';

/** Client -> Server. `after` = UUID of the last signal already seen. */
export type BrowserMessageInit =
  | { type: 'subscribe'; data: { sessionId: string; after?: string | null } }
  | { type: 'signal'; data: SignalMessage }
  | { type: 'ping' }
  | { type: 'subscribe-fleet' }
  | { type: 'unsubscribe-fleet' };

/** Server -> Client. Same envelope convention as `AgentSocketMessage`. */
export type BrowserSocketMessage =
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage; id: string }
  | {
      type: 'subscribed';
      data: { sessionId: string; after: string | null; hasMore: boolean };
    }
  | { type: 'fleet-changed' }
  | { type: 'error'; code: BrowserErrorCode };

/**
 * Parse and normalize one inbound browser frame.
 *
 * Mirrors the agent socket's validator: size is the caller's concern (the
 * frame limit is a transport concern), this rejects anything that is not a
 * well-formed frame of a known type. Signal payloads are normalized to the
 * same shape `recordSignal` writes, so a frame that survives this function
 * can be persisted without a second validation pass.
 */
export function parseBrowserMessage(raw: string): BrowserMessageInit | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return null;
  }

  const envelope = frame as { type?: unknown; data?: unknown };

  switch (envelope.type) {
    case 'ping':
      return { type: 'ping' };
    case 'subscribe-fleet':
      return { type: 'subscribe-fleet' };
    case 'unsubscribe-fleet':
      return { type: 'unsubscribe-fleet' };
    case 'subscribe':
      return parseSubscribe(envelope.data);
    case 'signal': {
      const message = parseSignalMessage(envelope.data);
      return message ? { type: 'signal', data: message } : null;
    }
    default:
      return null;
  }
}

/** A non-empty string, or `null` for anything else. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parseSubscribe(raw: unknown): BrowserMessageInit | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const data = raw as Record<string, unknown>;

  const sessionId = asString(data.sessionId);
  if (!sessionId) return null;

  const after = data.after;
  if (after === undefined || after === null) {
    return { type: 'subscribe', data: { sessionId } };
  }
  const cursor = asString(after);
  return cursor
    ? { type: 'subscribe', data: { sessionId, after: cursor } }
    : null;
}

/** Normalize a signal payload, mirroring the server's `parseSignalMessage`. */
function parseSignalMessage(frame: unknown): SignalMessage | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return null;
  }

  switch ((frame as Record<string, unknown>).type) {
    case 'offer':
      return parseOffer(frame);
    case 'answer':
      return parseAnswer(frame);
    case 'ice-candidate':
      return parseIceCandidate(frame);
    default:
      return null;
  }
}

/** The inner `data` object of a signal payload, when it is a plain object. */
function signalData(frame: unknown): Record<string, unknown> | null {
  const payload = (frame as Record<string, unknown>).data;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function parseOffer(frame: unknown): SignalMessage | null {
  const inner = signalData(frame);
  if (!inner) return null;

  const sessionId = asString(inner.sessionId);
  const sdp = asString(inner.sdp);
  if (!sessionId || !sdp) return null;

  const capabilities = Array.isArray(inner.capabilities)
    ? inner.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  return { type: 'offer', data: { sessionId, sdp, capabilities } };
}

function parseAnswer(frame: unknown): SignalMessage | null {
  const inner = signalData(frame);
  if (!inner) return null;

  const sessionId = asString(inner.sessionId);
  const sdp = asString(inner.sdp);
  if (!sessionId || !sdp) return null;

  const capabilities = Array.isArray(inner.capabilities)
    ? (inner.capabilities as unknown[]).filter(
        (c): c is string => typeof c === 'string',
      )
    : [];
  return {
    type: 'answer',
    data: {
      sessionId,
      sdp,
      approved: inner.approved !== false,
      ...(capabilities.length > 0 ? { capabilities } : {}),
    },
  };
}

function parseIceCandidate(frame: unknown): SignalMessage | null {
  const inner = signalData(frame);
  if (!inner) return null;

  const sessionId = asString(inner.sessionId);
  const candidate = asString(inner.candidate);
  if (!sessionId || !candidate) return null;

  return {
    type: 'ice-candidate',
    data: {
      sessionId,
      candidate,
      sdpMid: typeof inner.sdpMid === 'string' ? inner.sdpMid : null,
      sdpMLineIndex: parseSdpMLineIndex(inner.sdpMLineIndex),
    },
  };
}

/** `sdpMLineIndex` is a non-negative 16-bit integer, or `null`. */
function parseSdpMLineIndex(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 65535
  ) {
    return null;
  }
  return value;
}
