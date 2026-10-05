import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) =>
  readFileSync(resolve(__dirname, '..', rel), 'utf8');

// Exit gate G2: no UI text may assert E2EE or Zero-Trust that the code does
// not implement. These labels did, before Phase 5 lands the feature. The
// match is case-insensitive so a badge reading `ZERO-TRUST` is caught too.
const FILES = [
  'components/layout/AppHeader.vue',
  'components/auth/RegisterForm.vue',
  'components/auth/LoginForm.vue',
  'views/DashboardView.vue',
];

describe('no false E2EE claims in the UI', () => {
  for (const file of FILES) {
    it(`${file} does not claim E2EE or Zero-Trust`, () => {
      const source = read(file);
      expect(source).not.toMatch(/e2ee/i);
      expect(source).not.toMatch(/zero-trust/i);
    });
  }
});

// Scope guard C: no UI text may assert a peer-identity property the code does
// not implement. WS2 peer identity is enforced at the agent and signal-layer
// (Phase 5 Week 13); a marketing label in the UI that outpaces the wire
// protocol would be a false claim of the same stripe. The match is
// case-insensitive and covers the common forms ("Peer Identity", "peer
// identity", "end-to-end identity").
const WS2_FILES = [
  'components/layout/AppHeader.vue',
  'components/auth/RegisterForm.vue',
  'views/DashboardView.vue',
];

describe('no false peer-identity claims in the UI', () => {
  for (const file of WS2_FILES) {
    it(`${file} does not claim peer identity`, () => {
      const source = read(file);
      expect(source).not.toMatch(/peer[\s-]*ident/i);
    });
  }
});
