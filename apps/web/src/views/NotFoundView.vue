<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <div
    class="flex flex-col items-center justify-center min-h-[calc(100vh-var(--header-height))] p-4 text-center"
  >
    <h1 class="text-6xl font-extrabold text-primary">404</h1>
    <h2 class="text-2xl font-bold tracking-tight mt-4">Page not found</h2>
    <p class="text-muted-foreground mt-2 max-w-sm">
      The page you are looking for doesn't exist or has been moved.
    </p>
    <RouterLink
      to="/"
      class="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Back to Home
    </RouterLink>
  </div>
</template>
