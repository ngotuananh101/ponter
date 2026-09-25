<script setup lang="ts">
import AppHeader from './AppHeader.vue';
</script>

<template>
  <div class="min-h-screen flex flex-col bg-background text-foreground">
    <AppHeader />
    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
