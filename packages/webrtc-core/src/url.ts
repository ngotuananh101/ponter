/**
 * The one WebSocket-URL rewrite (ADR-89, URL-3/4): derive a `ws(s)://` URL from
 * a resolved HTTP base, and trim trailing slashes before joining a path.
 *
 * A loop rather than `replace(/\/+$/, '')` for the trim: the regex backtracks
 * super-linearly on a long run of slashes (Sonar S8786), and the URL is
 * caller-supplied input.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return url.slice(0, end);
}

/**
 * Rewrite a base URL to its WebSocket scheme (URL-3): `http://`→`ws://`,
 * `https://`→`wss://`, `ws://`/`wss://` pass through. Any other scheme — or an
 * empty string — is an error. Trailing slashes are trimmed first (URL-4).
 */
export function toWsUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl);
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }
  throw new Error(`unsupported URL scheme: ${baseUrl}`);
}

/**
 * Rewrite a **complete** WebSocket URL's scheme (ADR-89, URL-3/4 — the agent's
 * contract). `http://`→`ws://`, `https://`→`wss://`; `ws://`/`wss://` pass
 * through; anything else throws.
 *
 * Two differences from {@link toWsUrl}, both deliberate:
 *
 * 1. The `?`/`#` suffix is split off **before** the trailing-slash trim. This
 *    function receives a finished URL, not a base, so a query value ending in
 *    `/` (`?next=/`, `?scope=/`) is data and must survive; trimming the whole
 *    string would silently change it.
 * 2. Nothing is appended. `toWsUrl`'s callers compose a path afterwards; this
 *    one's caller already has the path.
 *
 * Do not merge the two. `toWsUrl` is a base-URL helper and its whole-string
 * trim is correct for that use; changing it would change which base URLs the
 * desktop and web accept.
 */
export function rewriteWsScheme(url: string): string {
  const splitAt = url.search(/[?#]/);
  const head = splitAt === -1 ? url : url.slice(0, splitAt);
  const suffix = splitAt === -1 ? '' : url.slice(splitAt);
  const trimmed = stripTrailingSlashes(head);
  if (trimmed.startsWith('https://'))
    return `wss://${trimmed.slice(8)}${suffix}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice(7)}${suffix}`;
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://'))
    return `${trimmed}${suffix}`;
  throw new Error(`unsupported URL scheme in ${JSON.stringify(url)}`);
}
