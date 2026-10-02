import type {
  MediaStreamLike,
  MediaStreamTrackLike,
  RTCPeerConnectionLike,
} from './types';

/**
 * Add the receive-only transceivers the offer must contain.
 *
 * Must be called BEFORE `createOffer()`: a transceiver added after the offer is
 * created does not appear in its SDP, so the remote never sends the media.
 *
 * A no-op when `media?.video` is falsy — every terminal call site passes no
 * media and must behave exactly as before.
 */
export function configureReceiveMedia(
  peer: RTCPeerConnectionLike,
  media: { video?: boolean } | undefined,
): void {
  if (!media?.video) return;

  if (!peer.addTransceiver) {
    throw new Error(
      'media.video was requested but this RTCPeerConnectionLike adapter does not implement addTransceiver — the offer would contain no video m-line',
    );
  }

  peer.addTransceiver('video', { direction: 'recvonly' });
}

/**
 * Forward remote tracks to `handler`. Returns an unsubscribe function.
 *
 * Throws when the adapter lacks `onTrack`: an adapter that cannot deliver
 * tracks would produce a stream that silently never arrives, which is worse
 * than a loud error at setup time.
 *
 * The seam has no removal API (matching `onIceCandidate`/`onDataChannel`), so
 * the unsubscriber is a local gate rather than a deregistration: the handler
 * checks a mutable `active` flag, so late tracks stop being delivered here even
 * though the adapter keeps the wrapper registered for the connection's lifetime.
 */
export function subscribeRemoteTracks(
  peer: RTCPeerConnectionLike,
  handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
): () => void {
  if (!peer.onTrack) {
    throw new Error(
      'this RTCPeerConnectionLike adapter does not implement onTrack — remote tracks could never be delivered',
    );
  }

  let active = true;
  peer.onTrack((track, streams) => {
    if (active) handler(track, streams);
  });

  return () => {
    active = false;
  };
}
