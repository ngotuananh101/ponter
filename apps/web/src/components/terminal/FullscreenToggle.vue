<script setup lang="ts">
import { computed } from 'vue';
import { Maximize2, Minimize2 } from '@lucide/vue';

/**
 * Presentational fullscreen control. The owning view runs `useFullscreen` on
 * its own element and passes the state down, which keeps this component free of
 * any ref-plumbing (template auto-unwrap makes passing a ref through a prop
 * error-prone).
 */
const props = withDefaults(
  defineProps<{
    /** Whether the element is currently fullscreen. */
    active: boolean;
    /** Whether the browser supports the Fullscreen API at all. */
    supported: boolean;
    /** What the control acts on, for the accessible label. */
    label?: string;
    /**
     * `overlay` floats over a session body; `inline` sits in the tab strip
     * beside "Open new tab".
     */
    variant?: 'overlay' | 'inline';
  }>(),
  { variant: 'overlay' },
);

defineEmits<{
  (e: 'toggle'): void;
}>();

// The two placements want opposite treatments: an overlay needs its own
// surface to stay legible on top of a terminal, while the inline one should
// read as a sibling of the flat "+" button.
const buttonClass = computed(() =>
  props.variant === 'inline'
    ? 'p-1.5 mr-1 rounded-md flex-shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    : 'absolute top-2 right-2 z-20 flex items-center justify-center w-7 h-7 rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur-sm shadow-sm transition-colors hover:text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const iconClass = computed(() =>
  props.variant === 'inline' ? 'w-4 h-4' : 'w-3.5 h-3.5',
);
</script>

<template>
  <button
    v-if="supported"
    type="button"
    :class="buttonClass"
    :title="active ? 'Exit fullscreen' : 'Enter fullscreen'"
    :aria-label="
      (active ? 'Exit fullscreen' : 'Enter fullscreen') +
      (label ? ` for ${label}` : '')
    "
    :aria-pressed="active"
    data-test="fullscreen-toggle"
    @click="$emit('toggle')"
  >
    <Minimize2 v-if="active" :class="iconClass" />
    <Maximize2 v-else :class="iconClass" />
  </button>
</template>
