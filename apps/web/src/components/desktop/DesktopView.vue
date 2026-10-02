<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
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

    <div
      v-if="tab.status === 'connecting'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground"
    >
      <span
        class="h-5 w-5 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin"
      ></span>
      <p class="text-xs font-mono">Negotiating stream…</p>
    </div>

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
