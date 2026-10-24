/**
 * The signalling types are `@ponter/shared`'s. This module re-exports them and
 * adds only the payload shapes that exist solely on the agent side (the pushed
 * ICE configuration and the WS2 identity challenge).
 *
 * The Rust tree hand-mirrored these types in `signal.rs` and then pinned the
 * mirror with round-trip tests. A same-language import is strictly better: a
 * drift is a type error rather than a test failure.
 */
export type {
  IceCandidateSignal,
  IceServerConfig,
  IdentityProof,
  SignalAnswer,
  SignalMessage,
  SignalOffer,
} from '@ponter/shared';

export interface IceChallengePayload {
  /** The nonce the agent must sign and echo. */
  nonce: string;
}

/**
 * One ICE server as the server pushes it. `urls` is a list because a TURN entry
 * is advertised as two URLs (UDP and TCP) under one credential pair.
 */
export interface IceServerEntry {
  urls: string[];
  username?: string | null;
  credential?: string | null;
}
