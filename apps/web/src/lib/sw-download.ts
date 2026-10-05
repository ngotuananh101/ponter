/**
 * Lazy, feature-detected Service Worker registration for file downloads.
 *
 * `registerDownloadSW()` registers `/sw-files-download.js` with scope `/` and
 * caches the registration promise so subsequent calls return the same promise.
 * It never throws into the caller — failures surface as `null`, and the caller
 * falls back to the in-memory `saveBlob` path (spec ADR-38).
 *
 * Kept in its own module so `terminal.ts` tests can mock `navigator.serviceWorker`
 * without pulling SW code into the store.
 */
const SW_URL = '/sw-files-download.js';

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null =
  null;

/** True when the browser supports the SW API at all. */
export function swSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * True when the browser supports the Service Worker API. This is the
 * feature-detection gate used by `terminal.ts` before attempting the SW
 * download path (GAP-D ruling).
 */
export function swAvailable(): boolean {
  return swSupported();
}

/**
 * Register the download SW exactly once, caching the result. Returns `null`
 * when SW is unsupported or registration rejects (never throws).
 */
export function registerDownloadSW(): Promise<ServiceWorkerRegistration | null> | null {
  if (!swSupported()) return null;
  if (registrationPromise) return registrationPromise;
  registrationPromise = navigator.serviceWorker
    .register(SW_URL, { scope: '/' })
    .catch(() => null);
  return registrationPromise;
}

/**
 * Post a STREAM_INIT message with a MessagePort to the active SW. Resolves on
 * `controllerchange` (SW ready); rejects on timeout / registration failure.
 */
export async function initDownloadStream(
  transferId: string,
  filename: string,
  size: number,
  port: MessagePort,
): Promise<void> {
  const reg = registerDownloadSW();
  if (!reg) throw new Error('service worker unavailable');
  const registration = await reg;
  if (!registration) throw new Error('service worker registration failed');

  // Wait for the SW to be ready (installed + controlling).
  const sw = registration.active ?? registration.installing;
  if (!sw) throw new Error('service worker not active');

  if (sw.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      if (!sw) return reject(new Error('service worker not active'));
      const timer = setTimeout(() => {
        sw.removeEventListener('statechange', onChange);
        reject(new Error('service worker activation timed out'));
      }, 3000);
      const onChange = () => {
        if (sw.state === 'activated') {
          clearTimeout(timer);
          sw.removeEventListener('statechange', onChange);
          resolve();
        } else if (sw.state === 'redundant') {
          clearTimeout(timer);
          sw.removeEventListener('statechange', onChange);
          reject(new Error('service worker became redundant'));
        }
      };
      sw.addEventListener('statechange', onChange);
      // If the SW has already settled by the time we attach, resolve/reject once.
      if (sw.state === 'activated') {
        clearTimeout(timer);
        sw.removeEventListener('statechange', onChange);
        resolve();
      } else if (sw.state === 'redundant') {
        clearTimeout(timer);
        sw.removeEventListener('statechange', onChange);
        reject(new Error('service worker became redundant'));
      }
    });
  }

  sw.postMessage({ type: 'STREAM_INIT', transferId, filename, size }, [port]);
}
