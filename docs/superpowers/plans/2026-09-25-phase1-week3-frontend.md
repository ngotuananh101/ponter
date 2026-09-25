# Phase 1 Week 3 — Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend foundation: two reusable packages (`packages/crypto` for client-side ECDH P-256 keypair generation & IndexedDB storage; `packages/api-client` for typed HTTP communication with concurrency-safe single-flight token refresh) and a Vue 3 SPA (`apps/web`) styled with TailwindCSS v4 and shadcn-vue with dark mode, full authentication flow, and authenticated dashboard.

**Architecture:** Monorepo architecture with raw-TypeScript workspace package exports consumed directly by Vite and Vitest. `packages/crypto` leverages native Web Crypto API and IndexedDB (`remote-crypto` DB) with non-extractable private keys. `packages/api-client` exposes typed resources wrapping native `fetch` with a single-flight token refresh mutex queue preventing 401 refresh stampedes. `apps/web` integrates Vue 3, Pinia 4, Vue Router 5, and `@tailwindcss/vite`, using shadcn-vue (`reka-ui` primitives) initialized with custom template `--preset a5RaS2BE --template vite` and class-based dark mode persisted in localStorage.

**Tech Stack:** Vue 3.5.43, Vue Router 5.3.1, Pinia 4.0.3, Vite 8.3.1, TailwindCSS 4.3.3, `@tailwindcss/vite` 4.3.3, shadcn-vue 2.8.2 (`reka-ui` 2.10.5, `cva`, `clsx`, `tailwind-merge`), Vitest 5.0.1, `happy-dom` 20.14.5, `@vue/test-utils` 2.5.1, `fake-indexeddb` 6.2.5, TypeScript 6.0.3, pnpm 12.6.0, Turborepo 2.11.3.

**Spec:** `docs/superpowers/specs/2026-09-25-phase1-week3-frontend-design.md`

## Global Constraints

- Root `packageManager` is `pnpm@12.6.0`.
- TypeScript is pinned at `6.0.3` across all packages (`tsconfig.base.json` extends with `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`, `strict: true`).
- `baseUrl` is deprecated in TypeScript 6 (`TS5101`); path aliases must be declared as `paths: { "@/*": ["./src/*"] }` without `baseUrl`.
- Dual Vite/Vitest separation: Vitest 5 rejects `test` in Vite's `defineConfig` (`TS2769`); requires separate `vite.config.ts` and `vitest.config.ts`, with `@` alias declared in both.
- Version isolation in monorepo: `workers/signaling` uses Vitest `^4.1.0` (required by `@cloudflare/vitest-pool-workers`), whereas `apps/web` and new packages use Vitest `5.0.1`. Never hoist vitest to root devDependencies.
- Prettier ignore covers `docs/`, `.remember/`, `.superpowers/`. Root Prettier uses `{ "singleQuote": true }`.
- ESLint 10 flat config at repository root; Vue plugins (`eslint-plugin-vue`, `vue-eslint-parser`) installed at root using `flat/essential` only to prevent style conflicts with Prettier.
- shadcn-vue single-word component naming convention is exempted in root ESLint config specifically for `apps/web/src/components/ui/**/*.vue`.
- Supply-chain build gate: `pnpm-workspace.yaml` `allowBuilds` must include `vue-demi: true` so `reka-ui` postinstall script executes during `shadcn-vue init`.
- The user preset `--preset a5RaS2BE` is treated as an opaque user template input; do not investigate or reverse-engineer it.
- Non-extractable cryptography: Web Crypto ECDH P-256 private key must be generated with `extractable: false` and never transmitted across the wire or leaked in error logs. Only SPKI base64 public key is sent to the backend.

## Review Focus

- **Concurrent 401s cause a refresh stampede:** A dashboard loading user, devices, and agents fires three requests together; when the access token has expired all three return 401. If each refreshes independently, the backend accepts one refresh token and rejects the others, logging the user out mid-session. Expected: exactly one `POST /api/auth/refresh`, all three original requests retried and succeeded. Owned by the API client's refresh queue (ADR-03), pinned by `refresh-queue.test.ts` case 7.
- **Infinite refresh loop:** A 401 on `/api/auth/refresh` itself, or on a request already retried once, must terminate. Expected: auth paths are exempt from refresh, and a retried request throws on a second 401. Pinned by cases 8 and 9.
- **Private key exposure:** The E2EE private key must never be transmitted or written in extractable form. Expected: only `publicKeySpkiBase64` appears in the register request body, and the stored `CryptoKey` has `extractable === false`. Pinned by `auth-store.test.ts` case 3 and `packages/crypto` test 1.
- **Refresh on `/dashboard` bounces an authenticated user to login:** After an F5, the in-memory store is empty; a guard that checks only store state redirects to `/login` before `restore()` completes. Expected: the guard awaits `restore()`, which validates the stored token, and the user stays on `/dashboard`. Pinned by `router-guard.test.ts` case 10.
- **Logout that only clears local state:** Clearing tokens without calling `POST /api/auth/logout` leaves the access and refresh tokens valid server-side until natural expiry. Expected: logout sends the refresh token so the backend revokes both JTIs, and a failure to do so does not prevent local logout. Pinned by `auth-store.test.ts` case 5.

---

### Task 1: Package `packages/crypto` — Keypair Generation & Storage

**Files:**
- Modify: `packages/crypto/package.json`
- Create: `packages/crypto/tsconfig.json`
- Create: `packages/crypto/vitest.config.ts`
- Create: `packages/crypto/src/index.ts`
- Create: `packages/crypto/test/crypto.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface UserKeyPair {
    publicKeySpkiBase64: string;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  }
  export function generateUserKeyPair(): Promise<UserKeyPair>;
  export function exportPublicKeySpki(key: CryptoKey): Promise<string>;
  export function importPublicKeySpki(spkiBase64: string): Promise<CryptoKey>;
  export function savePrivateKey(userId: string, key: CryptoKey): Promise<void>;
  export function loadPrivateKey(userId: string): Promise<CryptoKey | null>;
  export function deletePrivateKey(userId: string): Promise<void>;
  ```

- [ ] **Step 1: Configure `packages/crypto/package.json`, `tsconfig.json`, and `vitest.config.ts`**

Update `packages/crypto/package.json`:
```json
{
  "name": "@remote/crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "fake-indexeddb": "6.2.5",
    "typescript": "6.0.3",
    "vitest": "5.0.1"
  }
}
```

Create `packages/crypto/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/crypto/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 2: Write failing unit tests for `packages/crypto`**

Create `packages/crypto/test/crypto.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  generateUserKeyPair,
  exportPublicKeySpki,
  importPublicKeySpki,
  savePrivateKey,
  loadPrivateKey,
  deletePrivateKey,
} from '../src/index';

describe('packages/crypto', () => {
  beforeEach(async () => {
    // Clear IndexedDB between tests
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((resolve, reject) => {
      req.onsuccess = resolve;
      req.onerror = reject;
    });
  });

  it('1. generateUserKeyPair returns a base64 SPKI string and non-extractable private key', async () => {
    const pair = await generateUserKeyPair();
    expect(typeof pair.publicKeySpkiBase64).toBe('string');
    expect(pair.publicKeySpkiBase64.length).toBeGreaterThan(50);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.type).toBe('private');
    expect(pair.publicKey.type).toBe('public');
    expect(pair.privateKey.algorithm.name).toBe('ECDH');
  });

  it('2. exportPublicKeySpki -> importPublicKeySpki round-trips to a key that derives bits against a peer', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();

    const aliceExported = await exportPublicKeySpki(alice.publicKey);
    const aliceImported = await importPublicKeySpki(aliceExported);

    const bobBitsWithOriginal = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: alice.publicKey },
      bob.privateKey,
      256,
    );

    const bobBitsWithImported = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: aliceImported },
      bob.privateKey,
      256,
    );

    expect(new Uint8Array(bobBitsWithOriginal)).toEqual(
      new Uint8Array(bobBitsWithImported),
    );
  });

  it('3. The generated private key derives bits against the returned public key', async () => {
    const pair = await generateUserKeyPair();
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      pair.privateKey,
      256,
    );
    expect(bits.byteLength).toBe(32);
  });

  it('4. savePrivateKey -> loadPrivateKey persists a non-extractable CryptoKey that still derives bits', async () => {
    const pair = await generateUserKeyPair();
    const userId = 'user-test-123';

    await savePrivateKey(userId, pair.privateKey);
    const loaded = await loadPrivateKey(userId);

    expect(loaded).not.toBeNull();
    expect(loaded!.extractable).toBe(false);

    const bitsWithOriginal = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      pair.privateKey,
      256,
    );

    const bitsWithLoaded = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pair.publicKey },
      loaded!,
      256,
    );

    expect(new Uint8Array(bitsWithOriginal)).toEqual(
      new Uint8Array(bitsWithLoaded),
    );
  });

  it('5. loadPrivateKey returns null for an unknown user ID', async () => {
    const loaded = await loadPrivateKey('non-existent-user');
    expect(loaded).toBeNull();
  });

  it('6. deletePrivateKey removes the record, and a subsequent load returns null', async () => {
    const pair = await generateUserKeyPair();
    const userId = 'user-delete-test';

    await savePrivateKey(userId, pair.privateKey);
    const loadedBefore = await loadPrivateKey(userId);
    expect(loadedBefore).not.toBeNull();

    await deletePrivateKey(userId);
    const loadedAfter = await loadPrivateKey(userId);
    expect(loadedAfter).toBeNull();
  });

  it('7. deletePrivateKey for a missing user ID does not throw (idempotent)', async () => {
    await expect(deletePrivateKey('never-existed')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run Vitest to verify tests fail before implementation**

Run:
```bash
pnpm --filter @remote/crypto test
```
Expected: FAIL (cannot find module `../src/index`).

- [ ] **Step 4: Implement `packages/crypto/src/index.ts`**

Create `packages/crypto/src/index.ts`:
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

const DB_NAME = 'remote-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

const ECDH_ALGORITHM: EcKeyGenParams = {
  name: 'ECDH',
  namedCurve: 'P-256',
};

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Generate an ECDH P-256 keypair for a new user identity. */
export async function generateUserKeyPair(): Promise<UserKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    ECDH_ALGORITHM,
    false, // extractable: false for private key
    ['deriveBits'],
  )) as CryptoKeyPair;

  const spkiBase64 = await exportPublicKeySpki(keyPair.publicKey);

  return {
    publicKeySpkiBase64: spkiBase64,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

/** Export a public key to SPKI base64 (the wire format for `user.publicKey`). */
export async function exportPublicKeySpki(key: CryptoKey): Promise<string> {
  const spkiBuffer = await crypto.subtle.exportKey('spki', key);
  return bufferToBase64(spkiBuffer);
}

/** Import a public key from SPKI base64. */
export async function importPublicKeySpki(spkiBase64: string): Promise<CryptoKey> {
  const buffer = base64ToBuffer(spkiBase64);
  return await crypto.subtle.importKey(
    'spki',
    buffer,
    ECDH_ALGORITHM,
    true, // extractable
    [],
  );
}

/** Persist a user's private key locally, keyed by user ID. */
export async function savePrivateKey(userId: string, key: CryptoKey): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(key, userId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Load a user's private key, or null if none is stored. */
export async function loadPrivateKey(userId: string): Promise<CryptoKey | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(userId);
    request.onsuccess = () => {
      db.close();
      const result = request.result;
      resolve(result instanceof CryptoKey ? result : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Remove a user's private key from local storage. */
export async function deletePrivateKey(userId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(userId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
```

- [ ] **Step 5: Run tests and typecheck for `packages/crypto`**

Run:
```bash
pnpm install
pnpm --filter @remote/crypto test
pnpm --filter @remote/crypto typecheck
pnpm --filter @remote/crypto lint
```
Expected: All 7 tests PASS, typecheck passes, lint passes.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/crypto/
git commit -m "feat(crypto): implement ECDH P-256 keypair generation and IndexedDB storage"
```

---

### Task 2: Package `packages/api-client` — HTTP Client & Refresh Queue

**Files:**
- Modify: `packages/api-client/package.json`
- Create: `packages/api-client/tsconfig.json`
- Create: `packages/api-client/vitest.config.ts`
- Create: `packages/api-client/src/types.ts`
- Create: `packages/api-client/src/errors.ts`
- Create: `packages/api-client/src/client.ts`
- Create: `packages/api-client/src/resources/auth.ts`
- Create: `packages/api-client/src/resources/users.ts`
- Create: `packages/api-client/src/resources/devices.ts`
- Create: `packages/api-client/src/resources/agents.ts`
- Create: `packages/api-client/src/resources/sessions.ts`
- Create: `packages/api-client/src/index.ts`
- Create: `packages/api-client/test/client.test.ts`
- Create: `packages/api-client/test/refresh-queue.test.ts`

**Interfaces:**
- Consumes: `@remote/shared` types (`User`, `Device`, `Agent`, `Session`, `LoginResponse`, `RegisterRequest`).
- Produces:
  ```typescript
  export class ApiClient {
    readonly auth: AuthResource;
    readonly users: UsersResource;
    readonly devices: DevicesResource;
    readonly agents: AgentsResource;
    readonly sessions: SessionsResource;
    constructor(config: ApiClientConfig);
  }
  export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details: unknown;
  }
  export function isApiError(value: unknown): value is ApiError;
  export interface TokenStorageAdapter {
    getAccessToken(): Promise<string | null> | string | null;
    getRefreshToken(): Promise<string | null> | string | null;
    setTokens(tokens: TokenPair): Promise<void> | void;
    clearTokens(): Promise<void> | void;
  }
  export interface ApiClientConfig {
    baseUrl: string;
    storage: TokenStorageAdapter;
    onAuthError?: AuthErrorHandler;
    fetch?: typeof fetch;
  }
  ```

- [ ] **Step 1: Configure `packages/api-client/package.json`, `tsconfig.json`, and `vitest.config.ts`**

Update `packages/api-client/package.json`:
```json
{
  "name": "@remote/api-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@remote/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "5.0.1"
  }
}
```

Create `packages/api-client/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/api-client/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 2: Create `packages/api-client/src/types.ts` and `src/errors.ts`**

Create `packages/api-client/src/types.ts`:
```typescript
import type { ApiError } from './errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStorageAdapter {
  getAccessToken(): Promise<string | null> | string | null;
  getRefreshToken(): Promise<string | null> | string | null;
  setTokens(tokens: TokenPair): Promise<void> | void;
  clearTokens(): Promise<void> | void;
}

export type AuthErrorHandler = (error: ApiError) => void;

export interface ApiClientConfig {
  baseUrl: string;
  storage: TokenStorageAdapter;
  onAuthError?: AuthErrorHandler;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  retried?: boolean;
}
```

Create `packages/api-client/src/errors.ts`:
```typescript
export interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    try {
      const data = (await response.json()) as ApiErrorPayload;
      return new ApiError(
        data.error || response.statusText || 'Unknown API Error',
        response.status,
        data.code || 'API_ERROR',
        data.details ?? null,
      );
    } catch {
      return new ApiError(
        response.statusText || `HTTP ${response.status}`,
        response.status,
        'NETWORK_ERROR',
        null,
      );
    }
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
```

- [ ] **Step 3: Create `packages/api-client/src/client.ts` with single-flight refresh queue**

Create `packages/api-client/src/client.ts`:
```typescript
import { ApiError } from './errors';
import type {
  ApiClientConfig,
  RequestOptions,
  TokenStorageAdapter,
  AuthErrorHandler,
} from './types';
import { AuthResource } from './resources/auth';
import { UsersResource } from './resources/users';
import { DevicesResource } from './resources/devices';
import { AgentsResource } from './resources/agents';
import { SessionsResource } from './resources/sessions';

export class HttpClient {
  readonly baseUrl: string;
  readonly storage: TokenStorageAdapter;
  readonly onAuthError?: AuthErrorHandler;
  private readonly customFetch: typeof fetch;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.storage = config.storage;
    this.onAuthError = config.onAuthError;
    this.customFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options.auth !== false) {
      const token = await this.storage.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const init: RequestInit = {
      method,
      headers,
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.customFetch(url, init);
    } catch (err) {
      throw new ApiError(
        err instanceof Error ? err.message : 'Network request failed',
        0,
        'NETWORK_ERROR',
        null,
      );
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      try {
        return (await response.json()) as T;
      } catch {
        return undefined as T;
      }
    }

    const isAuthPath =
      path.includes('/api/auth/login') ||
      path.includes('/api/auth/refresh') ||
      path.includes('/api/auth/register');

    if (
      response.status === 401 &&
      options.auth !== false &&
      !isAuthPath &&
      !options.retried
    ) {
      return await this.refreshAndRetry<T>(method, path, options);
    }

    throw await ApiError.fromResponse(response);
  }

  private async refreshAndRetry<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    if (this.refreshPromise === null) {
      this.refreshPromise = this.doRefresh();
    }

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }

    return await this.request<T>(method, path, { ...options, retried: true });
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = await this.storage.getRefreshToken();
    if (!refreshToken) {
      const err = new ApiError('No refresh token available', 401, 'UNAUTHORIZED');
      await this.storage.clearTokens();
      if (this.onAuthError) {
        this.onAuthError(err);
      }
      throw err;
    }

    try {
      const response = await this.customFetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        throw await ApiError.fromResponse(response);
      }

      const data = (await response.json()) as {
        token: string;
        refreshToken: string;
        expiresIn: number;
      };

      await this.storage.setTokens({
        accessToken: data.token,
        refreshToken: data.refreshToken,
      });
    } catch (error) {
      const apiErr =
        error instanceof ApiError
          ? error
          : new ApiError(
              error instanceof Error ? error.message : 'Refresh failed',
              401,
              'REFRESH_FAILED',
            );
      await this.storage.clearTokens();
      if (this.onAuthError) {
        this.onAuthError(apiErr);
      }
      throw apiErr;
    }
  }
}

export class ApiClient {
  readonly http: HttpClient;
  readonly auth: AuthResource;
  readonly users: UsersResource;
  readonly devices: DevicesResource;
  readonly agents: AgentsResource;
  readonly sessions: SessionsResource;

  constructor(config: ApiClientConfig) {
    this.http = new HttpClient(config);
    this.auth = new AuthResource(this.http);
    this.users = new UsersResource(this.http);
    this.devices = new DevicesResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.sessions = new SessionsResource(this.http);
  }
}
```

- [ ] **Step 4: Implement API Client Resources (`auth`, `users`, `devices`, `agents`, `sessions`)**

Create `packages/api-client/src/resources/auth.ts`:
```typescript
import type { HttpClient } from '../client';
import type { User, LoginResponse, RegisterRequest } from '@remote/shared';

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  publicKey: string;
}

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  async register(input: RegisterInput): Promise<LoginResponse> {
    const res = await this.http.request<LoginResponse>(
      'POST',
      '/api/auth/register',
      {
        body: input,
        auth: false,
      },
    );
    await this.http.storage.setTokens({
      accessToken: res.token,
      refreshToken: res.refreshToken,
    });
    return res;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await this.http.request<LoginResponse>('POST', '/api/auth/login', {
      body: { username, password },
      auth: false,
    });
    await this.http.storage.setTokens({
      accessToken: res.token,
      refreshToken: res.refreshToken,
    });
    return res;
  }

  async refresh(refreshToken: string): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
    return await this.http.request('POST', '/api/auth/refresh', {
      body: { refreshToken },
      auth: false,
    });
  }

  async logout(refreshToken?: string): Promise<{ success: boolean }> {
    const token = refreshToken || (await this.http.storage.getRefreshToken()) || undefined;
    try {
      return await this.http.request<{ success: boolean }>('POST', '/api/auth/logout', {
        body: token ? { refreshToken: token } : {},
        auth: true, // Requires Bearer token
      });
    } finally {
      await this.http.storage.clearTokens();
    }
  }
}
```

Create `packages/api-client/src/resources/users.ts`:
```typescript
import type { HttpClient } from '../client';
import type { User } from '@remote/shared';

export class UsersResource {
  constructor(private readonly http: HttpClient) {}

  async me(): Promise<{ user: User }> {
    return await this.http.request<{ user: User }>('GET', '/api/users/me');
  }
}
```

Create `packages/api-client/src/resources/devices.ts`:
```typescript
import type { HttpClient } from '../client';
import type { Device } from '@remote/shared';

export interface CreateDeviceInput {
  fingerprint: string;
  deviceName?: string;
  deviceType: 'desktop' | 'mobile' | 'web';
}

export class DevicesResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Device[]> {
    return await this.http.request<Device[]>('GET', '/api/devices');
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    return await this.http.request<Device>('POST', '/api/devices', {
      body: input,
    });
  }

  async remove(id: string): Promise<{ success: boolean }> {
    return await this.http.request<{ success: boolean }>('DELETE', `/api/devices/${id}`);
  }
}
```

Create `packages/api-client/src/resources/agents.ts`:
```typescript
import type { HttpClient } from '../client';
import type { Agent } from '@remote/shared';

export interface CreateAgentInput {
  id: string;
  hostname?: string;
  platform?: string;
  osVersion?: string;
  agentVersion?: string;
  publicKey: string;
}

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Agent[]> {
    return await this.http.request<Agent[]>('GET', '/api/agents');
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    return await this.http.request<Agent>('POST', '/api/agents', {
      body: input,
    });
  }

  async get(id: string): Promise<Agent> {
    return await this.http.request<Agent>('GET', `/api/agents/${id}`);
  }
}
```

Create `packages/api-client/src/resources/sessions.ts`:
```typescript
import type { HttpClient } from '../client';
import type { Session } from '@remote/shared';

export interface CreateSessionInput {
  deviceId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Session[]> {
    return await this.http.request<Session[]>('GET', '/api/sessions');
  }

  async create(input: CreateSessionInput): Promise<Session> {
    return await this.http.request<Session>('POST', '/api/sessions', {
      body: input,
    });
  }

  async get(id: string): Promise<Session> {
    return await this.http.request<Session>('GET', `/api/sessions/${id}`);
  }

  async terminate(id: string): Promise<{ success: boolean }> {
    return await this.http.request<{ success: boolean }>(
      'DELETE',
      `/api/sessions/${id}`,
    );
  }
}
```

Create `packages/api-client/src/index.ts`:
```typescript
export * from './types';
export * from './errors';
export * from './client';
export * from './resources/auth';
export * from './resources/users';
export * from './resources/devices';
export * from './resources/agents';
export * from './resources/sessions';
```

- [ ] **Step 5: Write unit and integration tests (`client.test.ts` & `refresh-queue.test.ts`)**

Create `packages/api-client/test/client.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../src/index';
import type { TokenStorageAdapter, TokenPair } from '../src/types';

class MemoryStorage implements TokenStorageAdapter {
  private tokens: TokenPair = { accessToken: '', refreshToken: '' };
  getAccessToken = vi.fn(() => this.tokens.accessToken || null);
  getRefreshToken = vi.fn(() => this.tokens.refreshToken || null);
  setTokens = vi.fn((t: TokenPair) => {
    this.tokens = t;
  });
  clearTokens = vi.fn(() => {
    this.tokens = { accessToken: '', refreshToken: '' };
  });
}

describe('ApiClient general requests & resources', () => {
  it('1. Attaches Authorization: Bearer <token> when token is stored', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'access-123', refreshToken: 'refresh-456' });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'dev-1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.devices.list();
    expect(res).toEqual([{ id: 'dev-1' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(callInit.headers).toMatchObject({
      Authorization: 'Bearer access-123',
    });
  });

  it('2. Omits the header when no token is stored', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'dev-1' }]), { status: 200 }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await client.devices.list();
    const callInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect((callInit.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('3. Parses { error, code, details } into ApiError with status and code', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Username already taken',
          code: 'USERNAME_EXISTS',
          details: null,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(
      client.auth.register({
        username: 'alice',
        password: 'password123',
        publicKey: 'pub-key-data',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'USERNAME_EXISTS',
      message: 'Username already taken',
    });
  });

  it('4. Throws ApiError with code: NETWORK_ERROR when response body is not JSON', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'NETWORK_ERROR',
      message: 'Bad Gateway',
    });
  });

  it('5. login persists the mapped token pair through the adapter', async () => {
    const storage = new MemoryStorage();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'u1', username: 'alice' },
          token: 'jwt-access-token',
          refreshToken: 'jwt-refresh-token',
          expiresIn: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.auth.login('alice', 'password123');
    expect(res.user.username).toBe('alice');
    expect(storage.setTokens).toHaveBeenCalledWith({
      accessToken: 'jwt-access-token',
      refreshToken: 'jwt-refresh-token',
    });
  });

  it('6. logout sends the refresh token in the request body with Bearer auth', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    const res = await client.auth.logout('refresh-1');
    expect(res.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(callInit.headers).toMatchObject({
      Authorization: 'Bearer access-1',
    });
    expect(JSON.parse(callInit.body as string)).toEqual({
      refreshToken: 'refresh-1',
    });
    expect(storage.clearTokens).toHaveBeenCalled();
  });
});
```

Create `packages/api-client/test/refresh-queue.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../src/index';
import type { TokenStorageAdapter, TokenPair } from '../src/types';

class MemoryStorage implements TokenStorageAdapter {
  tokens: TokenPair = { accessToken: '', refreshToken: '' };
  getAccessToken = vi.fn(() => this.tokens.accessToken || null);
  getRefreshToken = vi.fn(() => this.tokens.refreshToken || null);
  setTokens = vi.fn((t: TokenPair) => {
    this.tokens = t;
  });
  clearTokens = vi.fn(() => {
    this.tokens = { accessToken: '', refreshToken: '' };
  });
}

describe('Refresh Queue & Concurrency Tests', () => {
  it('7. Three concurrent 401s trigger exactly one refresh and retry all requests', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'valid-refresh',
    });

    let refreshCallCount = 0;
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      // Refresh endpoint
      if (urlStr.endsWith('/api/auth/refresh')) {
        refreshCallCount++;
        return new Response(
          JSON.stringify({
            token: 'fresh-access',
            refreshToken: 'valid-refresh',
            expiresIn: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Any resource endpoint
      const authHeader = (init?.headers as Record<string, string>)?.[
        'Authorization'
      ];
      if (authHeader === 'Bearer expired-access') {
        return new Response(
          JSON.stringify({ error: 'Token expired', code: 'UNAUTHORIZED' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (authHeader === 'Bearer fresh-access') {
        if (urlStr.endsWith('/api/users/me')) {
          return new Response(JSON.stringify({ user: { id: 'u1' } }), {
            status: 200,
          });
        }
        if (urlStr.endsWith('/api/devices')) {
          return new Response(JSON.stringify([{ id: 'd1' }]), { status: 200 });
        }
        if (urlStr.endsWith('/api/agents')) {
          return new Response(JSON.stringify([{ id: 'a1' }]), { status: 200 });
        }
      }

      return new Response('Not found', { status: 404 });
    });

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    // Fire 3 concurrent requests while token is expired
    const [userRes, devicesRes, agentsRes] = await Promise.all([
      client.users.me(),
      client.devices.list(),
      client.agents.list(),
    ]);

    expect(userRes).toEqual({ user: { id: 'u1' } });
    expect(devicesRes).toEqual([{ id: 'd1' }]);
    expect(agentsRes).toEqual([{ id: 'a1' }]);

    // Crucial assertion: exactly 1 refresh call took place!
    expect(refreshCallCount).toBe(1);
    expect(storage.setTokens).toHaveBeenCalledWith({
      accessToken: 'fresh-access',
      refreshToken: 'valid-refresh',
    });
  });

  it('8. A 401 from /api/auth/login does NOT trigger a refresh', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'token',
      refreshToken: 'valid-refresh',
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.auth.login('wrong', 'creds')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('9. A second 401 on a retried request throws instead of refreshing again', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'bad-access',
      refreshToken: 'bad-refresh',
    });

    // Return 401 on everything including refresh retry
    const mockFetch = vi.fn(async (url: string) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            token: 'still-bad-access',
            refreshToken: 'bad-refresh',
            expiresIn: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });

    // Initial 401 + 1 refresh + 1 retry = 3 calls total (no infinite loop)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('10. Refresh failure clears tokens and invokes onAuthError once', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
    });

    const onAuthError = vi.fn();
    const mockFetch = vi.fn(async (url: string) => {
      if (url.toString().endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            error: 'Refresh token revoked',
            code: 'TOKEN_REVOKED',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new ApiClient({
      baseUrl: 'http://localhost:8787',
      storage,
      onAuthError,
      fetch: mockFetch,
    });

    await expect(client.users.me()).rejects.toMatchObject({
      status: 401,
    });

    expect(storage.clearTokens).toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run tests and typecheck for `packages/api-client`**

Run:
```bash
pnpm install
pnpm --filter @remote/api-client test
pnpm --filter @remote/api-client typecheck
pnpm --filter @remote/api-client lint
```
Expected: All 10 tests PASS, typecheck passes, lint passes.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/api-client/
git commit -m "feat(api-client): implement typed HTTP client with single-flight refresh queue and resources"
```

---

### Task 3: Application `apps/web` — UI, shadcn-vue, Dark Mode, Router & Dashboard

**Files:**
- Modify: `pnpm-workspace.yaml` (prerequisite `vue-demi: true`)
- Modify: `package.json` (add root dependencies for Vue ESLint and `dev:web` script)
- Modify: `eslint.config.js` (add Vue flat parser and shadcn single-word rule override)
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/env.d.ts`
- Create: `apps/web/.env.example`
- Create: `apps/web/index.html`
- Create: `apps/web/src/test-setup.ts`
- Command: `pnpm dlx shadcn-vue@latest init -c apps/web --preset a5RaS2BE --template vite`
- Command: `pnpm dlx shadcn-vue@latest add -c apps/web button input label card alert dropdown-menu avatar badge`
- Modify: `apps/web/src/style.css` (append brand `@theme` palette)
- Create: `apps/web/src/composables/useTheme.ts`
- Create: `apps/web/src/services/token-storage.ts`
- Create: `apps/web/src/services/client.ts`
- Create: `apps/web/src/stores/auth.ts`
- Create: `apps/web/src/router/index.ts`
- Create: `apps/web/src/components/layout/ThemeToggle.vue`
- Create: `apps/web/src/components/layout/AppHeader.vue`
- Create: `apps/web/src/components/layout/AppLayout.vue`
- Create: `apps/web/src/components/auth/LoginForm.vue`
- Create: `apps/web/src/components/auth/RegisterForm.vue`
- Create: `apps/web/src/views/LoginView.vue`
- Create: `apps/web/src/views/RegisterView.vue`
- Create: `apps/web/src/views/DashboardView.vue`
- Create: `apps/web/src/views/NotFoundView.vue`
- Create: `apps/web/src/App.vue`
- Create: `apps/web/src/main.ts`
- Create: `apps/web/src/__tests__/use-theme.test.ts`
- Create: `apps/web/src/__tests__/auth-store.test.ts`
- Create: `apps/web/src/__tests__/router-guard.test.ts`
- Create: `apps/web/src/__tests__/LoginForm.test.ts`
- Create: `apps/web/src/__tests__/RegisterForm.test.ts`

**Interfaces:**
- Consumes: `@remote/crypto` (`generateUserKeyPair`, `savePrivateKey`, `loadPrivateKey`, `deletePrivateKey`).
- Consumes: `@remote/api-client` (`ApiClient`, `TokenStorageAdapter`, `ApiError`, `isApiError`).
- Produces: Working SPA with `pnpm dev:web`, `pnpm --filter @remote/web build`, and 22 passing tests.

- [ ] **Step 1: Configure root dependencies, `pnpm-workspace.yaml`, and root `eslint.config.js`**

Ensure `pnpm-workspace.yaml` has `vue-demi: true`:
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

Add Vue ESLint plugins and `dev:web` script to root `package.json`:
```json
{
  "scripts": {
    "dev:web": "pnpm --filter @remote/web dev"
  },
  "devDependencies": {
    "eslint-plugin-vue": "10.11.1",
    "vue-eslint-parser": "10.4.1"
  }
}
```

Update root `eslint.config.js`:
```javascript
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/target/**',
      'docs/**',
    ],
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
    files: [
      'packages/**/*.ts',
      'apps/**/*.ts',
      'apps/**/*.vue',
      'workers/**/*.ts',
    ],
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

- [ ] **Step 2: Scaffold `apps/web` base configuration files**

Update `apps/web/package.json`:
```json
{
  "name": "@remote/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "typecheck": "vue-tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@remote/api-client": "workspace:*",
    "@remote/crypto": "workspace:*",
    "@remote/shared": "workspace:*",
    "pinia": "4.0.3",
    "vue": "3.5.43",
    "vue-router": "5.3.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@vitejs/plugin-vue": "6.0.9",
    "@vue/test-utils": "2.5.1",
    "fake-indexeddb": "6.2.5",
    "happy-dom": "20.14.5",
    "tailwindcss": "4.3.3",
    "typescript": "6.0.3",
    "vite": "8.3.1",
    "vitest": "5.0.1",
    "vue-tsc": "3.3.11"
  }
}
```

Create `apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "types": ["vite/client"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts", "vitest.config.ts", "env.d.ts"],
  "exclude": ["node_modules", "dist", ".turbo"]
}
```

Create `apps/web/vite.config.ts`:
```typescript
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

Create `apps/web/vitest.config.ts`:
```typescript
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

Create `apps/web/src/test-setup.ts`:
```typescript
import 'fake-indexeddb/auto';
```

Create `apps/web/env.d.ts`:
```typescript
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

Create `apps/web/.env.example`:
```env
VITE_API_URL=http://localhost:8787
```

Create `apps/web/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ponta Remote Access</title>
  </head>
  <body class="bg-background text-foreground antialiased min-h-screen">
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create initial placeholder `apps/web/src/style.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 3: Run pnpm install and execute shadcn-vue initialization**

Run:
```bash
pnpm install
pnpm dlx shadcn-vue@latest init -c apps/web --preset a5RaS2BE --template vite
pnpm dlx shadcn-vue@latest add -c apps/web button input label card alert dropdown-menu avatar badge
```

Verify that:
1. `apps/web/components.json` was generated inside `apps/web/`.
2. `apps/web/src/lib/utils.ts` exists.
3. Components exist in `apps/web/src/components/ui/` (`button`, `input`, `label`, `card`, `alert`, `dropdown-menu`, `avatar`, `badge`).

- [ ] **Step 4: Update `apps/web/src/style.css` with additive brand palette**

Append the additive brand palette block to `apps/web/src/style.css` without overwriting the generated shadcn tokens:
```css
/* Project palette — additive, does not replace shadcn tokens */
@theme {
  --color-brand-50: oklch(0.97 0.02 259);
  --color-brand-500: oklch(0.62 0.19 259);
  --color-brand-600: oklch(0.55 0.19 259);
  --color-brand-700: oklch(0.48 0.18 259);
}
```

Format the workspace:
```bash
pnpm format
```

- [ ] **Step 5: Implement `apps/web/src/composables/useTheme.ts`**

Create `apps/web/src/composables/useTheme.ts`:
```typescript
import { ref, computed, watchEffect, type Ref, type ComputedRef } from 'vue';

export type Theme = 'light' | 'dark';

export interface UseTheme {
  theme: Ref<Theme>;
  isDark: ComputedRef<boolean>;
  toggle(): void;
  set(theme: Theme): void;
}

const STORAGE_KEY = 'remote.theme';

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // Ignore localStorage failures
  }

  if (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

// Module-level singleton state
const theme = ref<Theme>(getInitialTheme());
const isDark = computed(() => theme.value === 'dark');

// Apply class to <html> element
if (typeof document !== 'undefined') {
  watchEffect(() => {
    const el = document.documentElement;
    if (theme.value === 'dark') {
      el.classList.add('dark');
    } else {
      el.classList.remove('dark');
    }
  });
}

function setTheme(newTheme: Theme): void {
  theme.value = newTheme;
  try {
    localStorage.setItem(STORAGE_KEY, newTheme);
  } catch {
    // Ignore storage failure (e.g. private mode)
  }
}

function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme(): UseTheme {
  return {
    theme,
    isDark,
    toggle: toggleTheme,
    set: setTheme,
  };
}

/** Reset theme state for tests */
export function resetTheme(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  theme.value = getInitialTheme();
}
```

- [ ] **Step 6: Implement Token Storage and ApiClient singleton (`services/`)**

Create `apps/web/src/services/token-storage.ts`:
```typescript
import type { TokenStorageAdapter, TokenPair } from '@remote/api-client';

const ACCESS_TOKEN_KEY = 'remote.accessToken';
const REFRESH_TOKEN_KEY = 'remote.refreshToken';

export class LocalStorageTokenAdapter implements TokenStorageAdapter {
  getAccessToken(): string | null {
    try {
      return localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  getRefreshToken(): string | null {
    try {
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  setTokens(tokens: TokenPair): void {
    try {
      localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    } catch {
      // Degrade gracefully if storage blocked
    }
  }

  clearTokens(): void {
    try {
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // Degrade gracefully
    }
  }
}

export const tokenStorage = new LocalStorageTokenAdapter();
```

Create `apps/web/src/services/client.ts`:
```typescript
import { ApiClient } from '@remote/api-client';
import { tokenStorage } from './token-storage';

const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export const apiClient = new ApiClient({
  baseUrl,
  storage: tokenStorage,
});
```

- [ ] **Step 7: Implement Pinia Auth Store (`src/stores/auth.ts`)**

Create `apps/web/src/stores/auth.ts`:
```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from '@remote/shared';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import { generateUserKeyPair, savePrivateKey, deletePrivateKey } from '@remote/crypto';
import { isApiError } from '@remote/api-client';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const status = ref<AuthStatus>('idle');
  const error = ref<string | null>(null);
  const restored = ref<boolean>(false);

  const isAuthenticated = computed(
    () => user.value !== null && status.value === 'authenticated',
  );

  async function restore(): Promise<void> {
    if (restored.value) return;

    const token = tokenStorage.getAccessToken();
    if (!token) {
      status.value = 'idle';
      restored.value = true;
      return;
    }

    try {
      status.value = 'loading';
      const res = await apiClient.users.me();
      user.value = res.user;
      status.value = 'authenticated';
    } catch {
      tokenStorage.clearTokens();
      user.value = null;
      status.value = 'idle';
    } finally {
      restored.value = true;
    }
  }

  async function login(username: string, password: string): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const res = await apiClient.auth.login(username, password);
      user.value = res.user;
      status.value = 'authenticated';
    } catch (err) {
      status.value = 'error';
      error.value = isApiError(err) ? err.message : 'Login failed';
      throw err;
    }
  }

  async function register(params: {
    username: string;
    email?: string;
    password: string;
  }): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const keyPair = await generateUserKeyPair();
      const res = await apiClient.auth.register({
        username: params.username,
        email: params.email,
        password: params.password,
        publicKey: keyPair.publicKeySpkiBase64,
      });

      await savePrivateKey(res.user.id, keyPair.privateKey);

      user.value = res.user;
      status.value = 'authenticated';
    } catch (err) {
      status.value = 'error';
      error.value = isApiError(err) ? err.message : 'Registration failed';
      throw err;
    }
  }

  async function logout(): Promise<void> {
    const refreshToken = tokenStorage.getRefreshToken();
    if (user.value?.id) {
      try {
        await deletePrivateKey(user.value.id);
      } catch {
        // ignore storage cleanup failure
      }
    }
    try {
      if (refreshToken) {
        await apiClient.auth.logout(refreshToken);
      }
    } catch {
      // Best effort logout server-side
    } finally {
      tokenStorage.clearTokens();
      user.value = null;
      status.value = 'idle';
      error.value = null;
    }
  }

  async function fetchMe(): Promise<void> {
    try {
      const res = await apiClient.users.me();
      user.value = res.user;
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        tokenStorage.clearTokens();
        user.value = null;
        status.value = 'idle';
      }
      throw err;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  // Handle refresh failures emitted by the client
  apiClient.http.onAuthError = () => {
    tokenStorage.clearTokens();
    user.value = null;
    status.value = 'idle';
  };

  return {
    user,
    status,
    error,
    restored,
    isAuthenticated,
    restore,
    login,
    register,
    logout,
    fetchMe,
    clearError,
  };
});
```

- [ ] **Step 8: Implement Vue Router & Guards (`src/router/index.ts`)**

Create `apps/web/src/router/index.ts`:
```typescript
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from) => {
  const authStore = useAuthStore();

  if (!authStore.restored) {
    await authStore.restore();
  }

  const isAuth = authStore.isAuthenticated;

  if (to.meta.requiresAuth && !isAuth) {
    return {
      path: '/login',
      query: { redirect: to.fullPath },
    };
  }

  if (to.meta.requiresAuth === false && isAuth) {
    return { path: '/dashboard' };
  }

  return true;
});
```

- [ ] **Step 9: Implement Layout and Auth Form Components**

Create `apps/web/src/components/layout/ThemeToggle.vue`:
```vue
<script setup lang="ts">
import { useTheme } from '@/composables/useTheme';
import { Button } from '@/components/ui/button';

const { isDark, toggle } = useTheme();
</script>

<template>
  <Button
    variant="ghost"
    size="icon"
    :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
    @click="toggle"
  >
    <svg
      v-if="isDark"
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
    <svg
      v-else
      xmlns="http://www.w3.org/2000/svg"
      class="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </Button>
</template>
```

Create `apps/web/src/components/layout/AppHeader.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import ThemeToggle from './ThemeToggle.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

const router = useRouter();
const authStore = useAuthStore();

const userInitials = computed(() => {
  const name = authStore.user?.username || 'U';
  return name.slice(0, 2).toUpperCase();
});

async function handleLogout() {
  await authStore.logout();
  router.push('/login');
}
</script>

<template>
  <header class="border-b border-border bg-card">
    <div class="container mx-auto flex h-16 items-center justify-between px-4">
      <div class="flex items-center space-x-3">
        <router-link to="/" class="flex items-center space-x-2 text-xl font-bold tracking-tight">
          <span class="text-primary font-extrabold">Ponta</span>
          <span class="text-muted-foreground font-normal">Remote</span>
        </router-link>
      </div>

      <div class="flex items-center space-x-4">
        <ThemeToggle />

        <template v-if="authStore.isAuthenticated">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="relative h-9 w-9 rounded-full">
                <Avatar class="h-9 w-9">
                  <AvatarFallback class="bg-primary/10 text-primary font-medium">
                    {{ userInitials }}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuLabel class="font-normal">
                <div class="flex flex-col space-y-1">
                  <p class="text-sm font-medium leading-none">{{ authStore.user?.username }}</p>
                  <p class="text-xs leading-none text-muted-foreground">{{ authStore.user?.email || 'No email' }}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div class="px-2 py-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>Status</span>
                <Badge variant="secondary" class="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-none">
                  Active
                </Badge>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="cursor-pointer text-destructive focus:text-destructive" @click="handleLogout">
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
        <template v-else>
          <router-link to="/login">
            <Button variant="ghost" size="sm">Login</Button>
          </router-link>
          <router-link to="/register">
            <Button size="sm">Register</Button>
          </router-link>
        </template>
      </div>
    </div>
  </header>
</template>
```

Create `apps/web/src/components/layout/AppLayout.vue`:
```vue
<script setup lang="ts">
import AppHeader from './AppHeader.vue';
</script>

<template>
  <div class="min-h-screen flex flex-col bg-background text-foreground">
    <AppHeader />
    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
```

Create `apps/web/src/components/auth/LoginForm.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: 'submit', payload: { username: string; password: string }): void;
}>();

const username = ref('');
const password = ref('');
const validationError = ref<string | null>(null);

function handleSubmit() {
  validationError.value = null;
  if (!username.value.trim() || !password.value) {
    validationError.value = 'Please enter both username and password';
    return;
  }
  emit('submit', { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <Card class="w-full max-w-md mx-auto shadow-md">
    <CardHeader class="space-y-1">
      <CardTitle class="text-2xl font-bold tracking-tight">Login</CardTitle>
      <CardDescription>Enter your credentials to access your account</CardDescription>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <Alert v-if="validationError || errorMessage" variant="destructive">
          <AlertDescription>{{ validationError || errorMessage }}</AlertDescription>
        </Alert>

        <div class="space-y-2">
          <Label for="username">Username</Label>
          <Input
            id="username"
            v-model="username"
            type="text"
            placeholder="Username"
            autocomplete="username"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="password">Password</Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            placeholder="Password"
            autocomplete="current-password"
            :disabled="loading"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button type="submit" class="w-full" :disabled="loading">
          <span v-if="loading">Signing in...</span>
          <span v-else>Sign In</span>
        </Button>
        <div class="text-center text-sm text-muted-foreground">
          Don't have an account?
          <router-link to="/register" class="text-primary hover:underline font-medium">
            Register
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
```

Create `apps/web/src/components/auth/RegisterForm.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: 'submit', payload: { username: string; email?: string; password: string }): void;
}>();

const username = ref('');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');
const validationError = ref<string | null>(null);

function validateEmail(val: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

function handleSubmit() {
  validationError.value = null;
  const trimmedUser = username.value.trim();
  const trimmedEmail = email.value.trim();

  if (!trimmedUser || trimmedUser.length < 3) {
    validationError.value = 'Username must be at least 3 characters';
    return;
  }

  if (trimmedEmail && !validateEmail(trimmedEmail)) {
    validationError.value = 'Please enter a valid email address';
    return;
  }

  if (password.value.length < 8) {
    validationError.value = 'Password must be at least 8 characters';
    return;
  }

  if (password.value !== confirmPassword.value) {
    validationError.value = 'Passwords do not match';
    return;
  }

  emit('submit', {
    username: trimmedUser,
    email: trimmedEmail || undefined,
    password: password.value,
  });
}
</script>

<template>
  <Card class="w-full max-w-md mx-auto shadow-md">
    <CardHeader class="space-y-1">
      <CardTitle class="text-2xl font-bold tracking-tight">Create an account</CardTitle>
      <CardDescription>Enter your details to generate your secure identity</CardDescription>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <Alert v-if="validationError || errorMessage" variant="destructive">
          <AlertDescription>{{ validationError || errorMessage }}</AlertDescription>
        </Alert>

        <div class="space-y-2">
          <Label for="reg-username">Username</Label>
          <Input
            id="reg-username"
            v-model="username"
            type="text"
            placeholder="Username (min 3 chars)"
            autocomplete="username"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-email">Email (optional)</Label>
          <Input
            id="reg-email"
            v-model="email"
            type="email"
            placeholder="name@example.com"
            autocomplete="email"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-password">Password</Label>
          <Input
            id="reg-password"
            v-model="password"
            type="password"
            placeholder="Password (min 8 chars)"
            autocomplete="new-password"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-confirm-password">Confirm Password</Label>
          <Input
            id="reg-confirm-password"
            v-model="confirmPassword"
            type="password"
            placeholder="Repeat password"
            autocomplete="new-password"
            :disabled="loading"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button type="submit" class="w-full" :disabled="loading">
          <span v-if="loading">Generating Keys & Registering...</span>
          <span v-else>Register</span>
        </Button>
        <div class="text-center text-sm text-muted-foreground">
          Already have an account?
          <router-link to="/login" class="text-primary hover:underline font-medium">
            Sign In
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
```

- [ ] **Step 10: Implement Views (`LoginView`, `RegisterView`, `DashboardView`, `NotFoundView`, `App.vue`, `main.ts`)**

Create `apps/web/src/views/LoginView.vue`:
```vue
<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import LoginForm from '@/components/auth/LoginForm.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

async function handleLogin(payload: { username: string; password: string }) {
  try {
    await authStore.login(payload.username, payload.password);
    const redirect = (route.query.redirect as string) || '/dashboard';
    router.push(redirect);
  } catch {
    // Error state is captured in store
  }
}
</script>

<template>
  <div class="container mx-auto flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
    <LoginForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleLogin"
    />
  </div>
</template>
```

Create `apps/web/src/views/RegisterView.vue`:
```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import RegisterForm from '@/components/auth/RegisterForm.vue';

const router = useRouter();
const authStore = useAuthStore();

async function handleRegister(payload: { username: string; email?: string; password: string }) {
  try {
    await authStore.register(payload);
    router.push('/dashboard');
  } catch {
    // Error state is captured in store
  }
}
</script>

<template>
  <div class="container mx-auto flex items-center justify-center min-h-[calc(100vh-4rem)] p-4">
    <RegisterForm
      :loading="authStore.status === 'loading'"
      :error-message="authStore.error"
      @submit="handleRegister"
    />
  </div>
</template>
```

Create `apps/web/src/views/DashboardView.vue`:
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiClient } from '@/services/client';
import type { Device, Agent } from '@remote/shared';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

const authStore = useAuthStore();
const devices = ref<Device[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function loadDashboardData() {
  loading.value = true;
  error.value = null;
  try {
    const [devs, agts] = await Promise.all([
      apiClient.devices.list(),
      apiClient.agents.list(),
    ]);
    devices.value = devs;
    agents.value = agts;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load dashboard data';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadDashboardData();
});
</script>

<template>
  <div class="container mx-auto p-4 md:p-8 space-y-8">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p class="text-muted-foreground mt-1">
          Welcome back, <span class="font-medium text-foreground">{{ authStore.user?.username }}</span>
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="loading" @click="loadDashboardData">
        Refresh Data
      </Button>
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertDescription class="flex justify-between items-center">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" @click="loadDashboardData">Retry</Button>
      </AlertDescription>
    </Alert>

    <div v-if="loading" class="grid gap-6 md:grid-cols-2">
      <Card class="p-8 text-center text-muted-foreground animate-pulse">Loading devices...</Card>
      <Card class="p-8 text-center text-muted-foreground animate-pulse">Loading agents...</Card>
    </div>

    <div v-else class="grid gap-6 md:grid-cols-2">
      <!-- Devices Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Registered Devices</CardTitle>
              <CardDescription>Authorized browsers and hardware</CardDescription>
            </div>
            <Badge variant="secondary">{{ devices.length }}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div v-if="devices.length === 0" class="text-center py-6 text-muted-foreground text-sm">
            No devices registered yet.
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="d in devices"
              :key="d.id"
              class="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
            >
              <div>
                <p class="font-medium text-sm">{{ d.deviceName || 'Unnamed Device' }}</p>
                <p class="text-xs text-muted-foreground font-mono">{{ d.fingerprint.slice(0, 16) }}...</p>
              </div>
              <Badge :variant="d.isTrusted ? 'default' : 'outline'">
                {{ d.deviceType }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Agents Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle>Connected Agents</CardTitle>
              <CardDescription>Remote target systems</CardDescription>
            </div>
            <Badge variant="secondary">{{ agents.length }}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div v-if="agents.length === 0" class="text-center py-6 text-muted-foreground text-sm">
            No agents registered yet.
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="a in agents"
              :key="a.id"
              class="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
            >
              <div>
                <p class="font-medium text-sm">{{ a.hostname || a.id }}</p>
                <p class="text-xs text-muted-foreground">{{ a.platform || 'Unknown OS' }}</p>
              </div>
              <Badge :variant="a.isOnline ? 'default' : 'secondary'">
                {{ a.isOnline ? 'Online' : 'Offline' }}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
```

Create `apps/web/src/views/NotFoundView.vue`:
```vue
<script setup lang="ts">
import { Button } from '@/components/ui/button';
</script>

<template>
  <div class="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] p-4 text-center">
    <h1 class="text-6xl font-extrabold text-primary">404</h1>
    <h2 class="text-2xl font-bold tracking-tight mt-4">Page not found</h2>
    <p class="text-muted-foreground mt-2 max-w-sm">
      The page you are looking for doesn't exist or has been moved.
    </p>
    <router-link to="/" class="mt-6">
      <Button>Back to Home</Button>
    </router-link>
  </div>
</template>
```

Create `apps/web/src/App.vue`:
```vue
<script setup lang="ts">
import AppLayout from '@/components/layout/AppLayout.vue';
</script>

<template>
  <AppLayout>
    <router-view />
  </AppLayout>
</template>
```

Create `apps/web/src/main.ts`:
```typescript
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
```

- [ ] **Step 11: Write unit and component tests (22 tests)**

Create `apps/web/src/__tests__/use-theme.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTheme, resetTheme } from '@/composables/useTheme';

describe('useTheme composable', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    resetTheme();
  });

  it('12. Initial theme respects prefers-color-scheme when storage is empty', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));

    resetTheme();
    const { theme } = useTheme();
    expect(theme.value).toBe('dark');
  });

  it('13. toggle() flips the class on <html> and persists to localStorage', () => {
    const { theme, toggle } = useTheme();
    theme.value = 'light';
    toggle();
    expect(theme.value).toBe('dark');
    expect(localStorage.getItem('remote.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    toggle();
    expect(theme.value).toBe('light');
    expect(localStorage.getItem('remote.theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('14. A stored dark preference wins over matchMedia light', () => {
    localStorage.setItem('remote.theme', 'dark');
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, // light
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));

    resetTheme();
    const { theme } = useTheme();
    expect(theme.value).toBe('dark');
  });

  it('15. When localStorage.setItem throws, toggle() still applies class without crashing', () => {
    const { toggle } = useTheme();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded / Private browsing');
    });

    expect(() => toggle()).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
```

Create `apps/web/src/__tests__/auth-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '@/stores/auth';
import { apiClient } from '@/services/client';
import { tokenStorage } from '@/services/token-storage';
import * as cryptoPkg from '@remote/crypto';

describe('Auth Store (Pinia)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    tokenStorage.clearTokens();
    vi.restoreAllMocks();
  });

  it('1. login with valid credentials sets user and status: authenticated', async () => {
    const store = useAuthStore();
    vi.spyOn(apiClient.auth, 'login').mockResolvedValue({
      user: { id: 'u1', username: 'alice' } as any,
      token: 'access-tok',
      refreshToken: 'ref-tok',
      expiresIn: 900,
    });

    await store.login('alice', 'password123');
    expect(store.user?.username).toBe('alice');
    expect(store.isAuthenticated).toBe(true);
    expect(store.status).toBe('authenticated');
  });

  it('2. login failure sets error and leaves status: error', async () => {
    const store = useAuthStore();
    vi.spyOn(apiClient.auth, 'login').mockRejectedValue(
      new Error('Invalid credentials'),
    );

    await expect(store.login('alice', 'badpass')).rejects.toThrow();
    expect(store.isAuthenticated).toBe(false);
    expect(store.status).toBe('error');
    expect(store.error).toBe('Invalid credentials');
  });

  it('3. register calls generateUserKeyPair and passes publicKeySpkiBase64 to the API', async () => {
    const store = useAuthStore();
    const dummyKey = {} as CryptoKey;
    vi.spyOn(cryptoPkg, 'generateUserKeyPair').mockResolvedValue({
      publicKeySpkiBase64: 'MFkwEwYHKoZIzj0CAQYIKoZ...',
      privateKey: dummyKey,
      publicKey: dummyKey,
    });

    const regSpy = vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: { id: 'u-reg-1', username: 'bob' } as any,
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 900,
    });

    const saveSpy = vi.spyOn(cryptoPkg, 'savePrivateKey').mockResolvedValue();

    await store.register({
      username: 'bob',
      password: 'password123',
    });

    expect(regSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'bob',
        publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZ...',
      }),
    );
    expect(saveSpy).toHaveBeenCalledWith('u-reg-1', dummyKey);
    expect(store.user?.id).toBe('u-reg-1');
  });

  it('4. register persists the private key with the returned user ID', async () => {
    const store = useAuthStore();
    const mockPrivKey = { type: 'private' } as any;
    vi.spyOn(cryptoPkg, 'generateUserKeyPair').mockResolvedValue({
      publicKeySpkiBase64: 'spki-key',
      privateKey: mockPrivKey,
      publicKey: {} as any,
    });
    vi.spyOn(apiClient.auth, 'register').mockResolvedValue({
      user: { id: 'user-id-99', username: 'charlie' } as any,
      token: 't',
      refreshToken: 'r',
      expiresIn: 900,
    });
    const saveSpy = vi.spyOn(cryptoPkg, 'savePrivateKey').mockResolvedValue();

    await store.register({ username: 'charlie', password: 'password123' });
    expect(saveSpy).toHaveBeenCalledWith('user-id-99', mockPrivKey);
  });

  it('5. logout calls API, clears tokens, deletes private key, and resets state', async () => {
    const store = useAuthStore();
    store.user = { id: 'user-to-logout', username: 'dave' } as any;
    store.status = 'authenticated';
    tokenStorage.setTokens({ accessToken: 'a', refreshToken: 'r' });

    const logoutSpy = vi.spyOn(apiClient.auth, 'logout').mockResolvedValue({ success: true });
    const deleteKeySpy = vi.spyOn(cryptoPkg, 'deletePrivateKey').mockResolvedValue();

    await store.logout();

    expect(deleteKeySpy).toHaveBeenCalledWith('user-to-logout');
    expect(logoutSpy).toHaveBeenCalledWith('r');
    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(tokenStorage.getAccessToken()).toBeNull();
  });

  it('6. restore() with no stored token leaves store idle and does not call API', async () => {
    const store = useAuthStore();
    const meSpy = vi.spyOn(apiClient.users, 'me');

    await store.restore();

    expect(meSpy).not.toHaveBeenCalled();
    expect(store.status).toBe('idle');
    expect(store.restored).toBe(true);
  });

  it('7. restore() with a stored token calls fetchMe and sets authenticated', async () => {
    const store = useAuthStore();
    tokenStorage.setTokens({ accessToken: 'valid-token', refreshToken: 'valid-ref' });
    vi.spyOn(apiClient.users, 'me').mockResolvedValue({
      user: { id: 'u1', username: 'eve' } as any,
    });

    await store.restore();

    expect(store.user?.username).toBe('eve');
    expect(store.status).toBe('authenticated');
    expect(store.restored).toBe(true);
  });

  it('8. restore() with an invalid stored token clears tokens and returns to idle', async () => {
    const store = useAuthStore();
    tokenStorage.setTokens({ accessToken: 'expired-token', refreshToken: 'bad-ref' });
    vi.spyOn(apiClient.users, 'me').mockRejectedValue(new Error('Unauthorized'));

    await store.restore();

    expect(store.user).toBeNull();
    expect(store.status).toBe('idle');
    expect(tokenStorage.getAccessToken()).toBeNull();
  });
});
```

Create `apps/web/src/__tests__/router-guard.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { router } from '@/router';
import { useAuthStore } from '@/stores/auth';

describe('Router Guards', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    store.restored = true;
    store.user = null;
    store.status = 'idle';
  });

  it('9. Unauthenticated navigation to /dashboard redirects to /login with redirect query', async () => {
    const store = useAuthStore();
    store.user = null;
    store.status = 'idle';

    await router.push('/dashboard');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/dashboard');
  });

  it('10. Authenticated navigation to /dashboard is allowed', async () => {
    const store = useAuthStore();
    store.user = { id: 'u1', username: 'alice' } as any;
    store.status = 'authenticated';

    await router.push('/dashboard');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });

  it('11. Authenticated navigation to /login redirects to /dashboard', async () => {
    const store = useAuthStore();
    store.user = { id: 'u1', username: 'alice' } as any;
    store.status = 'authenticated';

    await router.push('/login');
    expect(router.currentRoute.value.path).toBe('/dashboard');
  });
});
```

Create `apps/web/src/__tests__/LoginForm.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LoginForm from '@/components/auth/LoginForm.vue';

describe('LoginForm.vue', () => {
  it('16. Submitting empty fields shows validation message and emits nothing', async () => {
    const wrapper = mount(LoginForm);
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Please enter both username and password');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('17. A valid submit emits submit event with entered credentials', async () => {
    const wrapper = mount(LoginForm);
    await wrapper.find('#username').setValue('alice');
    await wrapper.find('#password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      { username: 'alice', password: 'password123' },
    ]);
  });

  it('18. Submit button is disabled while loading', () => {
    const wrapper = mount(LoginForm, {
      props: { loading: true },
    });

    const submitBtn = wrapper.find('button[type="submit"]');
    expect(submitBtn.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Signing in...');
  });
});
```

Create `apps/web/src/__tests__/RegisterForm.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RegisterForm from '@/components/auth/RegisterForm.vue';

describe('RegisterForm.vue', () => {
  it('19. A mismatched password confirmation shows an error and does not emit', async () => {
    const wrapper = mount(RegisterForm);
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password456');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Passwords do not match');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('20. A password shorter than 8 characters shows an error', async () => {
    const wrapper = mount(RegisterForm);
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-password').setValue('short');
    await wrapper.find('#reg-confirm-password').setValue('short');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Password must be at least 8 characters');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('21. A malformed email shows an error', async () => {
    const wrapper = mount(RegisterForm);
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-email').setValue('not-an-email');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.text()).toContain('Please enter a valid email address');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('22. A valid form emits submit with entered fields', async () => {
    const wrapper = mount(RegisterForm);
    await wrapper.find('#reg-username').setValue('alice');
    await wrapper.find('#reg-email').setValue('alice@example.com');
    await wrapper.find('#reg-password').setValue('password123');
    await wrapper.find('#reg-confirm-password').setValue('password123');
    await wrapper.find('form').trigger('submit.prevent');

    expect(wrapper.emitted('submit')).toHaveLength(1);
    expect(wrapper.emitted('submit')![0]).toEqual([
      {
        username: 'alice',
        email: 'alice@example.com',
        password: 'password123',
      },
    ]);
  });
});
```

- [ ] **Step 12: Run full validation suite for `apps/web` and entire workspace**

Run:
```bash
pnpm install
pnpm --filter @remote/web test
pnpm --filter @remote/web typecheck
pnpm --filter @remote/web lint
pnpm --filter @remote/web build

# Verify whole monorepo passes CI commands
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
```
Expected:
- All 22 tests in `apps/web` PASS.
- Total repo tests: 85 PASS (46 workers + 7 crypto + 10 api-client + 22 web).
- Workspace build, typecheck, lint, and format checks all pass.

- [ ] **Step 13: Commit Task 3**

```bash
git add pnpm-workspace.yaml package.json eslint.config.js apps/web/
git commit -m "feat(web): implement Vue 3 SPA with shadcn-vue, dark mode, auth flow and dashboard"
```
