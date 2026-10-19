/** The inclusive range of a Device Code; the first digit is never zero. */
export const MIN_DEVICE_CODE = 100_000_000;
export const MAX_DEVICE_CODE = 999_999_999;

/** The placeholder shown wherever a code is absent. */
const NO_CODE = '—';

/** `'749281903'` -> `'749 281 903'`; a missing value -> the em dash. */
export function formatDeviceCode(code: string | null | undefined): string {
  if (!code) return NO_CODE;
  const digits = normalizeDeviceCode(code);
  if (!/^\d{9}$/.test(digits)) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/**
 * `'749 281 903'` / `'749-281-903'` -> `'749281903'`.
 *
 * Only whitespace and dashes are removed. Every other character survives, so a
 * legacy `dev_ab12cd34` identifier is returned unchanged.
 *
 * `String.replace` with a global regex rather than `replaceAll`: the desktop
 * renderer compiles against `lib: ES2020`, where `replaceAll` does not exist.
 * The two are equivalent for a global pattern.
 */
export function normalizeDeviceCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').trim();
}
