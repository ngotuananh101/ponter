import { describe, expect, it } from 'vitest';
import { STREAM_PROFILES, streamProfileById } from '../src/types/stream-profile';

describe('the shared stream-profile table', () => {
  it('carries the four shipped presets', () => {
    expect(STREAM_PROFILES.map((p) => p.id)).toEqual(['1080p30', '720p30', '1080p60', '720p60']);
  });

  it('gives each preset the profile-level-id openh264 actually emits for it', () => {
    // Recomputed from openh264's g_ksLevelLimits table (spec §3.3):
    // 1080p30 -> 4.0, 720p30 -> 3.1, 1080p60 -> 4.2, 720p60 -> 3.2.
    expect(streamProfileById('1080p30').profileLevelId).toBe('42c028');
    expect(streamProfileById('720p30').profileLevelId).toBe('42c01f');
    expect(streamProfileById('1080p60').profileLevelId).toBe('42c02a');
    expect(streamProfileById('720p60').profileLevelId).toBe('42c020');
  });

  it('throws on an unknown id rather than returning a default', () => {
    expect(() => streamProfileById('nope')).toThrow();
  });
});
