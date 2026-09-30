/**
 * JWT signing and verification built on the Web Crypto API.
 *
 * Hono 4.x no longer ships the `hono/jwt` subpath; this module provides a
 * minimal, dependency-free HS256 implementation that mirrors the interface
 * used by the Workers reference (`signAccessToken` / `signRefreshToken` /
 * `verifyToken`).
 */
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Encode an ArrayBuffer/Uint8Array to a base64url string (no padding). */
function toBase64Url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decode a base64url string (with or without padding) to a Uint8Array. */
function fromBase64Url(input: string): Uint8Array {
  const pad = input.length % 4;
  const padded = pad === 0 ? input : input + '='.repeat(4 - pad);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface TokenPayload {
  sub: string;
  username?: string;
  type: 'access' | 'refresh';
  jti: string;
  exp: number;
  /**
   * Namespaces a token beyond its `type`.
   *
   * A ws-ticket is a short-lived `type: 'access'` JWT carrying
   * `scope: 'ws-ticket'`. Both directions of the separation are enforced:
   * `authMiddleware` rejects any token with this scope, and `verifyWsTicket`
   * accepts nothing else. Without the first half the ticket would
   * authenticate REST calls; without the second, a normal access token would
   * work as a ticket.
   */
  scope?: string;
  [key: string]: unknown;
}

/** Parse the expiration duration string (e.g. "15m" => 900, "7d" => 604800). */
export function parseDurationToSeconds(duration: string): number {
  if (!duration) {
    return 900;
  }

  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 900;
  }

  const value = Number.parseInt(match[1] ?? '', 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return value * (multipliers[unit] ?? 900);
}

/** Sign a JWT payload with the given secret using HS256. */
export async function sign(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign'],
  );

  const headerPart = toBase64Url(TEXT_ENCODER.encode(JSON.stringify(header)));
  const payloadPart = toBase64Url(TEXT_ENCODER.encode(JSON.stringify(payload)));
  const data = `${headerPart}.${payloadPart}`;

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    TEXT_ENCODER.encode(data),
  );
  const sigPart = toBase64Url(signature);

  return `${data}.${sigPart}`;
}

/** Verify a JWT and return its payload. Throws on invalid/expired token. */
export async function verify(
  token: string,
  secret: string,
): Promise<TokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure');
  }

  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  const data = `${headerPart}.${payloadPart}`;

  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['verify'],
  );

  const signature = fromBase64Url(sigPart);
  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    TEXT_ENCODER.encode(data),
  );

  if (!isValid) {
    throw new Error('Invalid JWT signature');
  }

  const payloadJson = JSON.parse(
    TEXT_DECODER.decode(fromBase64Url(payloadPart)),
  );

  // Expiry check
  if (
    typeof payloadJson.exp === 'number' &&
    Math.floor(Date.now() / 1000) >= payloadJson.exp
  ) {
    throw new Error('JWT expired');
  }

  return payloadJson as TokenPayload;
}

export async function signAccessToken(
  userId: string,
  username: string,
  secret: string,
  expiresInSeconds = 900, // 15 mins
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    username,
    type: 'access',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

export async function signRefreshToken(
  userId: string,
  secret: string,
  expiresInSeconds = 604800, // 7 days
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    type: 'refresh',
    jti,
    exp,
  };

  const token = await sign(payload, secret);
  return { token, jti, exp };
}

/**
 * Mint a one-time WebSocket ticket.
 *
 * The browser WebSocket API cannot set an `Authorization` header, so the
 * ticket travels in the query string — where it can end up in proxy access
 * logs. The TTL is deliberately short (15s) and the caller registers the
 * `jti` in the one-time registry, so a leaked ticket is worth at most one
 * already-consumed upgrade. The returned `jti` is what the caller registers;
 * the ticket itself is opaque.
 */
export async function signWsTicket(
  userId: string,
  username: string,
  secret: string,
  expiresInSeconds = 15,
): Promise<{ ticket: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload: TokenPayload = {
    sub: userId,
    username,
    type: 'access',
    scope: 'ws-ticket',
    jti,
    exp,
  };

  const ticket = await sign(payload, secret);
  return { ticket, jti, exp };
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload> {
  const payload = await verify(token, secret);
  return payload;
}

export { sha256Hex } from './crypto.js';
