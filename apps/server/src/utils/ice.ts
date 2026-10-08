import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@ponter/shared';

const GOOGLE_STUN = 'stun:stun.l.google.com:19302';

/** TURN credentials are valid for one day. */
const TURN_TTL_SECONDS = 86400;

const CLOUDFLARE_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export type TurnProvider = 'coturn' | 'cloudflare' | 'none';

/**
 * Resolve the configured TURN provider.
 *
 * The default is `coturn` — the pre-Phase-8 behaviour — so an unset or empty
 * `TURN_PROVIDER` leaves existing deployments byte-for-byte unchanged. An
 * unrecognized value falls back to `coturn` with a warning rather than
 * throwing: ICE configuration is fetched while a peer is connecting, and a
 * typo in a deployment's `.env` must not break every session.
 */
export function resolveTurnProvider(): TurnProvider {
  const raw = (process.env.TURN_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'coturn') return 'coturn';
  if (raw === 'cloudflare') return 'cloudflare';
  if (raw === 'none') return 'none';
  console.warn(
    `[ice] unknown TURN_PROVIDER="${raw}"; falling back to "coturn"`,
  );
  return 'coturn';
}

/**
 * Normalize a `urls` value to the array shape the Rust agent parses
 * (`IceServerEntry { urls: Vec<String> }`).
 */
export function toUrlArray(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

function buildCoturnIceServers(userId: string): IceServerConfig[] {
  const turnSecret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL;
  const stunUrl = process.env.STUN_URL;

  if (!turnSecret || !turnUrl) {
    // STUN_URL is deliberately ignored here: `STUN_URL` configures the STUN
    // entry of a *TURN-enabled* deployment, while this branch is the
    // no-TURN fallback, which is always the public Google resolver.
    return [{ urls: [GOOGLE_STUN] }];
  }

  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', turnSecret)
    .update(username)
    .digest('base64');

  // Ensure the turn URL starts with turn:
  const baseTurnUrl = turnUrl.startsWith('turn:') ? turnUrl : `turn:${turnUrl}`;

  return [
    { urls: [stunUrl || GOOGLE_STUN] },
    {
      urls: [`${baseTurnUrl}?transport=udp`, `${baseTurnUrl}?transport=tcp`],
      username,
      credential,
    },
  ];
}

/**
 * STUN-only list. Used by `TURN_PROVIDER=none` and as the fail-soft result
 * when a TURN provider is selected but unavailable. Unlike the coturn
 * no-secret fallback, this honours `STUN_URL` when it is set (ADR-62).
 */
function buildStunOnlyIceServers(): IceServerConfig[] {
  return [{ urls: [process.env.STUN_URL || GOOGLE_STUN] }];
}

/**
 * Cached Cloudflare credentials. Cloudflare mints per-key (not per-user)
 * credentials, so one cached response serves every peer until it expires.
 */
let cloudflareCache: {
  iceServers: IceServerConfig[];
  expiresAt: number;
} | null = null;

function normalizeCloudflareServers(
  raw: unknown,
  fallbackStun: IceServerConfig[],
): IceServerConfig[] {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { iceServers?: unknown }).iceServers)
  ) {
    return fallbackStun;
  }
  const entries = (raw as { iceServers: IceServerConfig[] }).iceServers;
  if (entries.length === 0) {
    return fallbackStun;
  }
  return entries.map((entry) => ({
    ...entry,
    urls: toUrlArray(entry.urls),
  }));
}

/**
 * Mint short-lived TURN credentials from the Cloudflare Calls TURN API.
 *
 * Fail-soft: a missing key id/token, a non-2xx response, a malformed body, or
 * a network error returns a STUN-only list with a warning. ICE configuration
 * is fetched mid-connect, so a provider outage must not break a session — the
 * same posture as the no-TURN fallback.
 */
async function buildCloudflareIceServers(): Promise<IceServerConfig[]> {
  const keyId = process.env.TURN_KEY_ID;
  const apiToken = process.env.TURN_KEY_API_TOKEN;
  const fallback = buildStunOnlyIceServers();

  if (!keyId || !apiToken) {
    console.warn(
      '[ice] TURN_PROVIDER=cloudflare but TURN_KEY_ID/TURN_KEY_API_TOKEN is missing; falling back to STUN-only',
    );
    return fallback;
  }

  const now = Date.now();
  if (cloudflareCache && cloudflareCache.expiresAt > now) {
    return cloudflareCache.iceServers;
  }

  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );

    if (!response.ok) {
      console.warn(
        `[ice] Cloudflare TURN API returned ${response.status}; falling back to STUN-only`,
      );
      return fallback;
    }

    const body = (await response.json()) as unknown;
    const iceServers = normalizeCloudflareServers(body, fallback);
    if (iceServers === fallback) {
      console.warn(
        '[ice] Cloudflare TURN API returned an unexpected body; falling back to STUN-only',
      );
      return fallback;
    }

    cloudflareCache = {
      iceServers,
      expiresAt: now + TURN_TTL_SECONDS * 1000,
    };
    return iceServers;
  } catch (error) {
    console.warn(
      '[ice] Cloudflare TURN API request failed; falling back to STUN-only',
      error,
    );
    return fallback;
  }
}

/**
 * Build the ICE server list for a user.
 *
 * Provider is selected by `TURN_PROVIDER`:
 *   - `coturn` (default): RFC 5766 HMAC credentials from `TURN_SECRET` +
 *     `TURN_URL`; `STUN_URL` optional.
 *   - `cloudflare`: mint credentials from the Cloudflare Calls TURN API.
 *   - `none`: STUN only.
 *
 * Shared by the user-facing `GET /api/webrtc/ice-servers` route and the
 * `ice-servers` frame pushed to agents on connect, so both peers are handed
 * the same shape of configuration. Every emitted `urls` is a string array.
 */
export async function buildIceServers(
  userId: string,
): Promise<IceServerConfig[]> {
  const provider = resolveTurnProvider();

  if (provider === 'none') {
    return buildStunOnlyIceServers();
  }

  if (provider === 'cloudflare') {
    return buildCloudflareIceServers();
  }

  return buildCoturnIceServers(userId);
}
