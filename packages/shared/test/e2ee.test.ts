import { describe, it, expect } from 'vitest';
import {
  canonicalKeyBinding,
  WS1_KEY_VERSION,
  WS1_TERMINAL_INFO,
} from '../src/index';

describe('WS1 key-binding canonicalization', () => {
  it('is domain-separated and version-tagged', () => {
    const msg = canonicalKeyBinding('AAAABBBB');
    expect(msg).toBe(`${WS1_KEY_VERSION}\necdhPublicKey=AAAABBBB`);
  });

  it('changes when the key changes (no field is optional)', () => {
    expect(canonicalKeyBinding('K1')).not.toBe(canonicalKeyBinding('K2'));
  });

  it('pins the terminal purpose string', () => {
    expect(WS1_TERMINAL_INFO).toBe('ponter-ws1-terminal-v1');
  });
});
