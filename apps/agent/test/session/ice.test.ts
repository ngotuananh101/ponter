import { describe, expect, it } from 'vitest';
import {
  isUnusableTurnTcp,
  mapIceServers,
  narrowMlineIndex,
  requiredH264PayloadType,
  selectH264PayloadType,
} from '../../src/session/ice.js';

describe('isUnusableTurnTcp', () => {
  it('matches only turn: URLs with transport=tcp', () => {
    expect(isUnusableTurnTcp('turn:turn.example.com:3478?transport=tcp')).toBe(
      true,
    );
    expect(isUnusableTurnTcp('turn:turn.example.com:3478?transport=udp')).toBe(
      false,
    );
    expect(isUnusableTurnTcp('turns:turn.example.com:5349?transport=tcp')).toBe(
      false,
    );
    expect(isUnusableTurnTcp('stun:stun.example.com:19302')).toBe(false);
  });
});

describe('mapIceServers', () => {
  it('maps a STUN-only entry with no credentials', () => {
    expect(mapIceServers([{ urls: ['stun:h:3478'] }], '')).toEqual([
      { urls: ['stun:h:3478'] },
    ]);
  });

  it('maps a TURN entry with its credential pair', () => {
    expect(
      mapIceServers(
        [
          {
            urls: ['turn:h:3478?transport=udp'],
            username: 'u',
            credential: 'c',
          },
        ],
        '',
      ),
    ).toEqual([
      { urls: ['turn:h:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
  });

  it('drops a TURN/TCP url and keeps the UDP sibling', () => {
    expect(
      mapIceServers(
        [
          {
            urls: ['turn:h:3478?transport=udp', 'turn:h:3478?transport=tcp'],
            username: 'u',
            credential: 'c',
          },
        ],
        '',
      ),
    ).toEqual([
      { urls: ['turn:h:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
  });

  it('drops an entry left with no usable urls', () => {
    expect(
      mapIceServers([{ urls: ['turn:h:3478?transport=tcp'] }], ''),
    ).toEqual([]);
  });

  it('keeps a Cloudflare-style turns url untouched', () => {
    const url = 'turns:turn.cloudflare.com:5349?transport=udp';
    expect(mapIceServers([{ urls: [url] }], '')).toEqual([{ urls: [url] }]);
  });

  it('defaults absent credentials to an empty string', () => {
    expect(mapIceServers([{ urls: ['turn:h'] }], '')).toEqual([
      { urls: ['turn:h'], username: '', credential: '' },
    ]);
  });

  it('falls back to the configured STUN url only when nothing was pushed', () => {
    expect(mapIceServers([], 'stun:fallback:3478')).toEqual([
      { urls: ['stun:fallback:3478'] },
    ]);
  });

  it('lets the pushed entries win over the configured STUN url', () => {
    expect(
      mapIceServers([{ urls: ['stun:pushed:3478'] }], 'stun:fallback:3478'),
    ).toEqual([{ urls: ['stun:pushed:3478'] }]);
  });
});

describe('selectH264PayloadType', () => {
  it('picks H.264 even when VP8 is offered first', () => {
    expect(
      selectH264PayloadType([
        { mimeType: 'video/VP8', payloadType: 96 },
        { mimeType: 'video/rtx', payloadType: 97 },
        { mimeType: 'video/H264', payloadType: 102 },
        { mimeType: 'video/H264', payloadType: 127 },
      ]),
    ).toBe(102);
  });

  it('matches the mime type case-insensitively', () => {
    expect(
      selectH264PayloadType([{ mimeType: 'video/h264', payloadType: 102 }]),
    ).toBe(102);
  });

  it('returns null when no H.264 was negotiated', () => {
    expect(
      selectH264PayloadType([{ mimeType: 'video/VP8', payloadType: 96 }]),
    ).toBeNull();
  });

  it('takes the first H.264 entry, not the lowest payload type', () => {
    expect(
      selectH264PayloadType([
        { mimeType: 'video/H264', payloadType: 127 },
        { mimeType: 'video/H264', payloadType: 102 },
      ]),
    ).toBe(127);
  });
});

describe('requiredH264PayloadType', () => {
  it('throws a named error instead of returning null', () => {
    expect(() =>
      requiredH264PayloadType([{ mimeType: 'video/VP8', payloadType: 96 }]),
    ).toThrow(/no negotiated H\.264 codec/);
  });
});

describe('narrowMlineIndex', () => {
  it('accepts 0 and 65535', () => {
    expect(narrowMlineIndex(0)).toBe(0);
    expect(narrowMlineIndex(65535)).toBe(65535);
  });

  it('rejects negatives and anything above u16', () => {
    expect(narrowMlineIndex(-1)).toBeNull();
    expect(narrowMlineIndex(65536)).toBeNull();
  });

  it('rejects a non-integer', () => {
    expect(narrowMlineIndex(1.5)).toBeNull();
    expect(narrowMlineIndex('0')).toBeNull();
  });
});
