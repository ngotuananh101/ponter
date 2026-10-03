<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import ConnectionProgress from '@/components/terminal/ConnectionProgress.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';

const props = defineProps<{ tab: TabItem }>();
const store = useTerminalStore();
const videoEl = ref<HTMLVideoElement | null>(null);

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
onMounted(attach);

onBeforeUnmount(() => {
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
</script>

<template>
  <div class="relative h-full w-full bg-[#090d16]">
    <!-- No `controls`: Week 7 is view-only (ADR-18). -->
    <video
      ref="videoEl"
      autoplay
      muted
      playsinline
      class="h-full w-full object-contain"
    />

    <!-- Control chrome (Week 8). No input forwarding: that is Week 9. -->
    <div
      v-if="
        tab.status === 'active' && (tab.desktopSources?.length || statsLine)
      "
      class="absolute top-0 left-0 right-0 flex flex-wrap items-center gap-3 bg-[#090d16]/80 px-3 py-1.5 text-xs"
    >
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

      <label class="flex items-center gap-1 text-muted-foreground">
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

      <span
        v-if="statsLine"
        data-test="desktop-stats"
        class="text-muted-foreground font-mono"
      >
        {{ statsLine }}
      </span>
    </div>

    <!-- Desktop handshake can take up to 20s waiting for the first track; the
         step list makes that wait legible instead of a bare spinner. -->
    <ConnectionProgress v-if="tab.status === 'connecting'" :tab="tab" />

    <div
      v-if="tab.status === 'error'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#090d16]/95 p-6 text-center"
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
</template>
