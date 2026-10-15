/**
 * The one reconnect-backoff ladder shared by every WebSocket client (ADR-89,
 * WS-2). `WebSocketSignalTransport` and `FleetSocket` previously carried
 * byte-identical copies of this formula; the divergence between them (transport
 * caps retries and hands off to a fallback, fleet reconnects forever) is now
 * configuration, not a second copy.
 */
export interface ReconnectBackoffOptions {
  /** First-step delay in ms. Default 200. */
  initialMs?: number;
  /** Ceiling of the exponential ladder in ms. Default 2000. */
  maxMs?: number;
  /** Half-width of the symmetric jitter in ms. Default 50 (=> +/-50ms). */
  jitterMs?: number;
  /** Steps before `canRetry()` is false. Default `Infinity` (never give up). */
  maxRetries?: number;
  /** Uniform value in [0, 1). Default reads the platform CSPRNG. */
  random?: () => number;
}

/**
 * A uniform value in [0, 1) drawn from the platform CSPRNG.
 *
 * `Math.random()` is flagged by static analysis even where the value is only a
 * reconnect jitter; `crypto.getRandomValues` is available in every target
 * browser and in Node, and gives the same uniform distribution.
 */
function randomUnit(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) / 2 ** 32;
}

export class ReconnectBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly random: () => number;
  private retries = 0;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.initialMs = options.initialMs ?? 200;
    this.maxMs = options.maxMs ?? 2000;
    this.jitterMs = options.jitterMs ?? 50;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.random = options.random ?? randomUnit;
  }

  /** Number of steps taken so far. */
  get attempt(): number {
    return this.retries;
  }

  /** Whether another step is allowed under `maxRetries`. */
  canRetry(): boolean {
    return this.retries < this.maxRetries;
  }

  /**
   * Compute the next delay in ms and advance the ladder.
   *
   * The delay uses the CURRENT step count and is incremented afterwards, so the
   * first call returns `initialMs` (jitter aside). Jitter is an integer
   * millisecond offset: `setTimeout` has no use for a fractional delay, and
   * rounding keeps the ladder assertions exact.
   */
  next(): number {
    const delay =
      Math.min(this.initialMs * 2 ** this.retries, this.maxMs) +
      Math.round(this.random() * 2 * this.jitterMs - this.jitterMs);
    this.retries += 1;
    return delay;
  }

  /** Return the ladder to its first step (called after a successful connect). */
  reset(): void {
    this.retries = 0;
  }
}
