import { ref, onBeforeUnmount, type Ref } from 'vue';

export interface UseFullscreen {
  /** True while `target` is the element the browser is showing fullscreen. */
  isFullscreen: Ref<boolean>;
  /** False when the browser has no Fullscreen API (e.g. an old engine). */
  isSupported: boolean;
  toggle(): Promise<void>;
  enter(): Promise<void>;
  exit(): Promise<void>;
}

/**
 * Drive the Fullscreen API for a single element.
 *
 * The browser owns the actual state, so this composable never assumes its own
 * writes succeeded: it re-reads `document.fullscreenElement` after every action
 * and on `fullscreenchange`. That keeps it correct when the user leaves
 * fullscreen with Esc or F11 — a state a click handler alone would miss.
 *
 * All calls are best-effort: `requestFullscreen()` rejects when the browser
 * refuses (not a user gesture, a permissions policy block), and that rejection
 * must not surface as an unhandled promise.
 */
export function useFullscreen(target: Ref<HTMLElement | null>): UseFullscreen {
  const isFullscreen = ref(false);

  const doc = typeof document === 'undefined' ? null : document;
  const isSupported =
    !!doc && typeof doc.documentElement?.requestFullscreen === 'function';

  function sync(): void {
    isFullscreen.value = !!doc && doc.fullscreenElement === target.value;
  }

  if (doc) {
    doc.addEventListener('fullscreenchange', sync);
  }

  async function enter(): Promise<void> {
    const el = target.value;
    if (!el || !isSupported) return;
    try {
      await el.requestFullscreen();
    } catch {
      // The browser declined; `sync()` below records whatever the real state is.
    }
    sync();
  }

  async function exit(): Promise<void> {
    if (!doc || !doc.fullscreenElement) return;
    try {
      await doc.exitFullscreen();
    } catch {
      // Already exited (e.g. the element was removed); nothing to do.
    }
    sync();
  }

  async function toggle(): Promise<void> {
    if (isFullscreen.value) {
      await exit();
    } else {
      await enter();
    }
  }

  onBeforeUnmount(() => {
    if (doc) {
      doc.removeEventListener('fullscreenchange', sync);
    }
    // Leaving a route while fullscreen would otherwise strand the browser in
    // fullscreen with no visible control to escape.
    if (isFullscreen.value) void exit();
  });

  return { isFullscreen, isSupported, toggle, enter, exit };
}
