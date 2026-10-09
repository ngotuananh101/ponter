# Task 1 — Fix Round 2 (Test-Only: Sonar dedup + QA F1)

Branch: `feat/fleet-push-web` (on top of `b155839`).
Scope this round: **TEST-ONLY.** Production files (`fleet-socket.ts`, `fleet.ts`, `transport.ts`) untouched except the mutation proof temp-edit to `fleet.ts`, which was reverted — `git diff` is empty.

## Status: PASS

All verification gates green.

### Deliverable A — shared `FakeWebSocket` test helper (Sonar dedup)

Created `packages/webrtc-core/test/fake-websocket.ts` exporting the SUPERSET of helpers both test files need:
`FakeWebSocket` (with the fleet-only `deliverRaw` added on top of the ws-transport class),
`ORIGINAL_WEBSOCKET`, `installFakeWebSocket`, `restoreWebSocket`, `lastSocket`, `mockRandomUnit` (imports `vi` from `vitest`).

- A2. `packages/webrtc-core/package.json` — added exactly one `exports` subpath: `"./test/fake-websocket": "./test/fake-websocket.ts"` (existing entries untouched, not reordered).
- A3. `packages/webrtc-core/test/ws-transport.test.ts` — removed the local `FakeWebSocket` / `ORIGINAL_WEBSOCKET` / `installFakeWebSocket` / `lastSocket` / `mockRandomUnit` definitions; imports them from `./fake-websocket`. Kept `okTicketFetch` local. `afterEach` still references `ORIGINAL_WEBSOCKET` (now imported) — unchanged behavior.
- A4. `apps/web/src/stores/fleet.test.ts` — removed the local duplicate block; imports from `@ponter/webrtc-core/test/fake-websocket`. Kept local `okTicketFetch` + `vi.mock(...)` blocks.

### Deliverable B — QA F1 (vacuous flag-gate test, now mutation-proof)

`fleet.test.ts`'s first case previously reused one Pinia instance, so `store2.start()` early-returned at `if (client) return;` (fleet.ts:32) and never reached the `VITE_BROWSER_WS_SIGNALING` gate — removing the gate would still leave the test green.

Fix applied (within the single `it()` per PM): `store.stop()` the first store, then `setActivePinia(createPinia())` before constructing `store2`, so `store2.start()` reaches the flag guard. Both assertions kept (`length 1` for `'true'`, `length 0` for `'false'`).

**Mutation proof (RED):** temporarily deleted the gate line
`if (import.meta.env.VITE_BROWSER_WS_SIGNALING !== 'true') return;` in `apps/web/src/stores/fleet.ts`:
```
 FAIL  src/stores/fleet.test.ts > useFleetStore > opens a socket when the flag is "true" and opens none when "false"
AssertionError: expected [ FakeWebSocket{ …(8) } ] to have a length of +0 but got 1
```
Gate restored → GREEN. `fleet.ts` byte-identical to `b155839` (`git diff` empty).

## Commit

```
test(fleet): dedup FakeWebSocket into webrtc-core + fix F1 vacuous flag-gate

Extract the shared FakeWebSocket test helper to packages/webrtc-core/test/fake-websocket.ts
(exposed via the new ./test/fake-websocket exports subpath) and import it from
ws-transport.test.ts and fleet.test.ts. This removes the 62-line Sonar duplicate block.

QA F1: give store2 a fresh Pinia in the flag-gate test so start() reaches the
VITE_BROWSER_WS_SIGNALING guard instead of early-returning at `if (client) return`,
making the gate observable. Mutation proof: deleting the gate line turns the test RED,
restoring it is GREEN.
```

## Test results (both packages)

`pnpm --filter @ponter/webrtc-core test`:
```
Test Files  12 passed (12)
   Tests  94 passed (94)
```

`pnpm --filter @ponter/web test`:
```
Test Files  40 passed (40)
   Tests  313 passed (313)
```

## it() / expect() counts (unchanged — TEST-INTEGRITY)

| File / Scope          | it() before → after | expect() before → after |
|-----------------------|---------------------|--------------------------|
| `packages/webrtc-core/test/ws-transport.test.ts` | 29 → 29 | 70 → 70 |
| `apps/web/**` (whole suite) | 307 → 307 | 709 → 709 |

No assertion added, removed, or weakened. Definitions were only moved out; the flag test's setup was fixed without touching its assertions.

## Non-test changes

- `packages/webrtc-core/package.json`: one new `exports` subpath (A2). The only non-test file touched.

## Concerns

- None blocking. The `@ponter/webrtc-core/test/fake-websocket` import resolves at runtime via vitest (workspace alias) and type-checks via the added `exports` subpath; both `pnpm --filter @ponter/webrtc-core typecheck` and `pnpm --filter @ponter/web typecheck` are clean, and `pnpm format:check` passes.
