<script setup lang="ts">
import AppHeader from './AppHeader.vue';

defineProps<{
  /**
   * Full-bleed app-shell mode (workspace): the shell locks to the viewport
   * height and only inner panes scroll. Regular pages keep the default
   * document flow so long content scrolls the page itself.
   */
  fluid?: boolean;
}>();
</script>

<template>
  <div
    class="flex flex-col bg-background text-foreground"
    :class="fluid ? 'h-screen h-dvh overflow-hidden' : 'min-h-screen'"
  >
    <AppHeader :fluid="fluid" />
    <main class="flex-1" :class="fluid ? 'min-h-0 flex flex-col' : ''">
      <slot />
    </main>
  </div>
</template>
