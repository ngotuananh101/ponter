export interface FrameSample {
  seq: number;
  captureEpochMs: number;
  encodeMs: number;
}

/**
 * The last N encoded frames' timing (B24).
 *
 * Both medians are **telemetry only**: they reach the wire as `captureMsP50` /
 * `encodeMsP50` and never feed the sustain ladder, which reads the single
 * frame's `encode_time`. A port that fed the median to the ladder would
 * downgrade far more slowly, because a median smooths over exactly the stalls
 * the ladder exists to catch.
 *
 * `orderedSamples` matters for the wire: the ring's internal storage is
 * circular, so `slice(0, len)` returns slot order once it has wrapped. The
 * browser plots `captureEpochMs` and expects monotonicity, so the samples are
 * concatenated from the head.
 */
export class FrameTimingRing {
  private readonly samples: FrameSample[] = [];
  private readonly captureMs: number[] = [];
  private head = 0;

  constructor(private readonly capacity: number) {}

  record(
    seq: number,
    captureEpochMs: number,
    encodeMs: number,
    captureMs: number,
  ): void {
    const sample: FrameSample = { seq, captureEpochMs, encodeMs };
    if (this.samples.length < this.capacity) {
      this.samples.push(sample);
      this.captureMs.push(captureMs);
      return;
    }
    this.samples[this.head] = sample;
    this.captureMs[this.head] = captureMs;
    this.head = (this.head + 1) % this.capacity;
  }

  medians(): { captureMsP50: number; encodeMsP50: number } | null {
    if (this.samples.length === 0) return null;
    return {
      captureMsP50: median(this.captureMs),
      encodeMsP50: median(this.samples.map((s) => s.encodeMs)),
    };
  }

  orderedSamples(): FrameSample[] {
    if (this.samples.length < this.capacity) return [...this.samples];
    return [
      ...this.samples.slice(this.head),
      ...this.samples.slice(0, this.head),
    ];
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
