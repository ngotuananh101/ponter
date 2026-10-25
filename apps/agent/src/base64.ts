// apps/agent/src/base64.ts

/**
 * The **standard** alphabet only: `A–Z a–z 0–9 + /`, with at most two `=`
 * padding characters at the end. `-` and `_` are the URL-safe alphabet and are
 * deliberately absent — `base64url` is a different encoding, and accepting it
 * here would mean two spellings of one payload on one wire.
 */
const BASE64_STANDARD = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict standard-base64 decode, matching Rust's
 * `base64::engine::general_purpose::STANDARD.decode` (`lib.rs:212`).
 *
 * Returns `null` — never a best-effort prefix — when the input is not strict
 * standard base64. `Buffer.from(x, 'base64')` is the wrong primitive on its own:
 * it silently *skips* non-alphabet characters, so `"!!!!"` decodes to zero bytes
 * and a payload with one substituted character decodes to the right length with
 * the wrong content.
 *
 * Length must be a multiple of 4 even for the empty string (which is accepted:
 * Rust's `STANDARD.decode("")` is `Ok(vec![])`).
 */
export function decodeBase64Strict(data: string): Uint8Array | null {
  if (data.length % 4 !== 0 || !BASE64_STANDARD.test(data)) return null;
  return new Uint8Array(Buffer.from(data, 'base64'));
}
