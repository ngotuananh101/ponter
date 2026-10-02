import type {
  MediaStreamLike,
  MediaStreamTrackLike,
} from '@ponter/webrtc-core';

/** The first remote video track and whatever streams it belongs to. */
export interface DesktopStream {
  track: MediaStreamTrackLike;
  /** Possibly empty: werift's onTrack path carries no streams array. */
  streams: MediaStreamLike[];
}

export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
}
