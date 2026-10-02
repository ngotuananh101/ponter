<script setup lang="ts">
import { computed } from 'vue';
import { Check, Loader2 } from '@lucide/vue';
import type { TabItem } from '@/stores/terminal';
import { INIT_STEPS, stepIndex, type InitStep } from '@/lib/connection-steps';

const props = defineProps<{ tab: TabItem }>();

const steps = computed(() => INIT_STEPS[props.tab.kind]);

/**
 * Where the tab currently is. A tab that has not been stamped yet (should not
 * happen once the store pushes it, but keeps this robust) reads as step one.
 */
const currentIndex = computed(() =>
  stepIndex(
    props.tab.kind,
    (props.tab.initStep ?? steps.value[0]!.key) as InitStep,
  ),
);

type StepState = 'done' | 'active' | 'pending';

function stateOf(index: number): StepState {
  if (index < currentIndex.value) return 'done';
  if (index === currentIndex.value) return 'active';
  return 'pending';
}
</script>

<template>
  <div
    class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-[#090d16] p-6"
  >
    <div class="flex flex-col items-center gap-3">
      <Loader2
        class="w-8 h-8 text-primary motion-safe:animate-spin"
        aria-hidden="true"
      />
      <p class="text-sm font-medium text-foreground">
        Connecting to
        <span class="font-mono text-primary">{{ tab.title }}</span>
      </p>
    </div>

    <!-- Ordered list: the stages really are a sequence, so numbering-free
         ordered semantics carry the meaning (screen readers announce the
         position). -->
    <ol class="w-full max-w-xs space-y-2.5" role="status" aria-live="polite">
      <li
        v-for="(step, i) in steps"
        :key="step.key"
        class="flex items-center gap-2.5 text-xs"
        :data-state="stateOf(i)"
        :class="
          stateOf(i) === 'pending'
            ? 'text-muted-foreground/60'
            : stateOf(i) === 'active'
              ? 'text-foreground font-medium'
              : 'text-muted-foreground'
        "
      >
        <span
          class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border"
          :class="
            stateOf(i) === 'done'
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-500'
              : stateOf(i) === 'active'
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border/60 text-transparent'
          "
        >
          <Check v-if="stateOf(i) === 'done'" class="w-2.5 h-2.5" />
          <Loader2
            v-else-if="stateOf(i) === 'active'"
            class="w-2.5 h-2.5 motion-safe:animate-spin"
          />
          <span v-else class="h-1 w-1 rounded-full bg-current" />
        </span>
        <span class="truncate">{{ step.label }}</span>
      </li>
    </ol>
  </div>
</template>
