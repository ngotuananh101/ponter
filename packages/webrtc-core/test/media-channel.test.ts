import { describe, expect, it, vi } from 'vitest';
import {
  configureReceiveMedia,
  subscribeRemoteTracks,
} from '../src/media-channel';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
  RTCPeerConnectionLike,
} from '../src/types';

/** Minimal seam object: only the members each test actually needs. */
function fakePeer(
  members: Partial<RTCPeerConnectionLike>,
): RTCPeerConnectionLike {
  return members as RTCPeerConnectionLike;
}

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

describe('configureReceiveMedia', () => {
  it('is a no-op when media.video is falsy', () => {
    const addTransceiver = vi.fn();
    configureReceiveMedia(fakePeer({ addTransceiver }), undefined);
    configureReceiveMedia(fakePeer({ addTransceiver }), {});
    configureReceiveMedia(fakePeer({ addTransceiver }), { video: false });
    expect(addTransceiver).not.toHaveBeenCalled();
  });

  it('adds exactly one recvonly video transceiver', () => {
    const addTransceiver = vi.fn();
    configureReceiveMedia(fakePeer({ addTransceiver }), { video: true });
    expect(addTransceiver).toHaveBeenCalledTimes(1);
    expect(addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'recvonly',
    });
  });

  it('throws a descriptive error when the adapter lacks addTransceiver', () => {
    expect(() => configureReceiveMedia(fakePeer({}), { video: true })).toThrow(
      /addTransceiver/,
    );
  });
});

describe('subscribeRemoteTracks', () => {
  it('forwards tracks to the handler and unsubscribes cleanly', () => {
    let fire!: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void;
    const peer = fakePeer({
      onTrack: (handler: typeof fire) => {
        fire = handler;
      },
    });

    const received: string[] = [];
    const unsubscribe = subscribeRemoteTracks(peer, (track) => {
      received.push(track.kind);
    });

    fire(fakeTrack, fakeStreams);
    expect(received).toEqual(['video']);

    unsubscribe();
    fire(fakeTrack, fakeStreams);
    expect(received).toEqual(['video']);
  });

  it('throws a descriptive error when the adapter lacks onTrack', () => {
    expect(() => subscribeRemoteTracks(fakePeer({}), () => {})).toThrow(
      /onTrack/,
    );
  });
});
