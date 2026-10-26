import type { IceServerEntry } from '../signalling/messages.js';

export interface RtcIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * The agent has no TURN-over-TCP transport, so a `turn:` URL advertising
 * `transport=tcp` is unusable and must be removed rather than passed through:
 * werift would accept the entry, fail the allocation, and the ICE failure would
 * look like a network problem. `turns:` is deliberately **not** matched — its
 * TCP form is a TLS variant the port does support, and the test pins that.
 */
export function isUnusableTurnTcp(url: string): boolean {
  return url.startsWith('turn:') && url.includes('transport=tcp');
}

/**
 * The server pushes ICE configuration on connect; the CLI's `--stun` is only a
 * fallback for the case where none was pushed (B10). Pushed-wins is the Rust's
 * behaviour and matters for a self-hosted deployment whose coturn is not the
 * one baked into the default config.
 */
export function mapIceServers(
  entries: IceServerEntry[],
  stunFallback: string,
): RtcIceServer[] {
  const mapped: RtcIceServer[] = [];
  for (const entry of entries) {
    const urls = entry.urls.filter((url) => !isUnusableTurnTcp(url));
    if (urls.length === 0) continue;
    const isTurn = urls.some((url) => url.startsWith('turn:'));
    const server: RtcIceServer = { urls };
    if (isTurn || entry.username != null || entry.credential != null) {
      server.username = entry.username ?? '';
      server.credential = entry.credential ?? '';
    }
    mapped.push(server);
  }
  if (mapped.length === 0 && stunFallback !== '')
    return [{ urls: [stunFallback] }];
  return mapped;
}

/**
 * The **negotiated** H.264 payload type (B27).
 *
 * `codecs[0].payloadType` is wrong whenever the browser offers VP8 first, which
 * Chrome does. The list order is the offer's order and the first H.264 entry
 * wins — not the lowest payload number, which is why the test pins 127 over 102
 * when 127 comes first.
 */
export function selectH264PayloadType(
  codecs: readonly { mimeType: string; payloadType: number }[],
): number | null {
  const match = codecs.find(
    (codec) => codec.mimeType.toLowerCase() === 'video/h264',
  );
  return match ? match.payloadType : null;
}

export function requiredH264PayloadType(
  codecs: readonly { mimeType: string; payloadType: number }[],
): number {
  const payloadType = selectH264PayloadType(codecs);
  if (payloadType === null)
    throw new Error('the desktop sender has no negotiated H.264 codec');
  return payloadType;
}

/**
 * `sdpMLineIndex` is a u16 on the wire; the Rust narrowed it at the boundary
 * and rejected `-1`/`65535+` as a typed error rather than a malformed frame.
 * JSON gives us a number of unbounded range and possibly a non-integer, so the
 * narrowing has to be explicit.
 */
export function narrowMlineIndex(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > 65535) return null;
  return raw;
}
