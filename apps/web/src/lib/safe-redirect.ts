/**
 * Reduce an untrusted redirect target to a same-origin path.
 *
 * `route.query.redirect` arrives from the URL, so it is attacker-controlled:
 * `//evil.example.com/x` (protocol-relative) and `/\evil.example.com` both
 * resolve to a foreign origin. Anything that does not resolve to our own
 * origin falls back to `/dashboard`.
 */
export function safeRedirect(raw: unknown, fallback = '/dashboard'): string {
  if (typeof raw !== 'string' || raw === '') {
    return fallback;
  }
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
