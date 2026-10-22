# Plan 1 audit — counts, citations and "covers N things" claims

**Auditor:** BA role session
**Date:** 2026-10-21
**Subject:** `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-spike-foundation-addon.md` (2517 lines)
**Authoritative tree state:** `HEAD = 453a779`, branch `feat/agent-node-ts-rewrite`, plus an uncommitted in-progress Task 1 (`M apps/agent/package.json`, `M packages/webrtc-core/package.json`, `M pnpm-lock.yaml`, `?? apps/agent/spike/`, `?? apps/agent/tsconfig.json`, `?? apps/agent/vitest.config.ts`, `?? packages/webrtc-core/test/synthetic-offer.ts`). Nothing outside those paths was touched by this audit.

**Scope:** the three questions PM named — (a) does Task 4's surface match Task 2's and Task 3's produced interfaces by name and type? (b) does any task reference a symbol no task defines? (c) does `setBitrate` appear everywhere it is now needed? — plus the same defect class as the B19 catch: a count, a citation, or a "this covers N things" statement that is not what the tree contains.

**Result:** **30 confirmed, 21 refuted.** Finding **C19** is a **self-correction** — a finding I had recorded before compaction that re-measurement refuted; it is listed with the confirmed findings and marked REFUTED rather than silently dropped, so the count is honest in both directions.

This document does not edit the plan. Every finding carries a proposed replacement so PM can apply it directly.

---

## Part 1 — the three named questions (answers first)

### (c) `setBitrate` — CONFIRMED PRESENT everywhere it is needed

| Location | Plan line | What it says | Verdict |
|---|---|---|---|
| `NativeAddon` interface | 1417 | `setBitrate(handle: number, bps: number): Promise<void>;` | present |
| Smoke test — raise | 1492 | `await expect(addon.setBitrate(handle, 6_000_000)).resolves.toBeUndefined();` | present |
| Smoke test — lower | 1494 | `await expect(addon.setBitrate(handle, 1_000_000)).resolves.toBeUndefined();` | present |
| Smoke test — unknown handle | 1509–1510 | rejects | present |
| `encoder.cc` requirements | 1938–1950 | the two-call order, `current` tracking, `cmInitExpected` note | present |
| C++ order test | 2213–2216 (Step 12) | raise = exactly two calls in order; lower = exactly one | present |
| Completion criterion 4 | 2501 | names the surface and both tests | present |

The **only** place where `setBitrate` is still described as missing is the coverage matrix's §4.1, which is stale — see **C10**.

### (a) Task 4's surface vs Task 2's and Task 3's produced interfaces — CONFIRMED SYMBOL-COMPATIBLE, but the seam is asserted only in prose

- Task 3 produces `H264RtpPacket.bytes: Buffer` (L897).
- Task 2's `writeRtp(packet: Uint8Array)` (L526) accepts a `Buffer` — `Buffer extends Uint8Array`, so it is assignable.
- Task 4 emits `EncodedFrame.annexB: Buffer` (L1310), which is exactly what `packetizeAnnexB(annexB: Buffer, …)` (L956) consumes.

**No type conflict.** But **no task wires the two together, and no test spans the seam** — Task 2's tests never call `packetizeAnnexB`, and Task 3's tests never call `writeRtp`. The chain "addon → Annex-B → packetizer → `writeRtp`" is asserted only by prose at L805 ("the packetizer stamps its own PT for readability, but the authoritative PT is the one the sender carries"). See **C30**.

### (b) Symbols no task defines — CONFIRMED, **five symbols** that appear in the plan's own code but are defined nowhere

| Symbol | First use | Occurrences | Defined? |
|---|---|---|---|
| `WeriftMediaStreamTrack` | 700 | 1 | **No** — werift 0.24.4 exports `MediaStreamTrack` only (`lib/webrtc/src/media/track.d.ts:6`); `grep -rn WeriftMediaStreamTrack …/werift/lib/` returns nothing |
| `this.createWeriftTrack` | 721 | 1 | **No** |
| `this.createWeriftStream` | 722 | 1 | **No** |
| `this.senders` | 796 | 1 | **No** — no field declaration, no initializer |
| `getSenders()` | 549 (declare) → 584, 596, 612, 628, 649, 670, 846 (7 call sites) | 8 | **Declared, never implemented** |
| `getOutboundTrackCodec` | 855 (test), 861 (prose "a small, honest seam") | 2 | **No signature, no body, not in any Files block** |
| `this.peer` | 731, 735, 803 | 3 | **No** — `WeriftAdapter`'s field is `private readonly pc: WeriftPC` (`packages/webrtc-core/src/adapters/werift.ts:74`) |

---

## Part 2 — CONFIRMED findings

Severity is my own ranking: **S1** = a step cannot execute as written / an implementer will ship a silent defect; **S2** = a claim the tree contradicts; **S3** = cosmetic or hygiene.

### S1 — a step cannot run, or the plan's own code does not compile

**C1. `localCodecs` narrows its parameter below its own call site.** `apps/agent/spike/negotiation.ts:340` declares `function localCodecs(run: 'r-s1-list' | 'vp8-first-local')`, but `:362` calls `localCodecs(run)` where `run` is `'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer'`. That is a TS2345 in the exact file Task 1 Step 3 tells the implementer to write.
**Fix:** L340 → `function localCodecs(run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer')`. The body is already correct (`mode-0-first-offer` falls into the `useH264()`-only branch).

**C2. `new WeriftMediaStreamTrack({ kind })` — no such class.** L700. Construction will throw `ReferenceError` at runtime and fail typecheck.
**Fix:** L700 → `const track = new MediaStreamTrack({ kind });` and add `MediaStreamTrack` to the `werift` import in the adapter. (Task 1's Interfaces block at L109 already writes `MediaStreamTrack` — the name is right there; only Task 2's implementation drifts.)

**C3. `createOutboundTrack` returns two `undefined`s.** L699–705 returns `{ kind, id: track.id, ssrc: track.ssrc }`. A freshly constructed werift `MediaStreamTrack` sets both to `void 0` (`media/track.js` constructor). `id` is assigned later by `registerTrack` (`media/rtpSender.js:429 — track.id = this.trackId`), and **`ssrc` is never assigned to the track at all** (`grep -rn 'track\.ssrc' …/werift/lib/webrtc/src/` returns only a log line). So `track.id` at Step 5's assertion is `undefined`.
**Consequence:** Step 5's `adapter.getOutboundTrackCodec(track.id!)` (L855) keys on `undefined` — and the `!` is a lie that hides it.
**Fix:** either (a) `createOutboundTrack` mints its own id and hands it back — `const id = crypto.randomUUID(); const track = new MediaStreamTrack({ kind, id }); return { kind, id, ssrc: 0 };` — or (b) Step 5 keys the accessor on the track object rather than on an id. I recommend (b): `getOutboundTrackCodec(track: MediaStreamTrackLike)`. Rewrite L855 as `expect(adapter.getOutboundTrackCodec(track)?.payloadType).toBe(PT_H264_MODE1);` and L861 accordingly.

**C4. Five undefined symbols in Task 2's implementation.** L721 (`this.createWeriftTrack`), L722 (`this.createWeriftStream`), L796 (`this.senders`), L549/7 call sites (`getSenders`), L855/861 (`getOutboundTrackCodec`). Task 2 Step 3 says "add the sender surface" and then shows only the two methods — the helper methods, the `senders` field, the `getSenders` implementation and the `getOutboundTrackCodec` accessor are all implied but never written. An implementer following the plan literally gets a file that does not compile.

> **Superseded for `getSenders` (added 2026-10-21).** This finding stands as a record of the plan at audit time. Plan 2's Task 2 now writes the `RTCRtpSenderLike` seam and the sender surface itself, so the `getSenders` half of C4 is answered there rather than by an edit to Plan 1. The other four symbols remain Plan 1's.

**Fix:** add a short block to Step 3 before the shown code:

```ts
  private readonly senders: RTCRtpSenderLike[] = [];
  private readonly weriftTracks = new Map<string, WeriftTrack>();

  private createWeriftTrack(track: MediaStreamTrackLike): WeriftTrack {
    const weriftTrack = new WeriftTrack({ kind: track.kind as 'audio' | 'video' });
    this.weriftTracks.set(track.id, weriftTrack);
    return weriftTrack;
  }

  private createWeriftStream(track: MediaStreamTrackLike): WeriftStream {
    return new WeriftStream([this.weriftTracks.get(track.id)!]);
  }

  getSenders(): RTCRtpSenderLike[] {
    return [...this.senders];
  }

  getOutboundTrackCodec(track: MediaStreamTrackLike) {
    return this.weriftTracks.get(track.id)?.codec;
  }
```

(and key `weriftTracks` on the id `createOutboundTrack` actually mints, per C3).

**C5. `this.peer` is not the adapter's field.** L731, L735, L803. `WeriftAdapter` holds `private readonly pc: WeriftPC` (`packages/webrtc-core/src/adapters/werift.ts:74`), and there is no `peer` alias anywhere in the file.
**Fix:** L731 → `const weriftSender = this.pc.addTrack(`, L735 → `const transceiver = this.pc`, L803 → "…`this.pc.getTransceivers().find((t) => t.sender === weriftSender)`".

**C6. Task 1 Step 2 runs a package that no step has created yet.** L319 runs `pnpm --filter @ponter/agent-node exec vitest run spike/spike.test.ts`, but the rename of `apps/agent/package.json` to `@ponter/agent-node` happens in no step — it is only *committed* at Step 7 (L474). `apps/agent/package.json` exists at HEAD as `@ponter/agent` with `cargo` scripts. So the very first command in the plan fails with "No projects matched the filter".
**Fix:** add a step **before Step 1**: "Write `apps/agent/package.json` and `apps/agent/tsconfig.json`", with the full contents (`name: "@ponter/agent-node"`, `type: "module"`, `devDependencies: { vitest, playwright, @ponter/webrtc-core: workspace:* }`, `scripts: { test, typecheck }`) and the `tsconfig` `include: ["src/**/*.ts", "test/**/*.ts", "spike/**/*.ts"]` that L84/L89 already mandate.

**C7. Task 1's commit leaves two of its own edits unstaged.** L474: `git add apps/agent/spike apps/agent/package.json apps/agent/tsconfig.json pnpm-workspace.yaml`. Task 1 modifies **`packages/webrtc-core/package.json`** (L103, the `exports` entry for `synthetic-offer`) and creates **`packages/webrtc-core/test/synthetic-offer.ts`** — neither is staged. Task 2 and Task 3 both import `@ponter/webrtc-core/test/synthetic-offer`, so the committed state at Task 1's tip cannot resolve that specifier. Task 1 also stages `pnpm-workspace.yaml`, which Task 1 does not modify (Task 4 does).
**Fix:** L474 → `git add apps/agent packages/webrtc-core`.

**C8. Task 5 Step 7's expected outcome is inverted, which makes the gate pass vacuously.** L2442 says the first test "FAILS (`apps/agent/src` does not exist yet — `apps/agent` is still the Rust crate, whose source is `.rs`)". Measured: `apps/agent/src` **does exist** — it holds 20 `.rs` files and **0 `.ts` files**. So `expect(() => statSync(AGENT_SRC)).not.toThrow()` **passes**, `walk()` returns `[]`, the three offender lists are `[]`, and **all four tests are green**. That is precisely the outcome L2409–2411 says the test exists to prevent.
**Fix:** change the guard to assert on content, not existence:

```ts
  it('the agent source tree has TypeScript in it — this gate must never pass vacuously', () => {
    expect(walk(AGENT_SRC).length).toBeGreaterThan(0);
  });
```

and rewrite L2442–2446 to: "Expected: the **first** test FAILS (`apps/agent/src` holds 20 `.rs` files and no `.ts` files today), which is the honest state — the gate is written but not yet exercised."

**C9. Adding `id` and `ssrc` to `MediaStreamTrackLike` breaks three literals in two packages, and no task owns the fix.** L530 says the interface "must also grow `id` and `ssrc`" — and L61 confirms they become part of the type. Three existing literals use `{ kind: 'video' }` and are inside typecheck scope (`tsconfig` `include: ["src/**/*.ts", "test/**/*.ts"]`):
- `packages/webrtc-core/test/media-channel.test.ts:19`
- `packages/desktop-core/test/client.test.ts:20`
- `packages/desktop-core/test/client.test.ts:187`

Neither package's tests appear in Task 2's Files block, and Task 2's Step 4 ("no existing test changes status") will *not* catch a typecheck failure — it runs `vitest`, not `tsc`.
**Fix:** make the two new fields **optional** on the interface (`readonly id?: string; readonly ssrc?: number;`) — nothing in Task 2 needs them to be required once C3 is fixed by keying on the object — **or** add `packages/webrtc-core/test/media-channel.test.ts` and `packages/desktop-core/test/client.test.ts` to Task 2's Files block with the three literal updates, and add `pnpm --filter @ponter/desktop-core typecheck` to Step 4.

**C10. The coverage matrix still declares B19 a Gap.** `…plan-1-coverage-matrix.md:145` still reads "**None in Plan 1** — see §4 | None | **Gap — see §4.1**", and §4.1 (lines 238–269) still argues "There is **no `applyBitrate`**". PM fixed this in the plan at `85b6974`; the matrix predates the fix and now contradicts the plan it grades.
**Fix (matrix):** B19 row → `Plan 1, Task 4 | \`apps/agent/test/native/smoke.test.ts\` (retarget on a live handle) + \`apps/agent/native/test/\` (the two-call order) | Covered`; replace §4.1 with a one-paragraph "closed by `85b6974`" note recording that the gap was found here and fixed in the plan.

### S2 — a claim the tree contradicts

**C11. `node-addon-api` version contradicts itself inside the plan.** L9 (Tech Stack) says `^7.1.0`; L1293, L1819–1820, L1825 say `^8.9.2` / `node-addon-api@8.9.2`.
**Fix:** L9 → `` `node-addon-api` ^8.9.2 ``.

**C12. `node-gyp`'s provenance claim is wrong.** L1293 and L1825 both say "both already resolved in the lockfile **via `better-sqlite3`**". Verified in `pnpm-lock.yaml`:
- `node-addon-api@8.9.2` ← `better-sqlite3@13.0.3` (`:6658-6660`) ✓
- `node-gyp@9.4.1` ← **`@electron/rebuild@3.6.1`** (`:5389-5399`), **not** better-sqlite3.

The conclusion ("neither is a new resolution") still holds; the attribution does not.
**Fix:** L1293 and L1825 → "`node-addon-api@8.9.2` resolves transitively via `better-sqlite3` and `node-gyp@9.4.1` via `@electron/rebuild`; both are already in the lockfile, so neither is a new resolution."

**C13. `allowBuilds` is written as a YAML list; the real file is a map.** L1967–1973 shows `allowBuilds:` followed by `- esbuild` / `- workerd` / `- vue-demi` / `- electron` / `- '@ponter/agent-native'`. `pnpm-workspace.yaml:6–18` is a **map** with per-package booleans, including `better-sqlite3: false` (a *deny*, with a load-bearing comment about network-restricted Docker builds). An implementer who replaces the block literally **deletes the `better-sqlite3` denial** and reintroduces the Docker build failure the comment describes. This contradicts L34 in the same plan, which correctly says `allowBuilds` "is keyed on the package name that owns the install script".
**Fix:** L1967–1973 → an edit instruction, not a block: "Add `'@ponter/agent-native': true` to `pnpm-workspace.yaml`'s existing `allowBuilds` **map**, beside `electron: true`. Do not replace the map — it carries a `better-sqlite3: false` denial that exists for Docker builds."

**C14. `apps/agent/package.json` is marked "**New.**" but exists at HEAD.** L83 and the File Structure table. `git show HEAD:apps/agent/package.json` returns `{"name": "@ponter/agent", "scripts": {"build": "cargo build --locked", …}}`.
**Fix:** L83 → `**Modify.** Rewrite from the Rust crate's manifest (\`@ponter/agent\`, cargo scripts) to \`@ponter/agent-node\` with TypeScript scripts.`

**C15. `apps/agent/vitest.config.ts` is required by every Task 1–4 `vitest run` command but appears in no Files block and not in the File Structure table.** The file exists in BE's WIP tree, so the implementer will produce it — but the plan does not say so, and the File Structure table is the document that "locks" what each task creates. Every other package in the repo has one (`packages/webrtc-core/vitest.config.ts`, `packages/shared/vitest.config.ts`, `apps/desktop/vitest.config.ts`, …), and this repo has **no root vitest workspace file** — so a package without its own config is not picked up.
**Fix:** add `apps/agent/vitest.config.ts` to both the File Structure table and Task 1's Files block, and create it in the new pre-Step-1 step from C6.

**C16. Review Focus #3 claims a pin that does not exist.** L42: "Pinned in Task 4 (**the addon's reconfiguration path**)." Task 4 has no reconfiguration path: the surface is `createEncoder` / `encode` / `setBitrate` / `destroyEncoder` (L1398–1424), and `grep -nE 'reconfigur|recreate|resolution change'` over the plan returns only L42 itself. The nearest thing is the upscale refusal (L2145–2159) and the downscale case (L2160–2190), neither of which is a size-change path.
**Fix:** either (i) rewrite L42 to name what Task 4 actually pins — "Pinned in Task 4 (the upscale refusal and the SPS frame-size read-back, which is the observable half; a true mid-stream size change is Plan 2's)" — or (ii) add the test. I recommend (i): the addon has no reconfiguration surface by design (spec §6.3 keeps it narrow), so (ii) would widen the interface.

**C17. Review Focus #5 claims a `null`-buffer test that does not exist.** L44: "A `null` / zero-length / wrong-stride buffer … Pinned in Task 4 (the deliberate-corruption test)." The fault-containment gate has a **zero-length** test (L2110) and a **wrong-stride** test (L2118). There is **no `null` case**, and the interface takes a `Buffer` (L1445) which cannot be `null` without the caller lying through a cast. Two of the three named inputs are pinned.
**Fix:** L44 → "**A zero-length / wrong-stride buffer handed to the addon.** …" — drop `null`, which the typed interface excludes.

**C18. Review Focus #2 claims an A4 assertion that is not written.** L41: "Pinned in Task 1 (**A4 detection**)". `SpikeRunResult` carries `encoderProfileLevelId`, `negotiatedProfileLevelId`, `profileMatches` (L124–127), and `report.json` is expected to record them — but **none of Task 1's eight `it()`s asserts any of them** (L268–313). A4 is described twice as "detection only, never a pass/fail" (L124, L2513), which is fine as a *policy*, but the plan then claims the Review Focus line is pinned.
**Fix:** add one assertion to the transport test at L300:

```ts
    // A4 — detection only: record, never fail the gate on it.
    expect(typeof result.profileMatches).toBe('boolean');
```

**C19. [SELF-CORRECTION — REFUTED] `desktop.rs:1826-1850` is correct.** Before compaction I recorded this citation as off-by-two (claiming `DesktopEncoder::new` runs 1827–1852). Re-measured: `1826 = pub fn new`, `1850 = }`. The citation is **exact**. Recording it here so the refuted count is honest and the finding does not resurface.

**C20. `bCodecParams`-class count drift in B17: "four" vs a five-row table.** L1928 says "**The four "no" rows** are internal openh264 state…", and L2501 repeats "**four** of those nine fields have no getter". The table at L1916–1926 has **nine** rows, of which the "no" rows are **five**: `usageType`, `iComplexityMode`, `bEnableAdaptiveQuant`, `bEnableBackgroundDetection`, `sVuiParam`.
**Fix:** L1928 → "The **five** \"no\" rows …"; L2501 → "**five** of those nine fields have no getter".

**C21. The matrix's §4.2 miscounts in the same place.** `…coverage-matrix.md:274-281` says "B17 lists **seven** configuration constants", lists **six** in the same sentence, then calls the remainder "the other four" while naming **five**.
**Fix (matrix):** §4.2 → "B17 lists **nine** configuration fields. Task 4's smoke test can only observe the **four** that reach the SPS…; the other **five** (`usageType`, `iComplexityMode`, `bEnableAdaptiveQuant`, `bEnableBackgroundDetection`, `sVuiParam`) have no getter…"

**C22. `g_ksLevelLimits` citation range is one byte short.** L1908 cites `codec/common/src/common_tables.cpp:345-363` for a table it says has **17** levels. The array is `345` (`const SLevelLimits g_ksLevelLimits[LEVEL_NUMBER] = {`) through `367` (`};`), with entries on 346–350, 352–354, 356–358, 360–362, 364–366. The cited range `345-363` cuts at `LEVEL_4_2` and omits levels 5.0/5.1/5.2 — i.e. it truncates exactly the tail the sentence claims to have counted.
**Fix:** L1908 → `:345-367`.

**C23. `build.rs` citation ranges overshoot the file.** L1539 cites `build.rs:254-349`; L1582 cites `build.rs:315-355`. The file is **352 lines**; `pub fn compile()` is **314–351**. `315-355` names four lines that do not exist.
**Fix:** L1539 → `build.rs:254-351`; L1582 → `build.rs:314-351`.

**C24. `report.json` is "consumed by Task 2" — no Task 2 step consumes it.** L111 states it, L469 writes it. Task 2's files (L481–487) and steps (L552–866) never read it. Its real consumers are the plan's gate (L2497) and, later, the §8 trail.
**Fix:** L111 → "`apps/agent/spike/report.json` — the machine-readable record of the three runs, consumed by the plan's gate (Completion Criterion 1) and by the §8 trail. The shape is fixed here so the implementation and the gate agree on it."

**C25. `spike/packetizer-copy.ts` is mandated but no task deletes or even creates it.** L453: "the spike **must** carry a `spike/packetizer-copy.ts` that Task 3 deletes". Task 3's Files block (L875–876) lists only `apps/agent/src/session/packetizer.ts` and its test; no Task 3 step deletes anything; the only `git add` in Task 3 is `apps/agent/src/session apps/agent/test/session` (L1271).
**Fix:** add to Task 3's Files block — `- Delete: \`apps/agent/spike/packetizer-copy.ts\` (if Task 1 created it)` — and a Step 8 precondition before the commit: `test ! -e apps/agent/spike/packetizer-copy.ts || git rm apps/agent/spike/packetizer-copy.ts`.

**C26. Two "Task 6's matrix records it" pointers dangle.** L981 (STAP-A flush: "Task 6's matrix records it") and L1885 ("the preset-level table is Task 6's matrix"). The matrix contains **no** entry for the flush divergence (`grep -n 'flush\|STAP-A' …coverage-matrix.md` → one hit, B26's generic row) and **no** preset-level table (`grep -n 'preset-level' …` → nothing).
**Fix:** add both to the matrix — a row `| B26a | The one deliberate divergence: a pending SPS/PPS pair at end-of-AU is flushed as a STAP-A instead of dropped | Plan 1, Task 3 | \`apps/agent/test/session/packetizer.test.ts\` — "flushes a pending SPS/PPS pair…" | Covered (deliberate) |` and a four-row preset → level-byte table under §4.2. Alternatively, delete both pointers from the plan; I recommend adding them, since the divergence is a real behavioural difference from the Rust agent and a reader deserves to find it.

**C27. `Guard` contradicts the plan's own "every failure carries a stable code" constraint.** L1843–1845: "Every native failure goes through here, so the TS side can branch on `error.code`". But `Guard` (L1874–1886) has `catch (const Napi::Error& e) { e.ThrowAsJavaScriptException(); }` — rethrowing **without** attaching `code`. A `Napi::Error` thrown from anywhere inside the guarded body reaches JS with **no** `.code`, so a TS caller matching on `error.code` sees `undefined`.
**Fix:** attach the code in that clause too:

```cpp
  } catch (const Napi::Error& e) {
    if (!e.Value().IsObject() ||
        e.Value().As<Napi::Object>().Get("code").IsUndefined()) {
      e.Value().As<Napi::Object>().Set("code", Napi::String::New(env, code));
    }
    e.ThrowAsJavaScriptException();
  }
```

**C28. `Guard` is synchronous; the entire addon surface is `Promise`-returning.** Every `NativeAddon` member except `platform` and `errorCodes` returns `Promise<void>` / `Promise<…>` (L1398–1422). A rejected promise from an `async` body is **not** a C++ exception — it surfaces through `Promise::Deferred`, and `Guard`'s `try/catch` cannot see it. The plan contains **no** `AsyncWorker`, `AsyncPromiseWorker` or `Promise::Deferred` reference (`grep` returns nothing), yet L1928 asserts "the honest check lives in Step 12" and L2007 makes the fault-containment gate the §9.2 contract. The gate can pass while an async rejection escapes untyped.
**Fix:** add a paragraph to Task 4 Step 4: "`Guard` covers the **synchronous** half of every entry point — argument validation, handle lookup, and the first native call. Do **not** let a C++ exception or a `Napi::Error` cross a `Promise::Deferred` boundary: catch inside the async body, resolve `deferred.Reject(Napi::Error::New(env, message).Value())` with the `code` property attached by the same helper `ThrowError` uses. Add one fault-containment case for an **async** rejection to prove it: `await expect(addon.encode(handle, { pixels: Buffer.alloc(0), … })).rejects.toMatchObject({ code: 'NATIVE_INVALID_ARGUMENT' })` — which L2114 already is — plus a note that the assertion is meaningful only because the rejection is a *rejected promise*, not a throw."

**C29. Five of the seven `NativeErrorCode`s are never asserted thrown, and one is asserted in the wrong place.** The contract at L1430–1438 names seven codes. Assertions on thrown codes: `NATIVE_INVALID_ARGUMENT` (L2114, L2158), `NATIVE_BUFFER_OUT_OF_BOUNDS` (L2128), `NATIVE_HANDLE_INVALID` (L2141). `NATIVE_CAPTURE_FAILED`, `NATIVE_ENCODER_FAILED`, `NATIVE_INPUT_FAILED` and `NATIVE_UNSUPPORTED_PLATFORM` are declared, mapped in `error.h` (L1847–1850), and **never observed**. `platform` is asserted to be `win32`/`linux` (L1455), so `NATIVE_UNSUPPORTED_PLATFORM` is unreachable on a supported host — but the other three are reachable by construction (a failing capture, a rejected resolution, a bad input event) and no test forces them.
**Fix:** state the gap honestly in Task 4 Step 12 rather than pretending: "`NATIVE_CAPTURE_FAILED`, `NATIVE_ENCODER_FAILED` and `NATIVE_INPUT_FAILED` need a live device or a stubbed OS call; the C++-level harness stubs the OS entry point and asserts each of the three, which is the only place they can be observed on CI. `NATIVE_UNSUPPORTED_PLATFORM` is unreachable on a supported host and is asserted only through the C++ unit test's direct call." Then add the three stub cases to Step 12, whose "stub the encoder's `SetOption` entry point" pattern (L2233–2235) already extends naturally to capture and input.

**C30. The addon → packetizer → sender seam has no test spanning it.** See Part 1(a). Three tasks produce three correct halves; nothing asserts they compose. This is the same defect class as B19 — a behaviour that is everybody's interface and nobody's test.
**Fix:** add one test to **Task 3** (the latest task that owns a side of the seam) that is a pure composition check with no native build:

```ts
  it('a packetizer result feeds the sender seam without a type or unit change', () => {
    const { packets } = packetizeAnnexB(buildAnnexB([SPS, PPS, IDR]), {
      payloadType: 102, sequenceNumber: 0, timestamp: 0, ssrc: 0x11223344,
    });
    const written: Uint8Array[] = [];
    const sender: RTCRtpSenderLike = {
      selectNegotiatedCodec: () => {},
      writeRtp: (packet) => { written.push(packet); },
    };
    for (const packet of packets) sender.writeRtp(packet.bytes);
    expect(written).toHaveLength(packets.length);
  });
```

This compiles against `packages/webrtc-core/src/types.ts` only, so it needs no addon and no browser, and it fails loudly if either side's shape drifts.

**C31. The matrix's two internal plan citations are stale.** `…coverage-matrix.md:245` cites "the plan's line 1270" for the *entire* public surface claim — L1270 is ` ```bash `; the claim is at **L1293**. `…coverage-matrix.md:280` cites "plan line 1826" for `GetBaseParams` returning no profile — L1826 is blank; the claim is at **L1902**.
**Fix (matrix):** `245` → "line 1293"; `280` → "line 1902".

---

## Part 3 — REFUTED (checked, and the plan is right)

Recorded so PM does not re-audit them, and so the confirmed count is not inflated.

| # | Claim audited | Verdict |
|---|---|---|
| R1 | Task 1's "8 tests green (2 offer-builder + 4 negotiation + 2 transport)" (L463) | correct — 2 at 252/259, 4 at 268/277/283/289, 2 at 300/309 |
| R2 | Task 2's "6 tests green" (L823) then +1 in Step 5 | correct — 6 in Step 1, 7th at L834 |
| R3 | Task 3's 12 tests (implicit) | correct — L1008, 1021, 1036, 1062, 1076, 1101, 1120, 1135, 1150, 1165, 1169, 1182 |
| R4 | Task 4 smoke "5 tests green" (L2005) with the named list | correct — platform, error codes, encode+profile, retarget, unknown handle |
| R5 | The fault-containment gate's 7 `it()`s | correct — L2110, 2118, 2132, 2144, 2162, 2190, 2219 |
| R6 | openh264 source counts: 86 `.cpp`, 24 `.asm`, → 23 objects, and the per-directory/per-library split (L1536) | correct, re-derived from the vendored tree |
| R7 | `desktop.rs:1826-1850` for `DesktopEncoder::new` | **correct** — see C19, my earlier finding was wrong |
| R8 | `desktop.rs:1862` (`YUVBuffer::from_rgba8_source`), `:1880-1905` (`apply_bitrate`), `:1767-1776` (`sample_writer`), `:3091-3105` (the `cmInitExpected` test) | all correct |
| R9 | `param_svc.h:286-293` — `GetBaseParams` returns exactly those six fields, no profile, no level | correct |
| R10 | `GetOption` has no `ENCODER_OPTION_PROFILE`/`LEVEL`; `SetOption` has both at `:1114`/`:1129` | correct |
| R11 | `param_svc.h:1227-1231` — `GetOption`'s `SVC_ENCODE_PARAM_EXT` `memcpy`s back the requested struct | correct (`welsEncoderExt.cpp:1227-1230`) |
| R12 | `au_set.cpp:187-193` (`WelsGetLevelIdc`) | correct |
| R13 | `lib.rs:445-490` for the four presets + `FromStr` | correct |
| R14 | `ipc-types.ts:7-10` for `DESKTOP_PROFILES` | correct (`DESKTOP_PROFILES` at 7–12, names at 8–11) |
| R15 | The `AGENT_SRC` path arithmetic (`join(fileURLToPath(import.meta.url), '../../../../apps/agent/src')`) | correct — `fileURLToPath` yields a **file** path, so four `..` land on the repo root |
| R16 | The matrix's `grep -c '^| B[0-9]'` → 62 and `'^| R[0-9]'` → 6 | correct |
| R17 | The CI facts block (L29–34): `continue-on-error: true`, `apps/agent/**` absent from `paths:`, three `--filter='!@ponter/agent'` exclusions, `allowBuilds` keyed on package name | all correct |
| R18 | Task 2's negotiated-codec assertions expect `'video/H264'` — is that the casing werift produces? | correct — `buildOffer` writes `a=rtpmap:102 H264/90000` and the negotiated codec comes from the **remote** list, so it is `video/H264`; werift's local `useH264()` (`video/h264`, lower) is never the negotiated value |
| R19 | Task 3's nine-row parity table and the whole `rtc-rtp` citation set (`mod.rs`, `packetizer/mod.rs:137`, `static_sample.rs:89`, `h264_test.rs`) | all correct, including the STAP-A-vs-Annex-B distinction |
| R20 | The `setBitrate` presence sweep (Part 1c) | confirmed present in all six places; the only stale statement lives in the matrix (C10) |

---

## Part 4 — order I would apply them in

1. **C6, C15** — without these, the plan's first command fails and nothing downstream can run.
2. **C1–C5, C9** — Task 2's implementation does not compile as written, and C9 breaks two other packages' typecheck.
3. **C8** — a gate that reports green while proving nothing is the defect class this audit exists for.
4. **C10, C26, C31** — the matrix must agree with the plan it grades.
5. **C11–C14, C20–C23** — counts and citations.
6. **C16–C18** — Review Focus honesty; C18 is a two-line test, and C16/C17 are prose corrections.
7. **C27–C30** — fault-containment completeness and the untested seam. C30 is the one I would not defer: it is cheap and it closes the same hole B19 did.

---

## Part 5 — what this audit did not check

- **The gyp file's own correctness** (target ordering, include-set collisions, the NASM rule's outputs). I verified the *counts* it claims and the `sources!` conditions against the vendored tree; I did not attempt to evaluate it.
- **Playwright/Chromium behaviour** in Task 1's transport half — that needs a browser run, not a read.
- **Spec conformance beyond the three named questions.** This audit grades the plan against the tree; it does not re-grade the spec.
- **`packages/shared` re-exports** (Task 5's `types/index.ts` and `src/index.ts` edits) — I confirmed both files exist and are the right places, but did not verify that every consumer of `StreamProfile` is reached.
