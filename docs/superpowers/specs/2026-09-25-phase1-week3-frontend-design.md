# Phase 1 Week 3 — Frontend Foundation Design Specification

**Status:** Revised (shadcn-vue) — awaiting review
**Date:** 2026-09-25
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 1 Week 3 of `docs/ARCHITECTURE.md` (Section 8: Frontend Foundation)

> **Revision note (2026-09-25):** the UI layer changed from hand-rolled components to **shadcn-vue**, initialized with the project's own preset (ADR-07), and a **dark-mode toggle** was added (ADR-08). This revision supersedes ADR-01's hand-rolling decision, replaces §6.3 and §6.7, and adds `vue-demi: true` to `allowBuilds` as a hard prerequisite (§7.1). Findings F9–F13 record the verifications behind the change.

---

## 1. Executive Summary & Goals

This specification details the architecture, design, and implementation plan for **Phase 1, Week 3: Frontend Foundation** of the remote access platform.

Week 2 delivered a working backend (`workers/signaling`, 46 tests passing) exposing auth, users, devices, agents, and sessions over HTTP. Week 3 delivers the first client that consumes it: a Vue 3 web application with real authentication, plus the two reusable packages it needs.

### Goals

1. Implement **`packages/crypto`** — client-side ECDH P-256 keypair generation via the native Web Crypto API, with the private key persisted in the browser and never transmitted.
2. Implement **`packages/api-client`** — a typed, environment-agnostic HTTP SDK for the Week 2 REST API, with automatic token refresh and a concurrency-safe refresh queue.
3. Implement **`apps/web`** — a Vue 3 + Vite + TailwindCSS v4 single-page application with Pinia state, Vue Router, and a **shadcn-vue** component layer (ADR-07) including a dark-mode toggle.
4. Deliver a working **auth flow**: register (with client-generated keypair), login, logout, session restore, and protected routing.
5. Deliver a **dashboard** that proves the authenticated session works end-to-end by rendering the current user and their registered devices and agents.
6. Extend the **CI pipeline** so `lint`, `typecheck`, and `test` cover the new packages and application.

### Non-Goals (deferred)

- WebRTC, terminal, desktop streaming, and file manager UI (Phases 2–4).
- WebAuthn (backend returns HTTP 501; Phase 5).
- E2EE encryption/decryption of payloads (Phase 5) — Week 3 generates and stores the keypair only.
- `packages/ui-components` extraction (deferred until `apps/desktop` needs the same components).
- Desktop and mobile applications.
- A flash-free dark-mode boot (an inline pre-hydration script); Week 3 accepts a possible first-paint flash (ADR-08).
- Any UI beyond auth and the dashboard — no device/agent/session management screens, no real-time updates.

---

## 2. Verified Toolchain Findings

The frontend stack in `docs/ARCHITECTURE.md` §4.1 predates several major releases (it specifies Vite 5, Tailwind 3, Vitest 1). Before committing to versions, each risky integration was verified by building a throwaway monorepo that mirrors this repository's structure. The findings below are measured, not assumed, and they directly determine the design.

| # | Finding | Impact on design |
|---|---|---|
| F1 | **Vitest 5 rejects `test` inside Vite's `defineConfig`.** `vite.config.ts` with a `test` key fails `vue-tsc` with `TS2769: 'test' does not exist in type 'UserConfigExport'`. | Vite config and Vitest config must be **two separate files**: `vite.config.ts` (`defineConfig` from `vite`) and `vitest.config.ts` (`defineConfig` from `vitest/config`). This supersedes the single-file pattern used by `workers/signaling`. |
| F2 | **`happy-dom` does not provide `indexedDB`.** A test touching `indexedDB` fails with `ReferenceError: indexedDB is not defined`. | `fake-indexeddb/auto` must be loaded via `test.setupFiles` for any test exercising key storage. |
| F3 | **`CryptoKey` objects can be stored in IndexedDB while non-extractable.** Verified that a key generated with `extractable: false` survives a `put`/`get` round-trip and still performs `deriveBits`. | The private key is stored as a `CryptoKey` with `extractable: false` — **not** exported to JWK. There is no raw private-key material to leak. |
| F4 | **Raw-`.ts` workspace packages resolve correctly across the whole toolchain.** A package exporting `./src/index.ts` (the `packages/shared` pattern) imported cleanly through `vue-tsc --noEmit`, `vite build`, and `vitest run`. | `packages/crypto` and `packages/api-client` follow the existing `packages/shared` convention: no build step, `exports` pointing at source `.ts`. |
| F5 | **`eslint-plugin-vue` must be installed at the repo root.** Running `apps/web`'s lint with only a root `eslint.config.js` fails `ERR_MODULE_NOT_FOUND: Cannot find package 'typescript-eslint'` unless the plugins are root devDependencies. | Vue lint plugins are added to the **root** `package.json`, and the existing single root `eslint.config.js` is extended. No per-app ESLint config. |
| F6 | **`eslint-plugin-vue`'s `flat/recommended` fights Prettier.** It emits stylistic warnings (`vue/singleline-html-element-content-newline`) that `prettier --check` does not fix. | Use `flat/essential` only, keeping Prettier as the sole formatting authority. |
| F7 | **`vue-router` v5 keeps the v4 API.** `createRouter`, `createWebHistory`, `router.beforeEach((to, from) => ...)`, returning a route location to redirect, and `to.meta` are all unchanged. | The guard design uses the standard documented API. v5's heavy transitive dependencies (unplugin, chokidar) belong to its *optional* file-based routing, which this design does not use. |
| F8 | **The backend returns `token` / `refreshToken`, not `accessToken`.** `POST /api/auth/register` and `/login` respond with `{ user, token, refreshToken, expiresIn }`. | The `TokenStorageAdapter` interface uses `accessToken` internally; the auth resource maps `response.token → accessToken` at the boundary. |
| F9 | **pnpm blocks `vue-demi`'s build script, which breaks the shadcn-vue install.** `pnpm-workspace.yaml` allows builds only for `esbuild` and `workerd`. `reka-ui → @floating-ui/vue → vue-demi` has a `postinstall` script, so `pnpm add reka-ui` (which `shadcn-vue init` runs internally) fails with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: vue-demi@0.14.10`. Reproduced in a throwaway workspace carrying this repo's exact `allowBuilds` block, and confirmed fixed by adding `vue-demi: true`. | **`vue-demi: true` must be added to `allowBuilds` in `pnpm-workspace.yaml` *before* `shadcn-vue init` runs.** Without it the init command's dependency-install step fails. This is a hard prerequisite, not a cleanup step. |
| F10 | **shadcn-vue components mount and assert under `happy-dom` with zero stubs.** A probe suite mounted shadcn-style `Button` (reka-ui `Primitive` + cva), `Input`, `Label` (reka-ui `Label`), `Card`, `Select` (reka-ui, portal), `Dialog` (teleport + overlay), and `Checkbox` (interactive `aria-checked` toggle): 8/8 passed with an **empty** `setupFiles`. `happy-dom@20.14.5` supplies `ResizeObserver`, `IntersectionObserver`, `matchMedia`, `MutationObserver`, `PointerEvent`, `getComputedStyle`, `requestAnimationFrame`, and `structuredClone`. | **No browser-API stubs are needed for component tests.** The only stub required anywhere is `fake-indexeddb` (F2), and only for `packages/crypto`. This contradicts the common assumption that reka-ui needs a stub file. **Caveat:** upstream `reka-ui` tests under `jsdom` and stubs `ResizeObserver` because `@floating-ui/dom` constructs one when the global exists; happy-dom's version is a no-op, so floating-position *updates* never fire. Our 8/8 covers mounting and asserting, not pixel positioning — Week 3 asserts on DOM presence and ARIA state, never on computed coordinates. A component test that needs real positioning must stub `ResizeObserver` itself. |
| F11 | **`baseUrl` is deprecated in TypeScript 6 and fails the build.** A tsconfig with `compilerOptions.baseUrl` fails `vue-tsc` with `TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0`. Removing `baseUrl` while keeping `paths` yields exit code 0. | The app tsconfig uses `paths: { "@/*": ["./src/*"] }` **without** `baseUrl`. The shadcn-vue docs' recommended `baseUrl` + `paths` form must not be copied verbatim into this repo. |
| F12 | **shadcn-vue's generated CSS coexists with the project's own `@theme` palette.** The CLI writes `@import "tw-animate-css"`, `@import "shadcn-vue/tailwind.css"`, `@custom-variant dark (&:is(.dark *))`, `:root`/`.dark` CSS variables, `@theme inline` mappings, and a `@layer base` block (`* { @apply border-border outline-ring/50 }`, `body { @apply bg-background text-foreground }`). Adding a separate `@theme { --color-brand-500: ... }` block alongside it builds cleanly, and both resolve: `bg-primary` compiles to `var(--primary)` (theme-inline, dark-swappable) while `bg-brand-500` compiles to the literal `oklch(62% .19 259)`. | The brand palette is additive — a second `@theme` block, not a replacement for the shadcn tokens. `shadcn-vue/tailwind.css` is a real package export (`"./tailwind.css": { "style": "./dist/tailwind.css" }`) and resolves through the Tailwind Vite plugin. **Two precisions:** (a) shadcn-vue never *generates* brand tokens — the additive block is entirely ours, and the name `--color-brand-500` appears nowhere in the CLI or its registry; (b) the CLI emits `:root` variables in whatever colour space the source theme uses — its own test fixtures show `hsl(0 0% 100%)`, our probe's preset produced `oklch`. The values in §6.3 are therefore **illustrative of shape**; the CLI's generated file is authoritative for actual values. |
| F13 | **shadcn-vue init is fully non-interactive and `--preset` / `--template` are real flags.** `init --help` documents `-p, --preset [preset]` ("use a preset configuration, preset code, or URL"), `-t, --template <template>` (`nuxt, vite, astro, laravel`), `-y/--yes`, `-d/--defaults`, `-c/--cwd`, `--base`, `--style`, `--icon-library`, `--font`, `-b/--base-color`, `--css-variables`, and more. | The user's chosen command is well-formed. `-y` defaults to `true`, so no prompt is expected. `-c apps/web` is the flag that targets the app directory rather than the repo root. |

### 2.1 Pinned Versions

Versions verified working together in the smoke build. These supersede the older versions listed in `docs/ARCHITECTURE.md` §4.1.

| Package | Version | Scope |
|---|---|---|
| `vue` | `3.5.43` | `apps/web` dependency |
| `vue-router` | `5.3.1` | `apps/web` dependency |
| `pinia` | `4.0.3` | `apps/web` dependency |
| `vite` | `8.3.1` | `apps/web` devDependency |
| `@vitejs/plugin-vue` | `6.0.9` | `apps/web` devDependency |
| `tailwindcss` | `4.3.3` | `apps/web` devDependency |
| `@tailwindcss/vite` | `4.3.3` | `apps/web` devDependency |
| `vue-tsc` | `3.3.11` | `apps/web` devDependency |
| `vitest` | `5.0.1` | `apps/web`, `packages/*` devDependency |
| `happy-dom` | `20.14.5` | `apps/web` devDependency |
| `@vue/test-utils` | `2.5.1` | `apps/web` devDependency |
| `fake-indexeddb` | `6.2.5` | `apps/web`, `packages/crypto` devDependency |
| `eslint-plugin-vue` | `10.11.1` | **root** devDependency |
| `vue-eslint-parser` | `10.4.1` | **root** devDependency |

The UI component layer is installed by `shadcn-vue init` (see ADR-07). The CLI writes these into `apps/web/package.json`; the versions below are what `shadcn-vue@2.8.2` resolves to today.

| Package | Version | Scope |
|---|---|---|
| `shadcn-vue` | `2.8.2` | CLI, run via `pnpm dlx` (not a dependency) |
| `reka-ui` | `2.10.5` | `apps/web` dependency (shadcn's primitive layer) |
| `class-variance-authority` | `0.7.1` | `apps/web` dependency |
| `clsx` | `2.1.1` | `apps/web` dependency |
| `tailwind-merge` | `3.7.0` | `apps/web` dependency |
| `tw-animate-css` | `1.4.0` | `apps/web` dependency |
| `@lucide/vue` | `1.48.0` | `apps/web` dependency (icon set; `lucide-vue-next@1.0.0` also verified working) |

`typescript` stays pinned at `6.0.3` and `eslint` at `10.11.0` per the existing Global Constraints.

**Vitest 5 coexists with the worker's Vitest 4.** `workers/signaling` pins `vitest@^4.1.0` (4.1.11 installed) because `@cloudflare/vitest-pool-workers` requires that major. `apps/web` and the two new packages use `5.0.1`. pnpm installs both side by side per-project, and each package's `test` script resolves its own local binary, so there is no conflict — but the two must not be hoisted into one shared dependency, and a root-level `vitest` invocation would be ambiguous. Turborepo's per-package `test` task is what keeps them separate; do not add a root `vitest` devDependency.

---

## 3. Architectural Decision Records (ADRs)

### ADR-01: Extract `packages/crypto` and `packages/api-client` now, defer `packages/ui-components`

- **Context:** `docs/ARCHITECTURE.md` §3.1 declares `apps/web` as depending on five workspace packages (`shared`, `api-client`, `webrtc-core`, `terminal-core`, `ui-components`). Of these, only `packages/shared` currently contains code; `api-client`, `crypto`, `ui-components`, `webrtc-core`, and `terminal-core` are stubs whose `lint`/`typecheck` scripts are `echo ok`. Week 3 needs a crypto primitive and an HTTP client to deliver a working auth flow.
- **Decision:** Implement **`packages/crypto`** and **`packages/api-client`** as real packages in Week 3, and defer **`packages/ui-components`** to the week that `apps/desktop` first needs shared components.
- **Rationale:** Crypto and HTTP are the two pieces where duplication across `apps/web`, `apps/desktop`, and `apps/mobile` would be genuinely expensive and where logic is subtle enough to warrant its own test suite. UI components, by contrast, are the most volatile part of the system and the most expensive to package correctly: shipping Vue SFCs through a pnpm workspace with Tailwind v4 requires bundler configuration that would consume much of the week for components only one app currently uses. Extracting them later is a mechanical refactor; getting them wrong now is a week lost.
- **Consequence:** `apps/web` will import auth components from `apps/web/src/components/`. When `apps/desktop` needs them, the move to `packages/ui-components` is a file move plus an import rewrite. `packages/webrtc-core` and `packages/terminal-core` remain stubs until Phases 2 and 4.
- **Superseded in part by ADR-07:** the decision to *hand-roll* the components in `apps/web/src/components/` is replaced by shadcn-vue. The decision to *defer `packages/ui-components`* stands unchanged — shadcn components are copied into `apps/web/src/components/ui/`, which is the same extraction-later posture.

### ADR-02: Client-generated ECDH P-256 keypair at registration

- **Context:** `POST /api/auth/register` **requires** a `publicKey` field (it returns HTTP 400 `VALIDATION_ERROR` without one), and the `users` table stores it as a NOT NULL column. This is the foundation of the platform's zero-trust E2EE design (`docs/ARCHITECTURE.md` §7.2), but Week 3's roadmap does not include any cryptography work.
- **Decision:** Generate the keypair **in the browser** at registration time using the native Web Crypto API — ECDH over curve P-256. Send only the **public** key to the backend, SPKI-encoded as base64. Persist the **private** key in IndexedDB as a non-extractable `CryptoKey`, keyed by the user ID returned from registration.
- **Rationale:** ECDH P-256 is the key-agreement primitive the E2EE design needs, and Web Crypto is available natively in every target environment with no dependency to audit. Generating the keypair at registration means the user's identity is bound to a key they alone hold from the first moment. Making the private key non-extractable (verified in finding F3) means even a successful XSS cannot read the raw key material out of the browser — it can only be *used* in place.
- **Consequence:** `savePrivateKey` is called with the `user.id` returned by the backend, so registration and key persistence are two steps that must both succeed. If key storage fails, the user account exists but has no local private key; Week 3 surfaces this as an error rather than silently continuing. Actual encryption/decryption with this key arrives in Phase 5.

### ADR-03: Concurrency-safe token refresh in the API client

- **Context:** Access tokens expire after 15 minutes (`JWT_EXPIRES_IN`). A dashboard that loads the user plus their devices and agents fires several requests concurrently. When the access token has expired, every one of those requests returns HTTP 401 at the same moment.
- **Decision:** Implement a single-flight refresh queue inside `HttpClient`. On a 401 from a non-auth endpoint, the first caller starts the refresh; every subsequent 401 while a refresh is in flight is parked in a queue and retried with the new token once it resolves. Requests to `/api/auth/login` and `/api/auth/refresh` are exempt, so a failing refresh cannot recurse.
- **Rationale:** The naive implementation — refresh on every 401 — sends N concurrent refresh calls to the backend. While the Week 2 backend echoes the same refresh token without rotating, a stampede still burns backend CPU and DB reads verifying the user row N times in parallel, and Phase 5 will add token rotation where a non-queued caller's refresh token would be revoked. A queue collapses N refreshes into one single flight: the first 401 caller refreshes, and the parked callers await that result and retry with the fresh access token.
- **Consequence:** This is the single most subtle piece of logic in Week 3 and is called out as Review Focus item 1. It must be covered by an explicit test asserting that three concurrent 401s produce exactly one `POST /api/auth/refresh`.

### ADR-04: TailwindCSS v4 with CSS-first configuration

- **Context:** `docs/ARCHITECTURE.md` §4.1 specifies Tailwind `^3.4.0` with `autoprefixer` and `postcss`. Tailwind v4 (4.3.3) replaces that arrangement with a Vite plugin and CSS-first configuration.
- **Decision:** Use **TailwindCSS v4** via `@tailwindcss/vite`, declaring design tokens with `@theme` in `apps/web/src/style.css`. No `tailwind.config.js`, no `postcss.config.js`, no `autoprefixer`.
- **Rationale:** v4 is the current major release and the version a new project should start on; adopting v3 now would mean planning a migration. The Vite plugin eliminates an entire PostCSS configuration layer, and `@theme` keeps tokens in the same file as the stylesheet that uses them. Verified working: a `--color-brand-500` token declared in `@theme` reaches the built CSS as a custom property.
- **Consequence:** This deviates from the version numbers in `docs/ARCHITECTURE.md` §4.1, which §2.1 of this spec supersedes. Utility classes used in Week 3 are standard v4 classes; there is no v3 compatibility layer.

### ADR-05: `apps/web` owns the `ApiClient` singleton; the store owns auth state

- **Context:** `ApiClient` needs tokens to sign requests, and `authStore` needs the client to log in. A direct reference in both directions would be circular.
- **Decision:** Break the cycle with a **`TokenStorageAdapter` interface**. `apps/web/src/services/client.ts` constructs one `ApiClient` singleton backed by a `localStorage` adapter, and passes an `onAuthError` callback. `authStore` holds the reactive `user` and `status` and delegates all token persistence to the adapter through the client. The client never imports Pinia; the store never constructs a client.
- **Rationale:** The client stays a plain, testable, framework-free library — which is exactly what `apps/desktop` and `apps/mobile` need — while the reactive state that only Vue cares about stays in Pinia. It also makes the client's own tests trivial: pass an in-memory adapter, no Pinia, no DOM.
- **Consequence:** There are two sources of truth to keep in step: tokens live in the adapter (`localStorage`) and the user lives in the store. `restore()` reconciles them on app start by reading tokens and calling `GET /api/users/me`.

### ADR-06: Direct cross-origin calls to the API in local development (no Vite proxy)

- **Context:** The Worker dev server runs on `http://localhost:8787` and the Vite dev server on `http://localhost:5173`. Browsers enforce CORS on cross-origin requests, and the Worker's CORS middleware currently allows `origin: '*'`.
- **Decision:** Configure `VITE_API_URL` (default `http://localhost:8787`) as the client's base URL, and rely on the backend's existing permissive CORS for Week 3. Do **not** add a Vite proxy yet.
- **Rationale:** The backend already sends `Access-Control-Allow-Origin: *` with `Authorization` in `allowHeaders`, so direct cross-origin calls work today without extra configuration. Adding a proxy would introduce a second, dev-only code path that behaves differently from production, where the app will call the Worker's real URL.
- **Consequence:** The client always talks to an absolute base URL, identically in dev and production — only the value of `VITE_API_URL` changes. Tightening CORS to an explicit origin allowlist is deferred to Phase 5 (Security & Polish); when that happens, `origin: '*'` must be replaced with the deployed web origin, and localhost dev will need to be included explicitly.

### ADR-07: shadcn-vue is the component layer, initialized with the user's preset

- **Context:** Week 3 needs a small but real set of UI primitives — buttons, inputs, labels, cards, alerts, a dropdown menu, an avatar, and a badge — across the auth forms, the header, and the dashboard. Hand-rolling these means writing and maintaining focus management, ARIA wiring, and dark-mode-aware styling for each one. shadcn-vue provides them as **source files copied into the project** on top of `reka-ui` primitives, which is a materially different trade-off from a component library dependency: the code lands in the repository and can be edited freely.
- **Decision:** Initialize shadcn-vue **inside `apps/web/`** with the user's own preset:

  ```bash
  pnpm dlx shadcn-vue@latest init --preset a5RaS2BE --template vite
  ```

  Then customize the copied components with Tailwind. shadcn-vue becomes the component layer for **all** Week 3 UI. `packages/ui-components` stays deferred (ADR-01).
- **Rationale:** Copied source means no version lock-in and no wrapper layer to fight when a component needs to behave differently — the trade-off that makes shadcn attractive for a project that intends to customize heavily. The `reka-ui` base supplies correct accessibility behaviour (focus traps, roving tabindex, ARIA attributes) that hand-rolled components routinely get wrong. Initializing inside `apps/web` rather than at the repo root keeps `components.json`, `src/lib/utils.ts`, and `src/components/ui/**` inside the one application that uses them, which is also what makes the eventual extraction to `packages/ui-components` a directory move.
- **Consequence:** Two hard prerequisites, both verified: `vue-demi: true` must be in `allowBuilds` before init runs (F9), and the generated CSS must coexist with the brand `@theme` block (F12). The generated `components.json`, `src/lib/utils.ts`, and `src/components/ui/**` become tracked source — they are ours to edit, and `pnpm format` must run after init because the CLI does not format what it writes. The preset value `a5RaS2BE` is the user's own custom template; it is treated as an opaque configuration input and is not investigated or documented here.

### ADR-08: Dark mode is a class strategy with a persisted preference

- **Context:** shadcn-vue generates dark-mode tokens as a `.dark` CSS-variable block plus a `@custom-variant dark (&:is(.dark *))` rule (F12). Nothing applies the `.dark` class on its own, and nothing remembers the user's choice across reloads.
- **Decision:** Toggle a `dark` class on `document.documentElement`. A `useTheme()` composable owns the state: it reads `localStorage['remote.theme']`, falls back to `window.matchMedia('(prefers-color-scheme: dark)')` when nothing is stored, and exposes `theme`, `isDark`, `toggle()`, and `set(theme)`. `AppHeader` renders the toggle button.
- **Rationale:** The class strategy is what shadcn's generated CSS already expects, so no extra CSS work is needed and the `dark:` variant works in every component. Defaulting to the OS preference means the first visit is not jarring, while an explicit choice — once made — always wins, which is what users expect from a toggle they have used. Keeping the state in a composable rather than a Pinia store avoids pulling a store into a concern that has no cross-store dependencies.
- **Consequence:** `localStorage` access must be wrapped in `try`/`catch` for the same privacy-mode reason as token storage (§6.6); a failure degrades to OS preference with no persistence. Because the class is applied on `<html>` at runtime rather than in `index.html`, the initial paint can flash the light theme on a dark-preference device. Week 3 accepts this; eliminating it requires an inline pre-hydration script, which is deferred.

---

## 4. Package Design: `packages/crypto`

**Purpose:** Environment-agnostic client-side key generation and storage. Runs in the browser, in Node (for tests), and would run in `workerd`.

**Dependencies:** none at runtime. Dev: `vitest`, `fake-indexeddb`, `typescript`.

### 4.1 Public API (`packages/crypto/src/index.ts`)

```typescript
/** A freshly generated user keypair. */
export interface UserKeyPair {
  /** SPKI-encoded public key, base64. This is the value sent to the backend. */
  publicKeySpkiBase64: string;
  /** Non-extractable private key. Stored locally; never transmitted. */
  privateKey: CryptoKey;
  /** The public half, for local use. */
  publicKey: CryptoKey;
}

/** Generate an ECDH P-256 keypair for a new user identity. */
export function generateUserKeyPair(): Promise<UserKeyPair>;

/** Export a public key to SPKI base64 (the wire format for `user.publicKey`). */
export function exportPublicKeySpki(key: CryptoKey): Promise<string>;

/** Import a public key from SPKI base64. */
export function importPublicKeySpki(spkiBase64: string): Promise<CryptoKey>;

/** Persist a user's private key locally, keyed by user ID. */
export function savePrivateKey(userId: string, key: CryptoKey): Promise<void>;

/** Load a user's private key, or null if none is stored. */
export function loadPrivateKey(userId: string): Promise<CryptoKey | null>;

/** Remove a user's private key from local storage. */
export function deletePrivateKey(userId: string): Promise<void>;
```

### 4.2 Implementation Notes

- **Curve and algorithm:** `{ name: 'ECDH', namedCurve: 'P-256' }`. Key usages `['deriveBits']` for the private key (verified sufficient for `deriveBits` in finding F3).
- **Extractability:** the private key is generated with `extractable: false`. The public key is `true` so it can be exported.
- **Base64 encoding:** the SPKI export yields an `ArrayBuffer`; convert with `String.fromCharCode(...new Uint8Array(buf))` then `btoa`. The reverse for import. This avoids a dependency on `Buffer` (absent in browsers) and on `atob`/`btoa` being Node-flagged (they are global in Node 24, verified).
- **IndexedDB:** one database (`remote-crypto`), one object store (`keys`), records keyed by `userId`. Store the `CryptoKey` object directly — the structured clone algorithm handles it (verified F3).
- **`loadPrivateKey` returns `null`** rather than throwing when absent, so callers can distinguish "no key stored" from a storage failure.

### 4.3 Tests (`packages/crypto/test/crypto.test.ts`)

Run under Node with `fake-indexeddb/auto` loaded in `setupFiles`.

1. `generateUserKeyPair` returns a base64 SPKI string of plausible length and a private key with `extractable === false`.
2. `exportPublicKeySpki` → `importPublicKeySpki` round-trips to a key that successfully derives bits against a peer.
3. The generated private key derives bits against the returned public key (proves the pair actually matches).
4. `savePrivateKey` → `loadPrivateKey` returns a `CryptoKey` that still derives bits.
5. `loadPrivateKey` returns `null` for an unknown user ID.
6. `deletePrivateKey` removes the record, and a subsequent load returns `null`.
7. `deletePrivateKey` for a missing user ID does not throw (idempotent).

---

## 5. Package Design: `packages/api-client`

**Purpose:** A typed HTTP SDK for the Week 2 REST API. Framework-free and runtime-agnostic (uses global `fetch`).

**Dependencies:** `@remote/shared` (workspace). Dev: `vitest`, `typescript`.

### 5.1 File Structure

```
packages/api-client/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts          # Public exports
│   ├── client.ts         # HttpClient: fetch wrapper, auth header, refresh queue
│   ├── errors.ts         # ApiError + isApiError
│   ├── types.ts          # ApiClientConfig, TokenStorageAdapter, AuthErrorHandler
│   └── resources/
│       ├── auth.ts       # register, login, refresh, logout
│       ├── users.ts      # me
│       ├── devices.ts    # list, create, remove
│       ├── agents.ts     # list, create, get (no update/remove — not implemented server-side)
│       └── sessions.ts   # list, create, get, terminate
└── test/
    ├── client.test.ts
    └── refresh-queue.test.ts
```

### 5.2 Configuration and Adapters (`src/types.ts`)

```typescript
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Where the client persists tokens. The app supplies the implementation. */
export interface TokenStorageAdapter {
  getAccessToken(): Promise<string | null> | string | null;
  getRefreshToken(): Promise<string | null> | string | null;
  setTokens(tokens: TokenPair): Promise<void> | void;
  clearTokens(): Promise<void> | void;
}

/** Called when refresh fails, so the app can redirect to login. */
export type AuthErrorHandler = (error: ApiError) => void;

export interface ApiClientConfig {
  baseUrl: string;
  storage: TokenStorageAdapter;
  onAuthError?: AuthErrorHandler;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}
```

### 5.3 Error Model (`src/errors.ts`)

The backend's error middleware always responds with `{ error, code, details }` and an HTTP status. `ApiError` mirrors that shape:

```typescript
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
}

export function isApiError(value: unknown): value is ApiError;
```

When a response body is not the expected JSON shape (a network failure, an HTML error page, an empty body), the client throws an `ApiError` with `code: 'NETWORK_ERROR'` and `status: 0` rather than leaking a `SyntaxError`.

### 5.4 The Refresh Queue (`src/client.ts`)

This is the core of the package. `HttpClient` exposes a single `request<T>()` method used by every resource.

```
request(method, path, { body, auth }):
  token = await storage.getAccessToken()          if auth !== false
  response = fetch(baseUrl + path, headers, body)

  if response.ok: return parsed body

  if response.status === 401 AND auth !== false AND path is not an auth path:
     return await refreshAndRetry(method, path, options)

  throw ApiError.fromResponse(response)
```

`refreshAndRetry` implements single-flight:

```
if (refreshPromise === null):
    refreshPromise = doRefresh()        # exactly one in-flight refresh
    try:
        await refreshPromise
    finally:
        refreshPromise = null

# every 401 caller awaits the SAME promise, then retries once
await refreshPromise
return request(method, path, options, { retried: true })
```

- **Exempt paths:** `/api/auth/login`, `/api/auth/refresh`, `/api/auth/register`. A 401 from these is a genuine credential failure and must surface to the caller, not trigger a refresh loop.
- **Retry bound:** the retried request passes an internal flag; a second 401 on the retried request throws instead of refreshing again. This is the guard against an infinite loop.
- **Refresh failure:** `doRefresh()` clears tokens via `storage.clearTokens()`, invokes `onAuthError` if provided, and throws. All queued callers observe the same rejection.

### 5.5 Resources

Each resource is a factory taking the `HttpClient` and returning an object of methods. Response types come from `@remote/shared` where they exist.

| Resource | Methods | Endpoint |
|---|---|---|
| `auth` | `register(input)` | `POST /api/auth/register` |
| | `login(username, password)` | `POST /api/auth/login` |
| | `refresh(refreshToken)` | `POST /api/auth/refresh` |
| | `logout(refreshToken)` | `POST /api/auth/logout` |
| `users` | `me()` | `GET /api/users/me` |
| `devices` | `list()`, `create(input)`, `remove(id)` | `GET`/`POST /api/devices`, `DELETE /api/devices/:id` |
| `agents` | `list()`, `create(input)`, `get(id)` | `GET`/`POST /api/agents`, `GET /api/agents/:id` |
| `sessions` | `list()`, `create(input)`, `get(id)`, `terminate(id)` | `GET`/`POST /api/sessions`, `GET`/`DELETE /api/sessions/:id` |

> **Scope note:** the client exposes exactly the routes `workers/signaling` implements today. `docs/ARCHITECTURE.md` §6.3 also lists `PUT /api/agents/:id`, `DELETE /api/agents/:id`, and `PUT /api/devices/:id/trust`; those routes are **not** implemented in the Week 2 worker and are therefore deliberately absent from the client. Adding them to the client before the backend exists would produce methods that can only fail at runtime.

- `auth.login` and `auth.register` call `storage.setTokens({ accessToken: response.token, refreshToken: response.refreshToken })` internally — this is the F8 mapping, and it is the only place the backend's `token` field name appears.
- `auth.logout` sends the refresh token in the body so the backend revokes both JTIs (the backend reads `{ refreshToken }`).
- `auth` methods pass `auth: false` so no bearer header is attached and no refresh is attempted.
- List endpoints return the array directly (the backend does not wrap responses in an envelope).

### 5.6 Tests

**`test/client.test.ts`** — a stub `fetch` is injected via `ApiClientConfig.fetch`.

1. Attaches `Authorization: Bearer <token>` when a token is stored.
2. Omits the header when no token is stored.
3. Parses `{ error, code, details }` into `ApiError` with the correct `status`/`code`.
4. Throws `ApiError` with `code: 'NETWORK_ERROR'` when the body is not JSON.
5. `login` persists the mapped token pair through the adapter.
6. `logout` sends the refresh token in the request body.

**`test/refresh-queue.test.ts`** — the Review Focus cases.

7. **Three concurrent 401s trigger exactly one refresh.** Assert the stub's call count for `POST /api/auth/refresh` is `1`, and that all three original requests were retried and resolved with the new token.
8. A 401 from `/api/auth/login` does **not** trigger a refresh.
9. A second 401 on a retried request throws instead of refreshing again.
10. Refresh failure clears tokens and invokes `onAuthError` once.

---

## 6. Application Design: `apps/web`

### 6.1 File Structure

```
apps/web/
├── index.html
├── package.json
├── components.json                 # written by shadcn-vue init
├── tsconfig.json
├── vite.config.ts                  # vue + tailwindcss plugins only
├── vitest.config.ts                # happy-dom, fake-indexeddb setup
├── env.d.ts                        # ImportMetaEnv typing for VITE_API_URL
├── .env.example
└── src/
    ├── main.ts
    ├── App.vue
    ├── style.css                   # shadcn tokens + additive brand @theme block
    ├── test-setup.ts               # imports fake-indexeddb/auto
    ├── lib/
    │   └── utils.ts                # cn() — written by shadcn-vue init
    ├── components/
    │   ├── ui/                     # shadcn-vue components (copied source)
    │   │   ├── button/
    │   │   ├── input/
    │   │   ├── label/
    │   │   ├── card/
    │   │   ├── alert/
    │   │   ├── dropdown-menu/
    │   │   ├── avatar/
    │   │   └── badge/
    │   ├── layout/
    │   │   ├── AppLayout.vue
    │   │   ├── AppHeader.vue
    │   │   └── ThemeToggle.vue
    │   └── auth/
    │       ├── LoginForm.vue
    │       └── RegisterForm.vue
    ├── composables/
    │   └── useTheme.ts
    ├── router/
    │   └── index.ts
    ├── stores/
    │   └── auth.ts
    ├── services/
    │   ├── client.ts               # ApiClient singleton + localStorage adapter
    │   └── token-storage.ts        # TokenStorageAdapter implementation
    ├── views/
    │   ├── LoginView.vue
    │   ├── RegisterView.vue
    │   ├── DashboardView.vue
    │   └── NotFoundView.vue
    └── __tests__/
        ├── auth-store.test.ts
        ├── router-guard.test.ts
        ├── use-theme.test.ts
        ├── LoginForm.test.ts
        └── RegisterForm.test.ts
```

### 6.2 Build Configuration

Two config files, per finding F1:

```typescript
// vite.config.ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
```

```typescript
// vitest.config.ts
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```

The `@` alias must be declared in **both** config files: Vitest does not read `vite.config.ts` when a `vitest.config.ts` is present, and shadcn components import each other through `@/lib/utils` and `@/components/ui/...`.

`tsconfig.json` extends `../../tsconfig.base.json` and adds `"lib": ["ES2024", "DOM", "DOM.Iterable"]`, `"jsx": "preserve"`, `"types": ["vite/client"]`, `"paths": { "@/*": ["./src/*"] }` — **without `baseUrl`**, per finding F11 — plus `"include"` covering `src/**/*.ts`, `src/**/*.vue`, and both config files, and `"exclude": ["node_modules", "dist", ".turbo"]`. `tsconfig.base.json` sets `lib: ["ES2024"]` only, which lacks the DOM types Vue SFCs require.

Two details that would otherwise cost a debugging round:

- **`@types/node` is not added to `apps/web`.** It is already a root devDependency (24.13.6), and pnpm's workspace layout puts it in the root `node_modules`, which TypeScript reaches by walking up from `apps/web`. Both config files import `node:url`, so the types must resolve — they do, through inheritance. Adding it again in the app would pin a second version.
- **`fileURLToPath(new URL(...))` rather than `path.resolve(__dirname, ...)`.** Both work in Vite's ESM context, but `__dirname` is not a real ESM global and only exists because Vite's config loader injects it. `import.meta.url` is the standard form and does not depend on that injection. Either is acceptable; the spec standardizes on `import.meta.url`.

`components.json` (generated by init) points its aliases at the same `@/` prefix, so no post-init edit to it is needed as long as `--base` was not customized.

### 6.3 Styling

`shadcn-vue init` writes `src/style.css` in the v4 shape. The file below shows that shape with the project's brand palette appended as a **second, additive `@theme` block** (finding F12) — the shadcn tokens are not replaced:

> **The generated file is authoritative.** Everything below the brand block is illustrative: the CLI writes the full token set, the `@layer base` block, and its own radius formulas from the preset, and its colour space may be `hsl` or `oklch` depending on that preset. Do not hand-transcribe this listing over the generated file — read what init produced, then **append only** the brand block.

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn-vue/tailwind.css";

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --radius: 0.625rem;
  /* …remaining shadcn tokens as generated… */
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  /* …remaining shadcn tokens as generated… */
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  /* …remaining mappings, radius formulas included, as generated… */
}

/* Project palette — additive, does not replace the shadcn tokens above. */
@theme {
  --color-brand-50: oklch(0.97 0.02 259);
  --color-brand-500: oklch(0.62 0.19 259);
  --color-brand-600: oklch(0.55 0.19 259);
  --color-brand-700: oklch(0.48 0.18 259);
}
```

The two mechanisms resolve differently, and both are wanted: `bg-primary` compiles to `var(--primary)` so it follows the `.dark` block automatically, while `bg-brand-500` compiles to the literal `oklch(0.62 0.19 259)` — a fixed brand colour that does not shift between themes (verified in finding F12). Component code uses `bg-primary` / `text-muted-foreground` for anything that must be theme-aware and `bg-brand-*` only for deliberate brand accents.

`--radius` and the `--radius-sm`/`--radius-md`/`--radius-lg` formulas are written by init from the preset; the component radius utilities come from the `@theme inline` mappings, not from a `tailwind.config.js`. Do not substitute your own radius arithmetic — keep the generated values.

#### 6.3.1 Initialization Sequence

The order matters — F9 makes the first step a hard prerequisite:

```bash
# 1. Allow vue-demi's postinstall, or the init's install step fails (F9).
#    Add `vue-demi: true` to allowBuilds in pnpm-workspace.yaml, then:
pnpm install

# 2. Scaffold apps/web enough for the CLI to detect Vite: package.json,
#    vite.config.ts, tsconfig.json, src/style.css (with @import "tailwindcss"),
#    and the @ alias in both vite.config.ts and tsconfig.json.
#    The CLI reads these to decide where to write and how to rewrite CSS.

# 3. Initialize shadcn-vue with the project preset (ADR-07).
#    -c apps/web targets the app directory. The CLI resolves its config
#    against the cwd and does NOT traverse upward, so this must be given
#    (or the command must be run with apps/web as the cwd). The user's
#    preset is passed through unchanged.
pnpm dlx shadcn-vue@latest init -c apps/web --preset a5RaS2BE --template vite

# 4. Add the components Week 3 uses.
pnpm dlx shadcn-vue@latest add -c apps/web button input label card alert dropdown-menu avatar badge

# 5. Format what the CLI wrote — it does not run Prettier itself.
pnpm format
```

`-c apps/web` is equivalent to running both commands with `apps/web` as the working directory; it is written explicitly here because it is unambiguous in a script and because the CLI does not search upward for `package.json`. Either form writes `components.json`, `src/lib/utils.ts`, and `src/components/ui/**` **inside the app** rather than at the repo root.

`init` rewrites `src/style.css`; the brand `@theme` block from §6.3 is appended **after** init, never before, so the CLI's write does not clobber it.

If the preset already contains the component set, step 4 is a no-op for those components and only the missing ones are written.

**Verify after init, before writing any app code:** `components.json` exists in `apps/web/` (not the repo root), its `tailwind.css` path points at `src/style.css`, and its aliases use the `@/` prefix that matches `tsconfig.json`. All three are what make `@/components/ui/button` resolve; a mismatch surfaces later as an unresolvable import rather than as a clear error at init time.

### 6.4 Routing and Guards (`src/router/index.ts`)

| Path | Component | `meta.requiresAuth` | Guard behaviour |
|---|---|---|---|
| `/` | — | — | redirect → `/dashboard` |
| `/login` | `LoginView` | `false` | if authenticated → `/dashboard` |
| `/register` | `RegisterView` | `false` | if authenticated → `/dashboard` |
| `/dashboard` | `DashboardView` | `true` | if unauthenticated → `/login?redirect=<intended>` |
| `/:pathMatch(.*)*` | `NotFoundView` | — | 404 |

The global guard is `async` and calls `authStore.restore()` **once** before deciding, guarded by a store flag so it does not re-run on every navigation. `restore()` is what makes a page refresh on `/dashboard` work: it reads tokens from the adapter and validates them with `GET /api/users/me`. Without this, a refresh would bounce an authenticated user to `/login` because the in-memory store starts empty.

Redirect targets are preserved: `/dashboard?tab=agents` redirects to `/login?redirect=/dashboard%3Ftab%3Dagents`, and a successful login returns the user there.

### 6.5 Auth Store (`src/stores/auth.ts`)

```typescript
interface AuthState {
  user: User | null;
  status: 'idle' | 'loading' | 'authenticated' | 'error';
  error: string | null;
  restored: boolean;              // guards one-time restore
}
```

**Getters:** `isAuthenticated` (true when `user !== null && status === 'authenticated'`).

**Actions:**

| Action | Behaviour |
|---|---|
| `restore()` | No-op if `restored` is true. Reads the access token from the adapter; if absent, sets `idle` and returns. If present, calls `fetchMe()`; on failure clears tokens and resets to `idle`. Sets `restored = true` either way. |
| `login(username, password)` | Sets `loading`, calls `api.auth.login`, then `fetchMe()`, sets `authenticated`. On `ApiError` sets `error` to `err.message` and status `error`. |
| `register({ username, email, password })` | Calls `generateUserKeyPair()` from `@remote/crypto`, then `api.auth.register({ username, email, password, publicKey: publicKeySpkiBase64 })`, then `savePrivateKey(user.id, privateKey)`, then `fetchMe()`. |
| `logout()` | Reads the refresh token, calls `api.auth.logout(refreshToken)` (best-effort — a failure does not block local logout), clears tokens, resets state. |
| `fetchMe()` | Calls `api.users.me()` and assigns `user`. |
| `clearError()` | Sets `error = null`. |

The store subscribes to the client's `onAuthError` at construction: when a refresh fails, it clears its own state so the UI reflects the logged-out condition immediately, and the router guard sends the user to `/login` on the next navigation.

### 6.6 Token Storage (`src/services/token-storage.ts`)

A `localStorage`-backed `TokenStorageAdapter` under keys `remote.accessToken` and `remote.refreshToken`. Reads and writes are wrapped in `try`/`catch`: `localStorage` throws in some privacy modes, and a storage failure must degrade to an in-memory session rather than crash the app.

### 6.7 Views and Components

Every element below is a **shadcn-vue component** (ADR-07) unless the row says otherwise. Nothing in Week 3 is hand-rolled from raw HTML elements except layout containers.

| Component | Built from | Responsibility |
|---|---|---|
| `App.vue` | — | Renders `AppLayout` with a `RouterView` slot. |
| `AppLayout.vue` | — | Page shell: `AppHeader` plus the routed view. |
| `AppHeader.vue` | `Button`, `DropdownMenu`, `Avatar`, `Badge`, `ThemeToggle` | Product name; when authenticated, an `Avatar` + `DropdownMenu` containing the username, a `Badge` for status, and a Logout item; when not, `Button` links to Login and Register. |
| `ThemeToggle.vue` | `Button` (ghost, icon size) | Sun/Moon icon button calling `useTheme().toggle()`. `aria-label` reflects the action. |
| `LoginForm.vue` | `Card`, `Label`, `Input`, `Button`, `Alert` | Username + password fields, client-side required validation, inline error display via `Alert` (`variant="destructive"`), disabled submit while `loading`, emits `submit`. |
| `RegisterForm.vue` | `Card`, `Label`, `Input`, `Button`, `Alert` | Username (≥ 3), email (required, format-checked), password (≥ 8), confirm password (must match). Per-field validation messages; errors surfaced in an `Alert`. Emits `submit`. |
| `LoginView.vue` | `Card`, `LoginForm` | Renders `LoginForm`; on submit calls `authStore.login`, then redirects to `route.query.redirect` or `/dashboard`. |
| `RegisterView.vue` | `Card`, `RegisterForm` | Renders `RegisterForm`; on submit calls `authStore.register`; on success redirects to `/dashboard`. |
| `DashboardView.vue` | `Card`, `Badge`, `Alert`, `Button` | On mount calls `authStore.fetchMe()` if needed, plus `api.devices.list()` and `api.agents.list()`. Renders the username, and device and agent tables (or empty states). Shows a loading state and a retry `Button` on error. |
| `NotFoundView.vue` | `Button` | 404 with a link home. |

**Customization over the copied source.** shadcn components are edited in place, not wrapped. The project's brand colour is applied by editing the copied `button` variants (`class-variance-authority` `variants.variant`) to add a `brand` variant that uses `bg-brand-600 hover:bg-brand-700`, rather than by overriding from outside. Any change to a copied component is made in `src/components/ui/**` and is reviewed like ordinary source.

Validation lives in the form components so it can be tested without mounting a view or a router. `RegisterForm` performs **no** crypto: it emits plain fields, and `authStore.register` owns keypair generation. This keeps the keypair flow in one testable place.

Form components use shadcn's `Input` and `Label` but bind with plain `v-model` on native inputs — the generated `Input` forwards all attributes and emits, so no extra adapter is needed. `Alert` is rendered conditionally with `v-if`, not toggled by CSS, so tests assert on its presence rather than on a class.

### 6.8 Theme Composable (`src/composables/useTheme.ts`)

```typescript
export type Theme = 'light' | 'dark';

export interface UseTheme {
  theme: Ref<Theme>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: Theme): void;
}

export function useTheme(): UseTheme;
```

- **Initial value:** `localStorage['remote.theme']` if it is exactly `'light'` or `'dark'`; otherwise `window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`.
- **Application:** a `watchEffect` adds or removes the `dark` class on `document.documentElement`. shadcn's `@custom-variant dark (&:is(.dark *))` keys off exactly this class, so no other CSS work is needed.
- **Persistence:** `toggle()` is implemented as `set(theme === 'dark' ? 'light' : 'dark')`, and **`set()` is the only function that writes to storage** — the `try`/`catch` lives there, not in `toggle()`. Test case 15 asserts the observable consequence (`toggle()` still applies the class when `setItem` throws); the implementer should not add a second guard in `toggle()`.
- **Module-level singleton state:** the refs live at module scope, so every `useTheme()` caller shares one source of truth and two toggles cannot disagree. This is the reason a Pinia store is unnecessary here (ADR-08).
- **Test hook:** an exported `resetTheme()` clears the module state and the stored value, so tests do not leak into one another.

### 6.9 Tests

**`auth-store.test.ts`** — mocks `@remote/api-client` and `@remote/crypto` with `vi.mock`.

1. `login` with valid credentials sets `user` and `status: 'authenticated'`.
2. `login` failure sets `error` and leaves `status: 'error'`.
3. `register` calls `generateUserKeyPair` and passes `publicKeySpkiBase64` to the API.
4. `register` persists the private key with the returned user ID.
5. `logout` calls the API, clears tokens, and resets state.
6. `restore()` with no stored token leaves the store `idle` and does not call the API.
7. `restore()` with a stored token calls `fetchMe` and sets `authenticated`.
8. `restore()` with an invalid stored token clears tokens and returns to `idle`.

**`router-guard.test.ts`** — a real router instance with mocked store state.

9. Unauthenticated navigation to `/dashboard` redirects to `/login` and sets `redirect`.
10. Authenticated navigation to `/dashboard` is allowed.
11. Authenticated navigation to `/login` redirects to `/dashboard`.

**`use-theme.test.ts`** — `document.documentElement` class assertions, with `localStorage` cleared and `resetTheme()` in `beforeEach`.

12. With no stored preference and `matchMedia` reporting dark, the initial theme is `dark` and `<html>` carries the `dark` class.
13. `toggle()` flips the class on `<html>` and persists the new value to `localStorage`.
14. A stored `'dark'` preference wins over `matchMedia` reporting light.
15. When `localStorage.setItem` throws, `toggle()` still applies the class and does not throw.

**`LoginForm.test.ts`**

16. Submitting empty fields shows validation messages and emits nothing.
17. A valid submit emits `submit` with the entered credentials.
18. The submit button is disabled while `loading`.

**`RegisterForm.test.ts`**

19. A mismatched password confirmation shows an error and does not emit.
20. A password shorter than 8 characters shows an error.
21. A malformed email shows an error.
22. A valid form emits `submit` with all four fields.

**Coverage boundary — what these tests do not assert.** Per finding F10, happy-dom's `ResizeObserver` is a no-op, so `@floating-ui/dom` computes a position once and never updates it. Every assertion above is on DOM presence, emitted events, class state, or ARIA attributes — never on computed coordinates, and never on a dropdown's or alert's rendered position. A test that needs real floating positioning must stub `ResizeObserver` and drive the re-render itself; Week 3 deliberately does not, because none of its user-visible behaviour depends on it. Writing a positioning assertion here would produce a test that passes for the wrong reason.

### 6.10 Environment Configuration

`.env.example`:
```env
VITE_API_URL=http://localhost:8787
```

`env.d.ts` types `ImportMetaEnv` with `readonly VITE_API_URL: string`. `services/client.ts` reads it with a `http://localhost:8787` fallback so a missing `.env` does not break local development.

---

## 7. Workspace, Toolchain, and CI Integration

### 7.1 `pnpm-workspace.yaml` — the `vue-demi` build allowance

A **hard prerequisite** for the shadcn-vue install, per finding F9. The file must stay in block style; inline JSON flow style breaks pnpm with `ERR_PNPM_WORKSPACE_MANIFEST_WRITER_UNSUPPORTED_INLINE_BLOCK`.

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'workers/*'

allowBuilds:
  esbuild: true
  workerd: true
  vue-demi: true

minimumReleaseAgeExclude:
  - miniflare@5.20260923.0-alpha
  - wrangler@4.139.0
```

`reka-ui → @floating-ui/vue → vue-demi` has a `postinstall` script. Without this line, `pnpm add reka-ui` — which `shadcn-vue init` runs internally — fails with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: vue-demi@0.14.10`. This change is made **before** `shadcn-vue init` runs (step 1 of §6.3.1), not after.

### 7.2 Root `eslint.config.js`

Extended per findings F5 and F6 — the Vue plugins are root devDependencies, and only `flat/essential` is enabled so Prettier remains the formatting authority.

**The single-word component rule:** `flat/essential` enables `vue/multi-word-component-names: error`. shadcn-vue writes `Button.vue`, `Input.vue`, `Label.vue`, `Card.vue`, `Alert.vue`, `Badge.vue`, and `Avatar.vue` — all single words — into `apps/web/src/components/ui/**`. That rule is therefore **disabled** for `src/components/ui/**`, while remaining enabled everywhere else in the project (views and app components like `LoginForm.vue` and `RegisterForm.vue` must stay multi-word):

```javascript
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/target/**', 'docs/**'],
  },
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2024,
        sourceType: 'module',
      },
    },
  },
  {
    // shadcn-vue generates single-word component names by convention (Button.vue, Card.vue, etc.)
    files: ['apps/web/src/components/ui/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.vue', 'workers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
);
```

The `workers/**/*.ts` glob is preserved from the current config so backend lint rules do not change.

**On linting the copied shadcn components:** `apps/web/src/components/ui/**` is **not** ignored — per ADR-07 the copied source is ours to edit, so it is held to the same rules as the rest of the app, minus the single-word exemption above. The generated components use `<script setup lang="ts">` and pass `flat/essential`, which contains no stylistic rules. If a future `shadcn-vue add` writes a component that fails lint, the fix is to correct the component, not to add an ignore.

### 7.3 Turborepo

`turbo.json` needs no change. Its `lint`, `typecheck`, and `test` tasks are unconfigured passthroughs, and `apps/web` plus the two new packages each declare those three scripts — so `pnpm lint`, `pnpm typecheck`, and `pnpm test` pick them up automatically. The `typecheck` task's `dependsOn: ["^typecheck"]` already orders workspace dependencies correctly.

### 7.4 Root `package.json`

Add `"dev:web": "pnpm --filter @remote/web dev"` alongside the existing `deploy:workers` and `db:migrate:prod` shortcuts.

### 7.5 GitHub Actions

`.github/workflows/ci.yml` needs no change: it already runs `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `pnpm test`, all of which are Turborepo-wide.

CI does not run `shadcn-vue init` — `components.json`, `src/lib/utils.ts`, and `src/components/ui/**` are committed, so the components exist on a clean checkout. The only CI-visible effect of ADR-07 is the `vue-demi` build allowance in `pnpm-workspace.yaml`, which makes `pnpm install --frozen-lockfile` run that postinstall as it does locally.

### 7.6 `.prettierignore`

No change. `dist` and `node_modules` are already ignored, which covers `apps/web/dist`. `components.json` is deliberately **not** ignored: it is a tracked JSON file, and running `pnpm format` after init (step 5 of §6.3.1) normalizes whatever formatting the CLI produced.

### 7.7 Local Development

Two terminals:
```bash
pnpm --filter @remote/signaling dev   # Worker on http://localhost:8787
pnpm dev:web                          # Vite on http://localhost:5173
```

The Worker requires local D1 migrations to have been applied (`pnpm --filter @remote/signaling db:migrate:local`) and local secrets to be present for JWT signing.

---

## 8. Review Focus & Edge Cases

The failure modes most likely to reach a user, each pinned to the task that owns it.

1. **Concurrent 401s cause a refresh stampede.** A dashboard loading user, devices, and agents fires three requests together; when the access token has expired all three return 401. If each refreshes independently, the backend accepts one refresh token and rejects the others, logging the user out mid-session. *Expected:* exactly one `POST /api/auth/refresh`, all three original requests retried and succeeded. Owned by the API client's refresh queue (ADR-03), pinned by `refresh-queue.test.ts` case 7.
2. **Infinite refresh loop.** A 401 on `/api/auth/refresh` itself, or on a request already retried once, must terminate. *Expected:* auth paths are exempt from refresh, and a retried request throws on a second 401. Pinned by cases 8 and 9.
3. **Private key exposure.** The E2EE private key must never be transmitted or written in extractable form. *Expected:* only `publicKeySpkiBase64` appears in the register request body, and the stored `CryptoKey` has `extractable === false`. Pinned by `auth-store.test.ts` case 3 and `packages/crypto` test 1.
4. **Refresh on `/dashboard` bounces an authenticated user to login.** After an F5, the in-memory store is empty; a guard that checks only store state redirects to `/login` before `restore()` completes. *Expected:* the guard awaits `restore()`, which validates the stored token, and the user stays on `/dashboard`. Pinned by `router-guard.test.ts` case 10.
5. **Logout that only clears local state.** Clearing tokens without calling `POST /api/auth/logout` leaves the access and refresh tokens valid server-side until natural expiry. *Expected:* logout sends the refresh token so the backend revokes both JTIs, and a failure to do so does not prevent local logout. Pinned by `auth-store.test.ts` case 5.
6. **Storage that throws.** `localStorage` throws in some privacy modes; an unguarded read would crash the app on boot. *Expected:* reads and writes are wrapped, and the app degrades to an in-memory session. Pinned by `token-storage` handling in `auth-store.test.ts` case 6.
7. **A theme toggle that looks broken in dark mode.** A hardcoded colour — `text-black`, `bg-white`, or a raw hex — renders unreadable against the `.dark` background, and shadcn's generated components are already theme-aware, so the defect appears only where custom styling was added. *Expected:* every custom colour goes through a token (`bg-primary`, `text-muted-foreground`) or the brand palette, never a literal light/dark-only value. Pinned by `use-theme.test.ts` cases 12–15 asserting the class is applied, which is what every `dark:` variant and shadcn token depends on.
8. **Two `useTheme()` callers disagreeing.** Independent per-call state means the header toggle and any future consumer can hold different themes, and the class on `<html>` flickers as they reconcile. *Expected:* module-level singleton state, so all callers share one ref. Pinned by `use-theme.test.ts` case 13 (toggle applies the class globally) plus the `resetTheme()` hook in `beforeEach`.
9. **`shadcn-vue init` failing on a clean checkout.** The command is a prerequisite for the entire UI layer, and it fails opaquely — `ERR_PNPM_IGNORED_BUILDS` — if `vue-demi: true` is missing from `allowBuilds`. *Expected:* `pnpm-workspace.yaml` carries the allowance before init runs (§7.1, step 1 of §6.3.1). Pinned by the sequence itself; a reviewer should confirm the `allowBuilds` entry is present in the committed diff.

---

## 9. Delivery Sequence

Three tasks, each independently testable and reviewable.

| Task | Deliverable | Depends on |
|---|---|---|
| **Task 1** | `packages/crypto` — keypair generation, SPKI serialization, IndexedDB storage, 7 tests | — |
| **Task 2** | `packages/api-client` — `HttpClient`, refresh queue, five resources, 10 tests | Task 1 not required; `@remote/shared` only |
| **Task 3** | `apps/web` — Vite/Vue/Tailwind scaffold, shadcn-vue init + components, dark mode, router + guard, auth store, forms and views, 22 tests; plus `pnpm-workspace.yaml` (`vue-demi`), root ESLint, root `package.json`, and `.env.example` updates | Tasks 1 and 2 |

Tasks 1 and 2 are independent of each other. Task 3 consumes both, and begins with the `pnpm-workspace.yaml` change — nothing in Task 3's UI layer works until `shadcn-vue init` succeeds.

**Total new tests:** 39 (7 + 10 + 22), taking the repository from 46 to 85.
