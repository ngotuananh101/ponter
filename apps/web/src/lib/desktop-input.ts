/**
 * Map a pointer position within an `object-contain` <video> to normalized
 * (0..1) source coordinates (Week 9, spec §7.1, ADR-30).
 *
 * The element letterboxes/pillarboxes the stream; this removes that box
 * (aspect-fit, centred) before mapping, so a click on a black bar clamps to an
 * edge instead of landing on a wrong source point.
 */
export function toNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } {
  if (
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return { x: 0, y: 0 };
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
  const offsetX = rect.left + (rect.width - contentW) / 2;
  const offsetY = rect.top + (rect.height - contentH) / 2;
  const x = (clientX - offsetX) / contentW;
  const y = (clientY - offsetY) / contentH;
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
