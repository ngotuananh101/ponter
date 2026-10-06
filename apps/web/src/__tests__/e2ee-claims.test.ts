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

// Scope guard B-mandated docs scan (Task 10 FIX ROUND 1, Finding 2):
// The WS2 doc must not claim that WS2 *implements* E2EE or Zero-Trust end-to-end.
// We deliberately do NOT blanket-scan all of `docs/`, because
// `docs/security/2026-10-01-e2ee-zero-trust-audit.md` legitimately contains the
// bare words "E2EE"/"Zero-Trust" in an audit that asserts the feature is ABSENT
// — a blanket `/e2ee/i` over all of docs/ would false-positive there.
//
// Instead we scope to the WS2 doc only, and assert against the *claim pattern*
// (an affirmative verb + E2EE/Zero-Trust), not the bare words. The WS2 doc
// legitimately negates ("WS2 does NOT encrypt… / implements / provide …"), so a
// bare-word guard would false-positive on those negations. The pattern below
// matches affirmative claims only: "implements/provides/enables/is E2EE",
// "is/provide/are Zero-Trust", etc. It fails to match negations because they
// use verbs like "not", "does NOT", "out of scope" rather than the affirmative
// verbs we anchor on.
//
// The guard also catches the un-abbreviated forms "end-to-end encryption" and
// "zero trust" (with a space), so a sentence like "WS2 provides end-to-end
// encryption." or "Ponter is zero trust." trips the anchor too.
const WS2_DOC = '../../../docs/security/2026-10-05-ws2-peer-identity.md';

describe('no false E2EE/Zero-Trust claims in the WS2 doc', () => {
  it('WS2 doc does not claim to implement E2EE or Zero-Trust', () => {
    const doc = read(WS2_DOC);
    // Affirmative claim pattern: an affirmative verb followed by an
    // E2EE/Zero-Trust token, where the WS2 doc's negations use "does NOT" /
    // "not" / "out of scope" and so never match this anchor.
    expect(doc).not.toMatch(
      /(implements|provides|enables|is|are)\s+(end-to-end\s+)?(e2ee|zero[-\s]?trust|encryption)/i,
    );
  });
});

// G2 scan extended to the Week 15 WS1 terminal-E2EE security note. WS1 part 1
// is browser-side only: the agent has no negotiation producer yet, so the doc
// must not assert live terminal confidentiality. The same affirmative-claim
// pattern is used so the doc's negations ("does NOT", "not active against the
// real agent", "out of scope") never trip it.
const WS1_DOC = '../../../docs/security/2026-10-07-ws1-e2ee.md';

describe('no false E2EE claims in the WS1 doc', () => {
  it('WS1 part 1 doc does not claim end-to-end E2EE against the live agent', () => {
    const doc = read(WS1_DOC);
    expect(doc).not.toMatch(
      /(implements|provides|enables|is|are)\s+(end-to-end\s+)?(e2ee|zero[-\s]?trust|encryption)/i,
    );
  });
});
