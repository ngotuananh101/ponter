# SHA Remap Ledger — Issue #101

## Header

On 2026-10-10 the repository history was rewritten with `git filter-repo` to strip all `Co-authored-by:` trailers from commit messages. That rewrite changed every commit SHA whose message carried such a trailer (43 commits total), so many SHAs cited in `docs/**` before the rewrite are **no longer ancestors of `main`**. Issue #101 remaps the doc citations.

This work was performed on branch `docs/issue-101-sha-remap`, base `main @ 659f4e5`, in a dedicated worktree. The change is **docs-only** — no code, CI, generated UI, or tests were modified, and git history was not rewritten again.

Two token groups were resolved by the BA:

- **Group A (61 tokens):** each off-main SHA has a byte-identical twin (same `^{tree}` + same subject) already on `main`. Applied mechanically via literal token swap.
- **Group B (35 tokens):** pre-squash branch commits or pre-rewrite snapshots — no on-main twin. Ruling: `KEEP_LABEL` — keep the token, add an explicit "pre-rewrite" label, and add the PR's on-main squash anchor in the same sentence.

The four SHAs already on `main` (`3222c2f`, `4b2e84c`, `64a62c2`, `9f5d737`) were left untouched.

## Summary table

| Metric | Count |
|---|---|
| Group A — `SWAP` (mechanical twin swap) | 61 |
| Group B — `KEEP_LABEL` (kept + pre-rewrite label + squash anchor) | 35 |
| Group B — relabel-only (already cited with context, no SHA change needed) | 0 |
| Total tokens changed | 96 |
| Files changed in `docs/**` | 30 existing + 1 new (this ledger) |

Group B PR to on-main squash anchor map:

| PR | on-main squash anchor | Group B branch commits |
|----|----------------------|------------------------|
| #52 | `b23c846` | `998bc95` |
| #54 | `2963986` | `6e9c97f` |
| #55 | `bd310408` | `ce162f95`, `d315c667` |
| #56 | `a4dbffa` | `13fa265` |
| #57 | `3f38e2c` | `f96a472`, `463da71` |
| #58 | `418cdfb` | `50b37c4`, `b384736` |
| #59 | `9e20216` | `f7216ec`, `da016f1` |
| #60 | `0f28d51` | `b1d7868` |
| #61 | `248d931` | `b286f28`, `916e51e`, `8e75d41`, `7536b82`, `2d467cb` |
| #62 | `c3fc4ff` | `c4f17a9`, `6601650` |
| #64 | `cd51d33` | `7608cc5`, `f80caa9`, `d9349a3`, `e8afcde` |
| #67 | `34263bf` | `b0bf020`, `08176da`, `48ef477`, `bd182a5`, `1bada79` |
| #50 | `4fff206` | `4ddf993`, `943aae3`, `bfcedc26d08c86d884b4d6b2cab9adfb5ec650b2` |
| #27 | `82fa821` | `6ce398f`, `a2de973` |
| #40 | `e0e1137` | `d67e705`, `b32ef24` |

## Full ledger

Each row is one changed token. The source for Group A is `sha-map.tsv`; the source for Group B is `rulings.tsv`. The authoritative token-to-file(s) mapping is in `token-files.tsv`.

### Group A — SWAP (61 tokens)

| off-main token | on-main twin | file(s) | ruling |
|---|---|---|---|
| `0a86e7c` | `b87a1c6` | docs/ARCHITECTURE.md, docs/superpowers/specs/2026-10-09-fleet-push-websocket-design.md | SWAP |
| `11785bd` | `492fcec` | docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md | SWAP |
| `19bf0b1` | `639a642` | docs/superpowers/specs/2026-10-03-phase3-week9-demo.md | SWAP |
| `1c82218` | `cd51d33` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md, docs/superpowers/specs/2026-10-07-phase7-agent-desktop-app-design.md | SWAP |
| `1ebda79` | `c1aeb91` | docs/ARCHITECTURE.md, docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md | SWAP |
| `2256246` | `8a1c172` | docs/superpowers/specs/2026-10-01-phase3-week7-demo.md | SWAP |
| `264277f` | `a58625d` | docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md | SWAP |
| `26feeb4` | `2963986` | docs/ARCHITECTURE.md | SWAP |
| `2899b39` | `f8c2c97` | docs/superpowers/plans/2026-10-03-phase3-week8-stream-quality.md | SWAP |
| `2a7ebe6` | `028501b` | docs/ARCHITECTURE.md | SWAP |
| `2de7a23` | `5ef6bd5` | docs/security/2026-10-06-ws3-session-hardening.md, docs/superpowers/plans/2026-10-06-phase5-week14-ws3-agent-session-hardening.md, docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md | SWAP |
| `2e1fd5c` | `9e20216` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `2f608e7` | `ed8ac54` | docs/ARCHITECTURE.md, docs/superpowers/specs/2026-10-08-phase8c-desktop-config-design.md | SWAP |
| `3a5762a` | `fff5d3b` | docs/ARCHITECTURE.md | SWAP |
| `3db3bd5` | `9afaead` | docs/superpowers/plans/2026-10-03-phase3-week9-input-forwarding.md | SWAP |
| `3f75487` | `a4dbffa` | docs/ARCHITECTURE.md | SWAP |
| `430b749` | `e754bff` | docs/ARCHITECTURE.md, docs/security/2026-10-01-e2ee-zero-trust-audit.md | SWAP |
| `4526910` | `44fddb5` | docs/ARCHITECTURE.md | SWAP |
| `46eaaf6` | `097e115` | docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md | SWAP |
| `478f2ab` | `32c3248` | docs/superpowers/specs/2026-10-01-phase3-week7-demo.md | SWAP |
| `48edac1` | `c624897` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md, docs/superpowers/specs/2026-10-07-phase6b-low-latency-design.md | SWAP |
| `53846de` | `3f38e2c` | docs/ARCHITECTURE.md | SWAP |
| `591a53e` | `34263bf` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md, docs/superpowers/specs/2026-10-07-phase7-agent-desktop-app-design.md | SWAP |
| `5b8ed86` | `b4d9c00` | docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md, docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md | SWAP |
| `64e4066` | `64b5171` | docs/security/2026-10-01-e2ee-zero-trust-audit.md, docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md | SWAP |
| `6a568c0` | `00048bc` | docs/ARCHITECTURE.md, docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md, docs/superpowers/specs/2026-10-08-phase8c-desktop-config-design.md | SWAP |
| `6fee3e4` | `d6e94c7` | docs/ARCHITECTURE.md | SWAP |
| `70370ed` | `4bd4f6d` | docs/ARCHITECTURE.md | SWAP |
| `85ef040` | `418cdfb` | docs/ARCHITECTURE.md | SWAP |
| `8e957e2` | `e0e1137` | docs/superpowers/specs/2026-10-05-phase4-week11-file-transfer-design.md | SWAP |
| `98c3630` | `a2ef519` | docs/ARCHITECTURE.md | SWAP |
| `98d37ad` | `d9fdc02` | docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md | SWAP |
| `99c6c558` | `bd0cd738` | docs/ARCHITECTURE.md | SWAP (8-char) |
| `9ba5613` | `f04d1c4` | docs/superpowers/plans/2026-09-25-phase2-week4-webrtc-core.md, docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md | SWAP |
| `9eab552` | `204612e` | docs/security/2026-10-01-e2ee-zero-trust-audit.md | SWAP |
| `9f1efba` | `b23c846` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `a358622` | `0f28d51` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `a5dcc63` | `c3fc4ff` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `a9066ae` | `c53cd6f` | docs/superpowers/specs/2026-10-08-phase8-selfbuild-and-turn-design.md | SWAP |
| `ae5d251` | `4fff206` | docs/ARCHITECTURE.md | SWAP |
| `b15edad` | `faa67ae` | docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md | SWAP |
| `b1e5982` | `d3f504e` | docs/superpowers/plans/2026-10-01-phase3-week7-desktop-streaming.md | SWAP |
| `b2bf167` | `45b8d55` | docs/superpowers/plans/2026-10-03-phase3-week9-input-forwarding.md | SWAP |
| `b3d1ce3` | `9353aaf` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `bdcd2ca` | `f7b749f` | docs/superpowers/plans/2026-09-26-phase2-week5-terminal-agent.md | SWAP |
| `be8a8c9` | `82fa821` | docs/superpowers/plans/2026-10-03-phase3-week8-stream-quality.md, docs/superpowers/plans/2026-10-03-phase3-week9-input-forwarding.md, docs/superpowers/specs/2026-10-03-phase3-week9-input-forwarding-design.md | SWAP |
| `c51b80f` | `aabe8c5` | docs/ARCHITECTURE.md | SWAP |
| `c64e8fd` | `4529136` | docs/ARCHITECTURE.md | SWAP |
| `c810293` | `f6508d7` | docs/superpowers/specs/2026-10-07-phase7-agent-desktop-app-design.md | SWAP |
| `cbbfc5b` | `572854d` | docs/ARCHITECTURE.md | SWAP |
| `d6b9155` | `9caefac` | docs/ARCHITECTURE.md | SWAP |
| `d976b61` | `c05ef08` | docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md | SWAP |
| `db71f65` | `db7f165` | docs/superpowers/plans/2026-10-07-phase6a-interactive-desktop.md, docs/superpowers/specs/2026-10-06-phase6a-interactive-desktop-design.md | SWAP |
| `db82a11` | `7d17652` | docs/superpowers/specs/2026-10-01-phase3-week7-demo.md | SWAP |
| `dbe5240` | `519747f` | docs/superpowers/plans/2026-10-04-phase4-week10-file-transfer.md | SWAP |
| `e607e13` | `248d931` | docs/ARCHITECTURE.md, docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | SWAP |
| `e830d28` | `bd31040` | docs/ARCHITECTURE.md | SWAP |
| `ec09b66` | `ec2acdc` | docs/ARCHITECTURE.md | SWAP |
| `f7add22` | `6f7b00a` | docs/ARCHITECTURE.md | SWAP |
| `f9ba7fe` | `770b40f` | docs/ARCHITECTURE.md | SWAP |
| `fdead292` | `680cccc0` | docs/security/2026-10-06-ws3-session-hardening.md, docs/superpowers/plans/2026-10-06-phase5-week14-ws3-agent-session-hardening.md, docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md | SWAP (8-char) |

### Group B — KEEP_LABEL (35 tokens)

All kept in place with a "pre-rewrite" label and the PR's on-main squash anchor added in the citation sentence.

| off-main token | on-main squash anchor | PR | file(s) | ruling |
|---|---|---|---|---|
| `998bc95` | `b23c846` | #52 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `13fa265` | `a4dbffa` | #56 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `6e9c97f` | `2963986` | #54 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `ce162f95` | `bd310408` | #55 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL (8-char) |
| `d315c667` | `bd310408` | #55 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL (8-char) |
| `f96a472` | `3f38e2c` | #57 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `463da71` | `3f38e2c` | #57 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `50b37c4` | `418cdfb` | #58 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `b384736` | `418cdfb` | #58 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `f7216ec` | `9e20216` | #59 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `da016f1` | `9e20216` | #59 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `b1d7868` | `0f28d51` | #60 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `c4f17a9` | `c3fc4ff` | #62 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `6601650` | `c3fc4ff` | #62 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `b286f28` | `248d931` | #61 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `916e51e` | `248d931` | #61 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `8e75d41` | `248d931` | #61 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `7536b82` | `248d931` | #61 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `2d467cb` | `248d931` | #61 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `7608cc5` | `cd51d33` | #64 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `f80caa9` | `cd51d33` | #64 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `d9349a3` | `cd51d33` | #64 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `e8afcde` | `cd51d33` | #64 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `b0bf020` | `34263bf` | #67 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `08176da` | `34263bf` | #67 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `48ef477` | `34263bf` | #67 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `bd182a5` | `34263bf` | #67 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `1bada79` | `34263bf` | #67 | docs/superpowers/plans/2026-10-07-phase7-agent-desktop-app.md | KEEP_LABEL |
| `943aae3` | `4fff206` | #50 | docs/superpowers/plans/2026-10-07-phase6b-low-latency.md | KEEP_LABEL |
| `4ddf993` | `4fff206` | #50 | docs/superpowers/plans/2026-10-07-phase6b-low-latency.md | KEEP_LABEL |
| `bfcedc26d08c86d884b4d6b2cab9adfb5ec650b2` | `4fff206` | #50 | docs/spikes/2026-10-07-p1-playwright-smoke.md | KEEP_LABEL (40-char) |
| `6ce398f` | `82fa821` | #27 | docs/superpowers/specs/2026-10-03-phase3-week8-demo.md | KEEP_LABEL |
| `a2de973` | `82fa821` | #27 | docs/superpowers/specs/2026-10-03-phase3-week8-demo.md | KEEP_LABEL |
| `d67e705` | `e0e1137` | #40 | docs/superpowers/specs/2026-10-04-phase4-week10-demo.md | KEEP_LABEL |
| `b32ef24` | `e0e1137` | #40 | docs/superpowers/specs/2026-10-04-phase4-week10-demo.md | KEEP_LABEL |

## Ruling rationale

Group B tokens are pre-squash branch commits or pre-rewrite snapshot SHAs — they are **not** ancestors of `main` and have **no** byte-identical twin on `main`. A branch may contain many commits that collapse into a single squash merge, so replacing one branch SHA with its PR's squash SHA would falsely assert a 1:1 identity that does not hold (the branch commit is not the squash; the two differ in tree, scope, and parentage except at the twin boundary). Silently swapping would erase the document's own branch-vs-squash distinction and mislead future readers. The correct treatment is to **keep** the branch SHA as the historical record, **label** it explicitly as "pre-rewrite" so it is never mistaken for an on-main reference, and **anchor** it to the PR's on-main squash so the reader can locate the shipped state. Every Group B token remaining in `docs/**` now appears within a "pre-rewrite"-labeled context with its squash anchor.

## Invariant note

After this change, every SHA cited in `docs/**` is either:

1. An ancestor of `main` (a Group A token swapped to its on-main twin, or one of the 4 already-on-main SHAs `3222c2f` / `4b2e84c` / `64a62c2` / `9f5d737`), **or**
2. Explicitly labeled "pre-rewrite" with its PR squash anchor (a Group B token kept in place), **or**
3. Covered by a doc-level note that asserts the document's SHAs are all pre-rewrite snapshots not on `main` (e.g. `docs/superpowers/specs/2026-10-04-phase4-week10-demo.md`, where `b32ef24` appears in a doc-level note).

This is the post-remap citation invariant for Issue #101.
