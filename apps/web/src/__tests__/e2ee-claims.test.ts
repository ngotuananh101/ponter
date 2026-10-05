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
