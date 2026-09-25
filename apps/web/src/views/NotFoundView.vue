<script setup lang="ts">
import { Button } from '@/components/ui/button';
</script>

<template>
  <div
    class="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] p-4 text-center"
  >
    <h1 class="text-6xl font-extrabold text-primary">404</h1>
    <h2 class="text-2xl font-bold tracking-tight mt-4">Page not found</h2>
    <p class="text-muted-foreground mt-2 max-w-sm">
      The page you are looking for doesn't exist or has been moved.
    </p>
    <router-link to="/" class="mt-6">
      <Button>Back to Home</Button>
    </router-link>
  </div>
</template>
