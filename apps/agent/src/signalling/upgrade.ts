/**
 * The one place the agent builds a `Bearer` header (AUTH-3, ADR-13).
 *
 * The credential travels in the upgrade header and never in a query string: a
 * URL is logged by every proxy and by Cloudflare's own request log. The
 * validity check is the HTTP/1.1 field-value grammar reduced to what matters —
 * printable ASCII with no space — because `ws` would happily send a header
 * containing a newline and let the request be spliced.
 */
const VALID_HEADER_VALUE = /^[\x21-\x7E]+$/;

export function buildUpgradeHeaders(
  credential: string,
): Record<string, string> {
  if (!VALID_HEADER_VALUE.test(credential)) {
    throw new Error('credential is not a valid header value');
  }
  return { Authorization: `Bearer ${credential}` };
}
