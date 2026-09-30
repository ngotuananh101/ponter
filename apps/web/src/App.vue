<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '@/components/layout/AppLayout.vue';

const route = useRoute();

/**
 * The workspace is an app shell, not a document: one viewport-height frame
 * where only the terminal viewport scrolls. All other routes are regular
 * pages where long content scrolls the page itself.
 */
const fluidShell = computed(() => route.name === 'workspace');
</script>

<template>
  <AppLayout :fluid="fluidShell">
    <router-view />
  </AppLayout>
</template>
