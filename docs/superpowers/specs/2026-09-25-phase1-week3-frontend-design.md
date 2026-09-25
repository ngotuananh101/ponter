# Phase 1 Week 3 — Frontend Foundation Design Specification

**Status:** Approved
**Date:** 2026-09-25
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 1 Week 3 of `docs/ARCHITECTURE.md` (Section 8: Frontend Foundation)

---

## 1. Executive Summary & Goals

This specification details the architecture, design, and implementation plan for **Phase 1, Week 3: Frontend Foundation** of the remote access platform.

Week 2 delivered a working backend (`workers/signaling`, 46 tests passing) exposing auth, users, devices, agents, and sessions over HTTP. Week 3 delivers the first client that consumes it: a Vue 3 web application with real authentication, plus the two reusable packages it needs.

### Goals

1. Implement **`packages/crypto`** — client-side ECDH P-256 keypair generation via the native Web Crypto API, with the private key persisted in the browser and never transmitted.
2. Implement **`packages/api-client`** — a typed, environment-agnostic HTTP SDK for the Week 2 REST API, with automatic token refresh and a concurrency-safe refresh queue.
3. Implement **`apps/web`** — a Vue 3 + Vite + TailwindCSS v4 single-page application with Pinia state and Vue Router.
4. Deliver a working **auth flow**: register (with client-generated keypair), login, logout, session restore, and protected routing.
5. Deliver a **dashboard** that proves the authenticated session works end-to-end by rendering the current user and their registered devices and agents.
6. Extend the **CI pipeline** so `lint`, `typecheck`, and `test` cover the new packages and application.

### Non-Goals (deferred)

- WebRTC, terminal, desktop streaming, and file manager UI (Phases 2–4).
- WebAuthn (backend returns HTTP 501; Phase 5).
- E2EE encryption/decryption of payloads (Phase 5) — Week 3 generates and stores the keypair only.
- `packages/ui-components` extraction (deferred until `apps/desktop` needs the same components).
- Desktop and mobile applications.

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

`typescript` stays pinned at `6.0.3` and `eslint` at `10.11.0` per the existing Global Constraints.

---

## 3. Architectural Decision Records (ADRs)

### ADR-01: Extract `packages/crypto` and `packages/api-client` now, defer `packages/ui-components`

- **Context:** `docs/ARCHITECTURE.md` §3.1 declares `apps/web` as depending on five workspace packages (`shared`, `api-client`, `webrtc-core`, `terminal-core`, `ui-components`). Of these, only `packages/shared` currently contains code; `api-client`, `crypto`, `ui-components`, `webrtc-core`, and `terminal-core` are stubs whose `lint`/`typecheck` scripts are `echo ok`. Week 3 needs a crypto primitive and an HTTP client to deliver a working auth flow.
- **Decision:** Implement **`packages/crypto`** and **`packages/api-client`** as real packages in Week 3, and defer **`packages/ui-components`** to the week that `apps/desktop` first needs shared components.
- **Rationale:** Crypto and HTTP are the two pieces where duplication across `apps/web`, `apps/desktop`, and `apps/mobile` would be genuinely expensive and where logic is subtle enough to warrant its own test suite. UI components, by contrast, are the most volatile part of the system and the most expensive to package correctly: shipping Vue SFCs through a pnpm workspace with Tailwind v4 requires bundler configuration that would consume much of the week for components only one app currently uses. Extracting them later is a mechanical refactor; getting them wrong now is a week lost.
- **Consequence:** `apps/web` will import auth components from `apps/web/src/components/`. When `apps/desktop` needs them, the move to `packages/ui-components` is a file move plus an import rewrite. `packages/webrtc-core` and `packages/terminal-core` remain stubs until Phases 2 and 4.

### ADR-02: Client-generated ECDH P-256 keypair at registration

- **Context:** `POST /api/auth/register` **requires** a `publicKey` field (it returns HTTP 400 `VALIDATION_ERROR` without one), and the `users` table stores it as a NOT NULL column. This is the foundation of the platform's zero-trust E2EE design (`docs/ARCHITECTURE.md` §7.2), but Week 3's roadmap does not include any cryptography work.
- **Decision:** Generate the keypair **in the browser** at registration time using the native Web Crypto API — ECDH over curve P-256. Send only the **public** key to the backend, SPKI-encoded as base64. Persist the **private** key in IndexedDB as a non-extractable `CryptoKey`, keyed by the user ID returned from registration.
- **Rationale:** ECDH P-256 is the key-agreement primitive the E2EE design needs, and Web Crypto is available natively in every target environment with no dependency to audit. Generating the keypair at registration means the user's identity is bound to a key they alone hold from the first moment. Making the private key non-extractable (verified in finding F3) means even a successful XSS cannot read the raw key material out of the browser — it can only be *used* in place.
- **Consequence:** `savePrivateKey` is called with the `user.id` returned by the backend, so registration and key persistence are two steps that must both succeed. If key storage fails, the user account exists but has no local private key; Week 3 surfaces this as an error rather than silently continuing. Actual encryption/decryption with this key arrives in Phase 5.

### ADR-03: Concurrency-safe token refresh in the API client

- **Context:** Access tokens expire after 15 minutes (`JWT_EXPIRES_IN`). A dashboard that loads the user plus their devices and agents fires several requests concurrently. When the access token has expired, every one of those requests returns HTTP 401 at the same moment.
- **Decision:** Implement a single-flight refresh queue inside `HttpClient`. On a 401 from a non-auth endpoint, the first caller starts the refresh; every subsequent 401 while a refresh is in flight is parked in a queue and retried with the new token once it resolves. Requests to `/api/auth/login` and `/api/auth/refresh` are exempt, so a failing refresh cannot recurse.
- **Rationale:** The naive implementation — refresh on every 401 — sends N concurrent refresh calls, of which the backend accepts one and rejects the rest (the refresh token is single-use in practice once revocation is involved). The losing requests then log the user out. A queue collapses N refreshes into one and makes the concurrent case indistinguishable from the single-request case.
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

### ADR-06: Local development uses the Vite dev proxy for the API

- **Context:** The Worker dev server runs on `http://localhost:8787` and the Vite dev server on `http://localhost:5173`. Browsers enforce CORS on cross-origin requests, and the Worker's CORS middleware currently allows `origin: '*'`.
- **Decision:** Configure `VITE_API_URL` (default `http://localhost:8787`) as the client's base URL, and rely on the backend's existing permissive CORS for Week 3. Do **not** add a Vite proxy yet.
- **Rationale:** The backend already sends `Access-Control-Allow-Origin: *` with `Authorization` in `allowHeaders`, so direct cross-origin calls work today without extra configuration. Adding a proxy would introduce a second, dev-only code path that behaves differently from production, where the app will call the Worker's real URL.
- **Consequence:** The client always talks to an absolute base URL, identically in dev and production — only the value of `VITE_API_URL` changes. Tightening CORS to an explicit origin allowlist is deferred to Phase 5 (Security & Polish); when that happens, `origin: '*'` must be replaced with the deployed web origin, and localhost dev will need to be included explicitly.

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
│       ├── agents.ts     # list, create, get, update, remove
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
├── tsconfig.json
├── vite.config.ts                  # vue + tailwindcss plugins only
├── vitest.config.ts                # happy-dom, fake-indexeddb setup
├── env.d.ts                        # ImportMetaEnv typing for VITE_API_URL
├── .env.example
└── src/
    ├── main.ts
    ├── App.vue
    ├── style.css                   # @import "tailwindcss" + @theme tokens
    ├── test-setup.ts               # imports fake-indexeddb/auto
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
    ├── components/
    │   ├── layout/
    │   │   ├── AppLayout.vue
    │   │   └── AppHeader.vue
    │   └── auth/
    │       ├── LoginForm.vue
    │       └── RegisterForm.vue
    └── __tests__/
        ├── auth-store.test.ts
        ├── router-guard.test.ts
        ├── LoginForm.test.ts
        └── RegisterForm.test.ts
```

### 6.2 Build Configuration

Two config files, per finding F1:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
});
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```

`tsconfig.json` extends `../../tsconfig.base.json` and adds `"lib": ["ES2024", "DOM", "DOM.Iterable"]`, `"jsx": "preserve"`, `"types": ["vite/client"]`, and `"include"` covering `src/**/*.ts`, `src/**/*.vue`, and both config files. `tsconfig.base.json` sets `lib: ["ES2024"]` only, which lacks the DOM types Vue SFCs require.

### 6.3 Styling

`src/style.css` imports Tailwind and declares the token palette:

```css
@import "tailwindcss";

@theme {
  --color-brand-50: oklch(0.97 0.02 259);
  --color-brand-500: oklch(0.62 0.19 259);
  --color-brand-600: oklch(0.55 0.19 259);
  --color-brand-700: oklch(0.48 0.18 259);
}
```

These become `bg-brand-500`, `text-brand-600`, and so on (verified reaching the built CSS in finding F3's smoke build).

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

| Component | Responsibility |
|---|---|
| `App.vue` | Renders `AppLayout` with a `RouterView` slot. |
| `AppLayout.vue` | Page shell: `AppHeader` plus the routed view. |
| `AppHeader.vue` | Product name; when authenticated, the username and a Logout button; when not, links to Login and Register. |
| `LoginForm.vue` | Username + password fields, client-side required validation, inline error display, disabled submit while `loading`, emits `submit`. |
| `RegisterForm.vue` | Username (≥ 3), email (required, format-checked), password (≥ 8), confirm password (must match). Client-side validation with per-field messages. Emits `submit`. |
| `LoginView.vue` | Renders `LoginForm`; on submit calls `authStore.login`, then redirects to `route.query.redirect` or `/dashboard`. |
| `RegisterView.vue` | Renders `RegisterForm`; on submit calls `authStore.register`; on success redirects to `/dashboard`. |
| `DashboardView.vue` | On mount calls `authStore.fetchMe()` if needed, plus `api.devices.list()` and `api.agents.list()`. Renders the username, and device and agent tables (or empty states). Shows a loading state and a retry affordance on error. |
| `NotFoundView.vue` | 404 with a link home. |

Validation lives in the form components so it can be tested without mounting a view or a router. `RegisterForm` performs **no** crypto: it emits plain fields, and `authStore.register` owns keypair generation. This keeps the keypair flow in one testable place.

### 6.8 Tests

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

**`LoginForm.test.ts`**

12. Submitting empty fields shows validation messages and emits nothing.
13. A valid submit emits `submit` with the entered credentials.
14. The submit button is disabled while `loading`.

**`RegisterForm.test.ts`**

15. A mismatched password confirmation shows an error and does not emit.
16. A password shorter than 8 characters shows an error.
17. A malformed email shows an error.
18. A valid form emits `submit` with all four fields.

### 6.9 Environment Configuration

`.env.example`:
```env
VITE_API_URL=http://localhost:8787
```

`env.d.ts` types `ImportMetaEnv` with `readonly VITE_API_URL: string`. `services/client.ts` reads it with a `http://localhost:8787` fallback so a missing `.env` does not break local development.

---

## 7. Workspace, Toolchain, and CI Integration

### 7.1 Root `eslint.config.js`

Extended per findings F5 and F6 — the Vue plugins are root devDependencies, and only `flat/essential` is enabled so Prettier remains the formatting authority:

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

### 7.2 Turborepo

`turbo.json` needs no change. Its `lint`, `typecheck`, and `test` tasks are unconfigured passthroughs, and `apps/web` plus the two new packages each declare those three scripts — so `pnpm lint`, `pnpm typecheck`, and `pnpm test` pick them up automatically. The `typecheck` task's `dependsOn: ["^typecheck"]` already orders workspace dependencies correctly.

### 7.3 Root `package.json`

Add `"dev:web": "pnpm --filter @remote/web dev"` alongside the existing `deploy:workers` and `db:migrate:prod` shortcuts.

### 7.4 GitHub Actions

`.github/workflows/ci.yml` needs no change: it already runs `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `pnpm test`, all of which are Turborepo-wide.

### 7.5 `.prettierignore`

No change. `dist` and `node_modules` are already ignored, which covers `apps/web/dist`.

### 7.6 Local Development

Two terminals:
```bash
pnpm --filter @remote/signaling dev   # Worker on http://localhost:8787
pnpm dev:web                          # Vite on http://localhost:5173
```

The Worker requires local D1 migrations to have been applied (`pnpm --filter @remote/signaling db:migrate:local`) and local secrets to be present for JWT signing.

---

## 8. Review Focus & Edge Cases

The five failure modes most likely to reach a user, each pinned to the task that owns it.

1. **Concurrent 401s cause a refresh stampede.** A dashboard loading user, devices, and agents fires three requests together; when the access token has expired all three return 401. If each refreshes independently, the backend accepts one refresh token and rejects the others, logging the user out mid-session. *Expected:* exactly one `POST /api/auth/refresh`, all three original requests retried and succeeded. Owned by the API client's refresh queue (ADR-03), pinned by `refresh-queue.test.ts` case 7.
2. **Infinite refresh loop.** A 401 on `/api/auth/refresh` itself, or on a request already retried once, must terminate. *Expected:* auth paths are exempt from refresh, and a retried request throws on a second 401. Pinned by cases 8 and 9.
3. **Private key exposure.** The E2EE private key must never be transmitted or written in extractable form. *Expected:* only `publicKeySpkiBase64` appears in the register request body, and the stored `CryptoKey` has `extractable === false`. Pinned by `auth-store.test.ts` case 3 and `packages/crypto` test 1.
4. **Refresh on `/dashboard` bounces an authenticated user to login.** After an F5, the in-memory store is empty; a guard that checks only store state redirects to `/login` before `restore()` completes. *Expected:* the guard awaits `restore()`, which validates the stored token, and the user stays on `/dashboard`. Pinned by `router-guard.test.ts` case 10.
5. **Logout that only clears local state.** Clearing tokens without calling `POST /api/auth/logout` leaves the access and refresh tokens valid server-side until natural expiry. *Expected:* logout sends the refresh token so the backend revokes both JTIs, and a failure to do so does not prevent local logout. Pinned by `auth-store.test.ts` case 5.
6. **Storage that throws.** `localStorage` throws in some privacy modes; an unguarded read would crash the app on boot. *Expected:* reads and writes are wrapped, and the app degrades to an in-memory session. Pinned by `token-storage` handling in `auth-store.test.ts` case 6.

---

## 9. Delivery Sequence

Three tasks, each independently testable and reviewable.

| Task | Deliverable | Depends on |
|---|---|---|
| **Task 1** | `packages/crypto` — keypair generation, SPKI serialization, IndexedDB storage, 7 tests | — |
| **Task 2** | `packages/api-client` — `HttpClient`, refresh queue, five resources, 10 tests | Task 1 not required; `@remote/shared` only |
| **Task 3** | `apps/web` — Vite/Vue/Tailwind scaffold, router + guard, auth store, forms and views, 18 tests; plus root ESLint, root `package.json`, and `.env.example` updates | Tasks 1 and 2 |

Tasks 1 and 2 are independent of each other. Task 3 consumes both.

**Total new tests:** 35 (7 + 10 + 18), taking the repository from 46 to 81.
