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
