/**
 * Augments the `Cloudflare.Env` interface that `cloudflare:test` uses for its
 * `env` export, so `env.DB` / `env.CACHE` / `env.*` are typed in tests.
 *
 * Kept self-contained (no imports from `src/index.ts`) because the bindings are
 * later formalised in `src/types.ts`; importing them here would couple this
 * declaration file to an internal module layout that changes.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      ENVIRONMENT: string;
      JWT_SECRET: string;
      JWT_EXPIRES_IN: string;
      REFRESH_TOKEN_SECRET: string;
      REFRESH_TOKEN_EXPIRES_IN: string;
      DB: D1Database;
      CACHE: KVNamespace;
    }
  }
}

export {};
