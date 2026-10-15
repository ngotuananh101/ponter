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
