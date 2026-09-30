/**
 * The allowed browser origins, from `CORS_ORIGIN`.
 *
 * Extracted from the CORS middleware in `app.ts` so the WebSocket upgrade
 * handler applies the same policy: the browser socket is authenticated by a
 * query-string ticket, which CORS does not protect, so Origin is the CSWSH
 * defence and must agree with what the REST API accepts.
 *
 * `'*'` means "no allowlist" — the caller decides whether an absent Origin is
 * acceptable. A missing or empty variable is treated the same as `'*'`.
 */
export function getAllowedOrigins(): string[] | '*' {
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (!corsOrigin || corsOrigin === '*') return '*';
  return corsOrigin.split(',').map((o) => o.trim());
}
