/**
 * Geometry and extrapolation helpers for mapping pointer positions through an
 * `object-contain` <video> to normalized (0..1) source coordinates and back
 * (spec §7.1, ADR-30, ADR-45).
 *
 * The element letterboxes/pillarboxes the stream; `contentBox` derives the
 * aspect-fit, centred content rectangle (black bars removed), and the mapping
 * functions translate between client pixels and normalized source coords.
 */

/** Degenerate-input sentinel returned when the geometry cannot be computed. */
const ZERO_BOX = Object.freeze({ left: 0, top: 0, width: 0, height: 0 });

/** The aspect-fit, centred content box inside `rect` for the given video size. */
export function contentBox(
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { left: number; top: number; width: number; height: number } {
  if (
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return { ...ZERO_BOX };
  }
  const videoAspect = videoWidth / videoHeight;
  const rectAspect = rect.width / rect.height;
  // The content box is the largest rect with the video's aspect ratio that
  // fits inside the element, centred.
  let contentW = rect.width;
  let contentH = rect.height;
  if (videoAspect > rectAspect) {
    contentH = rect.width / videoAspect; // letterbox: bars top/bottom
  } else {
    contentW = rect.height * videoAspect; // pillarbox: bars left/right
  }
  return {
    left: rect.left + (rect.width - contentW) / 2,
    top: rect.top + (rect.height - contentH) / 2,
    width: contentW,
    height: contentH,
  };
}

/**
 * Map a pointer position within an `object-contain` <video> to normalized
 * (0..1) source coordinates (spec §7.1, ADR-30).
 *
 * A click on a black bar clamps to an edge instead of landing on a wrong
 * source point.
 */
export function toNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  const box = contentBox(rect, videoWidth, videoHeight);
  if (box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0 };
  }
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  return { x: clamp01(x), y: clamp01(y) };
}

/**
 * Inverse of `toNormalized`: map normalized (0..1) source coordinates back to
 * client pixel coordinates within the element.
 */
export function toClient(
  nx: number,
  ny: number,
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  const box = contentBox(rect, videoWidth, videoHeight);
  if (box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: box.left + clamp01(nx) * box.width,
    y: box.top + clamp01(ny) * box.height,
  };
}

/**
 * Linearly extrapolate a cursor position from two samples.
 *
 * Velocity is derived from `(p1 - p0) / (p1.time - p0.time)` and projected
 * forward by `min(targetTimeMs - p1.time, maxDeltaMs)` (never negative, never
 * beyond `maxDeltaMs`). The result is clamped to `[0, 1]` in both axes.
 *
 * Non-finite inputs, a zero/negative time delta, or projection beyond maxDelta
 * all fall back to returning p1's position unchanged.
 */
export function extrapolateCursor(
  p0: { x: number; y: number; time: number },
  p1: { x: number; y: number; time: number },
  targetTimeMs: number,
  maxDeltaMs: number,
): { x: number; y: number } {
  const dt = p1.time - p0.time;
  if (
    !Number.isFinite(p0.x) ||
    !Number.isFinite(p0.y) ||
    !Number.isFinite(p1.x) ||
    !Number.isFinite(p1.y) ||
    !Number.isFinite(p0.time) ||
    !Number.isFinite(p1.time) ||
    dt <= 0
  ) {
    // Degenerate: hold the latest sample (p1) unchanged.
    return { x: p1.x, y: p1.y };
  }
  const velocityX = (p1.x - p0.x) / dt;
  const velocityY = (p1.y - p0.y) / dt;
  const projDelta = Math.min(Math.max(0, targetTimeMs - p1.time), maxDeltaMs);
  return {
    x: clamp01(p1.x + velocityX * projDelta),
    y: clamp01(p1.y + velocityY * projDelta),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
