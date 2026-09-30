export interface SignalOffer {
  sessionId: string;
  sdp: string;
  capabilities: string[];
}

export interface SignalAnswer {
  sessionId: string;
  sdp: string;
  approved: boolean;
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
  | { type: 'ping' };

/** Server -> Client. Same envelope convention as `AgentSocketMessage`. */
export type BrowserSocketMessage =
  | { type: 'pong' }
  | { type: 'signal'; data: SignalMessage; id: string }
  | {
      type: 'subscribed';
      data: { sessionId: string; after: string | null; hasMore: boolean };
    }
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

  if (envelope.type === 'ping') {
    return { type: 'ping' };
  }

  if (envelope.type === 'subscribe') {
    const data = envelope.data as Record<string, unknown> | undefined;
    if (!data || typeof data.sessionId !== 'string' || !data.sessionId) {
      return null;
    }
    if (data.after === undefined || data.after === null) {
      return { type: 'subscribe', data: { sessionId: data.sessionId } };
    }
    if (typeof data.after !== 'string' || !data.after) {
      return null;
    }
    return {
      type: 'subscribe',
      data: { sessionId: data.sessionId, after: data.after },
    };
  }

  if (envelope.type !== 'signal') {
    return null;
  }

  const message = parseSignalMessage(envelope.data);
  if (!message) return null;
  return { type: 'signal', data: message };
}

/** Normalize a signal payload, mirroring the server's `parseSignalMessage`. */
function parseSignalMessage(frame: unknown): SignalMessage | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
    return null;
  const data = frame as Record<string, unknown>;

  if (data.type === 'offer') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.sdp !== 'string' || !inner.sdp) return null;
    const capabilities = Array.isArray(inner.capabilities)
      ? inner.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    return {
      type: 'offer',
      data: { sessionId: inner.sessionId, sdp: inner.sdp, capabilities },
    };
  }

  if (data.type === 'answer') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.sdp !== 'string' || !inner.sdp) return null;
    return {
      type: 'answer',
      data: {
        sessionId: inner.sessionId,
        sdp: inner.sdp,
        approved: inner.approved !== false,
      },
    };
  }

  if (data.type === 'ice-candidate') {
    const inner = data.data as Record<string, unknown> | undefined;
    if (!inner || typeof inner.sessionId !== 'string' || !inner.sessionId)
      return null;
    if (typeof inner.candidate !== 'string' || !inner.candidate) return null;
    const sdpMid = typeof inner.sdpMid === 'string' ? inner.sdpMid : null;
    const sdpMLineIndex =
      typeof inner.sdpMLineIndex === 'number' &&
      Number.isInteger(inner.sdpMLineIndex) &&
      inner.sdpMLineIndex >= 0 &&
      inner.sdpMLineIndex <= 65535
        ? inner.sdpMLineIndex
        : null;
    return {
      type: 'ice-candidate',
      data: {
        sessionId: inner.sessionId,
        candidate: inner.candidate,
        sdpMid,
        sdpMLineIndex,
      },
    };
  }

  return null;
}
