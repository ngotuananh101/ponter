/**
 * The allowed browser origins, from `CORS_ORIGIN`.
 *
 * Extracted from the CORS middleware in `app.ts` so the WebSocket upgrade
 * handler applies the same policy: the browser socket is authenticated by a
 * query-string ticket, which CORS does not protect, so Origin is the CSWSH
 * defence and must agree with what the REST API accepts.
 *
 * `'*'` means "no allowlist". It is returned only when the variable is unset
 * or explicitly `'*'`; `validateEnv` refuses both under `NODE_ENV=production`,
 * so a wildcard can only ever take effect in a development environment where
 * the operator asked for it. Outside production an unset value stays `'*'` so
 * `pnpm dev` needs no configuration.
 */
export function getAllowedOrigins(
  env: { CORS_ORIGIN?: string } = process.env,
): string[] | '*' {
  const corsOrigin = env.CORS_ORIGIN?.trim();
  if (!corsOrigin || corsOrigin === '*') return '*';
  return corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
