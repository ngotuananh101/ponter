<script setup lang="ts">
import {
  ref,
  watch,
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
} from 'vue';
import { RefreshCw, Settings, ShieldCheck } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import ConnectionProgress from '@/components/terminal/ConnectionProgress.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';
import {
  toNormalized,
  toClient,
  contentBox,
  extrapolateCursor,
} from '@/lib/desktop-input';
import type { KeyModifiers } from '@ponter/shared';

const props = defineProps<{ tab: TabItem }>();
const store = useTerminalStore();
const videoEl = ref<HTMLVideoElement | null>(null);
const cursorCanvas = ref<HTMLCanvasElement | null>(null);

/** Prior cursor sample for velocity-based extrapolation (view-only mode). */
let prevCursor: { x: number; y: number; time: number } | null = null;

let rafId: number | null = null;

/** Draw the remote/local cursor arrow onto the overlay canvas. */
function renderCursorFrame() {
  const canvas = cursorCanvas.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  const video = videoEl.value;
  if (!video) return;

  // Hide canvas when the cursor is explicitly hidden or in-frame (remote will draw it).
  if (
    props.tab.desktopCursorInFrame ||
    props.tab.desktopCursor?.visible === false
  ) {
    return;
  }

  const rect = video.getBoundingClientRect();
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (videoWidth <= 0 || videoHeight <= 0) return;

  const box = contentBox(rect, videoWidth, videoHeight);

  // Size the canvas to the video element's layout box.
  canvas.style.left = `${box.left}px`;
  canvas.style.top = `${box.top}px`;
  canvas.style.width = `${box.width}px`;
  canvas.style.height = `${box.height}px`;
  canvas.width = box.width;
  canvas.height = box.height;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (inputOn.value) {
    // Controlling: the local OS cursor is visible, so we don't draw a remote cursor.
    // The video has cursor-none so the native cursor shows instead.
    return;
  }

  // View-only: render the remote pointer arrow.
  const cursor = props.tab.desktopCursor;
  if (!cursor) return;

  const now = performance.now();
  const targetTimeMs = now;
  const maxDeltaMs = 100;

  let nx: number, ny: number;
  if (prevCursor && prevCursor.x !== cursor.x && prevCursor.y !== cursor.y) {
    const extrapolated = extrapolateCursor(
      prevCursor,
      { x: cursor.x, y: cursor.y, time: now },
      targetTimeMs,
      maxDeltaMs,
    );
    nx = extrapolated.x;
    ny = extrapolated.y;
  } else {
    nx = cursor.x;
    ny = cursor.y;
  }

  const clientPos = toClient(nx, ny, rect, videoWidth, videoHeight);

  // Convert to canvas-local coordinates (canvas is sized to content box).
  const cx = clientPos.x - box.left;
  const cy = clientPos.y - box.top;

  // Draw a simple arrow/cursor shape.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.5, 1.5);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#0099ff';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  // Simple arrow pointing to the upper-left (cursor tip at origin).
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(18, 20);
  ctx.lineTo(8, 14);
  ctx.lineTo(-2, 22);
  ctx.lineTo(4, 24);
  ctx.lineTo(10, 16);
  ctx.lineTo(18, 26);
  ctx.closePath();
  ctx.stroke();
  ctx.fill('evenodd');
  ctx.restore();

  prevCursor = { x: cursor.x, y: cursor.y, time: now };
}

function startRAF() {
  if (rafId !== null) return;
  function tick() {
    renderCursorFrame();
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function stopRAF() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// Reset extrapolation state when the cursor payload changes significantly.
watch(
  () => props.tab.desktopCursor?.seq,
  () => {
    prevCursor = null;
  },
);

/** Assign the stream, guarding the detached-element case during teardown. */
function attach() {
  const el = videoEl.value;
  if (!el) return;
  const stream = props.tab.desktopStream;
  if (!stream) {
    el.srcObject = null;
    return;
  }
  // werift's onTrack path reports no streams, so fall back to a stream built
  // from the track alone; a real browser reports `streams[0]`.
  const srcObject =
    stream.streams[0] ?? new MediaStream([stream.track as MediaStreamTrack]);
  try {
    el.srcObject = srcObject as MediaStream;
  } catch {
    // The element was detached mid-teardown; nothing to attach to.
  }
}

watch(() => props.tab.desktopStream, attach, { immediate: true });

// `watch(..., { immediate: true })` runs before the template ref exists, so its
// first call is a no-op. When the component remounts with the stream already
// present (the tab is keyed by tab id, so switching away and back remounts),
// the watcher's source never changes and would never fire — attach here instead.
onMounted(() => {
  attach();
  startRAF();
});

onBeforeUnmount(() => {
  stopRAF();
  // Release the decoder without touching the store's client lifecycle — the
  // store owns closing the client/peer (closeTab).
  if (videoEl.value) videoEl.value.srcObject = null;
});

/** The stats line, or `null` before the first `desktop-stats` frame. */
const statsLine = computed(() => {
  const stats = props.tab.desktopStats;
  if (!stats) return null;
  const mbps = (stats.targetBitrateBps / 1_000_000).toFixed(1);
  const base = `${stats.width}×${stats.height} · ${Math.round(stats.fps)} fps · ${mbps} Mbps`;
  return stats.status ? `${base} · ${stats.status.detail}` : base;
});

/** The settings (gear) popover: reveals the manual bitrate control. */
const settingsOpen = ref(false);

function onSourceChange(event: Event): void {
  const sourceId = (event.target as HTMLSelectElement).value;
  store.selectDesktopSource(props.tab.id, sourceId);
}

function onBitrateChange(event: Event): void {
  const bps = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(bps) && bps > 0) {
    store.setDesktopBitrate(props.tab.id, bps);
  }
}

/**
 * Input forwarding is OFF until the operator turns it on here, and the toggle
 * only exists when the agent's gate is open (`desktopInputEnabled`, ADR-29).
 */
const inputOn = ref(false);
// Turning the gate off mid-session must also drop the local state, so a later
// remount with the gate closed captures nothing.
watch(
  () => props.tab.desktopInputEnabled,
  (enabled) => {
    if (!enabled) inputOn.value = false;
  },
);
// Keydown only reaches the focused element, and a `tabindex` does not focus
// itself: moving focus to the video on enable is what makes typing land on the
// remote desktop without a click first (spec §7.2).
watch(inputOn, async (on) => {
  if (!on) return;
  await nextTick();
  videoEl.value?.focus();
});

/** The input toggle is our own chrome, so its state is the local `inputOn`. */
function onToggle(event: Event): void {
  inputOn.value = (event.target as HTMLInputElement).checked;
}

function modifiersOf(e: KeyboardEvent | MouseEvent): KeyModifiers {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/** The pointer position as normalized 0..1 source coords (letterbox removed). */
function pointOf(e: MouseEvent): { x: number; y: number } {
  const el = videoEl.value;
  if (!el) return { x: 0, y: 0 };
  return toNormalized(
    e.clientX,
    e.clientY,
    el.getBoundingClientRect(),
    el.videoWidth,
    el.videoHeight,
  );
}

function onPointerMove(e: PointerEvent): void {
  store.sendDesktopInput(props.tab.id, {
    kind: 'pointer-move',
    ...pointOf(e),
  });
}

function onPointerButton(e: PointerEvent, pressed: boolean): void {
  const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left';
  store.sendDesktopInput(props.tab.id, {
    kind: 'pointer-button',
    button,
    pressed,
    ...pointOf(e),
  });
}

function onWheel(e: WheelEvent): void {
  // Interacting with the remote desktop must not scroll the local page.
  e.preventDefault();
  store.sendDesktopInput(props.tab.id, {
    kind: 'wheel',
    dx: e.deltaX,
    dy: e.deltaY,
    ...pointOf(e),
  });
}

function onKey(e: KeyboardEvent, pressed: boolean): void {
  // Physical code + modifier state (ADR-28): layout-independent.
  store.sendDesktopInput(props.tab.id, {
    kind: 'key',
    code: e.code,
    pressed,
    modifiers: modifiersOf(e),
  });
}

/**
 * Attached only while the toggle is on, so the element captures nothing by
 * default (spec §7.2, ADR-29). A statically bound `@wheel.prevent` would
 * swallow local scrolling even with the gate closed.
 */
const inputHandlers = computed(() => {
  if (!inputOn.value) return {};
  return {
    pointermove: onPointerMove,
    pointerdown: (e: PointerEvent) => onPointerButton(e, true),
    pointerup: (e: PointerEvent) => onPointerButton(e, false),
    wheel: onWheel,
    keydown: (e: KeyboardEvent) => onKey(e, true),
    keyup: (e: KeyboardEvent) => onKey(e, false),
  };
});
</script>

<template>
  <div class="flex flex-col h-full w-full bg-terminal-bg overflow-hidden">
    <!-- Video container: fills the remaining height above the footer status bar. -->
    <div
      class="relative flex-1 min-h-0 w-full flex items-center justify-center"
    >
      <!-- No `controls` (our own chrome instead), and input listeners attach only
           while the operator turns the toggle on behind the agent's gate (ADR-26
           supersedes ADR-18; ADR-29 gates every injection path). -->
      <video
        ref="videoEl"
        autoplay
        muted
        playsinline
        :tabindex="inputOn ? 0 : undefined"
        class="h-full w-full object-contain"
        :class="{ 'cursor-none': inputOn }"
        v-on="inputHandlers"
      />
      <canvas
        ref="cursorCanvas"
        data-test="desktop-cursor-canvas"
        class="pointer-events-none absolute inset-0"
        :class="{
          hidden:
            tab.desktopCursorInFrame || tab.desktopCursor?.visible === false,
        }"
      ></canvas>

      <!-- Desktop handshake can take up to 20s waiting for the first track; the
           step list makes that wait legible instead of a bare spinner. -->
      <ConnectionProgress v-if="tab.status === 'connecting'" :tab="tab" />

      <div
        v-if="tab.status === 'error'"
        class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center text-foreground"
      >
        <p class="text-sm text-destructive font-semibold">
          Could not open the desktop stream for {{ tab.title }}
        </p>
        <p class="text-xs text-muted-foreground font-mono max-w-lg break-words">
          {{ tab.error }}
        </p>
        <Button
          size="sm"
          variant="outline"
          class="text-xs flex items-center gap-2 border-border/80"
          :data-test="`retry-desktop-${tab.id}`"
          @click="store.retryTab(tab.id)"
        >
          <RefreshCw class="w-3.5 h-3.5" />
          Retry connection
        </Button>
      </div>
    </div>

    <!-- Footer Status Bar: source picker, input toggle, settings/gear popover
         (manual bitrate), and telemetry stats. -->
    <div
      v-if="
        tab.status === 'active' &&
        (tab.desktopSources?.length || statsLine || tab.desktopEchoMs != null)
      "
      class="relative h-7 flex-shrink-0 flex items-center justify-between border-t border-border/40 bg-card/90 px-3 text-xs select-none"
    >
      <div class="flex items-center gap-3">
        <label
          v-if="tab.desktopSources?.length"
          class="flex items-center gap-1 text-muted-foreground"
        >
          <span>Source</span>
          <select
            data-test="desktop-source-picker"
            class="rounded border border-border/60 bg-transparent px-1 py-0.5"
            :value="tab.desktopSourceId"
            @change="onSourceChange"
          >
            <option
              v-for="source in tab.desktopSources"
              :key="source.id"
              :value="source.id"
            >
              {{ source.name }}{{ source.default ? ' (streaming)' : '' }}
            </option>
          </select>
        </label>

        <span
          v-if="tab.desktopPeerVerified"
          data-test="desktop-peer-verified"
          class="flex items-center gap-1 text-primary"
          title="This session's peer identity was verified by the agent"
        >
          <ShieldCheck class="w-3.5 h-3.5" />
          <span>Verified peer</span>
        </span>

        <label
          v-if="tab.desktopInputEnabled && tab.desktopPeerVerified"
          class="flex items-center gap-1 text-muted-foreground"
        >
          <input
            data-test="desktop-input-toggle"
            type="checkbox"
            :checked="inputOn"
            @change="onToggle"
          />
          <span>Input</span>
        </label>

        <span
          v-if="tab.desktopInputEnabled && tab.desktopPeerVerified"
          data-test="desktop-input-status"
          class="text-muted-foreground"
        >
          {{ inputOn ? 'Controlling' : 'View only' }}
        </span>

        <!-- Settings (gear) popover tucking the manual bitrate control. -->
        <div class="relative flex items-center">
          <button
            type="button"
            data-test="desktop-settings-toggle"
            aria-label="Stream settings"
            class="flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            @click="settingsOpen = !settingsOpen"
          >
            <Settings class="w-3.5 h-3.5" />
          </button>

          <div
            v-if="settingsOpen"
            class="absolute bottom-full left-0 mb-1.5 flex items-center gap-1.5 rounded-md border border-border bg-background/95 p-2 shadow-lg text-xs text-foreground"
          >
            <label
              class="flex items-center gap-1 text-muted-foreground whitespace-nowrap"
            >
              <span>Bitrate</span>
              <input
                data-test="desktop-bitrate"
                type="number"
                min="250000"
                max="20000000"
                step="250000"
                class="w-24 rounded border border-border/60 bg-transparent px-1 py-0.5"
                :value="tab.desktopStats?.targetBitrateBps ?? ''"
                @change="onBitrateChange"
              />
              <span>bps</span>
            </label>
          </div>
        </div>
      </div>

      <span
        v-if="statsLine"
        data-test="desktop-stats"
        class="font-mono text-muted-foreground"
      >
        {{ statsLine }}
      </span>

      <span
        v-if="tab.desktopEchoMs != null"
        data-test="desktop-echo"
        class="font-mono text-muted-foreground"
      >
        echo: {{ tab.desktopEchoMs }}ms
      </span>
    </div>
  </div>
</template>
