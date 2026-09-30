<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { reactiveOmit } from '@vueuse/core';
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui';
import { cn } from '@/lib/utils';
import ScrollBar from './ScrollBar.vue';

/**
 * `orientation` is a local addition over the stock shadcn-vue component: the
 * tab strip scrolls horizontally while the agent list scrolls vertically, and
 * a vertical-only bar would leave the horizontal case with no visible
 * scrollbar at all (the reka viewport hides native ones). Defaults to
 * `vertical`, so every existing usage is unchanged.
 */
const props = withDefaults(
  defineProps<
    ScrollAreaRootProps & {
      class?: HTMLAttributes['class'];
      orientation?: 'vertical' | 'horizontal' | 'both';
    }
  >(),
  { orientation: 'vertical' },
);

const delegatedProps = reactiveOmit(props, 'class', 'orientation');
</script>

<template>
  <ScrollAreaRoot
    data-slot="scroll-area"
    v-bind="delegatedProps"
    :class="cn('relative', props.class)"
  >
    <ScrollAreaViewport
      data-slot="scroll-area-viewport"
      class="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-1"
    >
      <slot />
    </ScrollAreaViewport>
    <ScrollBar v-if="orientation !== 'horizontal'" />
    <ScrollBar v-if="orientation !== 'vertical'" orientation="horizontal" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
